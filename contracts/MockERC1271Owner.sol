// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Minimal ERC-1271 smart-account stand-in for adversarial authorization tests.
contract MockERC1271Owner {
    bytes4 internal constant MAGICVALUE = 0x1626ba7e;

    address public signer;
    address public immutable admin;

    constructor(address signer_) {
        signer = signer_;
        admin = msg.sender;
    }

    function setSigner(address newSigner) external {
        require(msg.sender == admin, "not admin");
        signer = newSigner;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        return ECDSA.recover(hash, signature) == signer ? MAGICVALUE : bytes4(0xffffffff);
    }

    /// @dev Lets the contract owner create/manage policies so msg.sender is this contract.
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        (bool success, bytes memory returndata) = target.call(data);
        if (!success) {
            assembly {
                revert(add(returndata, 0x20), mload(returndata))
            }
        }
        return returndata;
    }
}
