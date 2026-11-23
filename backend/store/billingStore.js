/**
 * backend/store/billingStore.js
 *
 * Local JSON-backed persistence store for Phase 3A:
 * - Scoped by chainId and smartMandate contract address
 * - Stores discovered mandates, invoice statuses, payment attempts, and event scan cursor
 * - Survives worker and server restarts
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_STORE_DIR = path.join(__dirname, "..", "..", "data");

class BillingStore {
  constructor(options = {}) {
    this.chainId = options.chainId || 31337;
    this.contractAddress = (options.contractAddress || "").toLowerCase();
    this.storeDir = options.storeDir || DEFAULT_STORE_DIR;
    this.filePath = options.filePath || path.join(
      this.storeDir,
      `billing-${this.chainId}-${this.contractAddress.slice(0, 10)}.json`
    );

    this.state = {
      chainId: this.chainId,
      contractAddress: this.contractAddress,
      cursor: {
        lastScannedBlock: options.deploymentBlock !== undefined ? options.deploymentBlock : 0,
        lastScannedTimestamp: 0,
      },
      mandates: {}, // mandateId -> mandateDetails
      invoices: {}, // `${mandateId}:${billingPeriod}` -> invoiceRecord
      attempts: [], // array of attempt records
    };

    this.init();
  }

  init() {
    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true });
    }
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, "utf8");
        const loaded = JSON.parse(raw);
        if (loaded && loaded.chainId === this.chainId) {
          this.state = Object.assign(this.state, loaded);
        }
      } catch (err) {
        console.warn(`[BillingStore] Could not read existing store from ${this.filePath}, initializing fresh.`, err.message);
      }
    } else {
      this.save();
    }
  }

  save() {
    const tmpPath = `${this.filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }

  getCursor() {
    return { ...this.state.cursor };
  }

  updateCursor(blockNumber, timestamp = 0) {
    if (blockNumber > this.state.cursor.lastScannedBlock) {
      this.state.cursor.lastScannedBlock = blockNumber;
    }
    if (timestamp > this.state.cursor.lastScannedTimestamp) {
      this.state.cursor.lastScannedTimestamp = timestamp;
    }
    this.save();
  }

  // Mandate management
  saveMandate(mandate) {
    const id = mandate.mandateId.toLowerCase();
    const existing = this.state.mandates[id] || {};
    this.state.mandates[id] = {
      ...existing,
      ...mandate,
      mandateId: id,
      subscriber: (mandate.subscriber || existing.subscriber || "").toLowerCase(),
      merchant: (mandate.merchant || existing.merchant || "").toLowerCase(),
      token: (mandate.token || existing.token || "").toLowerCase(),
      amount: String(mandate.amount || existing.amount || "0"),
      interval: Number(mandate.interval || existing.interval || 0),
      firstDueTime: Number(mandate.firstDueTime || existing.firstDueTime || 0),
      maxCharges: Number(mandate.maxCharges || existing.maxCharges || 0),
      expiry: Number(mandate.expiry || existing.expiry || 0),
      status: mandate.status || existing.status || "ACTIVE", // ACTIVE, REVOKED, COMPLETED
    };

    // Auto-create blank invoices for all billing periods if not present
    const max = Number(this.state.mandates[id].maxCharges);
    const firstDue = Number(this.state.mandates[id].firstDueTime);
    const interval = Number(this.state.mandates[id].interval);
    const amount = this.state.mandates[id].amount;

    for (let p = 0; p < max; p++) {
      const invKey = `${id}:${p}`;
      if (!this.state.invoices[invKey]) {
        const dueTime = firstDue + p * interval;
        const windowEnd = dueTime + interval;
        this.state.invoices[invKey] = {
          invoiceKey: invKey,
          mandateId: id,
          billingPeriod: p,
          amount: amount,
          dueTime: dueTime,
          windowEnd: windowEnd,
          state: "OPEN", // PENDING, OPEN, SETTLED, MISSED
          settledAt: null,
          txHash: null,
          latestAttempt: null,
        };
      }
    }

    this.save();
    return this.state.mandates[id];
  }

  getMandate(mandateId) {
    return this.state.mandates[(mandateId || "").toLowerCase()] || null;
  }

  getAllMandates() {
    return Object.values(this.state.mandates);
  }

  updateMandateStatus(mandateId, status) {
    const id = (mandateId || "").toLowerCase();
    if (this.state.mandates[id]) {
      this.state.mandates[id].status = status;
      this.save();
    }
  }

  // Invoice management
  getInvoice(mandateId, billingPeriod) {
    const key = `${(mandateId || "").toLowerCase()}:${Number(billingPeriod)}`;
    return this.state.invoices[key] || null;
  }

  getAllInvoices() {
    return Object.values(this.state.invoices).sort((a, b) => a.dueTime - b.dueTime);
  }

  updateInvoice(mandateId, billingPeriod, updates) {
    const key = `${(mandateId || "").toLowerCase()}:${Number(billingPeriod)}`;
    if (!this.state.invoices[key]) {
      const mandate = this.getMandate(mandateId);
      if (mandate) {
        this.saveMandate(mandate);
      } else {
        this.state.invoices[key] = {
          invoiceKey: key,
          mandateId: (mandateId || "").toLowerCase(),
          billingPeriod: Number(billingPeriod),
          amount: "5000000000000000000",
          dueTime: 0,
          windowEnd: 0,
          state: "OPEN",
          settledAt: null,
          txHash: null,
          latestAttempt: null,
        };
      }
    }

    this.state.invoices[key] = {
      ...this.state.invoices[key],
      ...updates,
    };
    this.save();
    return this.state.invoices[key];
  }

  // Record an attempt
  recordAttempt(attempt) {
    const record = {
      id: "att_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
      timestamp: Math.floor(Date.now() / 1000),
      mandateId: (attempt.mandateId || "").toLowerCase(),
      billingPeriod: Number(attempt.billingPeriod),
      state: attempt.state, // SUBMITTED, CONFIRMED, REVERTED, FAILED, BANK_CHECKED
      txHash: attempt.txHash || null,
      errorReason: attempt.errorReason || null,
      bankCheck: attempt.bankCheck || null, // Phase 4: Reserve check details
      caller: (attempt.caller || "").toLowerCase(),
    };

    this.state.attempts.push(record);

    // Keep invoice latestAttempt & latestBankCheck up to date
    const invKey = `${record.mandateId}:${record.billingPeriod}`;
    if (this.state.invoices[invKey]) {
      this.state.invoices[invKey].latestAttempt = {
        state: record.state,
        txHash: record.txHash,
        errorReason: record.errorReason,
        timestamp: record.timestamp,
      };
      if (record.bankCheck) {
        this.state.invoices[invKey].latestBankCheck = record.bankCheck;
      }
      if (record.txHash && !this.state.invoices[invKey].txHash) {
        this.state.invoices[invKey].txHash = record.txHash;
      }
    }

    this.save();
    return record;
  }

  getAttemptsForInvoice(mandateId, billingPeriod) {
    const mid = (mandateId || "").toLowerCase();
    const bp = Number(billingPeriod);
    return this.state.attempts.filter((a) => a.mandateId === mid && a.billingPeriod === bp);
  }
}

module.exports = BillingStore;
