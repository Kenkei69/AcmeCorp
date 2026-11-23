"use strict";
/**
 * test/SmartMandate.test.js
 *
 * Full Phase 1 test suite for SmartMandate + DemoToken.
 *
 * Uses:
 *   - Hardhat local network (chain ID 31337)
 *   - ethers v6  (signer.signTypedData for EIP-712)
 *   - @nomicfoundation/hardhat-chai-matchers for .revertedWithCustomError
 *
 * Clock references use the Phase 0 fixture values:
 *   firstDueTime  = 1_800_000_000
 *   interval      = 120
 *   expiry        = 1_800_001_000
 *   signingDeadline = 1_800_000_000  (at or before firstDueTime)
 *   registerAt    = 1_799_999_990   (before firstDueTime)
 */

const { expect }       = require("chai");
const { ethers }       = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// ─────────────────────────────────────────────────────────────────────────────
// Demo parameters (must match Phase 0 fixture)
// ─────────────────────────────────────────────────────────────────────────────

const AMOUNT        = 5n * 10n ** 18n;          // 5 DEMO
const ALLOWANCE     = 15n * 10n ** 18n;         // 15 DEMO (3 × amount)
const INTERVAL      = 120n;                     // seconds
const MAX_CHARGES   = 3n;
const FIRST_DUE     = 1_800_000_000n;           // period 0 due time
const EXPIRY        = 1_800_001_000n;           // mandate expiry
const REGISTER_AT   = 1_799_999_990n;           // before firstDueTime
const SIGNING_DL    = 1_800_000_000n;           // == firstDueTime (must register before this)

// Period windows (all exclusive end)
const P0_START = FIRST_DUE;                     // 1_800_000_000
const P0_END   = FIRST_DUE + INTERVAL;          // 1_800_000_120
const P1_START = FIRST_DUE + INTERVAL;          // 1_800_000_120
const P1_END   = FIRST_DUE + 2n * INTERVAL;     // 1_800_000_240
const P2_START = FIRST_DUE + 2n * INTERVAL;     // 1_800_000_240
const P2_END   = FIRST_DUE + 3n * INTERVAL;     // 1_800_000_360

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the EIP-712 domain object from a deployed SmartMandate contract.
 * chainId is always 31337 for local Hardhat.
 */
function buildDomain(contractAddress) {
  return {
    name: "SmartMandateBilling",
    version: "1",
    chainId: 31337,
    verifyingContract: contractAddress,
  };
}

/** EIP-712 types — must match MANDATE_TYPEHASH in the contract. */
const MANDATE_TYPES = {
  Mandate: [
    { name: "subscriber",      type: "address"  },
    { name: "merchant",        type: "address"  },
    { name: "token",           type: "address"  },
    { name: "amount",          type: "uint256"  },
    { name: "interval",        type: "uint256"  },
    { name: "firstDueTime",    type: "uint256"  },
    { name: "maxCharges",      type: "uint256"  },
    { name: "expiry",          type: "uint256"  },
    { name: "nonce",           type: "uint256"  },
    { name: "signingDeadline", type: "uint256"  },
  ],
};

/**
 * Build a Mandate value object using actual deployed addresses.
 * All amounts / timestamps in BigInt.
 */
function buildMandateValue(subscriberAddr, merchantAddr, tokenAddr, overrides = {}) {
  return {
    subscriber:      subscriberAddr,
    merchant:        merchantAddr,
    token:           tokenAddr,
    amount:          AMOUNT,
    interval:        INTERVAL,
    firstDueTime:    FIRST_DUE,
    maxCharges:      MAX_CHARGES,
    expiry:          EXPIRY,
    nonce:           1n,
    signingDeadline: SIGNING_DL,
    ...overrides,
  };
}

/**
 * Sign a Mandate struct with the subscriber signer using ethers v6 signTypedData.
 */
async function signMandate(signer, domain, mandate) {
  return signer.signTypedData(domain, MANDATE_TYPES, mandate);
}

