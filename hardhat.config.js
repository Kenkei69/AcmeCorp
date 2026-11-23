require("@nomicfoundation/hardhat-toolbox");
const fs = require("fs");
const path = require("path");

// Load .env if present
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf8");
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const idx = trimmed.indexOf("=");
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";
const KEEPER_PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY || "";

const sepoliaAccounts = [];
if (DEPLOYER_PRIVATE_KEY && DEPLOYER_PRIVATE_KEY.startsWith("0x") && DEPLOYER_PRIVATE_KEY.length === 66) {
  sepoliaAccounts.push(DEPLOYER_PRIVATE_KEY);
}
if (KEEPER_PRIVATE_KEY && KEEPER_PRIVATE_KEY.startsWith("0x") && KEEPER_PRIVATE_KEY.length === 66) {
  sepoliaAccounts.push(KEEPER_PRIVATE_KEY);
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      // Allow arbitrary block.timestamp manipulation in tests
      allowBlocksWithSameTimestamp: true,
    },
    sepolia: {
      url: SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts: sepoliaAccounts.length > 0 ? sepoliaAccounts : undefined,
    },
  },
};
