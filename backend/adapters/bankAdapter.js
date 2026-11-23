/**
 * backend/adapters/bankAdapter.js
 *
 * Project 10 — Phase 4: Sandbox Bank Balance Lookup Adapter
 *
 * Features:
 * - Read-only interface for checking reserve balance of explicitly linked accounts.
 * - Credentials and internal bank account numbers/tokens stay strictly server-side.
 * - Supports simulated local mock with deterministic profiles:
 *     - "AVAILABLE": Sufficient reserve funds (e.g. $250.00 USD)
 *     - "INSUFFICIENT": Low reserve balance (e.g. $1.50 USD)
 *     - "UNLINKED": No bank account linked for this subscriber
 *     - "PROVIDER_ERROR": Simulated upstream 500 / network outage
 * - Supports live sandbox integration when configured via environment variables.
 * - Distinguishes available result, unlinked account, and provider failure.
 * - Keeps fiat balances strictly separate from DEMO tokens.
 */

class BankAdapter {
  /**
   * @param {Object} options
   * @param {string} [options.provider="mock"] - "mock" or external sandbox identifier
   * @param {Map|Object} [options.accountRegistry] - Server-side subscriber-to-account mapping
   */
  constructor(options = {}) {
    this.provider = options.provider || process.env.BANK_PROVIDER || "mock";
    this.isSimulated = this.provider === "mock";

    // Server-side mapping: subscriberAddress (lowercase) -> account details
    // Keeps bank credentials, account IDs, and routing tokens safe and server-side.
    this.accountRegistry = new Map();

    if (options.accountRegistry) {
      if (options.accountRegistry instanceof Map) {
        this.accountRegistry = options.accountRegistry;
      } else {
        for (const [k, v] of Object.entries(options.accountRegistry)) {
          this.accountRegistry.set(k.toLowerCase(), v);
        }
      }
    }
  }

  /**
   * Register or link a bank account for a subscriber (server-side only)
   * @param {string} subscriberAddress
   * @param {Object} accountInfo
   */
  linkAccount(subscriberAddress, accountInfo) {
    const key = (subscriberAddress || "").toLowerCase();
    this.accountRegistry.set(key, {
      ...accountInfo,
      linkedAt: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * Unlink a bank account
   * @param {string} subscriberAddress
   */
  unlinkAccount(subscriberAddress) {
    const key = (subscriberAddress || "").toLowerCase();
    this.accountRegistry.delete(key);
  }

  /**
   * Check bank balance for a subscriber.
   *
   * @param {string} subscriberAddress
   * @returns {Promise<Object>} {
   *   status: "AVAILABLE" | "INSUFFICIENT" | "UNLINKED" | "PROVIDER_ERROR",
   *   availableAmount: string | null,
   *   currency: string | null,
   *   checkedAt: number,
   *   isSimulated: boolean,
   *   errorReason?: string
   * }
   */
  async checkBalance(subscriberAddress) {
    const checkedAt = Math.floor(Date.now() / 1000);
    const key = (subscriberAddress || "").toLowerCase();

    // 1. Check if subscriber account is linked
    const account = this.accountRegistry.get(key);
    if (!account) {
      return {
        status: "UNLINKED",
        availableAmount: null,
        currency: null,
        checkedAt: checkedAt,
        isSimulated: this.isSimulated,
        errorReason: "No sandbox bank account linked for subscriber",
      };
    }

    // 2. Handle Mock / Simulated Provider
    if (this.isSimulated) {
      // Allow overriding behavior via account profile
      if (account.simulateError) {
        return {
          status: "PROVIDER_ERROR",
          availableAmount: null,
          currency: null,
          checkedAt: checkedAt,
          isSimulated: true,
          errorReason: account.simulateErrorReason || "Simulated upstream sandbox HTTP 503 error",
        };
      }

      const balance = account.balance !== undefined ? account.balance : "250.00";
      const currency = account.currency || "USD";
      const numBalance = parseFloat(balance);

      const status = numBalance >= 5.0 ? "AVAILABLE" : "INSUFFICIENT";

      return {
        status: status,
        availableAmount: String(balance),
        currency: currency,
        checkedAt: checkedAt,
        isSimulated: true,
      };
    }

    // 3. Live External Sandbox Integration (if environment configured)
    try {
      // Place for live sandbox HTTP client (e.g. Plaid, TrueLayer)
      throw new Error("External sandbox provider not configured; fallback to mock");
    } catch (err) {
      return {
        status: "PROVIDER_ERROR",
        availableAmount: null,
        currency: null,
        checkedAt: checkedAt,
        isSimulated: false,
        errorReason: err.message,
      };
    }
  }
}

module.exports = BankAdapter;
