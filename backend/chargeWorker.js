/**
 * backend/chargeWorker.js
 *
 * Project 10 — Phase 3 & Phase 4: Scheduled Billing Worker, Batch Settlement,
 * and Sandbox Bank Balance Fallback Integration.
 *
 * Capabilities:
 * - Scans MandateRegistered events from deploymentBlock onward to discover mandates.
 * - Computes and populates invoices with composite key (mandateId, billingPeriod).
 * - Scans ChargePaid and MandateRevoked events to reconcile on-chain state (including third-party charges).
 * - Identifies eligible invoices based on latest chain block timestamp [dueTime, windowEnd).
 * - Verifies mandate status, period settlement, subscriber token balance, and allowance.
 * - Supports bounded batch settlement (chargeBatch) up to batchSize (default 50) and single charge fallback.
 * - Tracks each item separately when grouped in a batch transaction; reconciles confirmed ChargePaid events.
 * - Isolate per-item failures so underfunded, revoked, or already-settled items do not abort other items.
 * - Phase 4 Sandbox Bank Fallback:
 *     - If charge fails due to insufficient token balance (pre-flight or on-chain revert), triggers read-only bank reserve lookup.
 *     - Records BANK_CHECKED in audit trail with check timestamp, status (AVAILABLE, INSUFFICIENT, UNLINKED, PROVIDER_ERROR), and fiat balance.
 *     - Throttles bank checks (default: at most once per 60 seconds per invoice) to prevent spamming on every polling tick.
 *     - Insufficient token allowance does NOT trigger bank check (stays on ERC-20 approval path).
 *     - Bank check NEVER mints, debits, or marks invoice settled; invoice strictly remains OPEN until confirmed ChargePaid event.
 * - Records detailed audit attempts (SUBMITTED, CONFIRMED, REVERTED, FAILED, BANK_CHECKED) with actionable reasons.
 * - Marks unpaid invoices MISSED when their billing window has elapsed.
 * - Supports runOnce() for deterministic Hardhat tests and start()/stop() for daemon polling.
 */

const { ethers } = require("ethers");
const BillingStore = require("./store/billingStore");
const BankAdapter = require("./adapters/bankAdapter");

class ChargeWorker {
  /**
   * @param {Object} options
   * @param {ethers.Provider} options.provider - Ethers provider connected to RPC
   * @param {ethers.Signer} options.signer - Dedicated keeper signer paying for gas
   * @param {ethers.Contract} options.smartMandate - SmartMandate contract instance
   * @param {ethers.Contract} [options.demoToken] - DemoToken contract instance (for balance/allowance pre-checks)
   * @param {BillingStore} [options.store] - Persistent billing store instance
   * @param {BankAdapter} [options.bankAdapter] - Sandbox bank balance adapter
   * @param {number} [options.pollIntervalMs=3000] - Polling interval for daemon mode
   * @param {number} [options.deploymentBlock=0] - Starting block for event scanning
   * @param {boolean} [options.useBatch=true] - Whether to execute eligible charges in batches
   * @param {number} [options.maxBatchSize=50] - Maximum charges to group per batch transaction
   * @param {number} [options.bankCheckThrottleSec=60] - Seconds between repeated bank checks for same invoice
   */
  constructor(options = {}) {
    if (!options.provider) throw new Error("ChargeWorker requires a provider");
    if (!options.signer) throw new Error("ChargeWorker requires a keeper signer");
    if (!options.smartMandate) throw new Error("ChargeWorker requires smartMandate contract");

    this.provider = options.provider;
    this.signer = options.signer;
    this.smartMandate = options.smartMandate.connect(this.signer);
    this.demoToken = options.demoToken ? options.demoToken.connect(this.signer) : null;
    this.pollIntervalMs = options.pollIntervalMs || 3000;
    this.deploymentBlock = options.deploymentBlock !== undefined ? options.deploymentBlock : 0;
    this.useBatch = options.useBatch !== undefined ? options.useBatch : true;
    this.maxBatchSize = options.maxBatchSize || 50;
    this.bankCheckThrottleSec = options.bankCheckThrottleSec || 60;

    this.bankAdapter = options.bankAdapter || new BankAdapter();

    this.store = options.store || new BillingStore({
      chainId: options.chainId || 31337,
      contractAddress: this.smartMandate.target || this.smartMandate.address,
      deploymentBlock: this.deploymentBlock,
    });

    this.isTicking = false;
    this.timer = null;
    this.pendingInvoices = new Set(); // tracks invoices currently being processed/submitted
    this.lastBankCheckTime = new Map(); // `${mandateId}:${billingPeriod}` -> timestamp (in seconds)
  }

