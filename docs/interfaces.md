# Interface Definitions & Standards — Smart Mandates

> **Project 10 — Automated Subscription & Recurring Billing via Smart Mandates**
> Document Version: 1.0.0 | Status: APPROVED FOR PHASE 1

---

## 1. EIP-712 Signed Mandate Specification

Subscribers authorize recurring billing terms off-chain using the EIP-712 standard for typed structured data hashing and signing. This ensures clear, human-readable review inside mobile wallets while preventing cross-chain or cross-contract replay attacks.

### 1.1 EIP-712 Domain Separator

```json
{
  "name": "SmartMandateBilling",
  "version": "1",
  "chainId": 31337,
  "verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
}
```

*Note: `chainId` is `31337` for local Hardhat node, and `11155111` for Ethereum Sepolia testnet.*

### 1.2 Mandate Type Definition & Signed Fields

The subscriber cryptographically signs the `Mandate` struct containing the following fields:

| Field Name | Solidity Type | Description & Semantic Role |
|------------|---------------|------------------------------|
| `subscriber` | `address` | The paying subscriber's wallet address (must match recovered signer). |
| `merchant` | `address` | Merchant identifier and designated payout address (`payoutAddress`) where debited tokens are transferred. |
| `token` | `address` | Contract address of the ERC-20 token debited for subscription charges. |
| `amount` | `uint256` | Recurring debit amount in token base units (`5000000000000000000` for 5 DEMO). |
| `interval` | `uint256` | Billing frequency in seconds (`120` seconds = 2 minutes). |
| `firstDueTime` | `uint256` | Unix timestamp (in seconds) when billing period 0 opens for payment. |
| `maxCharges` | `uint256` | Maximum number of allowable billing periods (`3`). |
| `expiry` | `uint256` | Unix timestamp (in seconds) after which no registration or charges can occur. |
| `nonce` | `uint256` | One-time sequential nonce per subscriber, preventing signature replay attacks. |
| `signingDeadline` | `uint256` | Unix timestamp after which the signature cannot be submitted for registration. |

> **Architectural Note on `merchant` vs `payoutAddress`**: In `SmartMandate.sol`, `merchant` directly designates the recipient payout address for all settled charges (`transferFrom(subscriber, merchant, amount)`). If a future enhancement requires decoupling merchant management keys from treasury cold storage, an explicit `payoutAddress` field may be introduced; for the Phase 0/Phase 1 standard, `merchant` is the active payout destination.

### 1.3 EIP-712 Type Hash

The contract verifies signatures using the precomputed keccak256 type hash:

```solidity
bytes32 public constant MANDATE_TYPEHASH = keccak256(
    "Mandate(address subscriber,address merchant,address token,"
    "uint256 amount,uint256 interval,uint256 firstDueTime,"
    "uint256 maxCharges,uint256 expiry,uint256 nonce,uint256 signingDeadline)"
);
```

### 1.4 Allowance Decoupling

The ERC-20 token allowance is authorized separately from the EIP-712 signature:
- The subscriber submits `IERC20(token).approve(smartMandateAddress, amount * maxCharges)`.
- For the demo scenario, the allowance is capped at exactly `15000000000000000000` base units (15 DEMO).
- This guarantees that even with an active mandate, the contract cannot debit more than the agreed total cap.

---

## 2. Smart Contract Function Signatures & ABI Specification

### 2.1 `registerMandate`

Submits an off-chain signed mandate to be activated and stored on-chain.

```solidity
function registerMandate(
    Mandate calldata mandate,
    bytes calldata signature
) external returns (bytes32 mandateId);
```

- **Inputs**:
  - `mandate` (`Mandate` struct): The billing parameters agreed to by the subscriber.
  - `signature` (`bytes`): 65-byte ECDSA signature `(r, s, v)` produced via `eth_signTypedData_v4`.
- **Outputs**:
  - `mandateId` (`bytes32`): Deterministic identifier computed as `keccak256(abi.encode(mandate))`.
