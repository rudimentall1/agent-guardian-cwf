import { expect } from "chai";
import { ethers } from "hardhat";
import { signTypedDataDigest } from "./typedDataTestHelpers";
import { deploySmartWallet, fundSmartWallet } from "./smartWalletTestHelpers";

describe("ERC-1271 contract owner approvals — adversarial", function () {
  const DEADLINE = 4102444800n;
  const registrationTypes = { AgentRegistration: [
    { name: "agent", type: "address" }, { name: "owner", type: "address" }, { name: "metadataHash", type: "bytes32" },
  ] };
  const intentTypes = { ExecutionIntent: [
    { name: "agent", type: "address" }, { name: "wallet", type: "address" }, { name: "target", type: "address" },
    { name: "value", type: "uint256" }, { name: "calldataHash", type: "bytes32" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }, { name: "policyHash", type: "bytes32" },
  ] };
  const approvalTypes = { ExecutionApproval: [
    { name: "agent", type: "address" }, { name: "wallet", type: "address" }, { name: "target", type: "address" },
    { name: "value", type: "uint256" }, { name: "calldataHash", type: "bytes32" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }, { name: "policyHash", type: "bytes32" }, { name: "approvalDeadline", type: "uint256" },
  ] };

  async function setup() {
    const [ownerSigner, attacker] = await ethers.getSigners();
    const agent = ethers.Wallet.createRandom().connect(ethers.provider);
    const registry = await (await ethers.getContractFactory("AgentRegistry")).deploy();
    await registry.waitForDeployment();
    const contractOwner = await (await ethers.getContractFactory("MockERC1271Owner")).deploy(ownerSigner.address);
    await contractOwner.waitForDeployment();
    const net = await ethers.provider.getNetwork();
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("erc1271"));
    const registrationSignature = await signTypedDataDigest(agent,
      { name: "AgentRegistry", version: "1", chainId: net.chainId, verifyingContract: await registry.getAddress() },
      registrationTypes,
      { agent: agent.address, owner: await contractOwner.getAddress(), metadataHash },
    );
    await registry.register(agent.address, await contractOwner.getAddress(), metadataHash, registrationSignature);
    const policyRegistry = await (await ethers.getContractFactory("PolicyRegistry")).deploy();
    await policyRegistry.waitForDeployment();
    const guard = await (await ethers.getContractFactory("AgentExecutionGuard")).deploy(await registry.getAddress(), await policyRegistry.getAddress());
    await guard.waitForDeployment();
    const wallet = await deploySmartWallet(await contractOwner.getAddress(), await guard.getAddress(), agent.address);
    const bindData = registry.interface.encodeFunctionData("bindWallet", [agent.address, await wallet.getAddress()]);
    await contractOwner.execute(await registry.getAddress(), bindData);
    await fundSmartWallet(wallet, ethers.parseEther("10"));
    const target = await (await ethers.getContractFactory("RecordingTarget")).deploy();
    await target.waitForDeployment();
    const salt = ethers.keccak256(ethers.toUtf8Bytes("erc1271-policy"));
    const createPolicyData = policyRegistry.interface.encodeFunctionData("createPolicy", [
      salt, agent.address, 100n, 100n, 0n, 0, DEADLINE, [], [await target.getAddress()],
    ]);
    await contractOwner.execute(await policyRegistry.getAddress(), createPolicyData);
    const policyId = await policyRegistry.computePolicyId(await contractOwner.getAddress(), salt);
    const policyHash = await policyRegistry.policyHashOf(policyId);
    return { ownerSigner, wallet, attacker, agent, registry, contractOwner, policyRegistry, guard, target, policyHash, net };
  }

  it("accepts a valid ERC-1271 approval from a contract owner", async function () {
    const { ownerSigner, wallet, agent, contractOwner, guard, target, policyHash, net } = await setup();
    const value = 2n;
    const targetAddress = await target.getAddress();
    const guardAddress = await guard.getAddress();
    const calldataHash = ethers.keccak256("0x");
    const intent = { agent: agent.address, wallet: await wallet.getAddress(), target: targetAddress, value, calldataHash, nonce: 0n, deadline: DEADLINE, policyHash };
    const intentSignature = await signTypedDataDigest(agent,
      { name: "AgentExecutionGuard", version: "1", chainId: net.chainId, verifyingContract: guardAddress }, intentTypes, intent,
    );
    const approval = { ...intent, approvalDeadline: DEADLINE };
    const approvalDigest = await guard.hashApproval(agent.address, await wallet.getAddress(), targetAddress, value, calldataHash, 0n, DEADLINE, policyHash, DEADLINE);
    const approvalSignature = await signTypedDataDigest(ownerSigner,
      { name: "AgentExecutionGuard", version: "1", chainId: net.chainId, verifyingContract: guardAddress }, approvalTypes, approval,
    );
    expect(await contractOwner.isValidSignature(approvalDigest, approvalSignature)).to.equal("0x1626ba7e");
    await guard.executeWithApprovalFromWallet(agent.address, await wallet.getAddress(), targetAddress, value, "0x", 0n, DEADLINE, policyHash, intentSignature, DEADLINE, approvalSignature);
    expect(await guard.nextNonce(agent.address)).to.equal(1n);
    expect((await guard.dailySpend(policyHash)).spent).to.equal(value);
  });

  it("fails closed when the ERC-1271 owner rejects the approval", async function () {
    const { wallet, attacker, agent, guard, target, policyHash, net } = await setup();
    const value = 2n;
    const targetAddress = await target.getAddress();
    const guardAddress = await guard.getAddress();
    const calldataHash = ethers.keccak256("0x");
    const intentSignature = await signTypedDataDigest(agent,
      { name: "AgentExecutionGuard", version: "1", chainId: net.chainId, verifyingContract: guardAddress }, intentTypes,
      { agent: agent.address, wallet: await wallet.getAddress(), target: targetAddress, value, calldataHash, nonce: 0n, deadline: DEADLINE, policyHash },
    );
    const invalidApproval = await signTypedDataDigest(attacker,
      { name: "AgentExecutionGuard", version: "1", chainId: net.chainId, verifyingContract: guardAddress }, approvalTypes,
      { agent: agent.address, wallet: await wallet.getAddress(), target: targetAddress, value, calldataHash, nonce: 0n, deadline: DEADLINE, policyHash, approvalDeadline: DEADLINE },
    );
    await expect(guard.executeWithApproval(agent.address, await wallet.getAddress(), targetAddress, value, "0x", 0n, DEADLINE, policyHash, intentSignature, DEADLINE, invalidApproval))
      .to.be.revertedWithCustomError(guard, "InvalidApprovalSignature");
    expect(await guard.nextNonce(agent.address)).to.equal(0n);
    expect((await guard.dailySpend(policyHash)).spent).to.equal(0n);
  });
});
