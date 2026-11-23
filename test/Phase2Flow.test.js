"use strict";
/**
 * test/Phase2Flow.test.js
 *
 * End-to-end test suite for Phase 2: Dynamic QR Checkout and Mobile Wallet Signing.
 * Tests session creation, QR generation, EIP-712 typed signing, allowance approval,
 * on-chain registration, and subscriber revocation.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { createCheckoutSession, buildCheckoutUrl, generateQRSvg } = require("../frontend/qr/generateLink.js");

describe("Phase 2 — QR Checkout, Wallet Signing, and Revocation Flow", function () {
  // Shared deployment fixture
  async function deployPhase2Fixture() {
    const [deployer, merchant, subscriber, keeper, attacker] = await ethers.getSigners();

    const DemoToken = await ethers.getContractFactory("DemoToken");
    const token = await DemoToken.deploy();
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    const SmartMandate = await ethers.getContractFactory("SmartMandate");
    const mandate = await SmartMandate.deploy();
    await mandate.waitForDeployment();
    const mandateAddr = await mandate.getAddress();

    // Mint 15 DEMO to subscriber
    const ALLOWANCE = ethers.parseUnits("15", 18);
    await token.mint(subscriber.address, ALLOWANCE);

    const domain = {
      name: "SmartMandateBilling",
      version: "1",
      chainId: 31337,
      verifyingContract: mandateAddr,
    };

    const MANDATE_TYPES = {
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

    return { token, mandate, domain, MANDATE_TYPES, deployer, merchant, subscriber, keeper, attacker, tokenAddr, mandateAddr, ALLOWANCE };
  }

  // 1. QR Code & Session Generation
  describe("1. Merchant QR Code & Session Generation", function () {
    it("generates a session with opaque request ID, fresh deadlines, and demo terms", function () {
      const session = createCheckoutSession();

      expect(session.requestId).to.be.a("string").that.matches(/^req_[a-f0-9]{24}$/);
      expect(session.checkoutExpiresAt).to.be.greaterThan(session.createdAt);
      expect(session.plan.chargeAmount).to.equal("5000000000000000000"); // 5 DEMO
      expect(session.plan.interval).to.equal(120); // 120s
      expect(session.plan.maxCharges).to.equal(3);
      expect(session.plan.allowanceCap).to.equal("15000000000000000000"); // 15 DEMO
    });

    it("generates standard scannable QR code SVG for mobile devices", function () {
      const session = createCheckoutSession();
      const url = buildCheckoutUrl("172.16.144.149", 3000, session.requestId);
      const svg = generateQRSvg(url);

      expect(svg).to.be.a("string");
      expect(svg).to.include("<svg");
      expect(svg).to.include("</svg>");
      expect(svg).to.include("viewBox");
    });
  });

  // 2. End-to-End Signing, Approval, Registration & Status Flow
  describe("2. End-to-End Subscriber Signing & On-Chain Registration", function () {
    it("completes full EIP-712 sign, 15-DEMO approve, and registerMandate confirmation", async function () {
      const ctx = await loadFixture(deployPhase2Fixture);
      const { token, mandate, domain, MANDATE_TYPES, subscriber, merchant, tokenAddr, mandateAddr, ALLOWANCE } = ctx;

      const now = BigInt(await time.latest());
      const firstDueTime = now + 120n;
      const signingDeadline = firstDueTime;
      const expiry = firstDueTime + 3600n;

      // 1. Subscriber queries current nonce on-chain
      const currentNonce = await mandate.currentNonce(subscriber.address);
      const nextNonce = currentNonce + 1n;

      // 2. Subscriber signs EIP-712 Mandate struct
      const mandateValue = {
        subscriber: subscriber.address,
        merchant: merchant.address,
        token: tokenAddr,
        amount: ethers.parseUnits("5", 18),
        interval: 120n,
        firstDueTime: firstDueTime,
        maxCharges: 3n,
        expiry: expiry,
        nonce: nextNonce,
        signingDeadline: signingDeadline,
      };

      const signature = await subscriber.signTypedData(domain, MANDATE_TYPES, mandateValue);
      expect(signature).to.have.lengthOf(132); // 65 bytes hex (0x + 130 chars)

      // Compute mandateId matching contract
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const encoded = coder.encode(
        ["address", "address", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
        [
          mandateValue.subscriber,
          mandateValue.merchant,
          mandateValue.token,
          mandateValue.amount,
          mandateValue.interval,
          mandateValue.firstDueTime,
          mandateValue.maxCharges,
          mandateValue.expiry,
          mandateValue.nonce,
          mandateValue.signingDeadline,
        ]
      );
      const expectedMandateId = ethers.keccak256(encoded);

      // 3. Subscriber approves capped allowance of 15 DEMO
      const approveTx = await token.connect(subscriber).approve(mandateAddr, ALLOWANCE);
      await approveTx.wait();
      expect(await token.allowance(subscriber.address, mandateAddr)).to.equal(ALLOWANCE);

      // 4. Submit registerMandate on-chain
      const registerTx = await mandate.connect(subscriber).registerMandate(mandateValue, signature);
      const receipt = await registerTx.wait();

      // Verify MandateRegistered event
      const events = receipt.logs
        .map((l) => { try { return mandate.interface.parseLog(l); } catch { return null; } })
        .filter((e) => e && e.name === "MandateRegistered");

      expect(events.length).to.equal(1);
      expect(events[0].args.mandateId).to.equal(expectedMandateId);
      expect(events[0].args.subscriber).to.equal(subscriber.address);
      expect(events[0].args.merchant).to.equal(merchant.address);

      // 5. Verify mandate is ACTIVE on-chain
      // MandateState: 0: UNREGISTERED, 1: ACTIVE, 2: REVOKED, 3: COMPLETED
      expect(await mandate.mandateState(expectedMandateId)).to.equal(1n);
    });
  });

  // 3. Subscriber Revocation Flow
  describe("3. Subscriber On-Chain Revocation Flow", function () {
    it("allows subscriber to revoke active mandate, emits MandateRevoked, and blocks future charges", async function () {
      const ctx = await loadFixture(deployPhase2Fixture);
      const { token, mandate, domain, MANDATE_TYPES, subscriber, merchant, keeper, tokenAddr, mandateAddr, ALLOWANCE } = ctx;

      const now = BigInt(await time.latest());
      const firstDueTime = now + 120n;

      const mandateValue = {
        subscriber: subscriber.address,
        merchant: merchant.address,
        token: tokenAddr,
        amount: ethers.parseUnits("5", 18),
        interval: 120n,
        firstDueTime: firstDueTime,
        maxCharges: 3n,
        expiry: firstDueTime + 3600n,
        nonce: 1n,
        signingDeadline: firstDueTime,
      };

      const signature = await subscriber.signTypedData(domain, MANDATE_TYPES, mandateValue);
      await token.connect(subscriber).approve(mandateAddr, ALLOWANCE);
      const regTx = await mandate.connect(subscriber).registerMandate(mandateValue, signature);
      const regReceipt = await regTx.wait();

      const regEvents = regReceipt.logs
        .map((l) => { try { return mandate.interface.parseLog(l); } catch { return null; } })
        .filter((e) => e && e.name === "MandateRegistered");
      const mandateId = regEvents[0].args.mandateId;

      expect(await mandate.mandateState(mandateId)).to.equal(1n); // ACTIVE

      // Subscriber revokes mandate
      const revokeTx = await mandate.connect(subscriber).revokeMandate(mandateId);
      const revokeReceipt = await revokeTx.wait();

      const revokeEvents = revokeReceipt.logs
        .map((l) => { try { return mandate.interface.parseLog(l); } catch { return null; } })
        .filter((e) => e && e.name === "MandateRevoked");

      expect(revokeEvents.length).to.equal(1);
      expect(revokeEvents[0].args.mandateId).to.equal(mandateId);
      expect(revokeEvents[0].args.subscriber).to.equal(subscriber.address);

      // Verify on-chain state is REVOKED (2)
      expect(await mandate.mandateState(mandateId)).to.equal(2n);

      // Advance clock to period 0 due time and verify charge is rejected
      await time.setNextBlockTimestamp(firstDueTime);
      await expect(mandate.connect(keeper).charge(mandateId, 0))
        .to.be.revertedWithCustomError(mandate, "MandateNotActive");
    });
  });
});