- **Permissions**: Public (anyone, including the merchant or subscriber, can relay this transaction).
- **Validation & Revert Conditions**:
  - `SignatureExpired(deadline, blockTime)`: If `block.timestamp > mandate.signingDeadline`.
  - `MandateExpired(expiry, blockTime)`: If `block.timestamp > mandate.expiry`.
  - `NonceMismatch(expected, got)`: If `mandate.nonce != currentNonce[mandate.subscriber] + 1`.
  - `InvalidSignature()`: If `ECDSA.recover(digest, signature) != mandate.subscriber`.
  - `DuplicateMandate(mandateId)`: If a mandate with `mandateId` is already registered.
- **Emitted Event**:
  ```solidity
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
  ```

---

### 2.2 `charge`

Executes an authorized recurring charge for a specific billing period.

```solidity
function charge(
    bytes32 mandateId,
    uint256 billingPeriod
) external;
```

- **Inputs**:
  - `mandateId` (`bytes32`): Identifier of the active mandate.
  - `billingPeriod` (`uint256`): Zero-indexed cycle number (`0`, `1`, `2`).
- **Outputs**: None (`void`).
- **Permissions**: Public (typically invoked by the backend keeper / scheduling worker).
- **Validation & Revert Conditions**:
  - `MandateNotActive(mandateId, state)`: If the mandate state is not `ACTIVE` (e.g. `REVOKED` or `COMPLETED`).
  - `BillingPeriodOutOfRange(billingPeriod, maxCharges)`: If `billingPeriod >= mandate.maxCharges`.
  - `InvoiceAlreadySettled(mandateId, billingPeriod)`: If period has already settled.
  - `MandateExpired(expiry, blockTime)`: If `block.timestamp > mandate.expiry`.
  - `ChargeTooEarly(dueTime, blockTime)`: If `block.timestamp < mandate.firstDueTime + billingPeriod * mandate.interval`.
  - `ChargeWindowClosed(windowEnd, blockTime)`: If `block.timestamp >= dueTime + mandate.interval`.
  - ERC-20 Revert: If `transferFrom(subscriber, merchant, amount)` fails (e.g. insufficient token balance or insufficient allowance).
- **Side Effects**:
  - Sets internal mapping `_invoiceSettled[mandateId][billingPeriod] = true`.
  - If `billingPeriod == mandate.maxCharges - 1`, transitions mandate state to `COMPLETED`.
- **Emitted Event** (*Marks invoice PAID*):
  ```solidity
  event ChargePaid(
      bytes32 indexed mandateId,
      uint256 indexed billingPeriod,
      address subscriber,
      address merchant,
      address token,
      uint256 amount,
      uint256 timestamp
  );
  ```

---

### 2.3 `revokeMandate`

Cancels an active mandate, preventing all subsequent charges.

```solidity
function revokeMandate(
    bytes32 mandateId
) external;
```

- **Inputs**:
  - `mandateId` (`bytes32`): Identifier of the mandate to revoke.
- **Outputs**: None (`void`).
- **Permissions**: Restricted: `msg.sender` must be `mandate.subscriber`.
- **Validation & Revert Conditions**:
  - `NotSubscriber(msg.sender, subscriber)`: If caller is not the subscriber.
  - `MandateNotActive(mandateId, state)`: If the mandate is not currently in the `ACTIVE` state.
- **Side Effects**:
  - Transitions mandate state from `ACTIVE` to `REVOKED`.
- **Emitted Event**:
  ```solidity
  event MandateRevoked(
      bytes32 indexed mandateId,
      address indexed subscriber,
      uint256 timestamp
  );
  ```

---

## 3. State Machines & Lifecycle Specifications

### 3.1 Mandate State Machine

```
                   registerMandate()
[UNREGISTERED] ─────────────────────────► [ACTIVE]
                                             │
                       revokeMandate()       │  charge() on period (maxCharges - 1)
                            ▼                ▼
                        [REVOKED]       [COMPLETED]
```

| State Name | Numeric Enum | Description |
|------------|--------------|-------------|
| `UNREGISTERED` | `0` | Default zero-state; mandate hash does not exist in contract storage. |
| `ACTIVE` | `1` | Mandate is verified and active; charges may be executed during valid windows. |
| `REVOKED` | `2` | Subscriber has cancelled; all pending and future charge calls strictly revert. |
| `COMPLETED` | `3` | All `maxCharges` periods have successfully settled; no further charges permitted. |

