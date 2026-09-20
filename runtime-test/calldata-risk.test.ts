import { expect } from "chai";
import { ethers } from "hardhat";
import { inspectCalldataRisk } from "../runtime/risk/calldata";

describe("CWF calldata risk inspection", function () {
  it("flags unlimited ERC-20 approvals", function () {
    const iface = new ethers.Interface(["function approve(address spender,uint256 value)"]);
    const spender = "0x1111111111111111111111111111111111111111";
    const signals = inspectCalldataRisk(iface.encodeFunctionData("approve", [spender, ethers.MaxUint256]));
    expect(signals).to.have.length(1);
    expect(signals[0].code).to.equal("UNLIMITED_APPROVAL_REQUESTED");
    expect(signals[0].severity).to.equal("HIGH");
    expect(signals[0].evidence.spender).to.equal(ethers.getAddress(spender));
  });

  it("does not flag bounded approvals", function () {
    const iface = new ethers.Interface(["function approve(address spender,uint256 value)"]);
    const signals = inspectCalldataRisk(iface.encodeFunctionData("approve", [
      "0x1111111111111111111111111111111111111111", 1000n,
    ]));
    expect(signals).to.deep.equal([]);
  });

  it("flags NFT operator approvals", function () {
    const iface = new ethers.Interface(["function setApprovalForAll(address operator,bool approved)"]);
    const operator = "0x2222222222222222222222222222222222222222";
    const signals = inspectCalldataRisk(iface.encodeFunctionData("setApprovalForAll", [operator, true]));
    expect(signals).to.have.length(1);
    expect(signals[0].code).to.equal("NFT_OPERATOR_APPROVAL_REQUESTED");
    expect(signals[0].severity).to.equal("HIGH");
  });

  it("does not flag operator revocation", function () {
    const iface = new ethers.Interface(["function setApprovalForAll(address operator,bool approved)"]);
    const signals = inspectCalldataRisk(iface.encodeFunctionData("setApprovalForAll", [
      "0x2222222222222222222222222222222222222222", false,
    ]));
    expect(signals).to.deep.equal([]);
  });

  it("does not confuse another selector with sensitive approvals", function () {
    const signals = inspectCalldataRisk(
      new ethers.Interface(["function ping(uint256 id)"]).encodeFunctionData("ping", [1]),
    );
    expect(signals).to.deep.equal([]);
  });
});