/**
 * Compute the mandateId the same way the contract does:
 *   keccak256(abi.encode(mandate))
 * We use the ABI coder to match Solidity exactly.
 */
function computeMandateId(mandate) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "address", "address", "address",
      "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256",
    ],
    [
      mandate.subscriber,
      mandate.merchant,
      mandate.token,
      mandate.amount,
      mandate.interval,
      mandate.firstDueTime,
      mandate.maxCharges,
      mandate.expiry,
      mandate.nonce,
      mandate.signingDeadline,
    ]
  );
  return ethers.keccak256(encoded);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("SmartMandate", function () {
  // Shared fixture — deployed fresh for each test via loadFixture
  async function deployFixture() {
    const [owner, subscriber, merchant, keeper, attacker] = await ethers.getSigners();

    // Deploy DemoToken
    const DemoToken = await ethers.getContractFactory("DemoToken");
    const token = await DemoToken.deploy();
    await token.waitForDeployment();

    // Deploy SmartMandate
    const SmartMandate = await ethers.getContractFactory("SmartMandate");
    const mandate = await SmartMandate.deploy();
    await mandate.waitForDeployment();

    const tokenAddr    = await token.getAddress();
    const mandateAddr  = await mandate.getAddress();
    const domain       = buildDomain(mandateAddr);

    // Mint 15 DEMO to subscriber
    await token.mint(subscriber.address, ALLOWANCE);

    // Subscriber approves SmartMandate for 15 DEMO
    await token.connect(subscriber).approve(mandateAddr, ALLOWANCE);

    return { token, mandate, domain, owner, subscriber, merchant, keeper, attacker, tokenAddr, mandateAddr };
  }

  /**
   * Register a mandate at REGISTER_AT, return mandateId.
   * Caller sets the clock before calling this if needed.
   */
  async function registerWithClock(ctx) {
    const { mandate, domain, subscriber, merchant, tokenAddr } = ctx;
    const val = buildMandateValue(subscriber.address, merchant.address, tokenAddr);
    const sig = await signMandate(subscriber, domain, val);

    await time.setNextBlockTimestamp(REGISTER_AT);
    const tx = await mandate.connect(subscriber).registerMandate(val, sig);
    await tx.wait();
    return computeMandateId(val);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1 — Happy path: authorised 5-DEMO payment for period 0
  // ───────────────────────────────────────────────────────────────────────────

  describe("Happy path", function () {
    it("charges 5 DEMO for period 0, moves balances, emits ChargePaid", async function () {
      const ctx = await loadFixture(deployFixture);
      const { mandate, token, keeper, subscriber, merchant } = ctx;

      const mandateId = await registerWithClock(ctx);

      // Advance clock to period 0 due time and charge
      await time.setNextBlockTimestamp(P0_START);
      const chargeTx = await mandate.connect(keeper).charge(mandateId, 0);
      const receipt  = await chargeTx.wait();

      // Balance assertions
      const subBalance  = await token.balanceOf(subscriber.address);
      const merBalance  = await token.balanceOf(merchant.address);
      expect(subBalance).to.equal(ALLOWANCE - AMOUNT);  // 10 DEMO
      expect(merBalance).to.equal(AMOUNT);               // 5 DEMO

      // Exactly one ChargePaid event
      const events = receipt.logs
        .map(l => { try { return mandate.interface.parseLog(l); } catch { return null; } })
        .filter(Boolean)
        .filter(e => e.name === "ChargePaid");

      expect(events.length).to.equal(1, "Expected exactly one ChargePaid event");
      const ev = events[0];
      expect(ev.args.mandateId).to.equal(mandateId);
      expect(ev.args.billingPeriod).to.equal(0n);
      expect(ev.args.amount).to.equal(AMOUNT);

      // On-chain settled flag
      expect(await mandate.isSettled(mandateId, 0)).to.be.true;
    });

    it("charges all 3 periods in sequence and completes the mandate", async function () {
      const ctx = await loadFixture(deployFixture);
      const { mandate, token, keeper, subscriber, merchant } = ctx;

      const mandateId = await registerWithClock(ctx);

      for (let i = 0; i < 3; i++) {
        await time.setNextBlockTimestamp(FIRST_DUE + BigInt(i) * INTERVAL);
        await mandate.connect(keeper).charge(mandateId, i);
      }

      expect(await token.balanceOf(subscriber.address)).to.equal(0n);
      expect(await token.balanceOf(merchant.address)).to.equal(ALLOWANCE);
      // All periods settled
      for (let i = 0; i < 3; i++) {
        expect(await mandate.isSettled(mandateId, i)).to.be.true;
      }
      // Mandate state = COMPLETED (3)
      expect(await mandate.mandateState(mandateId)).to.equal(3n);
    });

    it("allows any third-party caller (e.g. keeper or arbitrary address) to submit charge, transferring tokens strictly to merchant", async function () {
      const ctx = await loadFixture(deployFixture);
      const { mandate, token, attacker, subscriber, merchant } = ctx;

      const mandateId = await registerWithClock(ctx);

      // Advance clock to period 0 due time
      await time.setNextBlockTimestamp(P0_START);

      // Arbitrary third party calls charge()
      const tx = await mandate.connect(attacker).charge(mandateId, 0);
      await tx.wait();

      // Tokens flow strictly from subscriber to merchant (attacker receives nothing)
      expect(await token.balanceOf(subscriber.address)).to.equal(ALLOWANCE - AMOUNT);
      expect(await token.balanceOf(merchant.address)).to.equal(AMOUNT);
      expect(await token.balanceOf(attacker.address)).to.equal(0n);
      expect(await mandate.isSettled(mandateId, 0)).to.be.true;
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2 — Error paths
  // ───────────────────────────────────────────────────────────────────────────

  describe("Error: charge too early", function () {
    it("reverts with ChargeTooEarly when called before firstDueTime", async function () {
      const ctx = await loadFixture(deployFixture);
      const { mandate, keeper } = ctx;

      const mandateId = await registerWithClock(ctx);

      // Try to charge 1 second before period 0 opens
      await time.setNextBlockTimestamp(P0_START - 1n);
      await expect(mandate.connect(keeper).charge(mandateId, 0))
        .to.be.revertedWithCustomError(mandate, "ChargeTooEarly");
    });
  });

  describe("Error: duplicate charge", function () {
    it("reverts with InvoiceAlreadySettled on a second charge for the same period", async function () {
      const ctx = await loadFixture(deployFixture);
      const { mandate, keeper } = ctx;

      const mandateId = await registerWithClock(ctx);

      await time.setNextBlockTimestamp(P0_START);
      await mandate.connect(keeper).charge(mandateId, 0);

      // Second charge for the same period
      await time.setNextBlockTimestamp(P0_START + 10n);
      await expect(mandate.connect(keeper).charge(mandateId, 0))
        .to.be.revertedWithCustomError(mandate, "InvoiceAlreadySettled");
    });
  });

  describe("Error: charge after window closes", function () {
    it("reverts with ChargeWindowClosed when period window has passed", async function () {
      const ctx = await loadFixture(deployFixture);
      const { mandate, keeper } = ctx;

      const mandateId = await registerWithClock(ctx);

      // period 0 window is [P0_START, P0_END); try at P0_END
      await time.setNextBlockTimestamp(P0_END);
      await expect(mandate.connect(keeper).charge(mandateId, 0))
        .to.be.revertedWithCustomError(mandate, "ChargeWindowClosed");
    });
  });

  describe("Error: revoked mandate cannot be charged", function () {
    it("reverts with MandateNotActive after subscriber revokes", async function () {
      const ctx = await loadFixture(deployFixture);
      const { mandate, keeper, subscriber } = ctx;

      const mandateId = await registerWithClock(ctx);

      // Subscriber revokes before period 0
      await time.setNextBlockTimestamp(P0_START - 10n);
      await mandate.connect(subscriber).revokeMandate(mandateId);

      // Attempt charge
      await time.setNextBlockTimestamp(P0_START);
      await expect(mandate.connect(keeper).charge(mandateId, 0))
        .to.be.revertedWithCustomError(mandate, "MandateNotActive");
    });

    it("emits MandateRevoked on revocation", async function () {
      const ctx = await loadFixture(deployFixture);
      const { mandate, subscriber } = ctx;

      const mandateId = await registerWithClock(ctx);

      await time.setNextBlockTimestamp(P0_START - 5n);
      await expect(mandate.connect(subscriber).revokeMandate(mandateId))
        .to.emit(mandate, "MandateRevoked")
        .withArgs(mandateId, subscriber.address, P0_START - 5n);
    });
  });

  describe("Error: unauthorized revocation", function () {
    it("reverts with NotSubscriber when a non-subscriber tries to revoke", async function () {
      const ctx = await loadFixture(deployFixture);
      const { mandate, attacker } = ctx;

      const mandateId = await registerWithClock(ctx);

      await time.setNextBlockTimestamp(P0_START - 1n);
      await expect(mandate.connect(attacker).revokeMandate(mandateId))
        .to.be.revertedWithCustomError(mandate, "NotSubscriber");
    });
  });

  describe("Error: expired signing deadline", function () {
    it("reverts with SignatureExpired when registration is after signingDeadline", async function () {
      const ctx = await loadFixture(deployFixture);
      const { mandate, subscriber, merchant, tokenAddr, domain } = ctx;

      const val = buildMandateValue(subscriber.address, merchant.address, tokenAddr);
      const sig = await signMandate(subscriber, domain, val);

      // Register one second after the signing deadline
      await time.setNextBlockTimestamp(SIGNING_DL + 1n);
      await expect(mandate.connect(subscriber).registerMandate(val, sig))
        .to.be.revertedWithCustomError(mandate, "SignatureExpired");
    });
  });

  describe("Error: signature replay", function () {
    it("reverts with NonceMismatch on replay (same nonce used twice)", async function () {
      const ctx = await loadFixture(deployFixture);
      const { mandate, subscriber, merchant, tokenAddr, domain } = ctx;

      const val = buildMandateValue(subscriber.address, merchant.address, tokenAddr);
      const sig = await signMandate(subscriber, domain, val);

      // First registration succeeds
      await time.setNextBlockTimestamp(REGISTER_AT);
      await mandate.connect(subscriber).registerMandate(val, sig);

      // Replay the same signature — nonce is now consumed
      // Build a new mandate with the same nonce=1 (replay attempt)
      await time.setNextBlockTimestamp(REGISTER_AT + 5n);
      await expect(mandate.connect(subscriber).registerMandate(val, sig))
        .to.be.revertedWithCustomError(mandate, "NonceMismatch");
    });
  });

  describe("Error: invalid signature", function () {
    it("reverts with InvalidSignature when wrong signer", async function () {
      const ctx = await loadFixture(deployFixture);
      const { mandate, subscriber, merchant, tokenAddr, domain, attacker } = ctx;

      const val = buildMandateValue(subscriber.address, merchant.address, tokenAddr);
      // Attacker signs instead of subscriber
      const sig = await signMandate(attacker, domain, val);

      await time.setNextBlockTimestamp(REGISTER_AT);
      await expect(mandate.connect(subscriber).registerMandate(val, sig))
        .to.be.revertedWithCustomError(mandate, "InvalidSignature");
    });
  });

  describe("Error: insufficient token balance", function () {
    it("reverts the transferFrom (failed transfer leaves period unsettled / retryable)", async function () {
      const ctx = await loadFixture(deployFixture);
      const { mandate, token, keeper, subscriber, mandateAddr } = ctx;

      const mandateId = await registerWithClock(ctx);

      // Drain subscriber's balance (send all tokens away)
      await token.connect(subscriber).transfer(keeper.address, ALLOWANCE);
      expect(await token.balanceOf(subscriber.address)).to.equal(0n);

      // Charge attempt — transferFrom should revert due to zero balance
      await time.setNextBlockTimestamp(P0_START);
      await expect(mandate.connect(keeper).charge(mandateId, 0))
        .to.be.reverted; // ERC20 insufficient balance

      // Period 0 is NOT settled — still eligible for retry within window
      expect(await mandate.isSettled(mandateId, 0)).to.be.false;

      // Retry after topping up — subscriber receives tokens back
      await token.connect(keeper).transfer(subscriber.address, AMOUNT);
      await token.connect(subscriber).approve(mandateAddr, AMOUNT);

      // Retry within the same period window
      await time.setNextBlockTimestamp(P0_START + 60n);
      await expect(mandate.connect(keeper).charge(mandateId, 0)).to.not.be.reverted;
      expect(await mandate.isSettled(mandateId, 0)).to.be.true;
    });
  });

  describe("Error: insufficient allowance", function () {
    it("reverts when allowance is below the charge amount", async function () {
      const ctx = await loadFixture(deployFixture);
      const { mandate, token, keeper, subscriber, mandateAddr } = ctx;

      const mandateId = await registerWithClock(ctx);

      // Reduce allowance to 0 after registration
      await token.connect(subscriber).approve(mandateAddr, 0n);

      await time.setNextBlockTimestamp(P0_START);
      await expect(mandate.connect(keeper).charge(mandateId, 0))
        .to.be.reverted; // ERC20 insufficient allowance
    });
  });

  describe("Error: out-of-range billing period", function () {
    it("reverts with BillingPeriodOutOfRange for period >= maxCharges", async function () {
      const ctx = await loadFixture(deployFixture);
      const { mandate, keeper } = ctx;

      const mandateId = await registerWithClock(ctx);

      await time.setNextBlockTimestamp(P2_START);
      await expect(mandate.connect(keeper).charge(mandateId, 3))
        .to.be.revertedWithCustomError(mandate, "BillingPeriodOutOfRange");
    });
  });

  describe("Error: mandate expiry during charge", function () {
    it("reverts with MandateExpired if the mandate has expired before the charge", async function () {
      const ctx = await loadFixture(deployFixture);
      const { mandate, keeper, subscriber, merchant, tokenAddr, domain } = ctx;

      // Build a mandate that expires at firstDueTime + 60 (mid period 0 window)
      const earlyExpiry = FIRST_DUE + 60n;
      const val = buildMandateValue(subscriber.address, merchant.address, tokenAddr, {
        expiry:          earlyExpiry,
        signingDeadline: FIRST_DUE,
        nonce:           1n,
      });
      const sig = await signMandate(ctx.subscriber, domain, val);

      await time.setNextBlockTimestamp(REGISTER_AT);
      await mandate.connect(subscriber).registerMandate(val, sig);
      const mid = computeMandateId(val);

      // Charge AFTER expiry but still within P0 window
      await time.setNextBlockTimestamp(earlyExpiry + 1n);
      await expect(mandate.connect(keeper).charge(mid, 0))
        .to.be.revertedWithCustomError(mandate, "MandateExpired");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3 — MandateRegistered event
  // ───────────────────────────────────────────────────────────────────────────

  describe("Event: MandateRegistered", function () {
    it("emits MandateRegistered with correct fields on registration", async function () {
      const ctx = await loadFixture(deployFixture);
      const { mandate, subscriber, merchant, tokenAddr, domain } = ctx;

      const val = buildMandateValue(subscriber.address, merchant.address, tokenAddr);
      const sig = await signMandate(subscriber, domain, val);

      await time.setNextBlockTimestamp(REGISTER_AT);
      await expect(mandate.connect(subscriber).registerMandate(val, sig))
        .to.emit(mandate, "MandateRegistered")
        .withArgs(
          computeMandateId(val),
          subscriber.address,
          merchant.address,
          tokenAddr,
          AMOUNT,
          INTERVAL,
          FIRST_DUE,
          MAX_CHARGES,
          EXPIRY
        );
    });
  });
});
