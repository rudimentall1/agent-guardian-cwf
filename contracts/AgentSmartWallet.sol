// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title AgentSmartWallet
/// @notice Minimal owner-controlled custody layer. The execution guard is the
/// only address allowed to make agent-authorized external calls.
contract AgentSmartWallet is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public owner;
    /// @notice Immutable agent identity this wallet is exclusively bound to.
    /// The Guard must match this address before any agent-authorized execution.
    address public immutable agent;
    /// @notice Immutable after deployment. The owner cannot install a second execution path\n    /// that bypasses AgentExecutionGuard policy checks.\n    address public immutable executionGuard;

    error ZeroAddress();
    error NotOwner();
    error NotExecutionGuard();
    error CallFailed(bytes returndata);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ExecutionGuardChanged(address indexed previousGuard, address indexed newGuard);
    event Executed(address indexed target, uint256 value, bytes data);
    event NativeRecovered(address indexed to, uint256 amount);
    event ERC20Recovered(address indexed token, address indexed to, uint256 amount);

    constructor(address initialOwner, address initialExecutionGuard, address initialAgent) {
        if (initialOwner == address(0) || initialExecutionGuard == address(0) || initialAgent == address(0)) revert ZeroAddress();
        owner = initialOwner;
        agent = initialAgent;
        executionGuard = initialExecutionGuard;
        emit OwnershipTransferred(address(0), initialOwner);
        emit ExecutionGuardChanged(address(0), initialExecutionGuard);
    }

    receive() external payable {}

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyExecutionGuard() {
        if (msg.sender != executionGuard) revert NotExecutionGuard();
        _;
    }

    /// @notice Execute an external call using assets held by this wallet.
    /// @dev Agent authorization must happen in AgentExecutionGuard before this call.
    function execute(address target, uint256 value, bytes calldata data)
        external
        onlyExecutionGuard
        nonReentrant
        returns (bytes memory returndata)
    {
        if (target == address(0)) revert ZeroAddress();

        // slither-disable-next-line arbitrary-send-eth -- `target` and
        // `value` are only reachable via `onlyExecutionGuard`; this
        // wallet forwards only its own balance, and the Guard has
        // already authorized `target`/`value` against a signed,
        // policy-bound intent before ever calling here.
        (bool success, bytes memory ret) = target.call{value: value}(data);
        if (!success) revert CallFailed(ret);

        emit Executed(target, value, data);
        return ret;
    }


    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    function recoverNative(address payable to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        (bool success, bytes memory ret) = to.call{value: amount}("");
        if (!success) revert CallFailed(ret);
        emit NativeRecovered(to, amount);
    }

    function recoverERC20(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit ERC20Recovered(token, to, amount);
    }
}
