/**
 * scripts/checkSepoliaPreflight.js
 *
 * Checks Sepolia RPC connectivity, Chain ID 11155111, and test ETH balances
 * without exposing private keys or RPC credentials in console logs.
 */

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

async function main() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) {
    console.log(JSON.stringify({ error: ".env file missing" }));
    return;
  }

  const envContent = fs.readFileSync(envPath, "utf8");
  const envVars = {};
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const idx = trimmed.indexOf("=");
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
        envVars[key] = val;
      }
    }
  }

  const rpcUrl = envVars.SEPOLIA_RPC_URL;
  const deployerKey = envVars.DEPLOYER_PRIVATE_KEY;
  const keeperKey = envVars.KEEPER_PRIVATE_KEY;
  const subscriberAddress = envVars.SUBSCRIBER_ADDRESS;

  const isPlaceholderRpc = !rpcUrl || rpcUrl.includes("your_alchemy_api_key_here") || !rpcUrl.startsWith("http");
  const isPlaceholderDeployer = !deployerKey || deployerKey.includes("0000000000000000000000000000000000000000000000000000000000000000");
  const isPlaceholderKeeper = !keeperKey || keeperKey.includes("0000000000000000000000000000000000000000000000000000000000000000");

  if (isPlaceholderRpc || isPlaceholderDeployer || isPlaceholderKeeper) {
    console.log(JSON.stringify({
      configured: false,
      missingRpc: isPlaceholderRpc,
      missingDeployer: isPlaceholderDeployer,
      missingKeeper: isPlaceholderKeeper,
      missingSubscriber: !subscriberAddress || subscriberAddress.includes("0000000000000000000000000000000000000000"),
    }));
    return;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);

    if (chainId !== 11155111) {
      console.log(JSON.stringify({
        configured: true,
        validChain: false,
        chainId: chainId,
        expectedChainId: 11155111,
      }));
      return;
    }

    const deployerWallet = new ethers.Wallet(deployerKey, provider);
    const keeperWallet = new ethers.Wallet(keeperKey, provider);

    const deployerBal = await provider.getBalance(deployerWallet.address);
    const keeperBal = await provider.getBalance(keeperWallet.address);

    let subBal = 0n;
    let validSub = false;
    if (subscriberAddress && ethers.isAddress(subscriberAddress)) {
      subBal = await provider.getBalance(subscriberAddress);
      validSub = true;
    }

    console.log(JSON.stringify({
      configured: true,
      validChain: true,
      chainId: chainId,
      deployerAddress: deployerWallet.address,
      deployerBalanceEth: ethers.formatEther(deployerBal),
      hasMinDeployerEth: deployerBal >= ethers.parseEther("0.01"),
      keeperAddress: keeperWallet.address,
      keeperBalanceEth: ethers.formatEther(keeperBal),
      hasMinKeeperEth: keeperBal >= ethers.parseEther("0.005"),
      subscriberAddress: validSub ? subscriberAddress : null,
      subscriberBalanceEth: validSub ? ethers.formatEther(subBal) : "0",
      hasSubscriberEth: subBal > 0n,
    }));
  } catch (err) {
    console.log(JSON.stringify({
      configured: true,
      rpcError: err.message,
    }));
  }
}

main();
