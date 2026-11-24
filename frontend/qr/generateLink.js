/**
 * frontend/qr/generateLink.js
 *
 * Generates dynamic QR checkout links and requests for Project 10 (Phase 2).
 * Encodes billing parameters and generates short-lived, opaque request sessions.
 * Includes merchant payout address validation, phone-reachable base URL handling,
 * loopback address detection, and standard compliant QR code SVG generation.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const QRCode = require("qrcode");
const svgTag = require("qrcode/lib/renderer/svg-tag.js");

function loadContractsConfig() {
  const isSepolia = process.env.NETWORK === "sepolia" || process.env.CHAIN_ID === "11155111";
  const fileName = isSepolia ? "contracts-sepolia.json" : "contracts.json";
  const configPath = path.join(__dirname, "..", fileName);
  if (fs.existsSync(configPath)) {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    // Override merchantAddress from process.env if specified
    if (process.env.MERCHANT_ADDRESS && ethers.isAddress(process.env.MERCHANT_ADDRESS)) {
      raw.demoDefaults = raw.demoDefaults || {};
      raw.demoDefaults.merchantAddress = process.env.MERCHANT_ADDRESS;
    }
    return raw;
  }
  // Fallback defaults matching Phase 0 / Phase 1 fixtures
  return {
    network: {
      chainId: 31337,
      name: "Hardhat Local",
      rpcUrl: "http://127.0.0.1:8545",
      lanRpcUrl: "http://172.16.144.149:8545",
      explorerUrl: "",
    },
    contracts: {
      DemoToken: { address: "0x5FbDB2315678afecb367f032d93F642f64180aa3" },
      SmartMandate: { address: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" },
    },
    demoDefaults: {
      merchantName: "AcmeCorp Subscription Services",
      merchantAddress: process.env.MERCHANT_ADDRESS || "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
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
 * Validates if an address is a valid non-zero Ethereum address.
 * @param {string} address
 * @returns {boolean}
 */
function isValidPayoutAddress(address) {
  if (!address || typeof address !== "string") return false;
  const trimmed = address.trim();
  if (!ethers.isAddress(trimmed)) return false;
  if (trimmed.toLowerCase() === ethers.ZeroAddress.toLowerCase()) return false;
  return true;
}

/**
 * Checks whether a URL points to loopback/localhost.
 * @param {string} urlStr
 * @returns {boolean}
 */
function isLoopbackUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return false;
  try {
    const parsed = new URL(urlStr.includes("://") ? urlStr : `http://${urlStr}`);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".localhost")
    );
  } catch (err) {
    return false;
  }
}

/**
 * Returns configured checkout base URL from environment if present.
 */
function getCheckoutBaseUrl() {
  return process.env.CHECKOUT_BASE_URL || process.env.PHONE_CHECKOUT_BASE_URL || null;
}

/**
 * Builds the checkout URL for a given host/base and request ID.
 * Supports full base URLs (e.g., http://172.16.144.149:3000) or host+port.
 */
function buildCheckoutUrl(hostOrBase, port, requestId) {
  if (!hostOrBase) {
    return `http://127.0.0.1:${port || 3000}/checkout?request=${requestId}`;
  }
  const cleanStr = hostOrBase.trim();
  if (cleanStr.startsWith("http://") || cleanStr.startsWith("https://")) {
    const base = cleanStr.replace(/\/+$/, "");
    return `${base}/checkout?request=${requestId}`;
  }
  const basePort = port ? `:${port}` : "";
  return `http://${cleanStr}${basePort}/checkout?request=${requestId}`;
}

/**
 * Generates an SVG QR code for a given URL using standard QR encoding with error correction.
 */
function generateQRSvg(url) {
  const qrData = QRCode.create(url, { errorCorrectionLevel: "M" });
  return svgTag.render(qrData, { margin: 2 });
}

/**
 * Creates a fresh, short-lived checkout session with an opaque request ID.
 * Validates merchant payout address and configures phone base URL and loopback status.
 * @param {Object} options Optional overrides for testing
 */
