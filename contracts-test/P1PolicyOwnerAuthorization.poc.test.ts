import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deploySmartWallet, fundSmartWallet } from "./smartWalletTestHelpers";

describe("P1: PolicyRegistry policy-owner authorization", function () {
  async function deployFixture() {
    const [owner, attacker] = await ethers.getSigners();
    const agentWallet = ethers.Wallet.createRandom().connect(ethers.provider);

    const Registry = await ethers.getContractFactory("AgentRegistry");
    const registry = await Registry.deploy();
    await registry.waitForDeployment();

    const Policy = await ethers.getContractFactory("PolicyRegistry");
    const policyRegistry = await Policy.deploy();
    await policyRegistry.waitForDeployment();

    const Guard = await ethers.getContractFactory("AgentExecutionGuard");
    const guard = await Guard.deploy(await registry.getAddress(), await policyRegistry.getAddress());
    await guard.waitForDeployment();

    const smartWallet = await deploySmartWallet(owner.address, await guard.getAddress(), agentWallet.address);
    await fundSmartWallet(smartWallet, ethers.parseEther("100"));

    const RecordingTarget = await ethers.getContractFactory("RecordingTarget");
    const recordingTarget = await RecordingTarget.deploy();
    await recordingTarget.waitForDeployment();

    return { registry, policyRegistry, guard, owner, attacker, agentWallet, recordingTarget, smartWallet };
  }

  async function register(
    registry: any,
    agentWallet: ReturnType<typeof ethers.Wallet.createRandom>,
    owner: any
  ) {
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("v1"));
    const domain = {
      name: "AgentRegistry",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await registry.getAddress(),
    };
    const types = {
      AgentRegistration: [
        { name: "agent", type: "address" },
        { name: "owner", type: "address" },
        { name: "metadataHash", type: "bytes32" },
      ],
    };
    const sig = await agentWallet.signTypedData(domain, types, {
      agent: agentWallet.address,
      owner: owner.address,
      metadataHash,
    });
    await registry.register(agentWallet.address, owner.address, metadataHash, sig);
  }

  async function signIntent(guard: any, agent: any, wallet: string, target: string, value: bigint, policyHash: string) {
    const domain = {
      name: "AgentExecutionGuard",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await guard.getAddress(),
    };
    const types = {
      ExecutionIntent: [
        { name: "agent", type: "address" },
        { name: "wallet", type: "address" },
        { name: "target", type: "address" },
        { name: "value", type: "uint256" },
        { name: "calldataHash", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "policyHash", type: "bytes32" },
      ],
    };
    return agent.signTypedData(domain, types, {
      agent: agent.address,
      wallet,
      target,
      value,
      calldataHash: ethers.keccak256("0x"),
      nonce: 0n,
      deadline: 4102444800n,
      policyHash,
    });
  }

  it("attacker can create a policy for someone else's agent, but the policy cannot obtain execution authority", async function () {
    const { registry, policyRegistry, guard, owner, attacker, agentWallet, smartWallet } = await loadFixture(deployFixture);
    await register(registry, agentWallet, owner);
    await registry.connect(owner).bindWallet(agentWallet.address, await smartWallet.getAddress());

    const salt = ethers.keccak256(ethers.toUtf8Bytes("attacker-policy"));
    await policyRegistry.connect(attacker).createPolicy(
      salt,
      agentWallet.address,
      ethers.parseEther("1000"),
      ethers.parseEther("100"),
      ethers.parseEther("10"),
      0n,
      4102444800n,
      [],
      [attacker.address]
    );

    const policyId = await policyRegistry.computePolicyId(attacker.address, salt);
    const policyHash = await policyRegistry.policyHashOf(policyId);
    expect(await policyRegistry.ownerOf(policyId)).to.equal(attacker.address);
    expect(await policyRegistry.agentOf(policyId)).to.equal(agentWallet.address);
    expect(await policyRegistry.isPolicyActive(policyId)).to.equal(true);

    const value = ethers.parseEther("1");
    const sig = await signIntent(guard, agentWallet, await smartWallet.getAddress(), attacker.address, value, policyHash);

    await expect(
      guard.connect(owner).execute(
        agentWallet.address,
        await smartWallet.getAddress(),
        attacker.address,
        value,
        "0x",
        0n,
        4102444800n,
        policyHash,
        sig,
      )
    )
      .to.be.revertedWithCustomError(guard, "PolicyOwnerMismatch")
      .withArgs(policyHash, owner.address, attacker.address);

    expect(await guard.nextNonce(agentWallet.address)).to.equal(0n);
  });

  it("legitimate owner can create and use policy", async function () {
    const { registry, policyRegistry, guard, owner, agentWallet, recordingTarget, smartWallet } = await loadFixture(deployFixture);
    await register(registry, agentWallet, owner);
    await registry.connect(owner).bindWallet(agentWallet.address, await smartWallet.getAddress());

    const target = await recordingTarget.getAddress();
    const salt = ethers.keccak256(ethers.toUtf8Bytes("owner-policy"));
    const maxTxValue = ethers.parseEther("1");
    const dailyLimit = ethers.parseEther("100");
    const approvalThreshold = ethers.parseEther("0.1");

    await policyRegistry.connect(owner).createPolicy(
      salt,
      agentWallet.address,
      maxTxValue,
      dailyLimit,
      approvalThreshold,
      0n,
      4102444800n,
      [],
      [target]
    );

    const policyId = await policyRegistry.computePolicyId(owner.address, salt);
    const policyHash = await policyRegistry.policyHashOf(policyId);
    const intentSig = await signIntent(guard, agentWallet, await smartWallet.getAddress(), target, 0n, policyHash);

    await expect(
      guard.connect(owner).execute(
        agentWallet.address,
        await smartWallet.getAddress(),
        target,
        0n,
        "0x",
        0n,
        4102444800n,
        policyHash,
        intentSig,
      )
    ).to.not.be.reverted;

    expect(await guard.nextNonce(agentWallet.address)).to.equal(1n);
    expect(await recordingTarget.callCount()).to.equal(1n);
  });
});
