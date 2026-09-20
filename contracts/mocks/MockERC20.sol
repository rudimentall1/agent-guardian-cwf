// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Guardian Test Token", "GTT") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract RevertingERC20 {
    error TransferRejected();

    function transfer(address, uint256) external pure returns (bool) {
        revert TransferRejected();
    }
}