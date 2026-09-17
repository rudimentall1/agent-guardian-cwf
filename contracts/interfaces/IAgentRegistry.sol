// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IAgentRegistry
/// @notice The only Gate 1 surface Gate 2 depends on. Kept intentionally
/// minimal so the Execution Guard's compiled bytecode does not change if
/// AgentRegistry gains unrelated functionality later — only a change to
/// this one function's semantics should ever require touching Gate 2.
interface IAgentRegistry {
    /// @notice True only if `agent` is registered AND currently active.
    function isActiveAgent(address agent) external view returns (bool);

    /// @notice [P1 fix] The current registered owner/controller of
    /// `agent`, or `address(0)` if never registered. Checked LIVE at
    /// execution time against a policy's stored `owner` — see
    /// docs/adr/0006-policy-owner-authorization.md for why this must be
    /// a live check, not a creation-time-only one.
    function ownerOf(address agent) external view returns (address);

    /// @notice Canonical custody wallet bound to `agent`, or zero if none.
    function walletOf(address agent) external view returns (address);
}