---

### 3.2 Invoice State Machine

An invoice represents a specific billing cycle and is uniquely keyed by the composite pair:
$$\text{Invoice Key} = (\text{mandateId}, \text{billingPeriod})$$

```
                   charge() attempted & ERC20 reverts
  [PENDING] ────────────────────────────────────────────────► [OPEN]
      │                                                         │
      │  ChargePaid emitted on-chain                            │  Window closes without settlement
      ▼                                                         ▼
  [SETTLED]                                                 [MISSED]
```

| Invoice State | Context | Definition & Transition Triggers |
|---------------|---------|----------------------------------|
| `PENDING` | Backend Worker | Charge transaction has been submitted to the blockchain mempool; awaiting block confirmation. |
| `OPEN` | Backend / Off-chain | Initial charge attempt failed (e.g. insufficient token balance). Period remains within window $[T_n, W_n)$; eligible for retry. |
| `SETTLED` | On-Chain & Off-chain | **Confirmed on-chain event `ChargePaid` has been logged.** Tokens have been debited and transferred to merchant payout address. |
| `MISSED` | Backend & Contract | Window has expired ($block.timestamp \ge W_n$) without settlement. Reverts if attempted. |

---

### 3.3 Payment Attempt State Machine (Backend Keeper)

Every dispatch of a `charge()` call generates an immutable attempt audit record:

| Attempt State | Definition |
|---------------|------------|
| `SUBMITTED` | Transaction signed by keeper EOA and broadcast to RPC node. |
| `CONFIRMED` | Transaction receipt confirmed with status `0x1` and `ChargePaid` event. |
| `REVERTED` | Transaction mined with status `0x0` (e.g. custom contract revert or ERC-20 failure). |
| `FAILED` | Pre-flight error (gas estimation failed, nonce replacement, or RPC network timeout). |

---

## 4. Invoice Identification & Settlement Event

- **Invoice Primary Key**: `(mandateId, billingPeriod)`
  - `mandateId`: `bytes32` (keccak256 hash of the complete `Mandate` struct).
  - `billingPeriod`: `uint256` (0-indexed integer: `0`, `1`, `2`).
- **Settlement Confirmation**: An invoice is strictly marked `SETTLED` (or `PAID`) if and only if the `ChargePaid` event is emitted by the smart contract in a confirmed transaction:
  ```solidity
  event ChargePaid(
      bytes32 indexed mandateId,
      uint256 indexed billingPeriod,
      address subscriber,
      address merchant,
      address token,
      uint256 amount,
      uint256 timestamp
  );
  ```

---

## 5. Representation Standards Across Frontend, Backend, and Contract

To eliminate data type mismatches, deserialization bugs, and rounding errors between the TypeScript/JavaScript frontend, Node.js backend worker, and Solidity contracts, all components adhere to the following representation standards:

| Data Type | Solidity Smart Contract | Backend Worker (Node.js) | Frontend Wallet / UI | JSON Fixtures & REST APIs |
|-----------|-------------------------|--------------------------|----------------------|---------------------------|
| **Timestamps** | `uint256` (Unix seconds) | `BigInt` (Unix seconds) | `number` / `BigInt` (Unix seconds); ISO 8601 for display | Quoted integer string: `"1800000000"` |
| **Token Amounts** | `uint256` (Base units) | `BigInt` (Base units) | `BigInt` (Base units); Decimal string for display | Quoted integer string: `"5000000000000000000"` |
| **Addresses** | `address` (20 bytes) | `string` (EIP-55 Checksummed) | `string` (EIP-55 Checksummed) | Checksummed hex string: `"0x..."` |
| **Bytes32 IDs** | `bytes32` (32 bytes) | `string` (`0x`-prefixed hex) | `string` (`0x`-prefixed hex) | `0x`-prefixed 64-char hex string |
| **Nonces / Periods**| `uint256` | `BigInt` or `number` | `number` | Quoted integer string: `"1"`, `"0"` |

> **Prohibition of Floating-Point Types**: JavaScript `Number` types (64-bit float) must NEVER be used to calculate, store, or serialize token amounts. All monetary arithmetic must use native `BigInt` or `ethers.toBigInt()`.
