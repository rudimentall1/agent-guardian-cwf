import { expect } from "chai";
import { ethers } from "hardhat";
import { signTypedDataDigest } from "./typedDataTestHelpers";
import { deploySmartWallet } from "./smartWalletTestHelpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Gate 4B: daily limits and owner approvals вЂ” full stack", function () {
  let registry: any, policyRegistry: any, guard: any, target: any;
  let owner: HardhatEthersSigner;
  let wallet: any;
  let agent: ReturnType<typeof ethers.Wallet.createRandom>;
  let agentAddress: string, targetAddress: string, guardAddress: string;
  const DEADLINE = 4102444800n;
  const ZERO_SELECTOR = "0x00000000";
  const ALTERED_SELECTOR = "0x12345678";
  const regTypes = { AgentRegistration: [
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

  const uintWord = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
  const bytes32Word = (value: string) => `0x${value.slice(2).padStart(64, "0")}`;
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
    const fnSelector = ethers.id("createPolicy(bytes32,address,uint128,uint128,uint128,uint64,uint64,(address,bytes4)[],address[])").slice(0, 10);
    // 9 parameters => 9 words in the ABI head. The last two words are offsets to dynamic arrays.
    const staticHeadWords = 9n;
    const callsTail = [uintWord(BigInt(calls.length)), ...calls.flatMap((call) => [addressWord(call.target), bytes4Word(call.selector)])];
    const nativeTail = [uintWord(BigInt(nativeTargets.length)), ...nativeTargets.map(addressWord)];
    const callsOffset = staticHeadWords * 32n;
    const nativeOffset = callsOffset + BigInt(callsTail.length * 32);
    return ethers.concat([
      fnSelector,
      bytes32Word(salt),
      addressWord(policyAgent),
      uintWord(maxTxValue),
      uintWord(dailyLimit),
      uintWord(approvalThreshold),
      uintWord(0n),
      uintWord(DEADLINE),
      uintWord(callsOffset),
      uintWord(nativeOffset),
      ...callsTail,
      ...nativeTail,
    ]);
  }

  async function sendCreatePolicy(
    salt: string,
    policyAgent: string,
    maxTxValue: bigint,
    dailyLimit: bigint,
    approvalThreshold: bigint,
    calls: { target: string; selector: string }[],
    nativeTargets: string[],
  ) {
    const data = encodeCreatePolicy(salt, policyAgent, maxTxValue, dailyLimit, approvalThreshold, calls, nativeTargets);
    const tx = await owner.sendTransaction({ to: await policyRegistry.getAddress(), data });
    await tx.wait();
  }

  async function createPolicy(dailyLimit: bigint, approvalThreshold: bigint, maxTxValue = ethers.parseEther("100"), calls: {target: string; selector: string}[] = [{target: targetAddress, selector: ZERO_SELECTOR}], nativeTargets: string[] = [targetAddress]) {
    const salt = ethers.keccak256(ethers.toUtf8Bytes(`${dailyLimit}-${approvalThreshold}-${maxTxValue}-${Date.now()}-${Math.random()}`));
    await sendCreatePolicy(salt, agentAddress, maxTxValue, dailyLimit, approvalThreshold, calls, nativeTargets);
    return policyRegistry.policyHashOf(await policyRegistry.computePolicyId(owner.address, salt));
  }

  async function signIntent(policyHash: string, value: bigint, nonce: bigint, deadline = DEADLINE, data = "0x") {
    const net = await ethers.provider.getNetwork();
    return await signTypedDataDigest(agent, { name: "AgentExecutionGuard", version: "1", chainId: net.chainId, verifyingContract: guardAddress }, intentTypes,
      { agent: agentAddress, wallet: await wallet.getAddress(), target: targetAddress, value, calldataHash: ethers.keccak256(data), nonce, deadline, policyHash });
  }
  async function signApproval(policyHash: string, value: bigint, nonce: bigint, approvalDeadline: bigint, deadline = DEADLINE, data = "0x") {
    const net = await ethers.provider.getNetwork();
    return await signTypedDataDigest(owner, { name: "AgentExecutionGuard", version: "1", chainId: net.chainId, verifyingContract: guardAddress }, approvalTypes,
      { agent: agentAddress, wallet: await wallet.getAddress(), target: targetAddress, value, calldataHash: ethers.keccak256(data), nonce, deadline, policyHash, approvalDeadline });
  }
  async function execute(policyHash: string, value: bigint, nonce: bigint, deadline = DEADLINE, data = "0x") {
    const sig = await signIntent(policyHash, value, nonce, deadline, data);


    return guard.executeFromWallet(
      agentAddress,
      await wallet.getAddress(),
      targetAddress,
      value,
      data,
      nonce,
      deadline,
      policyHash,
      sig
    );
  }
  async function executeWithApproval(policyHash: string, value: bigint, nonce: bigint, approvalDeadline: bigint, intentDeadline = DEADLINE, data = "0x", intentSig?: string, approvalSig?: string) {
    const sig = intentSig ?? await signIntent(policyHash, value, nonce, intentDeadline, data);
    const approval = approvalSig ?? await signApproval(policyHash, value, nonce, approvalDeadline, intentDeadline, data);
    return guard.executeWithApprovalFromWallet(agentAddress, await wallet.getAddress(), targetAddress, value, data, nonce, intentDeadline, policyHash, sig, approvalDeadline, approval);
  }

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    agent = ethers.Wallet.createRandom().connect(ethers.provider);
    agentAddress = agent.address;
    registry = await (await ethers.getContractFactory("AgentRegistry")).deploy();
    await registry.waitForDeployment();
    const net = await ethers.provider.getNetwork();
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("gate4b"));
    const sig = await signTypedDataDigest(agent, { name: "AgentRegistry", version: "1", chainId: net.chainId, verifyingContract: await registry.getAddress() }, regTypes, { agent: agentAddress, owner: owner.address, metadataHash });
    await registry.register(agentAddress, owner.address, metadataHash, sig);
    policyRegistry = await (await ethers.getContractFactory("PolicyRegistry")).deploy();
    await policyRegistry.waitForDeployment();
    guard = await (await ethers.getContractFactory("AgentExecutionGuard")).deploy(await registry.getAddress(), await policyRegistry.getAddress());
    await guard.waitForDeployment();
    guardAddress = await guard.getAddress();
    wallet = await deploySmartWallet(owner.address, guardAddress, agent.address);
    await registry.bindWallet(agent.address, await wallet.getAddress());
    await owner.sendTransaction({
      to: await wallet.getAddress(),
      value: ethers.parseEther("10"),
    });
    target = await (await ethers.getContractFactory("RecordingTarget")).deploy();
    await target.waitForDeployment();
    targetAddress = await target.getAddress();
  });

  describe("daily-limit accounting", function () {
    it("allows exactly dailyLimit", async function () {
      const limit = ethers.parseEther("1");
      const policy = await createPolicy(limit, (2n ** 128n) - 1n);
      await execute(policy, limit, 0n);
      expect((await guard.dailySpend(policy)).spent).to.equal(limit);
    });
    it("rejects dailyLimit + 1 wei", async function () {
      const limit = ethers.parseEther("1");
      const policy = await createPolicy(limit, (2n ** 128n) - 1n);
      await expect(execute(policy, limit + 1n, 0n)).to.be.revertedWithCustomError(guard, "DailyLimitExceeded");
    });
    it("aggregates sequential spends under one policy", async function () {
      const limit = ethers.parseEther("1");
      const policy = await createPolicy(limit, (2n ** 128n) - 1n);
      await execute(policy, ethers.parseEther("0.4"), 0n);
      await execute(policy, ethers.parseEther("0.6"), 1n);
      expect((await guard.dailySpend(policy)).spent).to.equal(limit);
      await expect(execute(policy, 1n, 2n)).to.be.revertedWithCustomError(guard, "DailyLimitExceeded");
    });
    it("does not consume allowance or nonce when target reverts", async function () {
      const reverter = await (await ethers.getContractFactory("AlwaysRevertingTarget")).deploy();
      await reverter.waitForDeployment();
      const ra = await reverter.getAddress();
      const salt = ethers.keccak256(ethers.toUtf8Bytes("reverter"));
      await sendCreatePolicy(salt, agentAddress, ethers.parseEther("1"), ethers.parseEther("1"), (2n ** 128n) - 1n, [{target: ra, selector: ZERO_SELECTOR}], [ra]);
      const policy = await policyRegistry.policyHashOf(await policyRegistry.computePolicyId(owner.address, salt));
      const value = ethers.parseEther("0.5");
      const sig = await signTypedDataDigest(agent, {name:"AgentExecutionGuard",version:"1",chainId:(await ethers.provider.getNetwork()).chainId,verifyingContract:guardAddress},intentTypes,
        {agent:agentAddress,wallet:await wallet.getAddress(),target:ra,value,calldataHash:ethers.keccak256("0x"),nonce:0n,deadline:DEADLINE,policyHash:policy});
      // Routed through executeFromWallet (wallet is funded with 10 ETH in
      // beforeEach) so this actually exercises "the target itself
      // reverts", not an unrelated failure to source native value. Using
      // the legacy `execute()` here would revert with
      // `NativeTransferRequiresWalletCustody` before ever reaching
      // `AlwaysRevertingTarget` — that is a different assertion and
      // would silently defeat this test's stated purpose.
      const walletBalBefore = await ethers.provider.getBalance(await wallet.getAddress());
      await expect(
        guard.executeFromWallet(agentAddress, await wallet.getAddress(), ra, value, "0x", 0n, DEADLINE, policy, sig)
      ).to.be.revertedWithCustomError(guard, "ExecutionFailed");
      expect((await guard.dailySpend(policy)).spent).to.equal(0n);
      expect(await guard.nextNonce(agentAddress)).to.equal(0n);
      // and the wallet's balance must be untouched — proves the revert
      // happened inside the target call, not before the wallet was ever
      // asked to move anything.
      expect(await ethers.provider.getBalance(await wallet.getAddress())).to.equal(walletBalBefore);
    });
    it("legacy execute()/executeWithApproval() reject any nonzero value explicitly, rather than failing for an unrelated reason", async function () {
      const salt = ethers.keccak256(ethers.toUtf8Bytes("legacy-value-reject"));
      await sendCreatePolicy(salt, agentAddress, ethers.parseEther("1"), ethers.parseEther("1"), (2n ** 128n) - 1n, [{target: targetAddress, selector: ZERO_SELECTOR}], [targetAddress]);
      const policy = await policyRegistry.policyHashOf(await policyRegistry.computePolicyId(owner.address, salt));
      const value = ethers.parseEther("0.1");
      const sig = await signTypedDataDigest(agent, {name:"AgentExecutionGuard",version:"1",chainId:(await ethers.provider.getNetwork()).chainId,verifyingContract:guardAddress},intentTypes,
        {agent:agentAddress,wallet:await wallet.getAddress(),target:targetAddress,value,calldataHash:ethers.keccak256("0x"),nonce:0n,deadline:DEADLINE,policyHash:policy});
      await expect(
        guard.execute(agentAddress, await wallet.getAddress(), targetAddress, value, "0x", 0n, DEADLINE, policy, sig)
      ).to.be.revertedWithCustomError(guard, "NativeTransferRequiresWalletCustody");
      // a value=0 function call through the same legacy entry point still works
      const sig0 = await signTypedDataDigest(agent, {name:"AgentExecutionGuard",version:"1",chainId:(await ethers.provider.getNetwork()).chainId,verifyingContract:guardAddress},intentTypes,
        {agent:agentAddress,wallet:await wallet.getAddress(),target:targetAddress,value:0n,calldataHash:ethers.keccak256("0x"),nonce:0n,deadline:DEADLINE,policyHash:policy});
      await expect(guard.execute(agentAddress, await wallet.getAddress(), targetAddress, 0n, "0x", 0n, DEADLINE, policy, sig0)).to.not.be.reverted;
    });
    it("zero dailyLimit rejects positive value", async function () {
      const policy = await createPolicy(0n, (2n ** 128n) - 1n);
      await expect(execute(policy, 1n, 0n)).to.be.revertedWithCustomError(guard, "DailyLimitExceeded");
    });
  });

  describe("owner approval", function () {
    it("does not require approval at threshold", async function () {
      const threshold = ethers.parseEther("1");
      const policy = await createPolicy(ethers.parseEther("10"), threshold);
      await execute(policy, threshold, 0n);
    });
    it("requires approval one wei above threshold", async function () {
      const threshold = ethers.parseEther("1");
      const value = threshold + 1n;
      const policy = await createPolicy(ethers.parseEther("10"), threshold);
      await expect(execute(policy, value, 0n)).to.be.revertedWithCustomError(guard, "ApprovalRequired");
      await executeWithApproval(policy, value, 0n, DEADLINE);
    });
    it("rejects a nonce-mismatched owner approval", async function () {
      const policy = await createPolicy(ethers.parseEther("10"), 0n);
      const approval = await signApproval(policy, 1n, 1n, DEADLINE);
      const intent = await signIntent(policy, 1n, 0n);
      await expect(executeWithApproval(policy,1n,0n,DEADLINE,DEADLINE,"0x",intent,approval)).to.be.revertedWithCustomError(guard,"InvalidApprovalSignature");
    });
    it("rejects an approval replayed with altered calldata", async function () {
      const policy = await createPolicy(ethers.parseEther("10"), 0n, ethers.parseEther("100"), [{target: targetAddress, selector: ZERO_SELECTOR}, {target: targetAddress, selector: ALTERED_SELECTOR}], [targetAddress]);
      const approval = await signApproval(policy, 1n, 0n, DEADLINE, DEADLINE, "0x");
      const alteredIntent = await signIntent(policy, 1n, 0n, DEADLINE, ALTERED_SELECTOR);
      await expect(executeWithApproval(policy, 1n, 0n, DEADLINE, DEADLINE, ALTERED_SELECTOR, alteredIntent, approval)).to.be.revertedWithCustomError(guard, "InvalidApprovalSignature");
    });
    it("rejects approval signed by a non-owner", async function () {
      const policy = await createPolicy(ethers.parseEther("10"), 0n);
      const attacker = ethers.Wallet.createRandom().connect(ethers.provider);
      const net = await ethers.provider.getNetwork();
      const approval = await signTypedDataDigest(attacker, {name:"AgentExecutionGuard",version:"1",chainId:net.chainId,verifyingContract:guardAddress},approvalTypes,
        {agent:agentAddress,wallet:await wallet.getAddress(),target:targetAddress,value:1n,calldataHash:ethers.keccak256("0x"),nonce:0n,deadline:DEADLINE,policyHash:policy,approvalDeadline:DEADLINE});
      const intent = await signIntent(policy,1n,0n);
      await expect(executeWithApproval(policy,1n,0n,DEADLINE,DEADLINE,"0x",intent,approval)).to.be.revertedWithCustomError(guard,"InvalidApprovalSignature");
    });
    it("rejects approvalDeadline after intent deadline", async function () {
      const policy = await createPolicy(ethers.parseEther("10"),0n);
      const intentDeadline = 4102440000n;
      const approvalDeadline = intentDeadline + 1n;
      const intent = await signIntent(policy,1n,0n,intentDeadline);
      const approval = await signApproval(policy,1n,0n,approvalDeadline,intentDeadline);
      await expect(executeWithApproval(policy,1n,0n,approvalDeadline,intentDeadline,"0x",intent,approval)).to.be.revertedWithCustomError(guard,"ApprovalDeadlineAfterIntent");
    });
    it("expired approval cannot authorize execution", async function () {
      const policy = await createPolicy(ethers.parseEther("10"),0n);
      const block = (await ethers.provider.getBlock("latest"))!.timestamp;
      const approvalDeadline = BigInt(block + 10);
      const intentDeadline = BigInt(block + 1000);
      const intent = await signIntent(policy,1n,0n,intentDeadline);
      const approval = await signApproval(policy,1n,0n,approvalDeadline,intentDeadline);
      await ethers.provider.send("evm_setNextBlockTimestamp", [block + 11]);
      await expect(executeWithApproval(policy,1n,0n,approvalDeadline,intentDeadline,"0x",intent,approval)).to.be.revertedWithCustomError(guard,"ApprovalExpired");
    });
    it("approval cannot bypass maxTxValue", async function () {
      const capped = await createPolicy(10n,0n,1n);
      const intent = await signIntent(capped,2n,0n);
      const approval = await signApproval(capped,2n,0n,DEADLINE);
      await expect(executeWithApproval(capped,2n,0n,DEADLINE,DEADLINE,"0x",intent,approval)).to.be.revertedWithCustomError(guard,"MaxTxValueExceeded");
    });
    it("approval cannot bypass the daily limit", async function () {
      const limited = await createPolicy(1n,0n);
      await executeWithApproval(limited,1n,0n,DEADLINE);
      const intent2 = await signIntent(limited,1n,1n);
      const approval2 = await signApproval(limited,1n,1n,DEADLINE);
      await expect(executeWithApproval(limited,1n,1n,DEADLINE,DEADLINE,"0x",intent2,approval2)).to.be.revertedWithCustomError(guard,"DailyLimitExceeded");
    });
    it("a policy approval is blocked while the policy is revoked and can be used after explicit reactivation", async function () {
      const policy = await createPolicy(ethers.parseEther("10"), 0n);
      const value = 1n;
      const intent = await signIntent(policy, value, 0n);
      const approval = await signApproval(policy, value, 0n, DEADLINE);

      const policyId = await policyRegistry.policyIdOfHash(policy);
      await policyRegistry.connect(owner).revokePolicy(policyId);

      await expect(
        executeWithApproval(policy, value, 0n, DEADLINE, DEADLINE, "0x", intent, approval)
      ).to.be.revertedWithCustomError(guard, "PolicyNotActive");

      expect(await guard.nextNonce(agentAddress)).to.equal(0n);
      expect((await guard.dailySpend(policy)).spent).to.equal(0n);

      await policyRegistry.connect(owner).reactivatePolicy(policyId);

      await executeWithApproval(policy, value, 0n, DEADLINE, DEADLINE, "0x", intent, approval);
      expect(await guard.nextNonce(agentAddress)).to.equal(1n);
      expect((await guard.dailySpend(policy)).spent).to.equal(value);
    });
    it("an owner approval remains pending across pause/unpause but cannot execute while paused", async function () {
      const policy = await createPolicy(ethers.parseEther("10"), 0n);
      const value = 1n;
      const intent = await signIntent(policy, value, 0n);
      const approval = await signApproval(policy, value, 0n, DEADLINE);

      await guard.connect(owner).pauseAgent(agentAddress);

      await expect(
        executeWithApproval(policy, value, 0n, DEADLINE, DEADLINE, "0x", intent, approval)
      ).to.be.revertedWithCustomError(guard, "AgentExecutionPaused").withArgs(agentAddress);

      expect(await guard.nextNonce(agentAddress)).to.equal(0n);
      expect((await guard.dailySpend(policy)).spent).to.equal(0n);

      await guard.connect(owner).unpauseAgent(agentAddress);

      await executeWithApproval(policy, value, 0n, DEADLINE, DEADLINE, "0x", intent, approval);
      expect(await guard.nextNonce(agentAddress)).to.equal(1n);
      expect((await guard.dailySpend(policy)).spent).to.equal(value);
    });
  });
});


