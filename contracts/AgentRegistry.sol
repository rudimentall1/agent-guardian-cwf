// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAgentSmartWallet} from "./interfaces/IAgentSmartWallet.sol";

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title AgentRegistry
/// @notice Identity and lifecycle boundary for delegated autonomous agents.
///
/// @dev This contract answers exactly one question for the rest of the
/// protocol: "is `agent` currently an active, registered delegate of
/// `owner`?" It does NOT decide what an active agent is allowed to do —
/// that is the Execution Guard's job (a later gate) using a separate
/// financial mandate. AgentRegistry is deliberately narrow: identity and
/// lifecycle only.
///
/// Design decisions and why:
///
/// 1. Agent identity IS an address, not a synthetic id. The same address
///    later signs EIP-712 execution intents in the Execution Guard, so
///    there is no indirection between "the key that authorizes
///    transactions" and "the identity checked here".
///
/// 2. Registration requires an EIP-712 signature from the agent key
///    itself, binding (agent, owner, metadataHash, chainid, this
///    contract). This is the anti-squatting / anti-hijack control: no one
///    can register an address as "their agent" without cooperation from
///    whoever holds that address's private key, and the signed owner
///    field means a third party who observes the pending registration
///    transaction cannot front-run it to redirect ownership to
///    themselves — the owner is fixed inside the signed digest, not taken
///    from `msg.sender`. This also makes registration relayer-friendly:
///    any address can submit the transaction, only the signature matters.
///
/// 3. An agent address can be registered EXACTLY ONCE, ever. There is no
///    "release and re-register under a new, uncooperative owner" path in
///    this gate. This is what stops a compromised agent key from
///    unilaterally rebinding an already-registered identity to an
///    attacker-controlled owner while it is still active (or even while
///    deactivated) under its legitimate owner — `register` unconditionally
///    reverts once a record exists, regardless of `active`. Only the
///    current owner can deactivate, reactivate, or transfer ownership.
///    An abandoned agent key is retired by minting a new one; this is an
///    explicit, disclosed scope limitation, not an oversight.
///
/// 4. Ownership transfer forces `active = false` in the same state
///    transition. This closes the "stale authorization after ownership
///    change" window: the new owner must explicitly call `reactivate`
///    before the (unchanged) agent key can be treated as live again,
///    rather than silently continuing to operate under a new owner's
///    context the instant ownership changes.
///
/// 5. `metadataHash` is a bare commitment to off-chain metadata. It is
///    informational only and MUST NOT be used by any downstream
///    authorization decision — see docs/protocol-spec.md.
///
/// 6. No upgradeability. The registry's job is small and stable enough
///    that a new protocol version is a new contract with its own EIP-712
///    domain, not an in-place upgrade of this one. See
///    docs/adr/0001-no-upgradeability.md.
contract AgentRegistry is EIP712 {
    struct Agent {
        address owner;
        bool active;
        bytes32 metadataHash;
        uint64 registeredAt;
        address recoveryAgent;
        /// @notice Canonical custody wallet for this agent. Zero until the
        /// current owner explicitly binds one. The binding is one-time.
        address wallet;
    }

    /// @dev keccak256("AgentRegistration(address agent,address owner,bytes32 metadataHash)")
    bytes32 private constant AGENT_REGISTRATION_TYPEHASH =
        keccak256("AgentRegistration(address agent,address owner,bytes32 metadataHash)");

    mapping(address => Agent) private _agents;

    event AgentRegistered(address indexed agent, address indexed owner, bytes32 metadataHash);
    event AgentDeactivated(address indexed agent, address indexed owner);
    event AgentReactivated(address indexed agent, address indexed owner);
    event AgentOwnershipTransferred(address indexed agent, address indexed previousOwner, address indexed newOwner);
    event RecoveryGuardianSet(address indexed agent, address indexed guardian);
    event RecoveryExecuted(address indexed agent, address indexed guardian);
    event AgentWalletBound(address indexed agent, address indexed wallet, address indexed owner);

    error ZeroAddress();
    error AgentAlreadyRegistered(address agent);
    error AgentNotRegistered(address agent);
    error NotAgentOwner(address agent, address caller);
    error AgentAlreadyActive(address agent);
    error AgentAlreadyInactive(address agent);
    error InvalidSignature();
    error SameOwner();
    error NotRecoveryGuardian(address agent, address caller);
    error WalletAlreadyBound(address agent, address wallet);
    error WalletNotContract(address wallet);
    error WalletAgentMismatch(address wallet, address walletAgent, address expectedAgent);
    error WalletOwnerMismatch(address wallet, address walletOwner, address expectedOwner);
    error WalletOwnershipRequiredForTransfer(address wallet, address walletOwner, address expectedNewOwner);

    constructor() EIP712("AgentRegistry", "1") {}

    /// @notice Register `agent` as a delegate of `owner`. Callable by
    /// anyone (relayer-friendly) — the only thing that matters is a valid
    /// signature from `agent` itself over the exact (agent, owner,
    /// metadataHash) tuple, domain-separated by chain id and this
    /// contract's address.
    /// @dev Reverts unconditionally if `agent` has ever been registered
    /// before, even if that prior registration is now inactive. See
    /// contract-level NatSpec, point 3.
    function register(address agent, address owner, bytes32 metadataHash, bytes calldata signature) external {
        if (agent == address(0) || owner == address(0)) revert ZeroAddress();
        if (_agents[agent].owner != address(0)) revert AgentAlreadyRegistered(agent);

        bytes32 structHash = keccak256(abi.encode(AGENT_REGISTRATION_TYPEHASH, agent, owner, metadataHash));
        bytes32 digest = _hashTypedDataV4(structHash);
        // ERC-1271-aware: an EOA agent proves control the usual way; a
        // contract/TEE/AA agent proves control via its own
        // isValidSignature. This closes the EOA-only limitation recorded
        // in docs/threat-model.md, "Gate 1 status".
        if (!SignatureChecker.isValidSignatureNow(agent, digest, signature)) revert InvalidSignature();

        _agents[agent] = Agent({owner: owner, active: true, metadataHash: metadataHash, registeredAt: uint64(block.timestamp), recoveryAgent: address(0), wallet: address(0)});

        emit AgentRegistered(agent, owner, metadataHash);
    }

    /// @notice Deactivate `agent`. Only the current owner may call this.
    function deactivate(address agent) external {
        Agent storage record = _agents[agent];
        if (record.owner == address(0)) revert AgentNotRegistered(agent);
        if (record.owner != msg.sender) revert NotAgentOwner(agent, msg.sender);
        if (!record.active) revert AgentAlreadyInactive(agent);

        record.active = false;
        emit AgentDeactivated(agent, msg.sender);
    }

    /// @notice Reactivate `agent`. Only the current owner may call this.
    function reactivate(address agent) external {
        Agent storage record = _agents[agent];
        if (record.owner == address(0)) revert AgentNotRegistered(agent);
        if (record.owner != msg.sender) revert NotAgentOwner(agent, msg.sender);
        if (record.active) revert AgentAlreadyActive(agent);

        record.active = true;
        emit AgentReactivated(agent, msg.sender);
    }

    /// @notice Transfer ownership of `agent` to `newOwner`. The agent is
    /// forced inactive as part of the same transition; `newOwner` must
    /// explicitly call `reactivate` to resume authorization. See
    /// contract-level NatSpec, point 4.
    function transferAgentOwnership(address agent, address newOwner) external {
        Agent storage record = _agents[agent];
        if (record.owner == address(0)) revert AgentNotRegistered(agent);
        if (record.owner != msg.sender) revert NotAgentOwner(agent, msg.sender);
        if (newOwner == address(0)) revert ZeroAddress();
        if (newOwner == record.owner) revert SameOwner();

        // The canonical wallet is independently owned. If it already exists,
        // require custody to move first so registry owner and wallet owner
        // can never diverge after this function returns successfully.
        if (record.wallet != address(0)) {
            address walletOwner = IAgentSmartWallet(record.wallet).owner();
            if (walletOwner != newOwner) {
                revert WalletOwnershipRequiredForTransfer(record.wallet, walletOwner, newOwner);
            }
        }

        address previousOwner = record.owner;
        record.owner = newOwner;
        record.active = false;

        // Recovery authority is owner-specific. Never carry the previous
        // owner`s guardian into the new owner`s security domain. The new
        // owner must explicitly configure a fresh guardian after handoff.
        if (record.recoveryAgent != address(0)) {
            record.recoveryAgent = address(0);
            emit RecoveryGuardianSet(agent, address(0));
        }

        emit AgentOwnershipTransferred(agent, previousOwner, newOwner);
    }

    /// @notice True only if `agent` is registered AND currently active.
    /// This is the single check downstream contracts (e.g. the Execution
    /// Guard) must use — never read `owner`/`active` separately and infer
    /// state, since a not-yet-registered agent has `owner == address(0)`
    /// and `active == false` by construction, which already satisfies
    /// "unregistered agent cannot execute" with no special-casing.
    function isActiveAgent(address agent) external view returns (bool) {
        return _agents[agent].active;
    }

    function getAgent(address agent) external view returns (Agent memory) {
        return _agents[agent];
    }

    function ownerOf(address agent) external view returns (address) {
        return _agents[agent].owner;
    }

    /// @notice Bind the agent to its canonical custody wallet. The binding
    /// is immutable once set, so a compromised agent cannot switch the
    /// execution target to another wallet. The owner may perform this only
    /// while controlling the registered agent.
    function bindWallet(address agent, address wallet) external {
        Agent storage record = _agents[agent];
        if (record.owner == address(0)) revert AgentNotRegistered(agent);
        if (record.owner != msg.sender) revert NotAgentOwner(agent, msg.sender);
        if (wallet == address(0)) revert ZeroAddress();
        if (record.wallet != address(0)) revert WalletAlreadyBound(agent, record.wallet);
        if (wallet.code.length == 0) revert WalletNotContract(wallet);

        address walletAgent = IAgentSmartWallet(wallet).agent();
        if (walletAgent != agent) revert WalletAgentMismatch(wallet, walletAgent, agent);

        address walletOwner = IAgentSmartWallet(wallet).owner();
        if (walletOwner != msg.sender) revert WalletOwnerMismatch(wallet, walletOwner, msg.sender);

        record.wallet = wallet;
        emit AgentWalletBound(agent, wallet, msg.sender);
    }

    /// @notice Return the canonical wallet bound to `agent`, or zero if the
    /// owner has not completed wallet binding yet.
    function walletOf(address agent) external view returns (address) {
        return _agents[agent].wallet;
    }


    /// @notice Configure emergency recovery guardian.
    /// Guardian cannot take ownership. Guardian can only disable the agent.
    function setRecoveryGuardian(
        address agent,
        address guardian
    ) external {
        Agent storage record = _agents[agent];

        if (record.owner == address(0)) revert AgentNotRegistered(agent);
        if (record.owner != msg.sender) revert NotAgentOwner(agent, msg.sender);
        if (guardian == address(0)) revert ZeroAddress();

        record.recoveryAgent = guardian;

        emit RecoveryGuardianSet(agent, guardian);
    }

    /// @notice Emergency recovery action.
    /// Disables execution without changing ownership.
    function executeRecovery(
        address agent
    ) external {
        Agent storage record = _agents[agent];

        if (record.owner == address(0)) revert AgentNotRegistered(agent);
        if (record.recoveryAgent != msg.sender) {
            revert NotRecoveryGuardian(agent, msg.sender);
        }

        record.active = false;

        emit RecoveryExecuted(agent, msg.sender);
    }

}
