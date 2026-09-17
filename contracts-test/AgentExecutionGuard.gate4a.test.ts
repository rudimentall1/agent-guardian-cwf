import { expect } from "chai";
import { ethers } from "hardhat";
import { signTypedDataDigest } from "./typedDataTestHelpers";
import { deploySmartWallet } from "./smartWalletTestHelpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Gate 4A: call authorization and maxTxValue вЂ” full stack", function () {
  let agentRegistry: any;
  let policyRegistry: any;
  let guard: any;
  let selectorTarget: any;
  let recordingTarget: any;
  let otherTarget: any;
  let owner: HardhatEthersSigner;
  let wallet: any;
  let agent: ReturnType<typeof ethers.Wallet.createRandom>;
  let agentAddress: string;
  let selectorTargetAddress: string;
  let recordingTargetAddress: string;
  let otherTargetAddress: string;
  let guardAddress: string;

  const FAR_DEADLINE = 4102444800n;
  const FOO_SELECTOR = ethers.id("foo(uint256)").slice(0, 10);
  const BAR_SELECTOR = ethers.id("bar(address)").slice(0, 10);

  const registrationTypes = {
    AgentRegistration: [
      { name: "agent", type: "address" },
      { name: "owner", type: "address" },
      { name: "metadataHash", type: "bytes32" },
    ],
  };

  const intentTypes = {
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

  const hexWord = (hex: string) => `0x${hex.slice(2).padStart(64, "0")}`;
  const uintWord = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
  const addressWord = (value: string) => `0x${value.slice(2).padStart(64, "0")}`;
  const bytes4Word = (value: string) => `0x${value.slice(2).padEnd(64, "0")}`;

  function encodeCreatePolicy(
    salt: string,
    policyAgent: string,
    maxTxValue: bigint,
    dailyLimit: bigint,
    approvalThreshold: bigint,
    calls: { target: string; selector: string }[],
    nativeTargets: string[],
  ) {
    const selector = ethers.id("createPolicy(bytes32,address,uint128,uint128,uint128,uint64,uint64,(address,bytes4)[],address[])").slice(0, 10);

    // createPolicy has 9 parameters; the last two are dynamic arrays and occupy two head words.
    const staticHeadWords = 9n;
    const callsTail = [uintWord(BigInt(calls.length)), ...calls.flatMap((call) => [addressWord(call.target), bytes4Word(call.selector)])];
    const nativeTail = [uintWord(BigInt(nativeTargets.length)), ...nativeTargets.map(addressWord)];
    const callsOffset = staticHeadWords * 32n;
    const nativeOffset = callsOffset + BigInt(callsTail.length * 32);

    return ethers.concat([
      selector,
      hexWord(salt),
      addressWord(policyAgent),
      uintWord(maxTxValue),
      uintWord(dailyLimit),
      uintWord(approvalThreshold),
      uintWord(0n),
      uintWord(FAR_DEADLINE),
      uintWord(callsOffset),
      uintWord(nativeOffset),
      ...callsTail,
      ...nativeTail,
    ]);
  }

  async function registerAgent() {
    const net = await ethers.provider.getNetwork();
    const domain = { name: "AgentRegistry", version: "1", chainId: net.chainId, verifyingContract: await agentRegistry.getAddress() };
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("gate4a-agent"));
    const sig = await signTypedDataDigest(agent, domain, registrationTypes, { agent: agentAddress, owner: owner.address, metadataHash });
    await agentRegistry.register(agentAddress, owner.address, metadataHash, sig);
  }

  async function sendCreatePolicy(
    salt: string,
    policyAgent: string,
    maxTxValue: bigint,
    dailyLimit: bigint,
    approvalThreshold: bigint,
    calls: { target: string; selector: string }[],
    nativeTargets: string[]
  ) {
    const data = encodeCreatePolicy(salt, policyAgent, maxTxValue, dailyLimit, approvalThreshold, calls, nativeTargets);
    const tx = await owner.sendTransaction({ to: await policyRegistry.getAddress(), data });
    await tx.wait();
  }

  async function createPolicy(
    saltText: string,
    calls: { target: string; selector: string }[],
    nativeTargets: string[] = [],
    maxTxValue = ethers.parseEther("1")
  ) {
    const salt = ethers.keccak256(ethers.toUtf8Bytes(saltText));
    await sendCreatePolicy(salt, agentAddress, maxTxValue, (2n ** 128n) - 1n, (2n ** 128n) - 1n, calls, nativeTargets);
    const policyId = await policyRegistry.computePolicyId(owner.address, salt);
    return await policyRegistry.policyHashOf(policyId);
  }

  async function signIntent(policyHash: string, target: string, value: bigint, data: string, nonce: bigint) {
    const net = await ethers.provider.getNetwork();
    const domain = { name: "AgentExecutionGuard", version: "1", chainId: net.chainId, verifyingContract: guardAddress };
    return await signTypedDataDigest(agent, domain, intentTypes, { agent: agentAddress, wallet: await wallet.getAddress(), target, value, calldataHash: ethers.keccak256(data), nonce, deadline: FAR_DEADLINE, policyHash });
  }

  async function execute(policyHash: string, target: string, value: bigint, data: string, nonce: bigint) {
    const sig = await signIntent(policyHash, target, value, data, nonce);


    return guard.executeFromWallet(
      agentAddress,
      await wallet.getAddress(),
      target,
      value,
      data,
      nonce,
      FAR_DEADLINE,
      policyHash,
      sig
    );
  }

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    agent = ethers.Wallet.createRandom().connect(ethers.provider);
    agentAddress = agent.address;
    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    agentRegistry = await AgentRegistry.deploy(); await agentRegistry.waitForDeployment(); await registerAgent();
    const PolicyRegistry = await ethers.getContractFactory("PolicyRegistry");
    policyRegistry = await PolicyRegistry.deploy(); await policyRegistry.waitForDeployment();
    const Guard = await ethers.getContractFactory("AgentExecutionGuard");
    guard = await Guard.deploy(await agentRegistry.getAddress(), await policyRegistry.getAddress()); await guard.waitForDeployment(); guardAddress = await guard.getAddress();
    wallet = await deploySmartWallet(owner.address, guardAddress, agent.address);
    await agentRegistry.bindWallet(agent.address, await wallet.getAddress());
    await owner.sendTransaction({
      to: await wallet.getAddress(),
      value: ethers.parseEther("10"),
    });
    const SelectorTarget = await ethers.getContractFactory("SelectorTarget");
    selectorTarget = await SelectorTarget.deploy(); await selectorTarget.waitForDeployment(); selectorTargetAddress = await selectorTarget.getAddress();
    recordingTarget = await (await ethers.getContractFactory("RecordingTarget")).deploy(); await recordingTarget.waitForDeployment(); recordingTargetAddress = await recordingTarget.getAddress();
    otherTarget = await (await ethers.getContractFactory("SelectorTarget")).deploy(); await otherTarget.waitForDeployment(); otherTargetAddress = await otherTarget.getAddress();
  });

  it("authorizes only exact (target, selector) pairs", async function () {
    const policy = await createPolicy("cartesian", [{ target: selectorTargetAddress, selector: FOO_SELECTOR }, { target: otherTargetAddress, selector: BAR_SELECTOR }]);
    await execute(policy, selectorTargetAddress, 0n, selectorTarget.interface.encodeFunctionData("foo", [1]), 0n);
    await execute(policy, otherTargetAddress, 0n, otherTarget.interface.encodeFunctionData("bar", [await wallet.getAddress()]), 1n);
    await expect(execute(policy, selectorTargetAddress, 0n, selectorTarget.interface.encodeFunctionData("bar", [await wallet.getAddress()]), 2n)).to.be.revertedWithCustomError(guard, "CallNotAuthorized");
    await expect(execute(policy, otherTargetAddress, 0n, otherTarget.interface.encodeFunctionData("foo", [1]), 2n)).to.be.revertedWithCustomError(guard, "CallNotAuthorized");
  });

  it("rejects an authorized target with a forbidden selector", async function () {
    const policy = await createPolicy("forbidden-selector", [{ target: selectorTargetAddress, selector: FOO_SELECTOR }]);
    const data = selectorTarget.interface.encodeFunctionData("bar", [await wallet.getAddress()]);
    await expect(execute(policy, selectorTargetAddress, 0n, data, 0n)).to.be.revertedWithCustomError(guard, "CallNotAuthorized");
  });

  it("rejects a forbidden target even when selector bytes are authorized elsewhere", async function () {
    const policy = await createPolicy("forbidden-target", [{ target: selectorTargetAddress, selector: FOO_SELECTOR }]);
    const data = selectorTarget.interface.encodeFunctionData("foo", [1]);
    await expect(execute(policy, recordingTargetAddress, 0n, data, 0n)).to.be.revertedWithCustomError(guard, "CallNotAuthorized");
  });

  it("keeps native transfers separate from function-call authorization", async function () {
    const policy = await createPolicy("native-separation", [{ target: selectorTargetAddress, selector: "0x00000000" }], [recordingTargetAddress]);
    await execute(policy, recordingTargetAddress, 0n, "0x", 0n);
    expect(await recordingTarget.callCount()).to.equal(1n);
    await expect(execute(policy, recordingTargetAddress, 0n, "0x12345678", 1n)).to.be.revertedWithCustomError(guard, "CallNotAuthorized");
  });

  it("malformed calldata is never authorized", async function () {
    const policy = await createPolicy("malformed", [{ target: selectorTargetAddress, selector: "0x00000000" }], [selectorTargetAddress]);
    await expect(execute(policy, selectorTargetAddress, 0n, "0x12", 0n)).to.be.revertedWithCustomError(guard, "CallNotAuthorized");
  });

  it("enforces maxTxValue at the exact boundary", async function () {
    const max = ethers.parseEther("1");
    const policy = await createPolicy("max-exact", [{ target: selectorTargetAddress, selector: FOO_SELECTOR }], [], max);
    await execute(policy, selectorTargetAddress, max, selectorTarget.interface.encodeFunctionData("foo", [1]), 0n);
  });

  it("rejects maxTxValue + 1 wei", async function () {
    const max = ethers.parseEther("1");
    const policy = await createPolicy("max-plus-one", [{ target: selectorTargetAddress, selector: FOO_SELECTOR }], [], max);
    await expect(execute(policy, selectorTargetAddress, max + 1n, selectorTarget.interface.encodeFunctionData("foo", [1]), 0n)).to.be.revertedWithCustomError(guard, "MaxTxValueExceeded");
  });

  it("binds policy to the intended agent", async function () {
    const otherAgent = ethers.Wallet.createRandom().connect(ethers.provider);
    const net = await ethers.provider.getNetwork();
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("other-agent"));
    const sig = await signTypedDataDigest(otherAgent, { name: "AgentRegistry", version: "1", chainId: net.chainId, verifyingContract: await agentRegistry.getAddress() }, registrationTypes, { agent: otherAgent.address, owner: owner.address, metadataHash });
    await agentRegistry.register(otherAgent.address, owner.address, metadataHash, sig);
    const salt = ethers.keccak256(ethers.toUtf8Bytes("other-policy"));
    await sendCreatePolicy(salt, otherAgent.address, ethers.parseEther("1"), (2n ** 128n) - 1n, (2n ** 128n) - 1n, [{ target: recordingTargetAddress, selector: "0x00000000" }], [recordingTargetAddress]);
    const id = await policyRegistry.computePolicyId(owner.address, salt);
    const policy = await policyRegistry.policyHashOf(id);
    await expect(execute(policy, recordingTargetAddress, 0n, "0x", 0n)).to.be.revertedWithCustomError(guard, "PolicyAgentMismatch");
  });

  it("does not let changed calldata bypass the signed intent", async function () {
    const policy = await createPolicy("calldata-binding", [{ target: selectorTargetAddress, selector: FOO_SELECTOR }]);
    const signedData = selectorTarget.interface.encodeFunctionData("foo", [1]);
    const changedData = selectorTarget.interface.encodeFunctionData("foo", [2]);
    const sig = await signIntent(policy, selectorTargetAddress, 0n, signedData, 0n);
    await expect(guard.execute(agentAddress, await wallet.getAddress(), selectorTargetAddress, 0n, changedData, 0n, FAR_DEADLINE, policy, sig, { value: 0n })).to.be.revertedWithCustomError(guard, "InvalidSignature");
  });

  it("does not let changed target bypass the signed intent", async function () {
    const policy = await createPolicy("target-binding", [{ target: selectorTargetAddress, selector: FOO_SELECTOR }]);
    const data = selectorTarget.interface.encodeFunctionData("foo", [1]);
    const sig = await signIntent(policy, selectorTargetAddress, 0n, data, 0n);
    await expect(guard.execute(agentAddress, await wallet.getAddress(), recordingTargetAddress, 0n, data, 0n, FAR_DEADLINE, policy, sig, { value: 0n })).to.be.revertedWithCustomError(guard, "CallNotAuthorized");
  });
  
  it("rejects replay and future/stale nonces", async function () {
    const policy = await createPolicy("nonce", [{ target: selectorTargetAddress, selector: FOO_SELECTOR }]);
    const data = selectorTarget.interface.encodeFunctionData("foo", [1]);
    const sig = await signIntent(policy, selectorTargetAddress, 0n, data, 0n);
    await guard.execute(agentAddress, await wallet.getAddress(), selectorTargetAddress, 0n, data, 0n, FAR_DEADLINE, policy, sig, { value: 0n });
    await expect(guard.execute(agentAddress, await wallet.getAddress(), selectorTargetAddress, 0n, data, 0n, FAR_DEADLINE, policy, sig, { value: 0n })).to.be.revertedWithCustomError(guard, "InvalidNonce");
    const sigFuture = await signIntent(policy, selectorTargetAddress, 0n, data, 2n);
    await expect(guard.execute(agentAddress, await wallet.getAddress(), selectorTargetAddress, 0n, data, 2n, FAR_DEADLINE, policy, sigFuture, { value: 0n })).to.be.revertedWithCustomError(guard, "InvalidNonce");
  });
});


