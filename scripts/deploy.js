/**
 * scripts/deploy.js
 *
 * Local & testnet deployment script for Project 10 (Phase 2).
 * Deploys DemoToken and SmartMandate, mints demo tokens to test accounts,
 * and exports addresses + ABIs to frontend/contracts.json.
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("=== Deploying Project 10 Contracts (Phase 2) ===");

  const [deployer, merchant, subscriber] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Merchant (AcmeCorp):", merchant ? merchant.address : "N/A");
  console.log("Subscriber:", subscriber ? subscriber.address : "N/A");

  // 1. Deploy DemoToken
  console.log("\n1. Deploying DemoToken...");
  const DemoToken = await ethers.getContractFactory("DemoToken");
  const token = await DemoToken.deploy();
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log("   DemoToken deployed at:", tokenAddress);

  // 2. Deploy SmartMandate
  console.log("\n2. Deploying SmartMandate...");
  const SmartMandate = await ethers.getContractFactory("SmartMandate");
  const mandate = await SmartMandate.deploy();
  await mandate.waitForDeployment();
  const mandateAddress = await mandate.getAddress();
  console.log("   SmartMandate deployed at:", mandateAddress);

  // 3. Fund accounts with DemoToken for testing (100 DEMO each)
  const mintAmount = ethers.parseUnits("100", 18);
  if (subscriber) {
    console.log(`\n3. Minting 100 DEMO to subscriber (${subscriber.address})...`);
    const mintTx = await token.mint(subscriber.address, mintAmount);
    await mintTx.wait();
    console.log("   Minted successfully. Balance:", ethers.formatUnits(await token.balanceOf(subscriber.address), 18), "DEMO");
  }

  // 4. Export configuration for frontend & server
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const blockNumber = await ethers.provider.getBlockNumber();

  const deploymentData = {
    network: {
      name: network.name === "unknown" ? "hardhat" : network.name,
      chainId: chainId,
      rpcUrl: "http://127.0.0.1:8545",
      lanRpcUrl: "http://172.16.144.149:8545",
      deploymentBlock: blockNumber,
    },
    contracts: {
      DemoToken: {
        address: tokenAddress,
        abi: JSON.parse(DemoToken.interface.formatJson()),
      },
      SmartMandate: {
        address: mandateAddress,
        abi: JSON.parse(SmartMandate.interface.formatJson()),
      },
    },
    demoDefaults: {
      merchantName: "AcmeCorp Subscription Services",
      merchantAddress: merchant ? merchant.address : "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      tokenAddress: tokenAddress,
      tokenSymbol: "DEMO",
      tokenDecimals: 18,
      chargeAmount: "5000000000000000000",      // 5 DEMO
      chargeAmountFormatted: "5 DEMO",
      interval: 120,                           // 120 seconds
      maxCharges: 3,
      allowanceCap: "15000000000000000000",    // 15 DEMO
      allowanceCapFormatted: "15 DEMO",
    },
  };

  const outDir = path.join(__dirname, "..", "frontend");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outFile = path.join(outDir, "contracts.json");
  fs.writeFileSync(outFile, JSON.stringify(deploymentData, null, 2), "utf8");
  console.log("\n4. Exported deployment artifact to:", outFile);

  console.log("\n=== Deployment Completed Successfully ===");
  return deploymentData;
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = main;
