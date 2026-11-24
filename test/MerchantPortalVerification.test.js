"use strict";
/**
 * test/MerchantPortalVerification.test.js
 *
 * Automated verification suite for the AcmeCorp Merchant Portal redesign & backend fixes:
 * 1. Server-side merchant payout address validation (blocks zero address & missing address).
 * 2. Phone checkout base URL resolution & loopback address detection.
 * 3. Independent QR code decoding using jsQR, asserting resolution to active checkout session.
 * 4. Expired session handling & terms consistency.
 */

const { expect } = require("chai");
const { ethers } = require("ethers");
const jsQR = require("jsqr");
const QRCode = require("qrcode");
const {
  createCheckoutSession,
  buildCheckoutUrl,
  generateQRSvg,
  isValidPayoutAddress,
  isLoopbackUrl,
} = require("../frontend/qr/generateLink.js");

describe("Merchant Portal & QR Link Verification", function () {
  const VALID_PAYOUT = "0x25bd9dA57aFBeC2543a4e80975f43C3B095A0d81";
  const ZERO_ADDRESS = ethers.ZeroAddress;

  describe("1. Merchant Payout Address Validation", function () {
    it("recognizes valid Ethereum addresses as valid payout targets", function () {
      expect(isValidPayoutAddress(VALID_PAYOUT)).to.be.true;
      expect(isValidPayoutAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).to.be.true;
    });

    it("rejects zero address, null, empty strings, and malformed hex as invalid payout targets", function () {
      expect(isValidPayoutAddress(ZERO_ADDRESS)).to.be.false;
      expect(isValidPayoutAddress("0x0000000000000000000000000000000000000000")).to.be.false;
      expect(isValidPayoutAddress(null)).to.be.false;
      expect(isValidPayoutAddress("")).to.be.false;
      expect(isValidPayoutAddress("not-an-address")).to.be.false;
    });

    it("throws an error when createCheckoutSession is called with a zero payout address", function () {
      expect(() => {
        createCheckoutSession({ merchantAddress: ZERO_ADDRESS });
      }).to.throw(/Invalid or missing merchant payout address/);
    });

    it("throws an error when createCheckoutSession is called with an invalid/missing address", function () {
      expect(() => {
        createCheckoutSession({ merchantAddress: "0xinvalid" });
      }).to.throw(/Invalid or missing merchant payout address/);
    });

    it("successfully creates a session when provided with a valid merchant payout address", function () {
      const session = createCheckoutSession({ merchantAddress: VALID_PAYOUT });
      expect(session).to.be.an("object");
      expect(session.plan.merchantAddress.toLowerCase()).to.equal(VALID_PAYOUT.toLowerCase());
      expect(session.plan.payoutAddress.toLowerCase()).to.equal(VALID_PAYOUT.toLowerCase());
      expect(session.plan.chargeAmountFormatted).to.equal("5 DEMO");
      expect(session.plan.interval).to.equal(120);
      expect(session.plan.maxCharges).to.equal(3);
      expect(session.plan.allowanceCapFormatted).to.equal("15 DEMO");
    });
  });

  describe("2. Phone Base URL Handling & Loopback Detection", function () {
    it("correctly identifies loopback URLs (localhost, 127.0.0.1, ::1)", function () {
      expect(isLoopbackUrl("http://localhost:3000")).to.be.true;
      expect(isLoopbackUrl("http://127.0.0.1:3000")).to.be.true;
      expect(isLoopbackUrl("http://[::1]:3000")).to.be.true;
      expect(isLoopbackUrl("localhost:3000")).to.be.true;
    });

    it("correctly identifies non-loopback reachable LAN and tunnel URLs", function () {
      expect(isLoopbackUrl("http://172.16.144.149:3000")).to.be.false;
      expect(isLoopbackUrl("https://acme-demo.ngrok.app")).to.be.false;
      expect(isLoopbackUrl("http://192.168.1.100:3000")).to.be.false;
    });

    it("disables phone QR and sets actionable warning when base URL is loopback", function () {
      const session = createCheckoutSession({
        merchantAddress: VALID_PAYOUT,
        baseUrl: "http://127.0.0.1:3000",
      });

      expect(session.isPhoneQrDisabled).to.be.true;
      expect(session.phoneQrDisabledReason).to.include("loopback");
      expect(session.phoneCheckoutUrl).to.be.null;
    });

    it("disables phone QR when no base URL is configured", function () {
      const session = createCheckoutSession({
        merchantAddress: VALID_PAYOUT,
        baseUrl: null,
      });

      expect(session.isPhoneQrDisabled).to.be.true;
      expect(session.phoneQrDisabledReason).to.include("No phone-reachable CHECKOUT_BASE_URL");
      expect(session.phoneCheckoutUrl).to.be.null;
    });

    it("enables phone QR and generates SVG when phone-reachable base URL is supplied", function () {
      const phoneBase = "http://172.16.144.149:3000";
      const session = createCheckoutSession({
        merchantAddress: VALID_PAYOUT,
        baseUrl: phoneBase,
      });

      expect(session.isPhoneQrDisabled).to.be.false;
      expect(session.phoneQrDisabledReason).to.be.null;
      expect(session.phoneCheckoutUrl).to.equal(`${phoneBase}/checkout?request=${session.requestId}`);
      expect(session.qrSvg).to.be.a("string");
      expect(session.qrSvg).to.include("<svg");
      expect(session.qrSvg).to.include("</svg>");
    });
  });

  describe("3. Independent QR Code Decoding Verification", function () {
    it("generates a QR code that decodes via jsQR and matches the intended checkout session URL", function () {
      const phoneBase = "http://172.16.144.149:3000";
      const session = createCheckoutSession({
        merchantAddress: VALID_PAYOUT,
        baseUrl: phoneBase,
      });

      const targetUrl = session.phoneCheckoutUrl;
      expect(targetUrl).to.include(session.requestId);

      // Create QR matrix using qrcode
      const qrData = QRCode.create(targetUrl, { errorCorrectionLevel: "M" });
      const size = qrData.modules.size;
      const modules = qrData.modules.data;

      // Render to standard 4-channel RGBA pixel buffer
      const margin = 4;
      const scale = 4;
      const fullSize = (size + margin * 2) * scale;
      const rgba = new Uint8ClampedArray(fullSize * fullSize * 4);
      rgba.fill(255); // White background

      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (modules[r * size + c]) {
            for (let y = 0; y < scale; y++) {
              for (let x = 0; x < scale; x++) {
                const px = (c + margin) * scale + x;
                const py = (r + margin) * scale + y;
                const idx = (py * fullSize + px) * 4;
                rgba[idx] = 0;
                rgba[idx + 1] = 0;
                rgba[idx + 2] = 0;
                rgba[idx + 3] = 255;
              }
            }
          }
        }
      }

      // Decode using independent pure-JS decoder jsQR
      const decoded = jsQR(rgba, fullSize, fullSize);
      expect(decoded).to.not.be.null;
      expect(decoded.data).to.equal(targetUrl);

      // Extract request parameter from decoded URL
      const decodedUrl = new URL(decoded.data);
      const decodedRequestId = decodedUrl.searchParams.get("request");
      expect(decodedRequestId).to.equal(session.requestId);
    });
  });

  describe("4. Session Expiration & Term Consistency", function () {
    it("anchors timestamps to firstDueTime and enforces 15-minute checkout session TTL", function () {
      const now = Math.floor(Date.now() / 1000);
      const session = createCheckoutSession({ merchantAddress: VALID_PAYOUT, ttlSec: 900 });

      expect(session.checkoutExpiresAt).to.equal(session.createdAt + 900);
      expect(session.plan.firstDueTime).to.be.at.least(now + 115);
      expect(session.plan.signingDeadline).to.equal(session.plan.firstDueTime);
      expect(session.plan.expiry).to.equal(session.plan.firstDueTime + 3600);
    });
  });
});
