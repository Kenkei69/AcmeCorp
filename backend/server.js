/**
 * backend/server.js
 *
 * Project 10 — Phase 2 & Phase 3A Merchant, Checkout & Worker Web Server.
 * Zero-dependency native Node.js HTTP server.
 * Serves the Merchant QR Portal, Mobile Checkout Page, Subscriber Portal,
 * and exposes Phase 3A persistent invoice history and worker trigger endpoints.
 */

const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const {
  createCheckoutSession,
  loadContractsConfig,
  isValidPayoutAddress,
  isLoopbackUrl,
  getCheckoutBaseUrl,
  buildCheckoutUrl,
} = require("../frontend/qr/generateLink.js");
const BillingStore = require("./store/billingStore");
const ChargeWorker = require("./chargeWorker");
const BankAdapter = require("./adapters/bankAdapter");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const LAN_IP = "172.16.144.149";

// Shared BankAdapter instance
const bankAdapter = new BankAdapter({
  provider: "mock",
  accountRegistry: {
    // Pre-link default demo subscriber (Hardhat account #2) with $250.00 USD
    "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc": {
      accountName: "Demo Checking (...4821)",
      balance: "250.00",
      currency: "USD",
    },
  },
});

// In-memory checkout request store: requestId -> session
const activeSessions = new Map();

// Helper to send JSON responses
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

// Helper to serve files
function serveStaticFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
    return;
  }
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(content);
}

// Initialize BillingStore and optional ChargeWorker
let globalStore = null;
let globalWorker = null;

function getStore() {
  if (!globalStore) {
    const config = loadContractsConfig();
    const contractAddr = config.contracts.SmartMandate.address;
    const deploymentBlock = config.contracts.SmartMandate.deploymentBlock || 0;
    globalStore = new BillingStore({
      chainId: config.network.chainId || 31337,
      contractAddress: contractAddr,
      deploymentBlock: deploymentBlock,
    });
  }
  return globalStore;
}

function getWorker() {
  if (!globalWorker) {
    const config = loadContractsConfig();
    const rpcUrl = config.network.rpcUrl || "http://127.0.0.1:8545";
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    // Use dedicated keeper private key from environment or fallback to Hardhat account #3
    const keeperPrivateKey = process.env.KEEPER_PRIVATE_KEY || "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
    const signer = new ethers.Wallet(keeperPrivateKey, provider);

    const smartMandate = new ethers.Contract(
      config.contracts.SmartMandate.address,
      config.contracts.SmartMandate.abi,
      signer
    );
    const demoToken = new ethers.Contract(
      config.contracts.DemoToken.address,
      config.contracts.DemoToken.abi,
      signer
    );

    const store = getStore();
    globalWorker = new ChargeWorker({
      provider: provider,
      signer: signer,
      smartMandate: smartMandate,
      demoToken: demoToken,
      store: store,
      bankAdapter: bankAdapter,
      deploymentBlock: config.contracts.SmartMandate.deploymentBlock || 0,
      pollIntervalMs: 3000,
    });
  }
  return globalWorker;
}

