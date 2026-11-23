/**
 * test/Phase3BBatch.test.js
 *
 * Full test suite and gas measurement for Phase 3B:
 * - Bounded batch execution on SmartMandate (chargeBatch)
 * - Worker batch grouping and per-item invoice tracking
 * - Fault isolation for mixed batches (underfunded, revoked, or duplicate items)
 * - Persisted store rescan idempotency across restarts
 * - Boundary limit checks: EmptyBatch and BatchLimitExceeded
 * - Precise gas measurements: single vs batch at N=1, N=2, N=3, and mixed batch
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const ChargeWorker = require("../backend/chargeWorker");
const BillingStore = require("../backend/store/billingStore");
const fs = require("fs");
const path = require("path");

describe("Phase 3B — Batch Settlement & Gas Measurement", function () {
  const TEST_STORE_DIR = path.join(__dirname, "..", "data", "test-store-3b");

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

  // Helper to create & register a mandate for a subscriber
  async function setupMandate(smartMandate, demoToken, subscriberSigner, merchantSigner, overrides = {}) {
    const chargeAmount = overrides.amount || ethers.parseEther("5");
    const interval = overrides.interval || 120;
    const maxCharges = overrides.maxCharges || 3;
    const blockTime = await time.latest();
    const firstDueTime = overrides.firstDueTime || blockTime + 10;
    const expiry = firstDueTime + interval * maxCharges + 3600;
    const nonce = (await smartMandate.currentNonce(subscriberSigner.address)) + 1n;
    const signingDeadline = blockTime + 3600;

    const mandate = {
      subscriber: subscriberSigner.address,
      merchant: merchantSigner.address,
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

    const signature = await subscriberSigner.signTypedData(domain, types, mandate);
    const regTx = await smartMandate.registerMandate(mandate, signature);
    const receipt = await regTx.wait();
    const parsedLog = smartMandate.interface.parseLog(receipt.logs[0]);
    const mandateId = parsedLog.args.mandateId;

    return { mandate, mandateId, firstDueTime, interval, chargeAmount };
  }

  async function deployBatchFixture() {
    cleanTestStore();
    const signers = await ethers.getSigners();
    const [deployer, merchantA, merchantB, sub1, sub2, sub3, keeper, thirdParty] = signers;

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

    return {
      deployer,
      merchantA,
      merchantB,
      sub1,
      sub2,
      sub3,
      keeper,
      thirdParty,
      demoToken,
      smartMandate,
      deploymentBlock,
    };
  }

  describe("1. Bounded Batch Execution & Worker Flow", function () {
    it("1.1 All-valid batch: multiple invoices settle in one batch and each merchant receives tokens", async function () {
      const fixture = await loadFixture(deployBatchFixture);
      const { smartMandate, demoToken, merchantA, merchantB, sub1, sub2, keeper, deploymentBlock } = fixture;

      // Fund subscribers with 15 DEMO and approve
      await demoToken.mint(sub1.address, ethers.parseEther("15"));
      await demoToken.connect(sub1).approve(smartMandate.target, ethers.parseEther("15"));

      await demoToken.mint(sub2.address, ethers.parseEther("15"));
      await demoToken.connect(sub2).approve(smartMandate.target, ethers.parseEther("15"));

      const blockTime = await time.latest();
      const firstDue = blockTime + 10;

      const m1 = await setupMandate(smartMandate, demoToken, sub1, merchantA, { firstDueTime: firstDue });
      const m2 = await setupMandate(smartMandate, demoToken, sub2, merchantB, { firstDueTime: firstDue });

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
        useBatch: true,
      });

      // Advance time to open period 0
      await time.increaseTo(firstDue + 2);

      // Run worker tick
      const tickResult = await worker.runOnce();
      expect(tickResult.success).to.be.true;

      // Verify token movements
      expect(await demoToken.balanceOf(merchantA.address)).to.equal(ethers.parseEther("5"));
      expect(await demoToken.balanceOf(merchantB.address)).to.equal(ethers.parseEther("5"));
      expect(await demoToken.balanceOf(sub1.address)).to.equal(ethers.parseEther("10"));
      expect(await demoToken.balanceOf(sub2.address)).to.equal(ethers.parseEther("10"));

      // Verify persistent store state for both invoices
      const inv1 = store.getInvoice(m1.mandateId, 0);
      const inv2 = store.getInvoice(m2.mandateId, 0);
      expect(inv1.state).to.equal("SETTLED");
      expect(inv2.state).to.equal("SETTLED");
      expect(inv1.txHash).to.equal(inv2.txHash); // Shared the same batch transaction
    });

    it("1.2 Mixed batch: underfunded invoice between two valid invoices does not revert batch; retry settles after top-up", async function () {
      const fixture = await loadFixture(deployBatchFixture);
      const { smartMandate, demoToken, merchantA, sub1, sub2, sub3, keeper, deploymentBlock } = fixture;

      // sub1 has 15 DEMO
      await demoToken.mint(sub1.address, ethers.parseEther("15"));
      await demoToken.connect(sub1).approve(smartMandate.target, ethers.parseEther("15"));

      // sub2 is underfunded: has only 2 DEMO (< 5 DEMO)
      await demoToken.mint(sub2.address, ethers.parseEther("2"));
      await demoToken.connect(sub2).approve(smartMandate.target, ethers.parseEther("15"));

      // sub3 has 15 DEMO
      await demoToken.mint(sub3.address, ethers.parseEther("15"));
      await demoToken.connect(sub3).approve(smartMandate.target, ethers.parseEther("15"));

      const blockTime = await time.latest();
      const firstDue = blockTime + 10;

      const m1 = await setupMandate(smartMandate, demoToken, sub1, merchantA, { firstDueTime: firstDue });
      const m2 = await setupMandate(smartMandate, demoToken, sub2, merchantA, { firstDueTime: firstDue });
      const m3 = await setupMandate(smartMandate, demoToken, sub3, merchantA, { firstDueTime: firstDue });

      // Directly test smartMandate.chargeBatch with mixed items
      await time.increaseTo(firstDue + 2);

      const batchItems = [
        { mandateId: m1.mandateId, billingPeriod: 0 },
        { mandateId: m2.mandateId, billingPeriod: 0 }, // Underfunded
        { mandateId: m3.mandateId, billingPeriod: 0 },
      ];

      const batchTx = await smartMandate.connect(keeper).chargeBatch(batchItems);
      const receipt = await batchTx.wait();
      expect(receipt.status).to.equal(1);

      // Verify m1 and m3 settled, m2 did not
      expect(await smartMandate.isSettled(m1.mandateId, 0)).to.be.true;
      expect(await smartMandate.isSettled(m2.mandateId, 0)).to.be.false;
      expect(await smartMandate.isSettled(m3.mandateId, 0)).to.be.true;

      // Merchant received 10 DEMO (5 from sub1, 5 from sub3)
      expect(await demoToken.balanceOf(merchantA.address)).to.equal(ethers.parseEther("10"));

      // Top up sub2
      await demoToken.mint(sub2.address, ethers.parseEther("10"));
      expect(await demoToken.balanceOf(sub2.address)).to.equal(ethers.parseEther("12"));

      // Retry sub2
      const retryTx = await smartMandate.connect(keeper).charge(m2.mandateId, 0);
      await retryTx.wait();

      expect(await smartMandate.isSettled(m2.mandateId, 0)).to.be.true;
      expect(await demoToken.balanceOf(merchantA.address)).to.equal(ethers.parseEther("15"));
    });

    it("1.3 Duplicate / Already-settled item: proceeds without second debit and allows other items to settle", async function () {
      const fixture = await loadFixture(deployBatchFixture);
      const { smartMandate, demoToken, merchantA, sub1, sub2, keeper } = fixture;

      await demoToken.mint(sub1.address, ethers.parseEther("15"));
      await demoToken.connect(sub1).approve(smartMandate.target, ethers.parseEther("15"));

      await demoToken.mint(sub2.address, ethers.parseEther("15"));
      await demoToken.connect(sub2).approve(smartMandate.target, ethers.parseEther("15"));

      const blockTime = await time.latest();
      const firstDue = blockTime + 10;

      const m1 = await setupMandate(smartMandate, demoToken, sub1, merchantA, { firstDueTime: firstDue });
      const m2 = await setupMandate(smartMandate, demoToken, sub2, merchantA, { firstDueTime: firstDue });

      await time.increaseTo(firstDue + 2);

      // Settle m1 first
      await smartMandate.connect(keeper).charge(m1.mandateId, 0);
      expect(await demoToken.balanceOf(merchantA.address)).to.equal(ethers.parseEther("5"));

      // Now pass batch containing [m1:0 (already settled), m2:0 (open)]
      const batchItems = [
        { mandateId: m1.mandateId, billingPeriod: 0 },
        { mandateId: m2.mandateId, billingPeriod: 0 },
      ];

      const batchTx = await smartMandate.connect(keeper).chargeBatch(batchItems);
      const receipt = await batchTx.wait();
      expect(receipt.status).to.equal(1);

      // Verify m2 settled, m1 not double charged
      expect(await smartMandate.isSettled(m2.mandateId, 0)).to.be.true;
      expect(await demoToken.balanceOf(merchantA.address)).to.equal(ethers.parseEther("10"));
    });

    it("1.4 Store rescan idempotency: reloading persisted store after batch execution does not double-charge", async function () {
      const fixture = await loadFixture(deployBatchFixture);
      const { smartMandate, demoToken, merchantA, sub1, sub2, keeper, deploymentBlock } = fixture;

      await demoToken.mint(sub1.address, ethers.parseEther("15"));
      await demoToken.connect(sub1).approve(smartMandate.target, ethers.parseEther("15"));

      await demoToken.mint(sub2.address, ethers.parseEther("15"));
      await demoToken.connect(sub2).approve(smartMandate.target, ethers.parseEther("15"));

      const blockTime = await time.latest();
      const firstDue = blockTime + 10;

      const m1 = await setupMandate(smartMandate, demoToken, sub1, merchantA, { firstDueTime: firstDue });
      const m2 = await setupMandate(smartMandate, demoToken, sub2, merchantA, { firstDueTime: firstDue });

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
        useBatch: true,
      });

      await time.increaseTo(firstDue + 2);
      await worker1.runOnce();

      expect(await demoToken.balanceOf(merchantA.address)).to.equal(ethers.parseEther("10"));

      // Restart worker with newly loaded store from disk
      const store2 = new BillingStore({
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
        store: store2,
        deploymentBlock: deploymentBlock,
        useBatch: true,
      });

      await worker2.runOnce();

      // Merchant balance still exactly 10 DEMO
      expect(await demoToken.balanceOf(merchantA.address)).to.equal(ethers.parseEther("10"));
      expect(store2.getInvoice(m1.mandateId, 0).state).to.equal("SETTLED");
      expect(store2.getInvoice(m2.mandateId, 0).state).to.equal("SETTLED");
    });

    it("1.5 Contract limits: EmptyBatch and BatchLimitExceeded revert appropriately", async function () {
      const fixture = await loadFixture(deployBatchFixture);
      const { smartMandate, keeper } = fixture;

      // Empty batch
      await expect(smartMandate.connect(keeper).chargeBatch([])).to.be.revertedWithCustomError(
        smartMandate,
        "EmptyBatch"
      );

      // Oversized batch (> MAX_BATCH_SIZE = 50)
      const oversized = [];
      for (let i = 0; i < 51; i++) {
        oversized.push({
          mandateId: ethers.ZeroHash,
          billingPeriod: 0,
        });
      }

      await expect(smartMandate.connect(keeper).chargeBatch(oversized)).to.be.revertedWithCustomError(
        smartMandate,
        "BatchLimitExceeded"
      );
    });
  });

  describe("2. Gas Measurement & Comparison", function () {
    it("2.1 Measures gas for single charges vs batch charges (N=1, N=2, N=3) and mixed batch", async function () {
      const signers = await ethers.getSigners();
      const keeper = signers[0];
      const merchant = signers[1];

      // Deploy fresh contracts
      const DemoToken = await ethers.getContractFactory("DemoToken");
      const demoToken = await DemoToken.deploy();
      await demoToken.waitForDeployment();

      const SmartMandate = await ethers.getContractFactory("SmartMandate");
      const smartMandate = await SmartMandate.deploy();
      await smartMandate.waitForDeployment();

      // Create subscribers
      const subscribers = signers.slice(2, 7); // sub0..sub4
      for (const sub of subscribers) {
        await demoToken.mint(sub.address, ethers.parseEther("15"));
        await demoToken.connect(sub).approve(smartMandate.target, ethers.parseEther("15"));
      }

      const blockTime = await time.latest();
      const firstDue = blockTime + 10;

      const mandates = [];
      for (let i = 0; i < subscribers.length; i++) {
        const m = await setupMandate(smartMandate, demoToken, subscribers[i], merchant, {
          firstDueTime: firstDue,
        });
        mandates.push(m);
      }

      await time.increaseTo(firstDue + 2);

      // ── Test Case A: Single charge(mandateId, 0) ──
      const singleTx = await smartMandate.connect(keeper).charge(mandates[0].mandateId, 0);
      const singleReceipt = await singleTx.wait();
      const singleGas = singleReceipt.gasUsed;

      // ── Test Case B: Batch size 1 ──
      const batch1Tx = await smartMandate.connect(keeper).chargeBatch([
        { mandateId: mandates[1].mandateId, billingPeriod: 0 },
      ]);
      const batch1Receipt = await batch1Tx.wait();
      const batch1Gas = batch1Receipt.gasUsed;

      // ── Test Case C: Batch size 2 ──
      const batch2Tx = await smartMandate.connect(keeper).chargeBatch([
        { mandateId: mandates[2].mandateId, billingPeriod: 0 },
        { mandateId: mandates[3].mandateId, billingPeriod: 0 },
      ]);
      const batch2Receipt = await batch2Tx.wait();
      const batch2Gas = batch2Receipt.gasUsed;

      // ── Test Case D: Batch size 3 (All-valid) ──
      const validSubB = signers[7];
      await demoToken.mint(validSubB.address, ethers.parseEther("15"));
      await demoToken.connect(validSubB).approve(smartMandate.target, ethers.parseEther("15"));
      const validMB = await setupMandate(smartMandate, demoToken, validSubB, merchant, {
        firstDueTime: firstDue,
      });

      const validSubC = signers[8];
      await demoToken.mint(validSubC.address, ethers.parseEther("15"));
      await demoToken.connect(validSubC).approve(smartMandate.target, ethers.parseEther("15"));
      const validMC = await setupMandate(smartMandate, demoToken, validSubC, merchant, {
        firstDueTime: firstDue,
      });

      const batch3Tx = await smartMandate.connect(keeper).chargeBatch([
        { mandateId: mandates[4].mandateId, billingPeriod: 0 },
        { mandateId: validMB.mandateId, billingPeriod: 0 },
        { mandateId: validMC.mandateId, billingPeriod: 0 },
      ]);
      const batch3Receipt = await batch3Tx.wait();
      const batch3Gas = batch3Receipt.gasUsed;

      // ── Test Case E: Mixed batch (1 valid, 1 underfunded, 1 valid) ──
      const underfundedSub = signers[9];
      await demoToken.mint(underfundedSub.address, ethers.parseEther("2")); // only 2 DEMO
      await demoToken.connect(underfundedSub).approve(smartMandate.target, ethers.parseEther("15"));
      const underfundedM = await setupMandate(smartMandate, demoToken, underfundedSub, merchant, {
        firstDueTime: firstDue,
      });

      const validSubD = signers[10];
      await demoToken.mint(validSubD.address, ethers.parseEther("15"));
      await demoToken.connect(validSubD).approve(smartMandate.target, ethers.parseEther("15"));
      const validMD = await setupMandate(smartMandate, demoToken, validSubD, merchant, {
        firstDueTime: firstDue,
      });

      const validSubE = signers[11];
      await demoToken.mint(validSubE.address, ethers.parseEther("15"));
      await demoToken.connect(validSubE).approve(smartMandate.target, ethers.parseEther("15"));
      const validME = await setupMandate(smartMandate, demoToken, validSubE, merchant, {
        firstDueTime: firstDue,
      });

      const mixedTx = await smartMandate.connect(keeper).chargeBatch([
        { mandateId: validMD.mandateId, billingPeriod: 0 },     // valid
        { mandateId: underfundedM.mandateId, billingPeriod: 0 }, // fails (underfunded)
        { mandateId: validME.mandateId, billingPeriod: 0 },      // valid
      ]);
      const mixedReceipt = await mixedTx.wait();
      const mixedGas = mixedReceipt.gasUsed;

      console.log("\n=======================================================");
      console.log("📊 GAS MEASUREMENT REPORT — SmartMandate Batch Settlement");
      console.log("=======================================================");
      console.log(`Single charge (N=1)   : Total gas = ${singleGas.toString()} gas`);
      console.log(`Batch charge (N=1)    : Total gas = ${batch1Gas.toString()} gas (${(batch1Gas - singleGas).toString()} delta)`);
      console.log(`Batch charge (N=2)    : Total gas = ${batch2Gas.toString()} gas | Per-payment = ${(batch2Gas / 2n).toString()} gas`);
      console.log(`Batch charge (N=3)    : Total gas = ${batch3Gas.toString()} gas | Per-payment = ${(batch3Gas / 3n).toString()} gas`);
      console.log(`Mixed Batch (3 items) : Total gas = ${mixedGas.toString()} gas (2 settled, 1 failed)`);
      console.log("=======================================================\n");

      expect(singleReceipt.status).to.equal(1);
      expect(batch1Receipt.status).to.equal(1);
      expect(batch2Receipt.status).to.equal(1);
      expect(batch3Receipt.status).to.equal(1);
      expect(mixedReceipt.status).to.equal(1);
    });
  });
});
