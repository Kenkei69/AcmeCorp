/**
 * scripts/deploySepolia.js
 *
 * Dedicated deployment and verification script for Ethereum Sepolia (Chain ID 11155111).
 *
 * Requirements:
 * - Strictly restricted to Sepolia network (chainId 11155111).
 * - Verifies presence of SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, and KEEPER_PRIVATE_KEY.
 * - Verifies deployer and keeper have sufficient Sepolia test ETH for gas.
 * - Deploys DemoToken and SmartMandate.
 * - Mints initial test DEMO tokens via authorized owner/operator.
 * - Exports dedicated sepolia deployment configuration to frontend/contracts-sepolia.json.
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("===============================================================");
  console.log("🚀 Project 10 — Sepolia Testnet Deployment (Phase 5)");
  console.log("===============================================================\n");

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  if (chainId !== 11155111) {
    console.error(`❌ ERROR: This script is strictly restricted to Ethereum Sepolia (Chain ID 11155111).`);
    console.error(`   Current network: ${network.name} (Chain ID: ${chainId})`);
    console.error(`   Run with: npx hardhat run scripts/deploySepolia.js --network sepolia\n`);
    process.exit(1);
  }

  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  const keeperKey = process.env.KEEPER_PRIVATE_KEY;
  const rpcUrl = process.env.SEPOLIA_RPC_URL;

  if (!rpcUrl || !deployerKey || !keeperKey) {
    console.error(`❌ BLOCKER: Missing Sepolia credentials in environment!`);
    console.error(`   Please configure .env based on .env.example:`);
    console.error(`   - SEPOLIA_RPC_URL: ${rpcUrl ? "✓ Configured" : "✗ Missing"}`);
    console.error(`   - DEPLOYER_PRIVATE_KEY: ${deployerKey ? "✓ Configured" : "✗ Missing"}`);
    console.error(`   - KEEPER_PRIVATE_KEY: ${keeperKey ? "✓ Configured" : "✗ Missing"}\n`);
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();
  const keeperWallet = new ethers.Wallet(keeperKey, ethers.provider);

  console.log(`📡 Network Verified: Ethereum Sepolia (Chain ID ${chainId})`);
  console.log(`👤 Deployer Address: ${deployer.address}`);
  console.log(`🤖 Keeper Address:   ${keeperWallet.address}`);

  const deployerBal = await ethers.provider.getBalance(deployer.address);
  const keeperBal = await ethers.provider.getBalance(keeperWallet.address);

  console.log(`💰 Deployer Balance: ${ethers.formatEther(deployerBal)} Sepolia ETH`);
  console.log(`💰 Keeper Balance:   ${ethers.formatEther(keeperBal)} Sepolia ETH\n`);

  if (deployerBal < ethers.parseEther("0.01")) {
    console.error(`❌ BLOCKER: Insufficient test ETH on Deployer account (${deployer.address}).`);
    console.error(`   Minimum 0.01 Sepolia ETH required to deploy contracts.`);
    console.error(`   Fund this address using a Sepolia faucet before proceeding.\n`);
    process.exit(1);
  }

  if (keeperBal < ethers.parseEther("0.005")) {
    console.error(`❌ BLOCKER: Insufficient test ETH on Keeper account (${keeperWallet.address}).`);
    console.error(`   Minimum 0.005 Sepolia ETH required for scheduled gas payments.`);
    console.error(`   Fund this address using a Sepolia faucet before proceeding.\n`);
    process.exit(1);
  }

  const confirmations = Number(process.env.CONFIRMATIONS_REQUIRED || 1);

  // 1. Deploy DemoToken
  console.log(`1. Deploying DemoToken (restricted owner-only minting)...`);
  const DemoToken = await ethers.getContractFactory("DemoToken");
  const token = await DemoToken.deploy();
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  const tokenDeployTx = token.deploymentTransaction();
  const tokenReceipt = await tokenDeployTx.wait(confirmations);
  console.log(`   ✓ DemoToken deployed: ${tokenAddress}`);
  console.log(`   • Tx Hash: ${tokenDeployTx.hash}`);
  console.log(`   • Block:   ${tokenReceipt.blockNumber}\n`);

  // 2. Deploy SmartMandate
  console.log(`2. Deploying SmartMandate (pull payment & batch billing)...`);
  const SmartMandate = await ethers.getContractFactory("SmartMandate");
  const mandateContract = await SmartMandate.deploy();
  await mandateContract.waitForDeployment();
  const mandateAddress = await mandateContract.getAddress();
  const mandateDeployTx = mandateContract.deploymentTransaction();
  const mandateReceipt = await mandateDeployTx.wait(confirmations);
  console.log(`   ✓ SmartMandate deployed: ${mandateAddress}`);
  console.log(`   • Tx Hash: ${mandateDeployTx.hash}`);
  console.log(`   • Block:   ${mandateReceipt.blockNumber}\n`);

  // 3. Fund test subscriber with DemoToken if configured
  const subAddress = process.env.SUBSCRIBER_ADDRESS;
  if (subAddress && ethers.isAddress(subAddress)) {
    console.log(`3. Minting 100 DEMO to subscriber (${subAddress}) via authorized operator...`);
    const mintTx = await token.mint(subAddress, ethers.parseEther("100"));
    await mintTx.wait(confirmations);
    console.log(`   ✓ Minted 100 DEMO to ${subAddress}\n`);
  }

  // 4. Export configuration for frontend & backend
  const merchantAddress = process.env.MERCHANT_ADDRESS || deployer.address;
  const deploymentData = {
    network: {
      name: "sepolia",
      chainId: 11155111,
      rpcUrl: rpcUrl,
      deploymentBlock: mandateReceipt.blockNumber,
      explorerUrl: "https://sepolia.etherscan.io",
      confirmationsRequired: confirmations,
    },
    contracts: {
      DemoToken: {
        address: tokenAddress,
        deploymentTx: tokenDeployTx.hash,
        abi: JSON.parse(DemoToken.interface.formatJson()),
      },
      SmartMandate: {
        address: mandateAddress,
        deploymentTx: mandateDeployTx.hash,
        abi: JSON.parse(SmartMandate.interface.formatJson()),
      },
    },
    demoDefaults: {
      merchantName: "AcmeCorp Subscription Services (Sepolia)",
      merchantAddress: merchantAddress,
      tokenAddress: tokenAddress,
      tokenSymbol: "DEMO",
      tokenDecimals: 18,
      chargeAmount: "5000000000000000000",
      chargeAmountFormatted: "5 DEMO",
      interval: 120, // 2 minutes
      maxCharges: 3,
      allowanceCap: "15000000000000000000",
      allowanceCapFormatted: "15 DEMO",
    },
  };

  const outFile = path.join(__dirname, "..", "frontend", "contracts-sepolia.json");
  fs.writeFileSync(outFile, JSON.stringify(deploymentData, null, 2), "utf8");
  console.log(`4. Saved Sepolia deployment artifacts to: ${outFile}`);

  console.log(`\n===============================================================`);
  console.log(`🎉 Sepolia Deployment Complete!`);
  console.log(`   • DemoToken:    https://sepolia.etherscan.io/address/${tokenAddress}`);
  console.log(`   • SmartMandate:  https://sepolia.etherscan.io/address/${mandateAddress}`);
  console.log(`===============================================================\n`);

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