// Faucet helper to mint test tokens via local Hardhat JSON-RPC
async function mintTokensToAddress(recipientAddress, amountUnits = "15000000000000000000") {
  const config = loadContractsConfig();
  const tokenAddress = config.contracts.DemoToken.address;
  const rpcUrl = config.network.rpcUrl || "http://127.0.0.1:8545";

  const cleanAddr = recipientAddress.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const hexAmount = BigInt(amountUnits).toString(16).padStart(64, "0");
  const calldata = "0x40c10f19" + cleanAddr + hexAmount;

  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendTransaction",
    params: [
      {
        from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        to: tokenAddress,
        data: calldata,
      },
    ],
  };

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = await response.json();
  if (json.error) {
    throw new Error(json.error.message || JSON.stringify(json.error));
  }
  return json.result; // tx hash
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Handle CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  try {
    // 1. API: Create New Checkout Session
    if (pathname === "/api/checkout/new" && method === "POST") {
      try {
        const session = createCheckoutSession();
        activeSessions.set(session.requestId, session);
        console.log(`[API] Created session ${session.requestId} (expires in 15 mins)`);
        sendJson(res, 200, session);
      } catch (err) {
        console.error("Failed to create checkout session:", err.message);
        if (err.code === "INVALID_MERCHANT_ADDRESS") {
          sendJson(res, 400, {
            error: "Merchant payout address is missing or invalid (cannot be zero address). Set MERCHANT_ADDRESS in .env.",
            code: "INVALID_MERCHANT_ADDRESS",
          });
          return;
        }
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    // 2. API: Fetch Checkout Session by Request ID
    if (pathname.startsWith("/api/checkout/") && method === "GET") {
      const requestId = pathname.split("/api/checkout/")[1];
      const session = activeSessions.get(requestId);

      if (!session) {
        sendJson(res, 404, { error: "Session not found" });
        return;
      }

      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec > session.checkoutExpiresAt) {
        session.isExpired = true;
        sendJson(res, 410, { error: "Checkout session expired", session });
        return;
      }

      sendJson(res, 200, session);
      return;
    }

    // 3. API: Contracts Configuration & ABIs
    if (pathname === "/api/contracts" && method === "GET") {
      const config = loadContractsConfig();
      sendJson(res, 200, config);
      return;
    }

    // 4. API: Local Faucet Minting (Disabled in Sepolia mode)
    if (pathname === "/api/faucet" && method === "POST") {
      const isSepolia = process.env.NETWORK === "sepolia" || process.env.CHAIN_ID === "11155111";
      if (isSepolia) {
        sendJson(res, 403, { error: "Public faucet is disabled in Sepolia network mode. Tokens are distributed by authorized operator." });
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const recipient = parsed.recipient;
          if (!recipient) {
            sendJson(res, 400, { error: "Missing recipient address" });
            return;
          }
          const txHash = await mintTokensToAddress(recipient);
          sendJson(res, 200, { success: true, txHash, recipient, amount: "15 DEMO" });
        } catch (err) {
          console.error("Faucet error:", err);
          sendJson(res, 500, { error: err.message });
        }
      });
      return;
    }

    // 5. API: Dynamic Network info
    if (pathname === "/api/network" && method === "GET") {
      const config = loadContractsConfig();
      const isSepolia = config.network.chainId === 11155111 || process.env.NETWORK === "sepolia";
      const baseUrl = getCheckoutBaseUrl();
      const loopback = baseUrl ? isLoopbackUrl(baseUrl) : null;
      sendJson(res, 200, {
        chainId: config.network.chainId,
        name: config.network.name || (isSepolia ? "Sepolia" : "Hardhat Local"),
        rpcUrl: config.network.rpcUrl,
        lanRpc: config.network.lanRpcUrl || config.network.rpcUrl,
        explorerUrl: config.network.explorerUrl || (isSepolia ? "https://sepolia.etherscan.io" : ""),
        lanHost: LAN_IP,
        checkoutBaseUrl: baseUrl,
        isPhoneQrDisabled: !baseUrl || loopback,
        phoneQrDisabledReason: !baseUrl
          ? "No phone-reachable CHECKOUT_BASE_URL configured in .env."
          : loopback
          ? "CHECKOUT_BASE_URL is set to a loopback address (localhost / 127.0.0.1). Phones cannot connect to loopback."
          : null,
      });
      return;
    }

    // 6. Phase 3A API: Get All Invoices & Billing History
    if (pathname === "/api/invoices" && method === "GET") {
      const store = getStore();
      const invoices = store.getAllInvoices();
      const mandates = store.getAllMandates();
      const cursor = store.getCursor();
      sendJson(res, 200, { invoices, mandates, cursor });
      return;
    }

    // 7. Phase 3A API: Trigger One Worker Tick (Disabled in Sepolia mode)
    if (pathname === "/api/worker/tick" && method === "POST") {
      const isSepolia = process.env.NETWORK === "sepolia" || process.env.CHAIN_ID === "11155111";
      if (isSepolia) {
        sendJson(res, 403, { error: "Manual worker tick endpoint is disabled in Sepolia mode. Background daemon executes scheduled ticks." });
        return;
      }
      try {
        const worker = getWorker();
        const tickResult = await worker.runOnce();
        sendJson(res, 200, tickResult);
      } catch (err) {
        console.error("Worker tick error:", err);
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    // 8. Static Pages
    if (pathname === "/" || pathname === "/merchant") {
      serveStaticFile(res, path.join(__dirname, "..", "frontend", "index.html"), "text/html");
      return;
    }

    if (pathname === "/checkout") {
      serveStaticFile(res, path.join(__dirname, "..", "frontend", "checkout.html"), "text/html");
      return;
    }

    if (pathname === "/subscriber") {
      serveStaticFile(res, path.join(__dirname, "..", "frontend", "subscriber.html"), "text/html");
      return;
    }

    if (pathname === "/qr/qrcode.js") {
      serveStaticFile(res, path.join(__dirname, "..", "frontend", "qr", "qrcode.js"), "application/javascript");
      return;
    }

    // Default 404
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
  } catch (err) {
    console.error("Server error:", err);
    sendJson(res, 500, { error: "Internal Server Error", details: err.message });
  }
});

function startServer(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, HOST, () => {
      console.log(`\n======================================================`);
      console.log(`🚀 Project 10 — Phase 2 & 3A Server running on:`);
      console.log(`   • Merchant Portal: http://127.0.0.1:${port}/`);
      console.log(`   • Mobile LAN URL:  http://${LAN_IP}:${port}/`);
      console.log(`   • Subscriber View: http://${LAN_IP}:${port}/subscriber`);
      console.log(`======================================================\n`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { server, startServer, activeSessions, getStore, getWorker };
