// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAgentRegistry} from "../interfaces/IAgentRegistry.sol";

/// @notice TEST-ONLY mock. Lets Gate 2 tests toggle agent activity
/// directly instead of going through the real AgentRegistry's
/// EIP-712-signed registration flow, which is orthogonal to what Gate 2
/// is testing. `contracts-test/AgentExecutionGuard.integration.test.ts`
/// and `contracts-test/P1PolicyOwnerAuthorization.poc.test.ts` cover the
/// real AgentRegistry wiring separately. Not part of any deployment.
contract MockAgentRegistry is IAgentRegistry {
    mapping(address => bool) private _active;
    /// @dev Defaults to `agent` itself (set implicitly the first time
    /// `setActive` is called for that address) unless explicitly
    /// overridden via `setOwner` — matches
    /// `MockPolicyRegistry.setBinding`'s own "owner == agent" default,
    /// so tests that don't care about the P1 owner-authorization check
    /// get a matching pair without needing to think about it.
    mapping(address => address) private _owner;
    mapping(address => address) private _wallet;

    function setActive(address agent, bool active_) external {
        _active[agent] = active_;
        if (_owner[agent] == address(0)) {
            _owner[agent] = agent;
        }
    }

    function setOwner(address agent, address owner_) external {
        _owner[agent] = owner_;
    }

    function isActiveAgent(address agent) external view returns (bool) {
        return _active[agent];
    }

    function ownerOf(address agent) external view returns (address) {
        return _owner[agent];
    }

    function setWallet(address agent, address wallet) external {
        _wallet[agent] = wallet;
    }

    function walletOf(address agent) external view returns (address) {
        return _wallet[agent];
    }
}
