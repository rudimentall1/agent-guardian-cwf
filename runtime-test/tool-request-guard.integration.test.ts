import { expect } from "chai";
import { ethers } from "hardhat";

import {
  defineContractTool,
  resolveToolRequest,
} from "../runtime/tool-request";
import { signIntent } from "../runtime/intent";

const FAR_FUTURE = 4102444800n;

describe("CWF tool request -> Guard execution", function () {
  async function deployStack() {
    const [owner, relayer] = await ethers.getSigners();

    const agent = ethers.Wallet.createRandom().connect(ethers.provider);

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
    ).deploy(owner.address, await guard.getAddress(), agent.address);
    await wallet.waitForDeployment();

    const target = await (
      await ethers.getContractFactory("RecordingTarget")
    ).deploy();
    await target.waitForDeployment();

    const metadataHash = ethers.keccak256(
      ethers.toUtf8Bytes("cwf-agent"),
    );

    const registryDomain = {
      name: "AgentRegistry",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
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
    await registry.bindWallet(agent.address, await wallet.getAddress());

    const salt = ethers.keccak256(
      ethers.toUtf8Bytes("cwf-policy"),
    );

    const recordSelector = ethers.id("record(uint256)").slice(0, 10);

    await (
      await policyRegistry.connect(owner).createPolicy(
        salt,
        agent.address,
        ethers.parseEther("1"),
        ethers.parseEther("2"),
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

    expect(
      await policyRegistry.isCallAuthorized(
        policyId,
        await target.getAddress(),
        recordSelector,
      ),
    ).to.equal(true);

    const policyHash = await policyRegistry.policyHashOf(policyId);

    await (
      await owner.sendTransaction({
        to: await wallet.getAddress(),
        value: ethers.parseEther("1"),
      })
    ).wait();

    return {
      owner,
      relayer,
      agent,
      registry,
      policyRegistry,
      guard,
      wallet,
      target,
      policyHash,
    };
  }

  it("executes a ToolRequest through the real Guard", async function () {
    const stack = await deployStack();

    const tool = defineContractTool(
      "recording-target",
      "record",
      await stack.target.getAddress(),
      "function record(uint256 amount)",
    );

    const request = {
      agent: stack.agent.address,
      wallet: await stack.wallet.getAddress(),
      tool: "recording-target",
      action: "record",
      args: [42n],
      value: 0n,
      nonce: 0n,
      deadline: FAR_FUTURE,
      policyHash: stack.policyHash,
    };

    const resolved = resolveToolRequest(tool, request);

    const chainId = (await ethers.provider.getNetwork()).chainId;

    const signature = await signIntent(
      stack.agent,
      resolved.intent,
      chainId,
      await stack.guard.getAddress(),
    );

    await (
      await stack.guard.connect(stack.relayer).executeFromWallet(
        resolved.intent.agent,
        resolved.intent.wallet,
        resolved.intent.target,
        resolved.intent.value,
        resolved.intent.data,
        resolved.intent.nonce,
        resolved.intent.deadline,
        resolved.intent.policyHash,
        signature,
      )
    ).wait();

    expect(await stack.target.callCount()).to.equal(1n);
    expect(await stack.guard.nextNonce(stack.agent.address)).to.equal(1n);
  });

  it("blocks calldata modified after the agent signed the ToolRequest", async function () {
    const stack = await deployStack();

    const tool = defineContractTool(
      "recording-target",
      "record",
      await stack.target.getAddress(),
      "function record(uint256 amount)",
    );

    const resolved = resolveToolRequest(tool, {
      agent: stack.agent.address,
      wallet: await stack.wallet.getAddress(),
      tool: "recording-target",
      action: "record",
      args: [42n],
      value: 0n,
      nonce: 0n,
      deadline: FAR_FUTURE,
      policyHash: stack.policyHash,
    });

    const chainId = (await ethers.provider.getNetwork()).chainId;

    const signature = await signIntent(
      stack.agent,
      resolved.intent,
      chainId,
      await stack.guard.getAddress(),
    );

    const modifiedData = tool.encode([999n]);

    await expect(
      stack.guard.connect(stack.relayer).executeFromWallet(
        resolved.intent.agent,
        resolved.intent.wallet,
        resolved.intent.target,
        resolved.intent.value,
        modifiedData,
        resolved.intent.nonce,
        resolved.intent.deadline,
        resolved.intent.policyHash,
        signature,
      ),
    ).to.be.revertedWithCustomError(
      stack.guard,
      "InvalidSignature",
    );

    expect(await stack.target.callCount()).to.equal(0n);
    expect(await stack.guard.nextNonce(stack.agent.address)).to.equal(0n);
  });

  it("does not let a ToolRequest choose a different target", async function () {
    const stack = await deployStack();

    const allowedTarget = await stack.target.getAddress();
    const attackerTarget =
      "0x00000000000000000000000000000000000000AA";

    const tool = defineContractTool(
      "recording-target",
      "record",
      allowedTarget,
      "function record(uint256 amount)",
    );

    const resolved = resolveToolRequest(tool, {
      agent: stack.agent.address,
      wallet: await stack.wallet.getAddress(),
      tool: "recording-target",
      action: "record",
      args: [1n],
      value: 0n,
      nonce: 0n,
      deadline: FAR_FUTURE,
      policyHash: stack.policyHash,
    });

    expect(resolved.intent.target).to.equal(allowedTarget);
    expect(resolved.intent.target).to.not.equal(attackerTarget);
  });
});
