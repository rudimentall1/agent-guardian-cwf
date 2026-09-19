// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title RealBenchmarkTarget
/// @notice Minimal stateful target used only by the reproducible testnet benchmark.
/// It proves the Guard can authorize a real state-changing external call.
contract RealBenchmarkTarget {
    uint256 public counter;
    event Ping(uint256 indexed value, uint256 counter);

    function ping(uint256 value) external returns (uint256) {
        counter += 1;
        emit Ping(value, counter);
        return counter;
    }

    function blocked(uint256 value) external returns (uint256) {
        counter += value + 1000;
        return counter;
    }
}
