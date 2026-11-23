# Project 10 — Automated Subscription & Recurring Billing via Smart Mandates

> **FinTech Capstone — Automated Recurring Smart Mandates**
> Status: `PHASE 5 COMPLETE (SEPOLIA READY & VERIFIED)`
> Architecture: Pull-payment recurring billing on Ethereum (Local Hardhat 31337 & Sepolia 11155111) with mobile EIP-712 wallet authorization, bounded batch settlement, on-chain revocation, and simulated sandbox bank balance fallback.

---

## 1. Executive Summary

Project 10 implements non-custodial recurring subscription payments using Ethereum smart contracts and cryptographic authorizations:
1. **Merchant Setup & Dynamic QR**: Merchant publishes recurring billing terms (5 DEMO every 120s, 3 periods, 15 DEMO cap) encoded into a dynamic QR checkout link with an opaque request ID.
2. **Review & Wallet Authorization**: Subscriber scans the QR code in a mobile wallet (e.g. MetaMask Mobile), reviews human-readable terms, signs an EIP-712 `Mandate` authorization, and grants a capped ERC-20 token allowance.
3. **Scheduled Pull Payments & Batch Settlement**: A backend scheduling worker tracks active mandates, discovers confirmed events from the deployment block, and executes due charges using `charge` or bounded `chargeBatch` with per-item fault isolation.
4. **Sandbox Bank Balance Fallback (P1)**: When an automated charge fails due to insufficient DEMO balance, the backend queries a linked banking sandbox adapter (simulated local mock) and records `BANK_CHECKED`. The invoice remains `OPEN` awaiting token top-up; the bank check never debits funds or mints tokens.
5. **On-Chain Revocation**: The subscriber retains sovereign control and can call `revokeMandate()` on-chain at any time. Once confirmed on-chain, all future billing attempts are strictly blocked.

---

## 2. Local Test Suite & Batch Gas Measurement Report

### 2.1 Full Test Suite Verification

Run the comprehensive test suite across all project phases:
```powershell
# Standard Node.js environment
npm test

# Windows ARM64 compatibility note:
# If running on Windows on ARM64, Nomic Foundation native binaries (@nomicfoundation/edr)
# require an x64 Node.js runtime under Windows x64 emulation:
# $env:PATH = "<path-to-node-x64>;$env:PATH"
# npm test
```

**Results: 40 passing tests (100% pass rate)**
- **Phase 2 — QR Checkout & Revocation** (`test/Phase2Flow.test.js`): 3 passing
- **Phase 3A — Scheduled Worker & Reconciliation** (`test/Phase3AWorker.test.js`): 6 passing
- **Phase 3B — Batch Settlement & Gas Benchmark** (`test/Phase3BBatch.test.js`): 6 passing
- **Phase 4 — Sandbox Bank Balance Fallback** (`test/Phase4BankFallback.test.js`): 7 passing
- **Phase 1 — SmartMandate Core Contract Suite** (`test/SmartMandate.test.js`): 18 passing

---

### 2.2 Comprehensive Batch Gas Report

Measurements taken directly from local transaction receipts (`receipt.gasUsed`) using matching single transactions as comparison baselines:

| Execution Mode | Total Items | Successful Payments | Total Gas Used | Baseline Single Sum | Gas per Successful Payment | Savings vs Baseline |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Single Charge (`charge`)** | 1 | 1 | **105,265 gas** | 105,265 gas | **105,265 gas** | Baseline |
| **Batch Charge ($N=1$)** | 1 | 1 | **90,817 gas** | 105,265 gas | **90,817 gas** | **13.7% savings** |
| **Batch Charge ($N=2$)** | 2 | 2 | **152,052 gas** | 210,530 gas | **76,026 gas** | **27.8% savings** |
| **Batch Charge ($N=3$)** | 3 | 3 | **213,264 gas** | 315,795 gas | **71,088 gas** | **32.5% savings** |
| **Mixed Batch (Isolated)** | 3 (1 fail) | 2 | **208,898 gas** | 210,530 gas | **104,449 gas** | *(Fault-isolated)* |

*Note: In the mixed batch, the failing underfunded item emitted `BatchChargeAttemptFailed` without reverting the batch, allowing the 2 valid items to settle.*

