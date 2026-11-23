const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const ChargeWorker = require("../backend/chargeWorker");
const BillingStore = require("../backend/store/billingStore");
const fs = require("fs");
const path = require("path");

describe("Phase 3A — Scheduled Billing Worker & Reconciliation", function () {
  const TEST_STORE_DIR = path.join(__dirname, "..", "data", "test-store");

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

  async function deployWorkerFixture() {
    cleanTestStore();
    const [deployer, merchant, subscriber, keeper, thirdParty] = await ethers.getSigners();

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

    // Mint tokens to subscriber
    const chargeAmount = ethers.parseEther("5"); // 5 DEMO
    const maxAllowance = ethers.parseEther("15"); // 15 DEMO
    await demoToken.mint(subscriber.address, maxAllowance);

    // Approve SmartMandate contract
    await demoToken.connect(subscriber).approve(smartMandate.target, maxAllowance);

    // Register a valid mandate: 5 DEMO every 120s for 3 periods
    const blockTime = await time.latest();
    const firstDueTime = blockTime + 10; // Opens in 10 seconds
    const interval = 120; // 2 minutes
    const maxCharges = 3;
    const expiry = firstDueTime + interval * maxCharges + 3600;
    const nonce = (await smartMandate.currentNonce(subscriber.address)) + 1n;
    const signingDeadline = blockTime + 3600;

    const mandate = {
      subscriber: subscriber.address,
      merchant: merchant.address,
      token: demoToken.target,
      amount: chargeAmount,
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

    // Register mandate on-chain
    const regTx = await smartMandate.registerMandate(mandate, signature);
    const regReceipt = await regTx.wait();
    const regEvent = regReceipt.logs.find((log) => {
      try {
        return smartMandate.interface.parseLog(log)?.name === "MandateRegistered";
      } catch (_) {
        return false;
      }
    });
    const parsedReg = smartMandate.interface.parseLog(regEvent);
    const mandateId = parsedReg.args.mandateId;

    return {
      deployer,
      merchant,
      subscriber,
      keeper,
      thirdParty,
      demoToken,
      smartMandate,
      mandate,
      mandateId,
      firstDueTime,
      interval,
      chargeAmount,
      maxAllowance,
      deploymentBlock,
    };
  }

  it("1. Discovers mandate, charges period 0 upon opening, transfers 5 DEMO, and settles invoice", async function () {
    const fixture = await loadFixture(deployWorkerFixture);
    const { keeper, smartMandate, demoToken, subscriber, merchant, mandateId, firstDueTime, deploymentBlock } = fixture;

    const store = new BillingStore({
      chainId: 31337,
      contractAddress: smartMandate.target,
      storeDir: TEST_STORE_DIR,
      deploymentBlock: deploymentBlock,
    });

    const worker = new ChargeWorker({
      provider: ethers.provider,
      signer: keeper,
      smartMandate: smartMandate,
      demoToken: demoToken,
      store: store,
      deploymentBlock: deploymentBlock,
    });

    // Run tick before due time: should discover mandate & initialize invoices, but not charge
    const earlyTick = await worker.runOnce();
    expect(earlyTick.success).to.be.true;

    const inv0Early = store.getInvoice(mandateId, 0);
    expect(inv0Early).to.not.be.null;
    expect(inv0Early.state).to.equal("OPEN");
    expect(inv0Early.settledAt).to.be.null;

    // Balances before charge
    const subBalBefore = await demoToken.balanceOf(subscriber.address);
    const merBalBefore = await demoToken.balanceOf(merchant.address);
    expect(subBalBefore).to.equal(ethers.parseEther("15"));
    expect(merBalBefore).to.equal(0n);

    // Advance chain time to firstDueTime
    await time.increaseTo(firstDueTime + 1);

    // Run tick at due time: should charge period 0
    const chargeTick = await worker.runOnce();
    expect(chargeTick.success).to.be.true;

    // Verify token balances
    const subBalAfter = await demoToken.balanceOf(subscriber.address);
    const merBalAfter = await demoToken.balanceOf(merchant.address);
    expect(subBalAfter).to.equal(ethers.parseEther("10")); // 15 - 5 = 10 DEMO
    expect(merBalAfter).to.equal(ethers.parseEther("5")); // 0 + 5 = 5 DEMO

    // Verify invoice status in store
    const inv0Settled = store.getInvoice(mandateId, 0);
    expect(inv0Settled.state).to.equal("SETTLED");
    expect(inv0Settled.settledAt).to.be.a("number");
    expect(inv0Settled.txHash).to.be.a("string");

    // Verify attempt audit records
    const attempts = store.getAttemptsForInvoice(mandateId, 0);
    expect(attempts.length).to.be.greaterThanOrEqual(1);
    expect(attempts.some((a) => a.state === "CONFIRMED")).to.be.true;
  });

  it("2. Idempotency & Worker Restart: Running twice or restarting with the same store does not double-charge", async function () {
    const fixture = await loadFixture(deployWorkerFixture);
    const { keeper, smartMandate, demoToken, subscriber, merchant, mandateId, firstDueTime, deploymentBlock } = fixture;

    const store = new BillingStore({
      chainId: 31337,
      contractAddress: smartMandate.target,
      storeDir: TEST_STORE_DIR,
      deploymentBlock: deploymentBlock,
    });

    const worker1 = new ChargeWorker({
      provider: ethers.provider,
      signer: keeper,
      smartMandate: smartMandate,
      demoToken: demoToken,
      store: store,
      deploymentBlock: deploymentBlock,
    });

    // Advance time and charge period 0
    await time.increaseTo(firstDueTime + 5);
    await worker1.runOnce();

    expect(await demoToken.balanceOf(merchant.address)).to.equal(ethers.parseEther("5"));

    // Immediate second tick with same worker
    await worker1.runOnce();
    expect(await demoToken.balanceOf(merchant.address)).to.equal(ethers.parseEther("5"));

    // Restart worker with a newly instantiated worker using the persistent store from disk
    const restartedStore = new BillingStore({
      chainId: 31337,
      contractAddress: smartMandate.target,
      storeDir: TEST_STORE_DIR,
      deploymentBlock: deploymentBlock,
    });

    const worker2 = new ChargeWorker({
      provider: ethers.provider,
      signer: keeper,
      smartMandate: smartMandate,
      demoToken: demoToken,
      store: restartedStore,
      deploymentBlock: deploymentBlock,
    });

    await worker2.runOnce();

    // Verify still exactly 5 DEMO credited (no duplicate charge)
    expect(await demoToken.balanceOf(merchant.address)).to.equal(ethers.parseEther("5"));
    expect(restartedStore.getInvoice(mandateId, 0).state).to.equal("SETTLED");
  });

  it("3. Third-party Charge Reconciliation: Imports third-party payment and avoids submitting duplicate charge", async function () {
    const fixture = await loadFixture(deployWorkerFixture);
    const { keeper, thirdParty, smartMandate, demoToken, merchant, mandateId, firstDueTime, deploymentBlock } = fixture;

    const store = new BillingStore({
      chainId: 31337,
      contractAddress: smartMandate.target,
      storeDir: TEST_STORE_DIR,
      deploymentBlock: deploymentBlock,
    });

    const worker = new ChargeWorker({
      provider: ethers.provider,
      signer: keeper,
      smartMandate: smartMandate,
      demoToken: demoToken,
      store: store,
      deploymentBlock: deploymentBlock,
    });

    // Advance time to open window
    await time.increaseTo(firstDueTime + 2);

    // Third party executes charge on-chain
    const thirdPartyTx = await smartMandate.connect(thirdParty).charge(mandateId, 0);
    const thirdPartyReceipt = await thirdPartyTx.wait();
    expect(thirdPartyReceipt.status).to.equal(1);

    // Merchant now has 5 DEMO
    expect(await demoToken.balanceOf(merchant.address)).to.equal(ethers.parseEther("5"));

    // Now run worker: should reconcile ChargePaid event and mark invoice SETTLED without throwing error or double-charging
    const tickResult = await worker.runOnce();
    expect(tickResult.success).to.be.true;

    const inv = store.getInvoice(mandateId, 0);
    expect(inv.state).to.equal("SETTLED");
    expect(inv.txHash).to.equal(thirdPartyTx.hash);

    // Merchant balance remains exactly 5 DEMO
    expect(await demoToken.balanceOf(merchant.address)).to.equal(ethers.parseEther("5"));
  });

  it("4. Window Closure: Marks unpaid invoice MISSED once the billing window elapses", async function () {
    const fixture = await loadFixture(deployWorkerFixture);
    const { keeper, smartMandate, demoToken, mandateId, firstDueTime, interval, deploymentBlock } = fixture;

    const store = new BillingStore({
      chainId: 31337,
      contractAddress: smartMandate.target,
      storeDir: TEST_STORE_DIR,
      deploymentBlock: deploymentBlock,
    });

    const worker = new ChargeWorker({
      provider: ethers.provider,
      signer: keeper,
      smartMandate: smartMandate,
      demoToken: demoToken,
      store: store,
      deploymentBlock: deploymentBlock,
    });

    // Period 0 window is [firstDueTime, firstDueTime + interval)
    // Advance time PAST the window: e.g. firstDueTime + interval + 10
    await time.increaseTo(firstDueTime + interval + 10);

    // Worker tick should discover mandate and immediately mark period 0 as MISSED
    await worker.runOnce();

    const inv0 = store.getInvoice(mandateId, 0);
    expect(inv0.state).to.equal("MISSED");
  });

  it("5. Revocation: Stops attempts after on-chain revocation is confirmed", async function () {
    const fixture = await loadFixture(deployWorkerFixture);
    const { keeper, subscriber, smartMandate, demoToken, merchant, mandateId, firstDueTime, interval, deploymentBlock } = fixture;

    const store = new BillingStore({
      chainId: 31337,
      contractAddress: smartMandate.target,
      storeDir: TEST_STORE_DIR,
      deploymentBlock: deploymentBlock,
    });

    const worker = new ChargeWorker({
      provider: ethers.provider,
      signer: keeper,
      smartMandate: smartMandate,
      demoToken: demoToken,
      store: store,
      deploymentBlock: deploymentBlock,
    });

    // Settle period 0 first
    await time.increaseTo(firstDueTime + 5);
    await worker.runOnce();
    expect(store.getInvoice(mandateId, 0).state).to.equal("SETTLED");

    // Subscriber revokes mandate on-chain
    await smartMandate.connect(subscriber).revokeMandate(mandateId);

    // Advance time into Period 1 window
    await time.increaseTo(firstDueTime + interval + 5);

    // Run worker: should detect revocation and refuse to charge period 1
    await worker.runOnce();

    const inv1 = store.getInvoice(mandateId, 1);
    expect(inv1.state).to.not.equal("SETTLED");
    expect(await demoToken.balanceOf(merchant.address)).to.equal(ethers.parseEther("5")); // Still only 5 DEMO
  });

  it("6. Low-balance Recovery: Fails gracefully when balance < 5 DEMO, then succeeds after top-up within same window", async function () {
    const fixture = await loadFixture(deployWorkerFixture);
    const { keeper, deployer, subscriber, merchant, smartMandate, demoToken, mandateId, firstDueTime, deploymentBlock } = fixture;

    const store = new BillingStore({
      chainId: 31337,
      contractAddress: smartMandate.target,
      storeDir: TEST_STORE_DIR,
      deploymentBlock: deploymentBlock,
    });

    const worker = new ChargeWorker({
      provider: ethers.provider,
      signer: keeper,
      smartMandate: smartMandate,
      demoToken: demoToken,
      store: store,
      deploymentBlock: deploymentBlock,
    });

    // Drain subscriber balance to 2 DEMO (< 5 DEMO required)
    const currentBal = await demoToken.balanceOf(subscriber.address);
    const drainAmount = currentBal - ethers.parseEther("2");
    await demoToken.connect(subscriber).transfer(deployer.address, drainAmount);
    expect(await demoToken.balanceOf(subscriber.address)).to.equal(ethers.parseEther("2"));

    // Advance time to period 0 open window
    await time.increaseTo(firstDueTime + 5);

    // Tick worker: should detect insufficient balance and record FAILED attempt, leaving invoice OPEN
    await worker.runOnce();

    const inv0AfterFail = store.getInvoice(mandateId, 0);
    expect(inv0AfterFail.state).to.equal("OPEN");
    const attempts = store.getAttemptsForInvoice(mandateId, 0);
    expect(attempts.length).to.be.greaterThanOrEqual(1);
    expect(attempts.some((a) => a.state === "FAILED" && a.errorReason.includes("Insufficient balance"))).to.be.true;

    // Recover: Subscriber gets topped up (mint or transfer 10 DEMO)
    await demoToken.mint(subscriber.address, ethers.parseEther("10"));
    expect(await demoToken.balanceOf(subscriber.address)).to.equal(ethers.parseEther("12"));

    // Retry within the same billing window
    await time.increase(5); // Still well within [firstDueTime, firstDueTime + 120)
    await worker.runOnce();

    // Now invoice should be SETTLED and merchant credited
    const inv0AfterRecovery = store.getInvoice(mandateId, 0);
    expect(inv0AfterRecovery.state).to.equal("SETTLED");
    expect(await demoToken.balanceOf(merchant.address)).to.equal(ethers.parseEther("5"));
    expect(await demoToken.balanceOf(subscriber.address)).to.equal(ethers.parseEther("7")); // 12 - 5 = 7 DEMO
  });
});
