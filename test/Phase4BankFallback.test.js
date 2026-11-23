/**
 * test/Phase4BankFallback.test.js
 *
 * Full test suite for Phase 4:
 * - Sandbox Bank Balance Adapter (Simulated Local Mock & Read-Only Interface)
 * - Worker Integration:
 *     - Insufficient DEMO balance triggers read-only bank lookup
 *     - Records BANK_CHECKED in audit trail with check timestamp, status, and fiat balance
 *     - Leaves invoice OPEN during its billing window; never settles or debits bank
 *     - Top-up separately and retry within window settles exactly once
 *     - Unlinked account returns UNLINKED status
 *     - Upstream provider outage returns PROVIDER_ERROR status
 *     - Polling ticks within throttle window do not spam bank lookup
 *     - Insufficient token allowance does NOT trigger bank check (stays on ERC-20 approval path)
 *     - Revoked mandates or closed windows halt attempts and never retry
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const ChargeWorker = require("../backend/chargeWorker");
const BillingStore = require("../backend/store/billingStore");
const BankAdapter = require("../backend/adapters/bankAdapter");
const fs = require("fs");
const path = require("path");

describe("Phase 4 — Sandbox Bank Balance Fallback & Recovery Flow", function () {
  const TEST_STORE_DIR = path.join(__dirname, "..", "data", "test-store-4");

  function cleanTestStore() {
    if (fs.existsSync(TEST_STORE_DIR)) {
      fs.rmSync(TEST_STORE_DIR, { recursive: true, force: true });
    }
  }

  beforeEach(function () {
    cleanTestStore();
  });

  afterEach(function () {
    cleanTestStore();
  });

  async function deployPhase4Fixture() {
    cleanTestStore();
    const [deployer, merchant, subscriber, keeper] = await ethers.getSigners();

    // Deploy DemoToken
    const DemoToken = await ethers.getContractFactory("DemoToken");
    const demoToken = await DemoToken.deploy();
    await demoToken.waitForDeployment();

    // Deploy SmartMandate
    const SmartMandate = await ethers.getContractFactory("SmartMandate");
    const smartMandate = await SmartMandate.deploy();
    await smartMandate.waitForDeployment();

    const deploymentReceipt = await smartMandate.deploymentTransaction().wait();
    const deploymentBlock = deploymentReceipt.blockNumber;

    // Start subscriber with only 2 DEMO (< 5 DEMO charge amount)
    const initialBalance = ethers.parseEther("2");
    await demoToken.mint(subscriber.address, initialBalance);

    // Full 15 DEMO allowance approved
    const maxAllowance = ethers.parseEther("15");
    await demoToken.connect(subscriber).approve(smartMandate.target, maxAllowance);

    // Register mandate: 5 DEMO every 120s for 3 periods
    const blockTime = await time.latest();
    const firstDueTime = blockTime + 10;
    const interval = 120;
    const maxCharges = 3;
    const expiry = firstDueTime + interval * maxCharges + 3600;
    const nonce = (await smartMandate.currentNonce(subscriber.address)) + 1n;
    const signingDeadline = blockTime + 3600;

    const mandate = {
      subscriber: subscriber.address,
      merchant: merchant.address,
      token: demoToken.target,
      amount: ethers.parseEther("5"),
      interval: interval,
      firstDueTime: firstDueTime,
      maxCharges: maxCharges,
      expiry: expiry,
      nonce: nonce,
      signingDeadline: signingDeadline,
    };

    const domain = {
      name: "SmartMandateBilling",
      version: "1",
      chainId: 31337,
      verifyingContract: smartMandate.target,
    };

    const types = {
      Mandate: [
        { name: "subscriber", type: "address" },
        { name: "merchant", type: "address" },
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "interval", type: "uint256" },
        { name: "firstDueTime", type: "uint256" },
        { name: "maxCharges", type: "uint256" },
        { name: "expiry", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "signingDeadline", type: "uint256" },
      ],
    };

    const signature = await subscriber.signTypedData(domain, types, mandate);
    const regTx = await smartMandate.registerMandate(mandate, signature);
    const regReceipt = await regTx.wait();
    const parsedReg = smartMandate.interface.parseLog(regReceipt.logs[0]);
    const mandateId = parsedReg.args.mandateId;

    return {
      deployer,
      merchant,
      subscriber,
      keeper,
      demoToken,
      smartMandate,
      mandate,
      mandateId,
      firstDueTime,
      interval,
      deploymentBlock,
    };
  }

  it("4.1 Insufficient DEMO balance triggers read-only bank check, logs BANK_CHECKED, and leaves invoice OPEN", async function () {
    const fixture = await loadFixture(deployPhase4Fixture);
    const { keeper, smartMandate, demoToken, subscriber, merchant, mandateId, firstDueTime, deploymentBlock } = fixture;

    const store = new BillingStore({
      chainId: 31337,
      contractAddress: smartMandate.target,
      storeDir: TEST_STORE_DIR,
      deploymentBlock: deploymentBlock,
    });

    const bankAdapter = new BankAdapter({
      provider: "mock",
      accountRegistry: {
        [subscriber.address]: {
          balance: "250.00",
          currency: "USD",
        },
      },
    });

    const worker = new ChargeWorker({
      provider: ethers.provider,
      signer: keeper,
      smartMandate: smartMandate,
      demoToken: demoToken,
      store: store,
      bankAdapter: bankAdapter,
      deploymentBlock: deploymentBlock,
      bankCheckThrottleSec: 60,
    });

    // Advance time to firstDueTime
    await time.increaseTo(firstDueTime + 2);

    // Subscriber balance is 2 DEMO (< 5 DEMO)
    expect(await demoToken.balanceOf(subscriber.address)).to.equal(ethers.parseEther("2"));

    // Run tick
    const tick = await worker.runOnce();
    expect(tick.success).to.be.true;

    // Verify invoice remains OPEN and NOT settled
    const inv0 = store.getInvoice(mandateId, 0);
    expect(inv0.state).to.equal("OPEN");
    expect(inv0.settledAt).to.be.null;

    // Merchant received 0 tokens
    expect(await demoToken.balanceOf(merchant.address)).to.equal(0n);

    // Verify bank check details in invoice and attempts
    expect(inv0.latestBankCheck).to.not.be.undefined;
    expect(inv0.latestBankCheck.status).to.equal("AVAILABLE");
    expect(inv0.latestBankCheck.availableAmount).to.equal("250.00");
    expect(inv0.latestBankCheck.currency).to.equal("USD");
    expect(inv0.latestBankCheck.isSimulated).to.be.true;

    const attempts = store.getAttemptsForInvoice(mandateId, 0);
    const bankAttempts = attempts.filter((a) => a.state === "BANK_CHECKED");
    expect(bankAttempts.length).to.equal(1);
    expect(bankAttempts[0].bankCheck.status).to.equal("AVAILABLE");
  });

  it("4.2 Recovery flow: Top-up DEMO tokens and retry within same window settles invoice exactly once", async function () {
    const fixture = await loadFixture(deployPhase4Fixture);
    const { keeper, smartMandate, demoToken, subscriber, merchant, mandateId, firstDueTime, deploymentBlock } = fixture;

    const store = new BillingStore({
      chainId: 31337,
      contractAddress: smartMandate.target,
      storeDir: TEST_STORE_DIR,
      deploymentBlock: deploymentBlock,
    });

    const bankAdapter = new BankAdapter({
      provider: "mock",
      accountRegistry: {
        [subscriber.address]: {
          balance: "250.00",
          currency: "USD",
        },
      },
    });

    const worker = new ChargeWorker({
      provider: ethers.provider,
      signer: keeper,
      smartMandate: smartMandate,
      demoToken: demoToken,
      store: store,
      bankAdapter: bankAdapter,
      deploymentBlock: deploymentBlock,
    });

    // Step 1: Open window, fail with insufficient balance
    await time.increaseTo(firstDueTime + 2);
    await worker.runOnce();
    expect(store.getInvoice(mandateId, 0).state).to.equal("OPEN");

    // Step 2: Subscriber tops up 10 DEMO into wallet (now has 12 DEMO)
    await demoToken.mint(subscriber.address, ethers.parseEther("10"));
    expect(await demoToken.balanceOf(subscriber.address)).to.equal(ethers.parseEther("12"));

    // Step 3: Retry charge within same open window [firstDueTime, firstDueTime + 120)
    await time.increase(5);
    await worker.runOnce();

    // Verify settled invoice and token movements
    const inv0 = store.getInvoice(mandateId, 0);
    expect(inv0.state).to.equal("SETTLED");
    expect(inv0.settledAt).to.be.a("number");
    expect(await demoToken.balanceOf(merchant.address)).to.equal(ethers.parseEther("5"));
    expect(await demoToken.balanceOf(subscriber.address)).to.equal(ethers.parseEther("7")); // 12 - 5 = 7 DEMO
  });

  it("4.3 Unlinked account: reports UNLINKED status without throwing error and keeps invoice OPEN", async function () {
    const fixture = await loadFixture(deployPhase4Fixture);
    const { keeper, smartMandate, demoToken, subscriber, mandateId, firstDueTime, deploymentBlock } = fixture;

    const store = new BillingStore({
      chainId: 31337,
      contractAddress: smartMandate.target,
      storeDir: TEST_STORE_DIR,
      deploymentBlock: deploymentBlock,
    });

    // Bank adapter with NO account linked for subscriber
    const bankAdapter = new BankAdapter({ provider: "mock" });

    const worker = new ChargeWorker({
      provider: ethers.provider,
      signer: keeper,
      smartMandate: smartMandate,
      demoToken: demoToken,
      store: store,
      bankAdapter: bankAdapter,
      deploymentBlock: deploymentBlock,
    });

    await time.increaseTo(firstDueTime + 2);
    await worker.runOnce();

    const inv0 = store.getInvoice(mandateId, 0);
    expect(inv0.state).to.equal("OPEN");
    expect(inv0.latestBankCheck.status).to.equal("UNLINKED");
    expect(inv0.latestBankCheck.availableAmount).to.be.null;
  });

  it("4.4 Provider outage: reports PROVIDER_ERROR without crashing worker and keeps invoice OPEN", async function () {
    const fixture = await loadFixture(deployPhase4Fixture);
    const { keeper, smartMandate, demoToken, subscriber, mandateId, firstDueTime, deploymentBlock } = fixture;

    const store = new BillingStore({
      chainId: 31337,
      contractAddress: smartMandate.target,
      storeDir: TEST_STORE_DIR,
      deploymentBlock: deploymentBlock,
    });

    // Simulated provider outage profile
    const bankAdapter = new BankAdapter({
      provider: "mock",
      accountRegistry: {
        [subscriber.address]: {
          simulateError: true,
          simulateErrorReason: "Upstream Core Banking API 503 Service Unavailable",
        },
      },
    });

    const worker = new ChargeWorker({
      provider: ethers.provider,
      signer: keeper,
      smartMandate: smartMandate,
      demoToken: demoToken,
      store: store,
      bankAdapter: bankAdapter,
      deploymentBlock: deploymentBlock,
    });

    await time.increaseTo(firstDueTime + 2);
    const tick = await worker.runOnce();
    expect(tick.success).to.be.true; // Worker does not crash

    const inv0 = store.getInvoice(mandateId, 0);
    expect(inv0.state).to.equal("OPEN");
    expect(inv0.latestBankCheck.status).to.equal("PROVIDER_ERROR");
    expect(inv0.latestBankCheck.errorReason).to.include("503");
  });

  it("4.5 Repeat polling throttle: does not spam bank lookup on consecutive ticks within throttle interval", async function () {
    const fixture = await loadFixture(deployPhase4Fixture);
    const { keeper, smartMandate, demoToken, subscriber, mandateId, firstDueTime, deploymentBlock } = fixture;

    const store = new BillingStore({
      chainId: 31337,
      contractAddress: smartMandate.target,
      storeDir: TEST_STORE_DIR,
      deploymentBlock: deploymentBlock,
    });

    const bankAdapter = new BankAdapter({
      provider: "mock",
      accountRegistry: {
        [subscriber.address]: { balance: "250.00", currency: "USD" },
      },
    });

    const worker = new ChargeWorker({
      provider: ethers.provider,
      signer: keeper,
      smartMandate: smartMandate,
      demoToken: demoToken,
      store: store,
      bankAdapter: bankAdapter,
      deploymentBlock: deploymentBlock,
      bankCheckThrottleSec: 60, // 60s throttle
    });

    await time.increaseTo(firstDueTime + 2);

    // Tick 1: Triggers bank check
    await worker.runOnce();
    let attempts = store.getAttemptsForInvoice(mandateId, 0);
    expect(attempts.filter((a) => a.state === "BANK_CHECKED").length).to.equal(1);

    // Tick 2: 5 seconds later (within throttle window)
    await time.increase(5);
    await worker.runOnce();
    attempts = store.getAttemptsForInvoice(mandateId, 0);
    expect(attempts.filter((a) => a.state === "BANK_CHECKED").length).to.equal(1); // Not spammed

    // Tick 3: 70 seconds later (past throttle window)
    await time.increase(70);
    await worker.runOnce();
    attempts = store.getAttemptsForInvoice(mandateId, 0);
    expect(attempts.filter((a) => a.state === "BANK_CHECKED").length).to.equal(2); // Allowed
  });

  it("4.6 Insufficient allowance does NOT trigger bank balance check", async function () {
    const fixture = await loadFixture(deployPhase4Fixture);
    const { keeper, smartMandate, demoToken, subscriber, mandateId, firstDueTime, deploymentBlock } = fixture;

    // Give subscriber plenty of tokens (50 DEMO) but revoke token allowance to 0
    await demoToken.mint(subscriber.address, ethers.parseEther("50"));
    await demoToken.connect(subscriber).approve(smartMandate.target, 0n);

    const store = new BillingStore({
      chainId: 31337,
      contractAddress: smartMandate.target,
      storeDir: TEST_STORE_DIR,
      deploymentBlock: deploymentBlock,
    });

    const bankAdapter = new BankAdapter({
      provider: "mock",
      accountRegistry: {
        [subscriber.address]: { balance: "250.00", currency: "USD" },
      },
    });

    const worker = new ChargeWorker({
      provider: ethers.provider,
      signer: keeper,
      smartMandate: smartMandate,
      demoToken: demoToken,
      store: store,
      bankAdapter: bankAdapter,
      deploymentBlock: deploymentBlock,
    });

    await time.increaseTo(firstDueTime + 2);
    await worker.runOnce();

    const inv0 = store.getInvoice(mandateId, 0);
    expect(inv0.state).to.equal("OPEN");
    // Verify NO bank check was performed
    expect(inv0.latestBankCheck).to.be.undefined;
    const attempts = store.getAttemptsForInvoice(mandateId, 0);
    expect(attempts.some((a) => a.state === "BANK_CHECKED")).to.be.false;
    expect(attempts[0].errorReason).to.include("Insufficient allowance");
  });

  it("4.7 Revocation & window closure: halts attempts and never retries bank check", async function () {
    const fixture = await loadFixture(deployPhase4Fixture);
    const { keeper, smartMandate, demoToken, subscriber, mandateId, firstDueTime, interval, deploymentBlock } = fixture;

    const store = new BillingStore({
      chainId: 31337,
      contractAddress: smartMandate.target,
      storeDir: TEST_STORE_DIR,
      deploymentBlock: deploymentBlock,
    });

    const bankAdapter = new BankAdapter({
      provider: "mock",
      accountRegistry: {
        [subscriber.address]: { balance: "250.00", currency: "USD" },
      },
    });

    const worker = new ChargeWorker({
      provider: ethers.provider,
      signer: keeper,
      smartMandate: smartMandate,
      demoToken: demoToken,
      store: store,
      bankAdapter: bankAdapter,
      deploymentBlock: deploymentBlock,
    });

    // Advance time past window end: firstDueTime + interval + 10
    await time.increaseTo(firstDueTime + interval + 10);
    await worker.runOnce();

    const inv0 = store.getInvoice(mandateId, 0);
    expect(inv0.state).to.equal("MISSED");
    // No bank check on missed invoice
    expect(inv0.latestBankCheck).to.be.undefined;
  });
});
