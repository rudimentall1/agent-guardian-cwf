import { expect } from "chai";
import { ethers } from "hardhat";

import {
  defineContractTool,
  resolveToolRequest,
} from "../runtime/tool-request";

import { signIntent } from "../runtime/intent";
import { executeIntent } from "../runtime/executor";

const FAR_FUTURE = 4102444800n;

describe("CWF reusable intent executor", function () {
  it("executes a signed intent through the real Guard", async function () {
    const [owner, relayer] = await ethers.getSigners();

    const agent = ethers.Wallet.createRandom().connect(
      ethers.provider,
    );

    const registry = await (
      await ethers.getContractFactory("AgentRegistry")
    ).deploy();
    await registry.waitForDeployment();

    const policyRegistry = await (
      await ethers.getContractFactory("PolicyRegistry")
    ).deploy();
    await policyRegistry.waitForDeployment();

    const guard = await (
      await ethers.getContractFactory("AgentExecutionGuard")
    ).deploy(
      await registry.getAddress(),
      await policyRegistry.getAddress(),
    );
    await guard.waitForDeployment();

    const wallet = await (
      await ethers.getContractFactory("AgentSmartWallet")
    ).deploy(
      owner.address,
      await guard.getAddress(),
    );
    await wallet.waitForDeployment();

    const target = await (
      await ethers.getContractFactory("RecordingTarget")
    ).deploy();
    await target.waitForDeployment();

    const metadataHash = ethers.keccak256(
      ethers.toUtf8Bytes("executor-test"),
    );

    const network = await ethers.provider.getNetwork();

    const registryDomain = {
      name: "AgentRegistry",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await registry.getAddress(),
    };

    const registrationSignature = await agent.signTypedData(
      registryDomain,
      {
        AgentRegistration: [
          { name: "agent", type: "address" },
          { name: "owner", type: "address" },
          { name: "metadataHash", type: "bytes32" },
        ],
      },
      {
        agent: agent.address,
        owner: owner.address,
        metadataHash,
      },
    );

    await (
      await registry.register(
        agent.address,
        owner.address,
        metadataHash,
        registrationSignature,
      )
    ).wait();

    const recordSelector = ethers.id(
      "record(uint256)",
    ).slice(0, 10);

    const salt = ethers.keccak256(
      ethers.toUtf8Bytes("executor-policy"),
    );

    await (
      await policyRegistry.connect(owner).createPolicy(
        salt,
        agent.address,
        0n,
        0n,
        ethers.parseEther("1"),
        0n,
        FAR_FUTURE,
        [
          {
            target: await target.getAddress(),
            selector: recordSelector,
          },
        ],
        [],
      )
    ).wait();

    const policyId = await policyRegistry.computePolicyId(
      owner.address,
      salt,
    );

    const policyHash = await policyRegistry.policyHashOf(
      policyId,
    );

    const tool = defineContractTool(
      "recording-target",
      "record",
      await target.getAddress(),
      "function record(uint256 amount)",
    );

    const intent = resolveToolRequest(tool, {
      agent: agent.address,
      wallet: await wallet.getAddress(),
      tool: "recording-target",
      action: "record",
      args: [123n],
      value: 0n,
      nonce: 0n,
      deadline: FAR_FUTURE,
      policyHash,
    }).intent;

    const signature = await signIntent(
      agent,
      intent,
      network.chainId,
      await guard.getAddress(),
    );

    await executeIntent(guard, {
      intent,
      signature,
    });

    expect(await target.callCount()).to.equal(1n);
    expect(await guard.nextNonce(agent.address)).to.equal(1n);

    void relayer;
  });

  it("fails before sending when the signature is malformed", async function () {
    const [owner] = await ethers.getSigners();

    const fakeGuard = {
      async executeFromWallet() {
        throw new Error(
          "executeFromWallet should not be called",
        );
      },
    };

    const intent = {
      agent: owner.address,
      wallet: owner.address,
      target: owner.address,
      value: 0n,
      data: "0x",
      nonce: 0n,
      deadline: FAR_FUTURE,
      policyHash: ethers.ZeroHash,
    };

    await expect(
      executeIntent(fakeGuard, {
        intent,
        signature: "not-a-signature",
      }),
    ).to.be.rejectedWith("Invalid intent signature");
  });
});