  /**
   * Scan confirmed events (MandateRegistered, ChargePaid, MandateRevoked)
   * from cursor.lastScannedBlock up to targetBlock.
   */
  async syncEvents(toBlock) {
    const cursor = this.store.getCursor();
    const fromBlock = cursor.lastScannedBlock > 0 ? cursor.lastScannedBlock : this.deploymentBlock;
    const targetBlock = toBlock !== undefined ? toBlock : await this.provider.getBlockNumber();

    if (fromBlock > targetBlock) {
      return;
    }

    // 1. Scan MandateRegistered events
    const regFilter = this.smartMandate.filters.MandateRegistered();
    const registeredEvents = await this.smartMandate.queryFilter(regFilter, fromBlock, targetBlock);
    for (const evt of registeredEvents) {
      const args = evt.args;
      const mandateId = args.mandateId;
      this.store.saveMandate({
        mandateId: mandateId,
        subscriber: args.subscriber,
        merchant: args.merchant,
        token: args.token,
        amount: args.amount.toString(),
        interval: Number(args.interval),
        firstDueTime: Number(args.firstDueTime),
        maxCharges: Number(args.maxCharges),
        expiry: Number(args.expiry),
        registeredBlock: evt.blockNumber,
        registeredTxHash: evt.transactionHash,
      });
    }

    // 2. Scan ChargePaid events (covers self, batch, and third-party submissions)
    const paidFilter = this.smartMandate.filters.ChargePaid();
    const paidEvents = await this.smartMandate.queryFilter(paidFilter, fromBlock, targetBlock);
    for (const evt of paidEvents) {
      const args = evt.args;
      const mandateId = args.mandateId.toLowerCase();
      const billingPeriod = Number(args.billingPeriod);

      const inv = this.store.getInvoice(mandateId, billingPeriod);
      if (!inv || inv.state !== "SETTLED") {
        this.store.updateInvoice(mandateId, billingPeriod, {
          state: "SETTLED",
          settledAt: Number(args.timestamp || Math.floor(Date.now() / 1000)),
          txHash: evt.transactionHash,
        });

        // Record confirmed attempt for third-party or deduplicated records
        const existingAttempts = this.store.getAttemptsForInvoice(mandateId, billingPeriod);
        const hasMatchingConfirmed = existingAttempts.some(
          (a) => a.txHash && a.txHash.toLowerCase() === evt.transactionHash.toLowerCase()
        );
        if (!hasMatchingConfirmed) {
          this.store.recordAttempt({
            mandateId: mandateId,
            billingPeriod: billingPeriod,
            state: "CONFIRMED",
            txHash: evt.transactionHash,
            caller: "reconciled-from-log",
          });
        }
      }
    }

    // 3. Scan MandateRevoked events
    const revokedFilter = this.smartMandate.filters.MandateRevoked();
    const revokedEvents = await this.smartMandate.queryFilter(revokedFilter, fromBlock, targetBlock);
    for (const evt of revokedEvents) {
      const args = evt.args;
      const mandateId = args.mandateId.toLowerCase();
      this.store.updateMandateStatus(mandateId, "REVOKED");
    }

    // Update cursor
    const latestBlock = await this.provider.getBlock(targetBlock);
    const blockTime = latestBlock ? latestBlock.timestamp : 0;
    this.store.updateCursor(targetBlock + 1, blockTime);
  }

