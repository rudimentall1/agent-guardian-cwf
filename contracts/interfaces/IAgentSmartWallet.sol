// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IAgentSmartWallet {
    function owner() external view returns (address);
    function agent() external view returns (address);
    function executionGuard() external view returns (address);
    function execute(address target, uint256 value, bytes calldata data) external returns (bytes memory returndata);
}
