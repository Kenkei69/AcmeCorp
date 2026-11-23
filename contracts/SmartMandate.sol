// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @title SmartMandate
 * @notice Pull-payment contract for recurring ERC-20 subscriptions.
 *
 * Flow:
 *   1. Subscriber signs an EIP-712 Mandate off-chain.
 *   2. Subscriber approves this contract for `amount * maxCharges` tokens.
 *   3. Anyone calls registerMandate(mandate, signature) to activate it.
 *   4. At each billing period a keeper calls charge(mandateId, billingPeriod).
 *   5. Subscriber may revoke at any time via revokeMandate(mandateId).
 *
 * Spec: docs/interfaces.md (Phase 0)
 */
contract SmartMandate is EIP712 {
    using ECDSA for bytes32;

    // ─────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────

    struct Mandate {
        address subscriber;
        address merchant;
        address token;
        uint256 amount;
        uint256 interval;
        uint256 firstDueTime;
        uint256 maxCharges;
        uint256 expiry;
        uint256 nonce;
        uint256 signingDeadline;
    }

    enum MandateState {
        UNREGISTERED, // 0 — default
        ACTIVE,       // 1 — charges may be submitted
        REVOKED,      // 2 — subscriber revoked; no further charges
        COMPLETED     // 3 — all periods settled
    }

    struct MandateRecord {
        Mandate      mandate;
        MandateState state;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EIP-712 type hash
    // ─────────────────────────────────────────────────────────────────────────

    bytes32 public constant MANDATE_TYPEHASH = keccak256(
        "Mandate(address subscriber,address merchant,address token,"
        "uint256 amount,uint256 interval,uint256 firstDueTime,"
        "uint256 maxCharges,uint256 expiry,uint256 nonce,uint256 signingDeadline)"
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Per-subscriber nonce, starts at 1 for the first mandate.
    mapping(address => uint256) public currentNonce;

    /// @notice mandateId → mandate record
    mapping(bytes32 => MandateRecord) private _mandates;

    /// @notice mandateId → billingPeriod → settled flag
    mapping(bytes32 => mapping(uint256 => bool)) private _invoiceSettled;

    // ─────────────────────────────────────────────────────────────────────────
    // Events (spec: docs/interfaces.md §3)
    // ─────────────────────────────────────────────────────────────────────────

    event MandateRegistered(
        bytes32 indexed mandateId,
        address indexed subscriber,
        address indexed merchant,
        address token,
        uint256 amount,
        uint256 interval,
        uint256 firstDueTime,
        uint256 maxCharges,
        uint256 expiry
    );

    event ChargePaid(
        bytes32 indexed mandateId,
        uint256 indexed billingPeriod,
        address subscriber,
        address merchant,
        address token,
        uint256 amount,
        uint256 timestamp
    );

    event MandateRevoked(
        bytes32 indexed mandateId,
        address indexed subscriber,
        uint256 timestamp
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Errors (spec: docs/interfaces.md §7)
    // ─────────────────────────────────────────────────────────────────────────

    error SignatureExpired(uint256 deadline, uint256 blockTime);
    error MandateExpired(uint256 expiry, uint256 blockTime);
    error NonceMismatch(uint256 expected, uint256 got);
    error InvalidSignature();
    error DuplicateMandate(bytes32 mandateId);
    error MandateNotActive(bytes32 mandateId, uint8 state);
    error InvoiceAlreadySettled(bytes32 mandateId, uint256 billingPeriod);
    error BillingPeriodOutOfRange(uint256 billingPeriod, uint256 maxCharges);
    error ChargeTooEarly(uint256 dueTime, uint256 blockTime);
    error ChargeWindowClosed(uint256 windowEnd, uint256 blockTime);
    error NotSubscriber(address caller, address subscriber);
    error EmptyBatch();
    error BatchLimitExceeded(uint256 size, uint256 limit);

    event BatchChargeAttemptFailed(
        bytes32 indexed mandateId,
        uint256 indexed billingPeriod,
        bytes revertReason
    );

    struct BatchChargeItem {
        bytes32 mandateId;
        uint256 billingPeriod;
    }

    struct BatchChargeResult {
        bytes32 mandateId;
        uint256 billingPeriod;
        bool success;
        bytes revertReason;
    }

    uint256 public constant MAX_BATCH_SIZE = 50;

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    constructor() EIP712("SmartMandateBilling", "1") {
        // nonces start at 0 in mapping; first mandate per subscriber uses nonce 1
    }

    // ─────────────────────────────────────────────────────────────────────────
    // External functions
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Register a subscriber's signed mandate on-chain.
     * @param mandate   The Mandate struct from the QR checkout flow.
     * @param signature 65-byte ECDSA signature over the EIP-712 hash.
     * @return mandateId keccak256 of the encoded mandate.
     */
    function registerMandate(
        Mandate calldata mandate,
        bytes calldata signature
    ) external returns (bytes32 mandateId) {
        // 1. Signing deadline
        if (block.timestamp > mandate.signingDeadline) {
            revert SignatureExpired(mandate.signingDeadline, block.timestamp);
        }
        // 2. Mandate expiry
        if (block.timestamp > mandate.expiry) {
            revert MandateExpired(mandate.expiry, block.timestamp);
        }
        // 3. Nonce — the contract starts each subscriber at 0 and the first
        //    mandate must carry nonce = 1 (as per Phase 0 fixture convention:
        //    "nonce": "1").  We store the *next* expected nonce as currentNonce,
        //    defaulting to 0, so the first valid call carries nonce == 1.
        uint256 expected = currentNonce[mandate.subscriber] + 1;
        if (mandate.nonce != expected) {
            revert NonceMismatch(expected, mandate.nonce);
        }
        // 4. EIP-712 signature verification
        bytes32 structHash = _mandateStructHash(mandate);
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != mandate.subscriber) {
            revert InvalidSignature();
        }
        // 5. Duplicate check
        mandateId = keccak256(abi.encode(mandate));
        if (_mandates[mandateId].state != MandateState.UNREGISTERED) {
            revert DuplicateMandate(mandateId);
        }

        // 6. Persist and increment nonce
        _mandates[mandateId] = MandateRecord({ mandate: mandate, state: MandateState.ACTIVE });
        currentNonce[mandate.subscriber] = mandate.nonce; // mark nonce used

        emit MandateRegistered(
            mandateId,
            mandate.subscriber,
            mandate.merchant,
            mandate.token,
            mandate.amount,
            mandate.interval,
            mandate.firstDueTime,
            mandate.maxCharges,
            mandate.expiry
        );
    }

    /**
     * @notice Attempt to settle one billing period for an active mandate.
     * @param mandateId     The id returned by registerMandate.
     * @param billingPeriod Zero-based period index.
     */
    function charge(bytes32 mandateId, uint256 billingPeriod) external {
        MandateRecord storage rec = _mandates[mandateId];

        // 1. Mandate must be ACTIVE
        if (rec.state != MandateState.ACTIVE) {
            revert MandateNotActive(mandateId, uint8(rec.state));
        }
        Mandate storage m = rec.mandate;

        // 2. Period in range
        if (billingPeriod >= m.maxCharges) {
            revert BillingPeriodOutOfRange(billingPeriod, m.maxCharges);
        }

        // 3. Invoice not already settled
        if (_invoiceSettled[mandateId][billingPeriod]) {
            revert InvoiceAlreadySettled(mandateId, billingPeriod);
        }

        // 4. Mandate not expired
        if (block.timestamp > m.expiry) {
            revert MandateExpired(m.expiry, block.timestamp);
        }

        // 5. Timing: within [dueTime, windowEnd)
        uint256 dueTime   = m.firstDueTime + billingPeriod * m.interval;
        uint256 windowEnd = dueTime + m.interval;

        if (block.timestamp < dueTime) {
            revert ChargeTooEarly(dueTime, block.timestamp);
        }
        if (block.timestamp >= windowEnd) {
            revert ChargeWindowClosed(windowEnd, block.timestamp);
        }

        // 6. Mark settled before external call (reentrancy guard)
        _invoiceSettled[mandateId][billingPeriod] = true;

        // 7. Transfer tokens — reverts propagate up (insufficient balance/allowance)
        IERC20(m.token).transferFrom(m.subscriber, m.merchant, m.amount);

        // 8. If this was the last period, complete the mandate
        if (billingPeriod == m.maxCharges - 1) {
            rec.state = MandateState.COMPLETED;
        }

        emit ChargePaid(
            mandateId,
            billingPeriod,
            m.subscriber,
            m.merchant,
            m.token,
            m.amount,
            block.timestamp
        );
    }

    /**
     * @notice Bounded batch execution of charges with per-item failure isolation.
     * @param items Array of (mandateId, billingPeriod) pairs to execute.
     * @return results Array of results detailing per-item success and failure reasons.
     */
    function chargeBatch(
        BatchChargeItem[] calldata items
    ) external returns (BatchChargeResult[] memory results) {
        uint256 len = items.length;
        if (len == 0) {
            revert EmptyBatch();
        }
        if (len > MAX_BATCH_SIZE) {
            revert BatchLimitExceeded(len, MAX_BATCH_SIZE);
        }

        results = new BatchChargeResult[](len);

        for (uint256 i = 0; i < len; i++) {
            bytes32 mid = items[i].mandateId;
            uint256 bp = items[i].billingPeriod;
            results[i].mandateId = mid;
            results[i].billingPeriod = bp;

            // Execute via external call to this.charge to isolate reverts per item
            try this.charge(mid, bp) {
                results[i].success = true;
            } catch (bytes memory reason) {
                results[i].success = false;
                results[i].revertReason = reason;
                emit BatchChargeAttemptFailed(mid, bp, reason);
            }
        }
    }

    /**
     * @notice Revoke an active mandate, preventing all future charges.
     * @param mandateId The id returned by registerMandate.
     */
    function revokeMandate(bytes32 mandateId) external {
        MandateRecord storage rec = _mandates[mandateId];

        if (msg.sender != rec.mandate.subscriber) {
            revert NotSubscriber(msg.sender, rec.mandate.subscriber);
        }
        if (rec.state != MandateState.ACTIVE) {
            revert MandateNotActive(mandateId, uint8(rec.state));
        }

        rec.state = MandateState.REVOKED;

        emit MandateRevoked(mandateId, msg.sender, block.timestamp);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Returns the state of a mandate.
    function mandateState(bytes32 mandateId) external view returns (MandateState) {
        return _mandates[mandateId].state;
    }

    /// @notice Returns true if the given period has been settled.
    function isSettled(bytes32 mandateId, uint256 billingPeriod) external view returns (bool) {
        return _invoiceSettled[mandateId][billingPeriod];
    }

    /// @notice Expose the stored mandate struct for testing.
    function getMandate(bytes32 mandateId) external view returns (Mandate memory) {
        return _mandates[mandateId].mandate;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _mandateStructHash(Mandate calldata m) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            MANDATE_TYPEHASH,
            m.subscriber,
            m.merchant,
            m.token,
            m.amount,
            m.interval,
            m.firstDueTime,
            m.maxCharges,
            m.expiry,
            m.nonce,
            m.signingDeadline
        ));
    }
}
