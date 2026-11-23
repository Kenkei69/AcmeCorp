/**
 * frontend/qr/generateLink.js
 *
 * Generates dynamic QR checkout links and requests for Project 10 (Phase 2).
 * Encodes billing parameters and generates short-lived, opaque request sessions.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const QRCode = require("./qrcode.js");

function loadContractsConfig() {
  const isSepolia = process.env.NETWORK === "sepolia" || process.env.CHAIN_ID === "11155111";
  const fileName = isSepolia ? "contracts-sepolia.json" : "contracts.json";
  const configPath = path.join(__dirname, "..", fileName);
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
  // Fallback defaults matching Phase 0 / Phase 1 fixtures
  return {
    network: {
      chainId: 31337,
      rpcUrl: "http://127.0.0.1:8545",
      lanRpcUrl: "http://172.16.144.149:8545",
    },
    contracts: {
      DemoToken: { address: "0x5FbDB2315678afecb367f032d93F642f64180aa3" },
      SmartMandate: { address: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" },
    },
    demoDefaults: {
      merchantName: "AcmeCorp Subscription Services",
      merchantAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      tokenAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      tokenSymbol: "DEMO",
      tokenDecimals: 18,
      chargeAmount: "5000000000000000000",
      chargeAmountFormatted: "5 DEMO",
      interval: 120,
      maxCharges: 3,
      allowanceCap: "15000000000000000000",
      allowanceCapFormatted: "15 DEMO",
    },
  };
}

/**
 * Creates a fresh, short-lived checkout session with an opaque request ID.
 * @param {Object} options Optional overrides for testing
 */
function createCheckoutSession(options = {}) {
  const config = loadContractsConfig();
  const requestId = "req_" + crypto.randomBytes(12).toString("hex");

  const nowSec = Math.floor(Date.now() / 1000);
  const checkoutTtlSec = options.ttlSec || 15 * 60; // 15-minute validity for the QR link
  const checkoutExpiresAt = nowSec + checkoutTtlSec;

  // Timestamps for the mandate anchored to firstDueTime
  const firstDueTime = options.firstDueTime || (nowSec + 120); // Opens 2 mins from now
  const signingDeadline = options.signingDeadline || firstDueTime;
  const mandateExpiry = options.mandateExpiry || (firstDueTime + 3600); // 1 hour validity

  const session = {
    requestId,
    createdAt: nowSec,
    checkoutExpiresAt,
    isExpired: false,
    plan: {
      merchantName: config.demoDefaults.merchantName,
      merchantAddress: options.merchantAddress || config.demoDefaults.merchantAddress,
      payoutAddress: options.merchantAddress || config.demoDefaults.merchantAddress,
      tokenAddress: options.tokenAddress || config.demoDefaults.tokenAddress,
      tokenSymbol: config.demoDefaults.tokenSymbol || "DEMO",
      tokenDecimals: config.demoDefaults.tokenDecimals || 18,
      chargeAmount: options.chargeAmount || config.demoDefaults.chargeAmount,
      chargeAmountFormatted: options.chargeAmountFormatted || config.demoDefaults.chargeAmountFormatted,
      interval: options.interval || config.demoDefaults.interval,
      maxCharges: options.maxCharges || config.demoDefaults.maxCharges,
      allowanceCap: options.allowanceCap || config.demoDefaults.allowanceCap,
      allowanceCapFormatted: options.allowanceCapFormatted || config.demoDefaults.allowanceCapFormatted,
      firstDueTime,
      signingDeadline,
      expiry: mandateExpiry,
    },
    network: {
      chainId: config.network.chainId,
      smartMandateAddress: config.contracts.SmartMandate.address,
      lanRpcUrl: config.network.lanRpcUrl,
      localRpcUrl: config.network.rpcUrl,
    },
  };

  return session;
}

/**
 * Builds the checkout URL for a given host and request ID.
 */
function buildCheckoutUrl(host, port, requestId) {
  const baseHost = host || "127.0.0.1";
  const basePort = port ? `:${port}` : "";
  return `http://${baseHost}${basePort}/checkout?request=${requestId}`;
}

/**
 * Generates an SVG QR code for a given URL.
 */
function generateQRSvg(url) {
  const qr = QRCode.create(url, "M");
  return qr.toSVG(6, 4);
}

module.exports = {
  createCheckoutSession,
  buildCheckoutUrl,
  generateQRSvg,
  loadContractsConfig,
};

if (require.main === module) {
  const session = createCheckoutSession();
  const url = buildCheckoutUrl("172.16.144.149", 3000, session.requestId);
  console.log("=== Generated Dynamic Checkout Session ===");
  console.log("Request ID:", session.requestId);
  console.log("Checkout URL:", url);
  console.log("Expires At:", new Date(session.checkoutExpiresAt * 1000).toISOString());
  console.log("Plan Terms:", `${session.plan.chargeAmountFormatted} every ${session.plan.interval}s, max ${session.plan.allowanceCapFormatted}`);
}