  /**
   * Helper to parse revert reason bytes from contract error data
   */
  _parseRevertReason(reasonBytes) {
    if (!reasonBytes || reasonBytes === "0x") return "Execution reverted";
    try {
      const parsed = this.smartMandate.interface.parseError(reasonBytes);
      if (parsed) return parsed.name;
    } catch (_) {}
    try {
      if (reasonBytes.startsWith("0x08c379a0")) {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + reasonBytes.slice(10));
        return decoded[0];
      }
    } catch (_) {}
    return reasonBytes;
  }

  /**
   * Phase 4: Handle Bank Balance Fallback
   * Checks reserve balance if failure was due to insufficient token balance,
   * obeying throttle interval. Keeps invoice in OPEN state.
   */
  async _handleBankFallback(mandateId, billingPeriod, subscriberAddress, failureReason, currentChainTimestamp) {
    // Only trigger bank check if failure is insufficient token balance
    const isTokenBalanceIssue = failureReason && failureReason.toLowerCase().includes("insufficient balance");
    if (!isTokenBalanceIssue) {
      return null;
    }

    const invKey = `${mandateId.toLowerCase()}:${Number(billingPeriod)}`;
    const nowSec = currentChainTimestamp || Math.floor(Date.now() / 1000);
    const lastCheck = this.lastBankCheckTime.get(invKey) || 0;

    // Check throttle
    if (nowSec - lastCheck < this.bankCheckThrottleSec) {
      return null;
    }

    this.lastBankCheckTime.set(invKey, nowSec);

    let checkResult = null;
    try {
      checkResult = await this.bankAdapter.checkBalance(subscriberAddress);
    } catch (err) {
      checkResult = {
        status: "PROVIDER_ERROR",
        availableAmount: null,
        currency: null,
        checkedAt: nowSec,
        isSimulated: this.bankAdapter.isSimulated,
        errorReason: err.message,
      };
    }

    // Record BANK_CHECKED attempt in audit trail
    this.store.recordAttempt({
      mandateId: mandateId,
      billingPeriod: billingPeriod,
      state: "BANK_CHECKED",
      bankCheck: {
        status: checkResult.status,
        availableAmount: checkResult.availableAmount,
        currency: checkResult.currency,
        checkedAt: checkResult.checkedAt,
        isSimulated: checkResult.isSimulated,
        errorReason: checkResult.errorReason || null,
      },
      errorReason: checkResult.errorReason || `Bank balance status: ${checkResult.status}`,
      caller: "bank-fallback-adapter",
    });

    return checkResult;
  }

  /**
   * Evaluate all invoices and execute due charges (single or batch).
   */
  async processInvoices() {
    const currentBlock = await this.provider.getBlock("latest");
    if (!currentBlock) return [];
    const chainTimestamp = currentBlock.timestamp;

    const invoices = this.store.getAllInvoices();
    const results = [];
    const eligibleForCharge = [];

    for (const invoice of invoices) {
      const invKey = invoice.invoiceKey;

      // Skip invoices that are already settled or missed
      if (invoice.state === "SETTLED" || invoice.state === "MISSED") {
        continue;
      }

      // Check if mandate is revoked or completed
      const mandate = this.store.getMandate(invoice.mandateId);
      if (!mandate) continue;

      if (mandate.status === "REVOKED") {
        continue;
      }

      // Check if billing window has elapsed
      if (chainTimestamp >= invoice.windowEnd) {
        this.store.updateInvoice(invoice.mandateId, invoice.billingPeriod, {
          state: "MISSED",
        });
        results.push({
          invoiceKey: invKey,
          status: "MISSED",
          reason: `Billing window closed at ${invoice.windowEnd} (current block time ${chainTimestamp})`,
        });
        continue;
      }

      // Check if period is not yet due
      if (chainTimestamp < invoice.dueTime) {
        continue;
      }

      // Check on-chain if already settled (reconcile before sending)
      try {
        const onChainSettled = await this.smartMandate.isSettled(invoice.mandateId, invoice.billingPeriod);
        if (onChainSettled) {
          this.store.updateInvoice(invoice.mandateId, invoice.billingPeriod, {
            state: "SETTLED",
            settledAt: chainTimestamp,
          });
          continue;
        }
      } catch (err) {
        // Contract query error, ignore and continue
      }

      // Prevent duplicate concurrent submission
      if (this.pendingInvoices.has(invKey)) {
        continue;
      }

      // Check subscriber token balance and allowance
      let canCharge = true;
      let failureReason = null;

      if (this.demoToken) {
        try {
          const reqAmount = BigInt(invoice.amount);
          const balance = await this.demoToken.balanceOf(mandate.subscriber);
          const allowance = await this.demoToken.allowance(
            mandate.subscriber,
            this.smartMandate.target || this.smartMandate.address
          );

          if (balance < reqAmount) {
            canCharge = false;
            failureReason = `Insufficient balance: required ${reqAmount}, available ${balance}`;
          } else if (allowance < reqAmount) {
            canCharge = false;
            failureReason = `Insufficient allowance: required ${reqAmount}, approved ${allowance}`;
          }
        } catch (err) {
          console.warn(`[ChargeWorker] Pre-flight token check failed for ${invKey}:`, err.message);
        }
      }

      if (!canCharge) {
        // Record failed attempt, keep invoice OPEN for bounded retry within window
        this.store.recordAttempt({
          mandateId: invoice.mandateId,
          billingPeriod: invoice.billingPeriod,
          state: "FAILED",
          errorReason: failureReason,
          caller: await this.signer.getAddress(),
        });

        // Trigger Phase 4 Sandbox Bank Balance Fallback if insufficient balance
        await this._handleBankFallback(invoice.mandateId, invoice.billingPeriod, mandate.subscriber, failureReason, chainTimestamp);

        results.push({
          invoiceKey: invKey,
          status: "FAILED",
          reason: failureReason,
        });
        continue;
      }

      eligibleForCharge.push(invoice);
    }

    if (eligibleForCharge.length === 0) {
      return results;
    }

    const keeperAddress = await this.signer.getAddress();

    // ─────────────────────────────────────────────────────────────────────────
    // Execution Branch: Batch vs Single Charge
    // ─────────────────────────────────────────────────────────────────────────
    if (this.useBatch && eligibleForCharge.length > 1) {
      for (let i = 0; i < eligibleForCharge.length; i += this.maxBatchSize) {
        const batchSlice = eligibleForCharge.slice(i, i + this.maxBatchSize);
        const batchItems = batchSlice.map((inv) => ({
          mandateId: inv.mandateId,
          billingPeriod: inv.billingPeriod,
        }));

        batchSlice.forEach((inv) => {
          this.pendingInvoices.add(inv.invoiceKey);
          this.store.updateInvoice(inv.mandateId, inv.billingPeriod, { state: "PENDING" });
        });

        try {
          const tx = await this.smartMandate.chargeBatch(batchItems);
          batchSlice.forEach((inv) => {
            this.store.recordAttempt({
              mandateId: inv.mandateId,
              billingPeriod: inv.billingPeriod,
              state: "SUBMITTED",
              txHash: tx.hash,
              caller: keeperAddress,
            });
          });

          const receipt = await tx.wait();

          const paidEventsInReceipt = receipt.logs
            .map((log) => {
              try {
                return this.smartMandate.interface.parseLog(log);
              } catch (_) {
                return null;
              }
            })
            .filter((p) => p && p.name === "ChargePaid");

          const settledKeySet = new Set(
            paidEventsInReceipt.map((p) => `${p.args.mandateId.toLowerCase()}:${Number(p.args.billingPeriod)}`)
          );

          const failedEventsInReceipt = receipt.logs
            .map((log) => {
              try {
                return this.smartMandate.interface.parseLog(log);
              } catch (_) {
                return null;
              }
            })
            .filter((p) => p && p.name === "BatchChargeAttemptFailed");

          const failedMap = new Map();
          failedEventsInReceipt.forEach((f) => {
            const key = `${f.args.mandateId.toLowerCase()}:${Number(f.args.billingPeriod)}`;
            failedMap.set(key, this._parseRevertReason(f.args.revertReason));
          });

          for (const inv of batchSlice) {
            const key = inv.invoiceKey;
            const mandate = this.store.getMandate(inv.mandateId);
            if (settledKeySet.has(key)) {
              this.store.updateInvoice(inv.mandateId, inv.billingPeriod, {
                state: "SETTLED",
                settledAt: chainTimestamp,
                txHash: receipt.hash || tx.hash,
              });
              this.store.recordAttempt({
                mandateId: inv.mandateId,
                billingPeriod: inv.billingPeriod,
                state: "CONFIRMED",
                txHash: receipt.hash || tx.hash,
                caller: keeperAddress,
              });
              results.push({
                invoiceKey: key,
                status: "SETTLED",
                txHash: receipt.hash || tx.hash,
              });
            } else {
              const failureReason = failedMap.get(key) || "Batch charge item failed on-chain";
              this.store.updateInvoice(inv.mandateId, inv.billingPeriod, {
                state: "OPEN",
              });
              this.store.recordAttempt({
                mandateId: inv.mandateId,
                billingPeriod: inv.billingPeriod,
                state: "FAILED",
                txHash: receipt.hash || tx.hash,
                errorReason: failureReason,
                caller: keeperAddress,
              });

              if (mandate) {
                await this._handleBankFallback(inv.mandateId, inv.billingPeriod, mandate.subscriber, failureReason, chainTimestamp);
              }

              results.push({
                invoiceKey: key,
                status: "FAILED",
                reason: failureReason,
                txHash: receipt.hash || tx.hash,
              });
            }
          }
        } catch (err) {
          let revertReason = err.shortMessage || err.reason || err.message;
          for (const inv of batchSlice) {
            const mandate = this.store.getMandate(inv.mandateId);
            this.store.updateInvoice(inv.mandateId, inv.billingPeriod, { state: "OPEN" });
            this.store.recordAttempt({
              mandateId: inv.mandateId,
              billingPeriod: inv.billingPeriod,
              state: "FAILED",
              errorReason: revertReason,
              caller: keeperAddress,
            });
            if (mandate) {
              await this._handleBankFallback(inv.mandateId, inv.billingPeriod, mandate.subscriber, revertReason, chainTimestamp);
            }
            results.push({
              invoiceKey: inv.invoiceKey,
              status: "FAILED",
              reason: revertReason,
            });
          }
        } finally {
          batchSlice.forEach((inv) => this.pendingInvoices.delete(inv.invoiceKey));
        }
      }
    } else {
      // Single charge execution path
      for (const invoice of eligibleForCharge) {
        const invKey = invoice.invoiceKey;
        const mandate = this.store.getMandate(invoice.mandateId);
        this.pendingInvoices.add(invKey);
        this.store.updateInvoice(invoice.mandateId, invoice.billingPeriod, {
          state: "PENDING",
        });

        try {
          const tx = await this.smartMandate.charge(invoice.mandateId, invoice.billingPeriod);
          this.store.recordAttempt({
            mandateId: invoice.mandateId,
            billingPeriod: invoice.billingPeriod,
            state: "SUBMITTED",
            txHash: tx.hash,
            caller: keeperAddress,
          });

          const receipt = await tx.wait();

          if (receipt && receipt.status === 1) {
            this.store.updateInvoice(invoice.mandateId, invoice.billingPeriod, {
              state: "SETTLED",
              settledAt: chainTimestamp,
              txHash: receipt.hash || tx.hash,
            });

            this.store.recordAttempt({
              mandateId: invoice.mandateId,
              billingPeriod: invoice.billingPeriod,
              state: "CONFIRMED",
              txHash: receipt.hash || tx.hash,
              caller: keeperAddress,
            });

            results.push({
              invoiceKey: invKey,
              status: "SETTLED",
              txHash: receipt.hash || tx.hash,
            });
          } else {
            this.store.updateInvoice(invoice.mandateId, invoice.billingPeriod, {
              state: "OPEN",
            });

            this.store.recordAttempt({
              mandateId: invoice.mandateId,
              billingPeriod: invoice.billingPeriod,
              state: "REVERTED",
              txHash: tx.hash,
              errorReason: "Transaction mined with status 0x0",
              caller: keeperAddress,
            });

            results.push({
              invoiceKey: invKey,
              status: "REVERTED",
              txHash: tx.hash,
            });
          }
        } catch (err) {
          let revertReason = err.shortMessage || err.reason || err.message;
          if (err.data) {
            try {
              const decodedError = this.smartMandate.interface.parseError(err.data);
              if (decodedError) revertReason = decodedError.name;
            } catch (_) {}
          }

          this.store.updateInvoice(invoice.mandateId, invoice.billingPeriod, {
            state: "OPEN",
          });

          this.store.recordAttempt({
            mandateId: invoice.mandateId,
            billingPeriod: invoice.billingPeriod,
            state: "FAILED",
            errorReason: revertReason,
            caller: keeperAddress,
          });

          if (mandate) {
            await this._handleBankFallback(invoice.mandateId, invoice.billingPeriod, mandate.subscriber, revertReason, chainTimestamp);
          }

          results.push({
            invoiceKey: invKey,
            status: "FAILED",
            reason: revertReason,
          });
        } finally {
          this.pendingInvoices.delete(invKey);
        }
      }
    }

    return results;
  }

  /**
   * Run one complete tick:
   * 1. Synchronize on-chain events (new mandates, payments, revocations)
   * 2. Evaluate and charge due invoices
   */
  async runOnce() {
    if (this.isTicking) {
      return { skipped: true, reason: "Tick already in progress" };
    }

    this.isTicking = true;
    try {
      const latestBlockNumber = await this.provider.getBlockNumber();
      await this.syncEvents(latestBlockNumber);
      const results = await this.processInvoices();
      return { success: true, processedBlock: latestBlockNumber, results };
    } finally {
      this.isTicking = false;
    }
  }

  /**
   * Start daemon polling
   */
  start() {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      try {
        await this.runOnce();
      } catch (err) {
        console.error("[ChargeWorker] Daemon tick error:", err.message);
      }
    }, this.pollIntervalMs);
  }

  /**
   * Stop daemon polling
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = ChargeWorker;