function createCheckoutSession(options = {}) {
  const config = loadContractsConfig();
  const requestId = "req_" + crypto.randomBytes(12).toString("hex");

  // Validate merchant payout address
  const merchantPayoutAddress = options.merchantAddress || options.payoutAddress || config.demoDefaults?.merchantAddress;
  if (!isValidPayoutAddress(merchantPayoutAddress)) {
    const err = new Error("Invalid or missing merchant payout address. Must be a valid non-zero Ethereum address. Please configure MERCHANT_ADDRESS in .env.");
    err.code = "INVALID_MERCHANT_ADDRESS";
    throw err;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const checkoutTtlSec = options.ttlSec || 15 * 60; // 15-minute validity for the QR link
  const checkoutExpiresAt = nowSec + checkoutTtlSec;

  // Timestamps for the mandate anchored to firstDueTime
  const firstDueTime = options.firstDueTime || (nowSec + 120); // Opens 2 mins from now
  const signingDeadline = options.signingDeadline || firstDueTime;
  const mandateExpiry = options.mandateExpiry || (firstDueTime + 3600); // 1 hour validity

  // Resolve checkout base URL and phone reachability
  const configuredBaseUrl = options.baseUrl !== undefined ? options.baseUrl : getCheckoutBaseUrl();
  const isLoopback = configuredBaseUrl ? isLoopbackUrl(configuredBaseUrl) : null;
  const isPhoneQrDisabled = !configuredBaseUrl || isLoopback;

  let phoneQrDisabledReason = null;
  if (!configuredBaseUrl) {
    phoneQrDisabledReason = "No phone-reachable CHECKOUT_BASE_URL configured in .env. Mobile phone QR scanning is disabled.";
  } else if (isLoopback) {
    phoneQrDisabledReason = "Checkout base URL is set to loopback (localhost / 127.0.0.1). Mobile phones on Wi-Fi cannot resolve loopback. To enable phone scanning, configure CHECKOUT_BASE_URL in .env with your network IP (e.g., http://172.16.144.149:3000) or tunnel URL.";
  }

  const phoneCheckoutUrl = !isPhoneQrDisabled ? buildCheckoutUrl(configuredBaseUrl, null, requestId) : null;
  let qrSvg = null;
  if (phoneCheckoutUrl) {
    try {
      qrSvg = generateQRSvg(phoneCheckoutUrl);
    } catch (e) {
      console.warn("Failed to generate QR SVG for phoneCheckoutUrl:", e.message);
    }
  }

  const session = {
    requestId,
    createdAt: nowSec,
    checkoutExpiresAt,
    isExpired: false,
    phoneCheckoutBaseUrl: configuredBaseUrl,
    phoneCheckoutUrl,
    isPhoneQrDisabled: !!isPhoneQrDisabled,
    phoneQrDisabledReason,
    qrSvg,
    plan: {
      merchantName: config.demoDefaults.merchantName,
      merchantAddress: merchantPayoutAddress,
      payoutAddress: merchantPayoutAddress,
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
      name: config.network.name || (config.network.chainId === 11155111 ? "Sepolia" : "Hardhat Local"),
      smartMandateAddress: config.contracts.SmartMandate.address,
      lanRpcUrl: config.network.lanRpcUrl || config.network.rpcUrl,
      localRpcUrl: config.network.rpcUrl,
      explorerUrl: config.network.explorerUrl || "",
    },
  };

  return session;
}

module.exports = {
  createCheckoutSession,
  buildCheckoutUrl,
  generateQRSvg,
  loadContractsConfig,
  isValidPayoutAddress,
  isLoopbackUrl,
  getCheckoutBaseUrl,
};

if (require.main === module) {
  try {
    const session = createCheckoutSession();
    const url = buildCheckoutUrl("172.16.144.149", 3000, session.requestId);
    console.log("=== Generated Dynamic Checkout Session ===");
    console.log("Request ID:", session.requestId);
    console.log("Checkout URL:", url);
    console.log("Expires At:", new Date(session.checkoutExpiresAt * 1000).toISOString());
    console.log("Plan Terms:", `${session.plan.chargeAmountFormatted} every ${session.plan.interval}s, max ${session.plan.allowanceCapFormatted}`);
  } catch (err) {
    console.error("Session creation error:", err.message);
  }
}