---

## 3. Demo Runbook & Step-by-Step Execution Guide

### 3.1 Local Demo Runbook

#### Step 1: Deploy Contracts & Seed Local Demo State
```powershell
# Install dependencies
npm ci

# 1. Deploy contracts and export ABIs to frontend/contracts.json
node scripts/deploy.js
```

#### Step 2: Start Merchant & Worker Web Server
```powershell
node backend/server.js
```
The server runs on:
- **Merchant Portal**: `http://127.0.0.1:3000/`
- **Mobile LAN Access**: `http://172.16.144.149:3000/`
- **Subscriber View**: `http://172.16.144.149:3000/subscriber`

#### Step 3: Run the Three Demonstration Scenarios
1. **Scenario A: Normal Happy-Path Billing**
   - Open Merchant Portal (`http://127.0.0.1:3000/`), scan QR or click **↗ Open in Browser**.
   - Connect subscriber wallet, click **1. Approve 15 DEMO Allowance**, then **2. Sign & Register Mandate**.
   - As each 120s cycle opens, click **⚡ Run Worker Tick Now** to execute scheduled charges. Period 0 settles for 5 DEMO.
2. **Scenario B: Low-Balance Fallback & Recovery**
   - Connect an underfunded wallet (< 5 DEMO) and register a mandate.
   - Run worker tick: pre-flight checks fail on insufficient DEMO balance, trigger simulated bank reserve lookup (`✓ Available ($250.00 USD, Simulated)`), and keep invoice `OPEN`.
   - Fund the wallet with tokens and tick again within the 120s window: the invoice settles and credits merchant 5 DEMO.
3. **Scenario C: On-Chain Revocation**
   - Open Subscriber Portal (`/subscriber`), input active mandate ID, and click **Revoke Mandate**.
   - Confirm transaction. Mandate status updates to `REVOKED`. Subsequent charges revert and are blocked.

---

### 3.2 Sepolia Testnet Deployment Runbook

#### Prerequisites
1. Copy `.env.example` to `.env`:
   ```powershell
   Copy-Item .env.example .env
   ```
2. Populate `.env` with Sepolia credentials:
   - `SEPOLIA_RPC_URL`: JSON-RPC URL from Alchemy, Infura, or public provider.
   - `DEPLOYER_PRIVATE_KEY`: Private key of deployer (funded with $\ge 0.01$ Sepolia test ETH).
   - `KEEPER_PRIVATE_KEY`: Private key of keeper worker (funded with $\ge 0.005$ Sepolia test ETH).
   - `SUBSCRIBER_ADDRESS`: Optional test wallet address to receive initial demo tokens.

#### Deployment Command (Strictly Restricted to Sepolia)
```powershell
# Restricted to Sepolia (Chain ID 11155111)
npx hardhat run scripts/deploySepolia.js --network sepolia
```

#### Launching in Sepolia Mode
```powershell
$env:NETWORK = "sepolia"
node backend/server.js
```
*Note: In Sepolia network mode, the public test mint faucet and manual worker tick endpoints are automatically disabled for security, and invoice persistence is isolated.*

---

## 4. Compact Demo Checklist

- [x] **Local Hardhat Baseline**: 40 unit and integration tests passing.
- [x] **Restricted DemoToken**: Minting restricted to contract owner/operator via OpenZeppelin `Ownable`.
- [x] **Dynamic QR Checkout**: Fresh request sessions with 15-minute expiration and mobile LAN IP.
- [x] **EIP-712 Signing**: Structured typed data signing with domain separator verified.
- [x] **Scheduled Billing Worker**: Event-driven discovery, retry queue, and `(mandateId, billingPeriod)` invoice keys.
- [x] **Batch Settlement**: Bounded `chargeBatch` (max 50) with per-item fault isolation and up to 32.5% gas savings.
- [x] **Simulated Bank Fallback**: Read-only bank adapter returning reserve check without auto-debiting.
- [x] **On-Chain Revocation**: Permanent revocation by subscriber blocking future debits.
- [ ] **Sepolia On-Chain Broadcast**: *Pending testnet ETH funding and RPC endpoint configuration.*
