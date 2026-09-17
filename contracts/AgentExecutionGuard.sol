// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";
import {IPolicyRegistry} from "./interfaces/IPolicyRegistry.sol";
import {IAgentSmartWallet} from "./interfaces/IAgentSmartWallet.sol";

/// @title AgentExecutionGuard
/// @notice Gate 2 + remediation + Gate 4A + Gate 4B execution boundary.
/// Enforces signed intents, replay protection, immutable policy authority,
/// exact call authorization, per-policy daily native-ETH limits, and
/// owner approvals for executions above the policy approval threshold.
contract AgentExecutionGuard is EIP712, ReentrancyGuard {
    bytes32 private constant EXECUTION_INTENT_TYPEHASH =
        keccak256(
            "ExecutionIntent(address agent,address wallet,address target,uint256 value,bytes32 calldataHash,uint256 nonce,uint256 deadline,bytes32 policyHash)"
        );

    bytes32 private constant EXECUTION_APPROVAL_TYPEHASH = keccak256(
        "ExecutionApproval(address agent,address wallet,address target,uint256 value,bytes32 calldataHash,uint256 nonce,uint256 deadline,bytes32 policyHash,uint256 approvalDeadline)"
    );

    IAgentRegistry public immutable REGISTRY;
    IPolicyRegistry public immutable POLICY_REGISTRY;

    mapping(address => uint256) public nextNonce;
    mapping(address => bool) public pausedAgents;

    struct DailySpend {
        uint64 day;
        uint128 spent;
    }

    /// @notice Cumulative successful native-value spend for each immutable policy's current UTC day.
    mapping(bytes32 => DailySpend) public dailySpend;
    event AgentPaused(address indexed agent);
    event AgentUnpaused(address indexed agent);

    event IntentExecuted(
        address indexed agent, address indexed wallet, address indexed target, uint256 nonce, bytes32 policyHash
    );

    error ZeroAddress();
    error AgentNotActive(address agent);
    error AgentExecutionPaused(address agent);
    error NotPolicyOwner();
    error IntentExpired(uint256 deadline, uint256 currentTimestamp);
    error InvalidNonce(uint256 provided, uint256 expected);
    error InvalidSignature();
    error InvalidApprovalSignature();
    error ApprovalRequired(bytes32 policyHash, uint256 value, uint256 threshold);
    error ApprovalExpired(uint256 approvalDeadline, uint256 currentTimestamp);
    error ApprovalDeadlineAfterIntent(uint256 approvalDeadline, uint256 intentDeadline);
    error ExecutionFailed(bytes returndata);
    error GuardMustNotReceiveValue(uint256 value);
    error PolicyAgentMismatch(bytes32 policyHash, address intentAgent, address boundAgent);
    error PolicyOwnerMismatch(bytes32 policyHash, address registeredOwner, address policyOwner);
    error PolicyNotActive(bytes32 policyHash);
    error PolicyOutsideTimeWindow(bytes32 policyHash, uint256 currentTimestamp);
    error MaxTxValueExceeded(uint256 value, bytes32 policyHash);
    error DailyLimitExceeded(bytes32 policyHash, uint256 value, uint256 spent, uint256 dailyLimit);
    error DailySpendOverflow(bytes32 policyHash);
    error CallNotAuthorized(address target, bytes4 selector, bool isNativeTransfer);
    error WalletNotBoundToThisGuard(address wallet, address walletsGuard);
    error WalletNotBoundToAgent(address wallet, address walletAgent, address intentAgent);
    error WalletNotCanonical(address wallet, address expectedWallet, address agent);
    error WalletOwnerMismatch(address wallet, address walletOwner, address registeredOwner);
    error WalletNotContract(address wallet);
    error NativeTransferRequiresWalletCustody(uint256 value);

    constructor(address registry, address policyRegistry) EIP712("AgentExecutionGuard", "1") {
        if (registry == address(0) || policyRegistry == address(0)) revert ZeroAddress();
        REGISTRY = IAgentRegistry(registry);
        POLICY_REGISTRY = IPolicyRegistry(policyRegistry);
    }

    function pauseAgent(address agent) external {
        if (REGISTRY.ownerOf(agent) != msg.sender) {
            revert NotPolicyOwner();
        }
        pausedAgents[agent] = true;
        emit AgentPaused(agent);
    }
    function unpauseAgent(address agent) external {
        if (REGISTRY.ownerOf(agent) != msg.sender) {
            revert NotPolicyOwner();
        }
        pausedAgents[agent] = false;
        emit AgentUnpaused(agent);
    }
    /// @notice Execute a function-call-only intent (value == 0) that does
    /// not require an owner approval.
    /// @dev Function-call-only: reverts with
    /// `NativeTransferRequiresWalletCustody` if `value > 0`. Native
    /// transfers must go through `executeFromWallet`, funded by the
    /// agent's own `AgentSmartWallet` — this Guard never holds or moves
    /// funds on its own account. (An earlier version of this function
    /// moved value via `msg.value`; that was removed when
    /// `GuardMustNotReceiveValue` was added, but this function kept
    /// accepting nonzero `value` and silently reverting with a generic
    /// `ExecutionFailed` instead of an explicit error — fixed here.) If
    /// the policy requires approval, this function reverts with
    /// `ApprovalRequired`; callers must use `executeWithApproval`.
    function execute(
        address agent,
        address wallet,
        address target,
        uint256 value,
        bytes calldata data,
        uint256 nonce,
        uint256 deadline,
        bytes32 policyHash,
        bytes calldata signature
    ) external nonReentrant returns (bytes memory returndata) {
        return _execute(agent, wallet, target, value, data, nonce, deadline, policyHash, signature, 0, hex"", false);
    }

    /// @notice Execute a function-call-only intent (value == 0) together
    /// with a current-owner approval when the policy's value threshold
    /// requires one. See `execute`: reverts with
    /// `NativeTransferRequiresWalletCustody` if `value > 0` — use
    /// `executeWithApprovalFromWallet` for native transfers.
    function executeWithApproval(
        address agent,
        address wallet,
        address target,
        uint256 value,
        bytes calldata data,
        uint256 nonce,
        uint256 deadline,
        bytes32 policyHash,
        bytes calldata signature,
        uint256 approvalDeadline,
        bytes memory approvalSignature
    ) external nonReentrant returns (bytes memory returndata) {
        return _execute(
            agent,
            wallet,
            target,
            value,
            data,
            nonce,
            deadline,
            policyHash,
            signature,
            approvalDeadline,
            approvalSignature,
            false
        );
    }

    /// @notice Execute an intent that does not require an owner approval,
    /// sourcing native value from `wallet`'s own balance via
    /// `IAgentSmartWallet.execute` instead of from `msg.value`.
    /// @dev `wallet` must have this Guard set as its `executionGuard`
    /// (checked live, on every call, by `AgentSmartWallet` itself via its
    /// `onlyExecutionGuard` modifier) вЂ” this function does not, and must
    /// not, take that binding on faith. Reverts if any ETH is attached to
    /// this call: in the wallet-custody model, value comes exclusively
    /// from the wallet's balance, never from the caller.
    function executeFromWallet(
        address agent,
        address wallet,
        address target,
        uint256 value,
        bytes calldata data,
        uint256 nonce,
        uint256 deadline,
        bytes32 policyHash,
        bytes calldata signature
    ) external nonReentrant returns (bytes memory returndata) {
        return _execute(agent, wallet, target, value, data, nonce, deadline, policyHash, signature, 0, hex"", true);
    }

    /// @notice `executeWithApproval`, but sourcing value from `wallet`'s
    /// own balance. See `executeFromWallet` for the custody model.
    function executeWithApprovalFromWallet(
        address agent,
        address wallet,
        address target,
        uint256 value,
        bytes calldata data,
        uint256 nonce,
        uint256 deadline,
        bytes32 policyHash,
        bytes calldata signature,
        uint256 approvalDeadline,
        bytes memory approvalSignature
    ) external nonReentrant returns (bytes memory returndata) {
        return _execute(
            agent,
            wallet,
            target,
            value,
            data,
            nonce,
            deadline,
            policyHash,
            signature,
            approvalDeadline,
            approvalSignature,
            true
        );
    }

    function _execute(
        address agent,
        address wallet,
        address target,
        uint256 value,
        bytes calldata data,
        uint256 nonce,
        uint256 deadline,
        bytes32 policyHash,
        bytes calldata signature,
        uint256 approvalDeadline,
        bytes memory approvalSignature,
        bool fromWallet
    ) internal returns (bytes memory returndata) {
        if (agent == address(0) || wallet == address(0) || target == address(0)) revert ZeroAddress();
        if (wallet.code.length == 0) revert WalletNotContract(wallet);
        if (pausedAgents[agent]) {
            revert AgentExecutionPaused(agent);
        }
        if (block.timestamp > deadline) revert IntentExpired(deadline, block.timestamp);
        if (msg.value != 0) revert GuardMustNotReceiveValue(msg.value);

        (IPolicyRegistry.CallKind callKind, bytes4 selector) = classifyCalldata(data);

        if (!REGISTRY.isActiveAgent(agent)) revert AgentNotActive(agent);
        address registeredOwner = REGISTRY.ownerOf(agent);

        (address policyOwner, address boundAgent, bool policyActive, bool withinWindow, bool valueAllowed, bool callAllowed) =
            POLICY_REGISTRY.checkAuthorization(policyHash, target, callKind, selector, value);

        if (boundAgent != agent) revert PolicyAgentMismatch(policyHash, agent, boundAgent);
        if (policyOwner != registeredOwner) revert PolicyOwnerMismatch(policyHash, registeredOwner, policyOwner);
        if (!policyActive) revert PolicyNotActive(policyHash);
        if (!withinWindow) revert PolicyOutsideTimeWindow(policyHash, block.timestamp);
        if (!valueAllowed) revert MaxTxValueExceeded(value, policyHash);
        if (!callAllowed) revert CallNotAuthorized(target, selector, callKind == IPolicyRegistry.CallKind.NativeTransfer);

        uint256 expected = nextNonce[agent];
        if (nonce != expected) revert InvalidNonce(nonce, expected);

        bytes32 policyId = POLICY_REGISTRY.policyIdOfHash(policyHash);
        IPolicyRegistry.Mandate memory mandate = POLICY_REGISTRY.getMandate(policyId);

        uint64 day = uint64(block.timestamp / 1 days);
        DailySpend memory current = dailySpend[policyHash];
        uint128 spentToday = current.day == day ? current.spent : 0;
        uint128 amount = uint128(value); // safe after maxTxValue/valueAllowed check

        if (uint256(spentToday) + uint256(amount) > uint256(mandate.dailyLimit)) {
            revert DailyLimitExceeded(policyHash, value, spentToday, mandate.dailyLimit);
        }

        bool approvalRequired = value > mandate.approvalThreshold;
        if (approvalRequired) {
            if (approvalSignature.length == 0) {
                revert ApprovalRequired(policyHash, value, mandate.approvalThreshold);
            }
            if (approvalDeadline > deadline) revert ApprovalDeadlineAfterIntent(approvalDeadline, deadline);
            if (block.timestamp > approvalDeadline) revert ApprovalExpired(approvalDeadline, block.timestamp);

            bytes32 approvalDigest = hashApproval(
                agent,
                wallet,
                target,
                value,
                keccak256(data),
                nonce,
                deadline,
                policyHash,
                approvalDeadline
            );
            if (!SignatureChecker.isValidSignatureNow(registeredOwner, approvalDigest, approvalSignature)) {
                revert InvalidApprovalSignature();
            }
        }

        bytes32 digest = hashIntent(agent, wallet, target, value, keccak256(data), nonce, deadline, policyHash);
        // SignatureChecker: plain ECDSA for EOA agents, ERC-1271
        // `isValidSignature` for contract/TEE/AA agents. Strict superset
        // of `ECDSA.recover` for the EOA case (see docs/adr/0009).
        if (!SignatureChecker.isValidSignatureNow(agent, digest, signature)) revert InvalidSignature();

        // Only inspect the supplied wallet contract after the intent has
        // passed cryptographic verification. This prevents an attacker from
        // using an arbitrary wallet-shaped contract as a pre-signature
        // execution surface while still enforcing a one-wallet-per-agent
        // custody invariant.
        address canonicalWallet = REGISTRY.walletOf(agent);
        if (canonicalWallet == address(0) || canonicalWallet != wallet) {
            revert WalletNotCanonical(wallet, canonicalWallet, agent);
        }

        address walletAgent = IAgentSmartWallet(wallet).agent();
        if (walletAgent != agent) revert WalletNotBoundToAgent(wallet, walletAgent, agent);

        address walletOwner = IAgentSmartWallet(wallet).owner();
        if (walletOwner != registeredOwner) revert WalletOwnerMismatch(wallet, walletOwner, registeredOwner);

        if (fromWallet && IAgentSmartWallet(wallet).executionGuard() != address(this)) {
            revert WalletNotBoundToThisGuard(wallet, IAgentSmartWallet(wallet).executionGuard());
        }

        if (uint256(spentToday) + uint256(amount) > type(uint128).max) {
            revert DailySpendOverflow(policyHash);
        }

        dailySpend[policyHash] = DailySpend({day: day, spent: spentToday + amount});
        nextNonce[agent] = nonce + 1;

        bool success;
        bytes memory ret;
        if (fromWallet) {
            // Custody path: value is drawn from `wallet`'s own balance.
            // `AgentSmartWallet.execute` reverts closed if this Guard is
            // not its currently-configured `executionGuard`.
            // slither-disable-next-line arbitrary-send-eth -- `target` and
            // `value` come from a signed, policy-authorized intent
            // (target/selector pair, maxTxValue, dailyLimit, nonce,
            // deadline, and approval-threshold all already checked
            // above); `wallet` only forwards funds it holds itself and
            // only to a Guard it explicitly configured as its
            // executionGuard.
            try IAgentSmartWallet(wallet).execute(target, value, data) returns (bytes memory walletRet) {
                success = true;
                ret = walletRet;
            } catch (bytes memory walletErr) {
                success = false;
                ret = walletErr;
            }
        } else {
            // Function-call-only path: this Guard never holds a balance
            // (see `GuardMustNotReceiveValue` above) and has no
            // `receive`/`fallback`, so it cannot forward any native
            // value here under any circumstance. Reject explicitly
            // rather than let `target.call{value: value}` silently fail
            // with a generic `ExecutionFailed` for the wrong reason.
            if (value > 0) revert NativeTransferRequiresWalletCustody(value);
            (success, ret) = target.call(data);
        }
        if (!success) revert ExecutionFailed(ret);

        emit IntentExecuted(agent, wallet, target, nonce, policyHash);
        return ret;
    }

    function classifyCalldata(bytes calldata data) public pure returns (IPolicyRegistry.CallKind, bytes4 selector) {
        if (data.length == 0) return (IPolicyRegistry.CallKind.NativeTransfer, bytes4(0));
        if (data.length >= 4) return (IPolicyRegistry.CallKind.FunctionCall, bytes4(data[0:4]));
        return (IPolicyRegistry.CallKind.Malformed, bytes4(0));
    }

    function hashIntent(
        address agent,
        address wallet,
        address target,
        uint256 value,
        bytes32 calldataHash,
        uint256 nonce,
        uint256 deadline,
        bytes32 policyHash
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(EXECUTION_INTENT_TYPEHASH, agent, wallet, target, value, calldataHash, nonce, deadline, policyHash)
        );
        return _hashTypedDataV4(structHash);
    }

    function hashApproval(
        address agent,
        address wallet,
        address target,
        uint256 value,
        bytes32 calldataHash,
        uint256 nonce,
        uint256 deadline,
        bytes32 policyHash,
        uint256 approvalDeadline
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                EXECUTION_APPROVAL_TYPEHASH,
                agent,
                wallet,
                target,
                value,
                calldataHash,
                nonce,
                deadline,
                policyHash,
                approvalDeadline
            )
        );
        return _hashTypedDataV4(structHash);
    }
}
