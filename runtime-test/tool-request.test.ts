import { expect } from "chai";
import { ethers } from "hardhat";
import {
  defineContractTool,
  resolveToolRequest,
} from "../runtime/tool-request";

describe("CWF tool request boundary", function () {
  it("resolves a declared tool into a canonical transaction intent", async function () {
    const [agent, wallet] = await ethers.getSigners();

    const token = "0x1000000000000000000000000000000000000001";

    const transferTool = defineContractTool(
      "erc20",
      "transfer",
      token,
      "function transfer(address to,uint256 amount) returns (bool)",
    );

    const recipient = "0x2000000000000000000000000000000000000002";

    const result = resolveToolRequest(transferTool, {
      agent: agent.address,
      wallet: wallet.address,
      tool: "erc20",
      action: "transfer",
      args: [recipient, 1000n],
      value: 0n,
      nonce: 0n,
      deadline: 9999999999n,
      policyHash: ethers.ZeroHash,
    });

    expect(result.intent.agent).to.equal(agent.address);
    expect(result.intent.wallet).to.equal(wallet.address);
    expect(result.intent.target).to.equal(token);

    expect(result.intent.data).to.equal(
      ethers
        .Interface.from([
          "function transfer(address to,uint256 amount) returns (bool)",
        ])
        .encodeFunctionData("transfer", [recipient, 1000n]),
    );
  });

  it("cannot redirect a declared tool to another target", async function () {
    const [agent, wallet] = await ethers.getSigners();

    const allowedToken = "0x1000000000000000000000000000000000000001";

    const transferTool = defineContractTool(
      "erc20",
      "transfer",
      allowedToken,
      "function transfer(address to,uint256 amount) returns (bool)",
    );

    const request = {
      agent: agent.address,
      wallet: wallet.address,
      tool: "erc20",
      action: "transfer",
      args: [
        "0x2000000000000000000000000000000000000002",
        1000n,
      ],
      value: 0n,
      nonce: 0n,
      deadline: 9999999999n,
      policyHash: ethers.ZeroHash,
    };

    const result = resolveToolRequest(transferTool, request);

    expect(result.intent.target).to.equal(allowedToken);
    expect(result.intent.target).to.not.equal(
      "0x3000000000000000000000000000000000000003",
    );
  });

  it("rejects the wrong tool or action", async function () {
    const [agent, wallet] = await ethers.getSigners();

    const tool = defineContractTool(
      "erc20",
      "transfer",
      "0x1000000000000000000000000000000000000001",
      "function transfer(address to,uint256 amount) returns (bool)",
    );

    expect(() =>
      resolveToolRequest(tool, {
        agent: agent.address,
        wallet: wallet.address,
        tool: "erc20",
        action: "approve",
        args: [
          "0x2000000000000000000000000000000000000002",
          1000n,
        ],
        value: 0n,
        nonce: 0n,
        deadline: 9999999999n,
        policyHash: ethers.ZeroHash,
      }),
    ).to.throw("Action mismatch");
  });
});
