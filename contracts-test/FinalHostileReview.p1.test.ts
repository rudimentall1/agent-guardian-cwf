import { expect } from "chai";
import { ethers } from "hardhat";
import { deploySmartWallet, fundSmartWallet } from "./smartWalletTestHelpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * FINAL HOSTILE REVIEW of the P1 fix (Option B: live
 * policy.owner == AgentRegistry.ownerOf(intent.agent) check).
 *
 * Every test in this file runs against the REAL, non-mocked
 * AgentRegistry + PolicyRegistry + AgentExecutionGuard stack, per the
 * review brief's explicit instruction. Each test names the exact
 * authorization invariant it proves in its own description.
 */
describe("FINAL HOSTILE REVIEW: policy-owner authorization (real stack, no mocks)", function () {
  let agentRegistry: any;
  let agentRegistryAddress: string;
  let policyRegistry: any;
  let policyRegistryAddress: string;
  let guard: any;
  let guardAddress: string;
  let target: any;
  let targetAddress: string;
  let ownerA: HardhatEthersSigner;
  let ownerB: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let wallet: any;
  let agentA: ReturnType<typeof ethers.Wallet.createRandom>;

  const FAR_DEADLINE = 4102444800n;
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

  async function intentDomain() {
    const net = await ethers.provider.getNetwork();
    return { name: "AgentExecutionGuard", version: "1", chainId: net.chainId, verifyingContract: guardAddress };
  }

  interface Intent {
    agent: string; wallet: string; target: string; value: bigint; data: string;
    nonce: bigint; deadline: bigint; policyHash: string;
  }

  async function signIntent(signer: any, p: Intent) {
    const d = await intentDomain();

    const value = {
      agent: p.agent,
      wallet: p.wallet,
      target: p.target,
      value: p.value,
      calldataHash: ethers.keccak256(p.data),
      nonce: p.nonce,
      deadline: p.deadline,
      policyHash: p.policyHash,
    };

    const digest = ethers.TypedDataEncoder.hash(d, intentTypes, value);
    const signature = signer.signingKey.sign(digest);

    return ethers.Signature.from(signature).serialized;
  }
  async function submit(intent: Intent, sig: string, sender: any = agentA) {
    return guard.connect(sender).execute(
      intent.agent, intent.wallet, intent.target, intent.value, intent.data,
      intent.nonce, intent.deadline, intent.policyHash, sig,
    );
  }

  async function createPolicy(
    creator: HardhatEthersSigner | typeof agentA,
    agent: string,
    salt: string,
    maxTxValue = ethers.parseEther("1")
  ) {
    const tx = await policyRegistry.connect(creator).createPolicy(
      salt, agent, maxTxValue, 0n, 0n, 0n, FAR_DEADLINE, [], [targetAddress]
    );
    await tx.wait();
    const creatorAddress = "address" in creator ? creator.address : (creator as any).address;
    const policyId = await policyRegistry.computePolicyId(creatorAddress, salt);
    const policyHash = await policyRegistry.policyHashOf(policyId);
    return { policyId, policyHash };
  }

  beforeEach(async function () {
    [ownerA, ownerB, stranger] = await ethers.getSigners();
    agentA = ethers.Wallet.createRandom().connect(ethers.provider);
    await ethers.provider.send("hardhat_setBalance", [agentA.address, "0x" + ethers.parseEther("1000").toString(16)]);

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    agentRegistry = await AgentRegistry.deploy();
    await agentRegistry.waitForDeployment();
    agentRegistryAddress = await agentRegistry.getAddress();

    const net = await ethers.provider.getNetwork();
    const regDomain = { name: "AgentRegistry", version: "1", chainId: net.chainId, verifyingContract: agentRegistryAddress };
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("config"));
    const regSig = await agentA.signTypedData(regDomain, registrationTypes, {
      agent: agentA.address, owner: ownerA.address, metadataHash,
    });
    await agentRegistry.register(agentA.address, ownerA.address, metadataHash, regSig);

    const PolicyRegistry = await ethers.getContractFactory("PolicyRegistry");
    policyRegistry = await PolicyRegistry.deploy();
    await policyRegistry.waitForDeployment();
    policyRegistryAddress = await policyRegistry.getAddress();

    const Guard = await ethers.getContractFactory("AgentExecutionGuard");
    guard = await Guard.deploy(agentRegistryAddress, policyRegistryAddress);
    await guard.waitForDeployment();
    guardAddress = await guard.getAddress();
    wallet = await deploySmartWallet(ownerA.address, guardAddress, agentA.address);
    await agentRegistry.bindWallet(agentA.address, await wallet.getAddress());
    await fundSmartWallet(wallet, ethers.parseEther("100"));

    const RecordingTarget = await ethers.getContractFactory("RecordingTarget");
    target = await RecordingTarget.deploy();
    await target.waitForDeployment();
    targetAddress = await target.getAddress();
  });

  // 1. Owner A + Agent A + Policy A -> execute PASS.
  it("1. Owner A + Agent A + Policy A -> execute PASS", async function () {
    const { policyHash } = await createPolicy(ownerA, agentA.address, ethers.keccak256(ethers.toUtf8Bytes("policy-A")));
    const intent: Intent = { agent: agentA.address, wallet: await wallet.getAddress(), target: targetAddress, value: 0n, data: "0x", nonce: 0n, deadline: FAR_DEADLINE, policyHash };
    const sig = await signIntent(agentA, intent);
    await submit(intent, sig);
    expect(await guard.nextNonce(agentA.address)).to.equal(1n);
  });

  // 2. Owner A transfers Agent A ownership to Owner B -> old Policy A
  // must REVERT. Two-stage per actual AgentRegistry semantics: transfer
  // itself forces active=false, so immediately after transfer the
  // failure is AgentNotActive; only after Owner B reactivates does the
  // OLD policy's owner mismatch become the reachable failure mode.
  describe("2. ownership transfer -> old Policy A must REVERT", function () {
    it("2a. immediately after transfer (before reactivation): AgentNotActive", async function () {
      const { policyHash } = await createPolicy(ownerA, agentA.address, ethers.keccak256(ethers.toUtf8Bytes("policy-A")));
      const intent: Intent = { agent: agentA.address, wallet: await wallet.getAddress(), target: targetAddress, value: 0n, data: "0x", nonce: 0n, deadline: FAR_DEADLINE, policyHash };
      const sig = await signIntent(agentA, intent);

      await wallet.connect(ownerA).transferOwnership(ownerB.address);
      await agentRegistry.connect(ownerA).transferAgentOwnership(agentA.address, ownerB.address);

      await expect(submit(intent, sig)).to.be.revertedWithCustomError(guard, "AgentNotActive");
    });

    it("2b. after Owner B reactivates: PolicyOwnerMismatch (the load-bearing P1 case)", async function () {
      const { policyHash } = await createPolicy(ownerA, agentA.address, ethers.keccak256(ethers.toUtf8Bytes("policy-A")));
      const intent: Intent = { agent: agentA.address, wallet: await wallet.getAddress(), target: targetAddress, value: 0n, data: "0x", nonce: 0n, deadline: FAR_DEADLINE, policyHash };
      const sig = await signIntent(agentA, intent);

      await wallet.connect(ownerA).transferOwnership(ownerB.address);
      await agentRegistry.connect(ownerA).transferAgentOwnership(agentA.address, ownerB.address);
      await agentRegistry.connect(ownerB).reactivate(agentA.address);

      await expect(submit(intent, sig))
        .to.be.revertedWithCustomError(guard, "PolicyOwnerMismatch")
        .withArgs(policyHash, ownerB.address, ownerA.address);
    });
  });

  // 3. A second wallet owned by the same owner and bound to the same agent
  // must not become an alternate custody target. The registry's one-time
  // canonical wallet binding is the load-bearing invariant here.
  it("3. same owner + same agent + different wallet -> REVERT WalletNotCanonical", async function () {
    const { policyHash } = await createPolicy(ownerA, agentA.address, ethers.keccak256(ethers.toUtf8Bytes("policy-canonical-wallet")));
    const Wallet = await ethers.getContractFactory("AgentSmartWallet");
    const secondWallet = await Wallet.deploy(ownerA.address, guardAddress, agentA.address);
    await secondWallet.waitForDeployment();

    const intent: Intent = {
      agent: agentA.address,
      wallet: await secondWallet.getAddress(),
      target: targetAddress,
      value: 0n,
      data: "0x",
      nonce: 0n,
      deadline: FAR_DEADLINE,
      policyHash,
    };
    const sig = await signIntent(agentA, intent);

    await expect(submit(intent, sig))
      .to.be.revertedWithCustomError(guard, "WalletNotCanonical")
      .withArgs(await secondWallet.getAddress(), await wallet.getAddress(), agentA.address);
  });

  // 4. Owner B creates Policy B for the same Agent A -> execute PASS.
  it("3. Owner B creates Policy B for the same Agent A -> execute PASS", async function () {
    await wallet.connect(ownerA).transferOwnership(ownerB.address);
    await agentRegistry.connect(ownerA).transferAgentOwnership(agentA.address, ownerB.address);
    await agentRegistry.connect(ownerB).reactivate(agentA.address);

    const { policyHash } = await createPolicy(ownerB, agentA.address, ethers.keccak256(ethers.toUtf8Bytes("policy-B")));
    const intent: Intent = { agent: agentA.address, wallet: await wallet.getAddress(), target: targetAddress, value: 0n, data: "0x", nonce: 0n, deadline: FAR_DEADLINE, policyHash };
    const sig = await signIntent(agentA, intent);
    await submit(intent, sig);
    expect(await guard.nextNonce(agentA.address)).to.equal(1n);
  });

  // 4. Owner A attempts to create/use a new policy for Agent A after
  // losing ownership -> must NOT obtain execution authority.
  it("4. Owner A creates a NEW policy after losing ownership -> creation succeeds, execution REVERTs", async function () {
    await wallet.connect(ownerA).transferOwnership(ownerB.address);
    await agentRegistry.connect(ownerA).transferAgentOwnership(agentA.address, ownerB.address);
    await agentRegistry.connect(ownerB).reactivate(agentA.address);

    const { policyHash } = await createPolicy(ownerA, agentA.address, ethers.keccak256(ethers.toUtf8Bytes("policy-A-post-transfer")));

    const intent: Intent = { agent: agentA.address, wallet: await wallet.getAddress(), target: targetAddress, value: 0n, data: "0x", nonce: 0n, deadline: FAR_DEADLINE, policyHash };
    const sig = await signIntent(agentA, intent);
    await expect(submit(intent, sig))
      .to.be.revertedWithCustomError(guard, "PolicyOwnerMismatch")
      .withArgs(policyHash, ownerB.address, ownerA.address);
  });

  // 5. Agent A creates its own permissive policy using its own
  // legitimate key -> execute MUST REVERT with PolicyOwnerMismatch.
  it("5. Agent A self-creates a permissive policy -> REVERT PolicyOwnerMismatch", async function () {
    const salt = ethers.keccak256(ethers.toUtf8Bytes("attacker-policy"));
    const { policyHash } = await createPolicy(agentA, agentA.address, salt, ethers.parseEther("1000"));

    const intent: Intent = { agent: agentA.address, wallet: await wallet.getAddress(), target: targetAddress, value: ethers.parseEther("500"), data: "0x", nonce: 0n, deadline: FAR_DEADLINE, policyHash };
    const sig = await signIntent(agentA, intent);
    await expect(submit(intent, sig))
      .to.be.revertedWithCustomError(guard, "PolicyOwnerMismatch")
      .withArgs(policyHash, ownerA.address, agentA.address);
  });

  // 6. Agent A attempts to use Policy B belonging to another (unrelated,
  // third-party) owner -> REVERT.
  it("6. Agent A uses a policy created by an unrelated third party -> REVERT", async function () {
    const salt = ethers.keccak256(ethers.toUtf8Bytes("stranger-policy"));
    const { policyHash } = await createPolicy(stranger, agentA.address, salt, ethers.parseEther("1000"));

    const intent: Intent = { agent: agentA.address, wallet: await wallet.getAddress(), target: targetAddress, value: 0n, data: "0x", nonce: 0n, deadline: FAR_DEADLINE, policyHash };
    const sig = await signIntent(agentA, intent);
    await expect(submit(intent, sig))
      .to.be.revertedWithCustomError(guard, "PolicyOwnerMismatch")
      .withArgs(policyHash, ownerA.address, stranger.address);
  });

  // 7. Inactive Agent -> REVERT.
  it("7. Inactive agent -> REVERT AgentNotActive, even with an otherwise-perfect legitimate policy", async function () {
    const { policyHash } = await createPolicy(ownerA, agentA.address, ethers.keccak256(ethers.toUtf8Bytes("policy-A")));
    await agentRegistry.connect(ownerA).deactivate(agentA.address);

    const intent: Intent = { agent: agentA.address, wallet: await wallet.getAddress(), target: targetAddress, value: 0n, data: "0x", nonce: 0n, deadline: FAR_DEADLINE, policyHash };
    const sig = await signIntent(agentA, intent);
    await expect(submit(intent, sig)).to.be.revertedWithCustomError(guard, "AgentNotActive");
  });

  // 8. Reactivating an agent after ownership transfer MUST NOT revive
  // policies belonging to the previous owner.
  it("8. Repeated reactivation cycles never revive the old owner's policy", async function () {
    const { policyHash } = await createPolicy(ownerA, agentA.address, ethers.keccak256(ethers.toUtf8Bytes("policy-A")));
    const intent: Intent = { agent: agentA.address, wallet: await wallet.getAddress(), target: targetAddress, value: 0n, data: "0x", nonce: 0n, deadline: FAR_DEADLINE, policyHash };
    const sig = await signIntent(agentA, intent);

    await wallet.connect(ownerA).transferOwnership(ownerB.address);
    await agentRegistry.connect(ownerA).transferAgentOwnership(agentA.address, ownerB.address);
    await agentRegistry.connect(ownerB).reactivate(agentA.address);
    await expect(submit(intent, sig)).to.be.revertedWithCustomError(guard, "PolicyOwnerMismatch");

    await agentRegistry.connect(ownerB).deactivate(agentA.address);
    await agentRegistry.connect(ownerB).reactivate(agentA.address);
    await expect(submit(intent, sig)).to.be.revertedWithCustomError(guard, "PolicyOwnerMismatch");

    await agentRegistry.connect(ownerB).deactivate(agentA.address);
    await agentRegistry.connect(ownerB).reactivate(agentA.address);
    await expect(submit(intent, sig)).to.be.revertedWithCustomError(guard, "PolicyOwnerMismatch");

    expect(await guard.nextNonce(agentA.address)).to.equal(0n);
  });

  // 9. Old policyHash must not become valid again after ownership
  // transfer/reactivation — corroborated via direct storage inspection.
  it("9. Old policyHash's owner is verifiably permanent in PolicyRegistry storage across transfer/reactivation", async function () {
    const { policyId, policyHash } = await createPolicy(ownerA, agentA.address, ethers.keccak256(ethers.toUtf8Bytes("policy-A")));
    const ownerBefore = await policyRegistry.ownerOf(policyId);

    await wallet.connect(ownerA).transferOwnership(ownerB.address);
    await agentRegistry.connect(ownerA).transferAgentOwnership(agentA.address, ownerB.address);
    await agentRegistry.connect(ownerB).reactivate(agentA.address);

    const ownerAfter = await policyRegistry.ownerOf(policyId);
    expect(ownerAfter).to.equal(ownerBefore);
    expect(ownerAfter).to.equal(ownerA.address);
    expect(ownerAfter).to.not.equal(await agentRegistry.ownerOf(agentA.address));
    expect(await policyRegistry.policyHashOf(policyId)).to.equal(policyHash);
  });

  // 10. No policyHash substitution can bypass owner binding.
  it("10. Substituting a different (legitimately-owned) policyHash after signing -> REVERT InvalidSignature", async function () {
    const salt = ethers.keccak256(ethers.toUtf8Bytes("attacker-policy"));
    const { policyHash: attackerHash } = await createPolicy(agentA, agentA.address, salt, ethers.parseEther("1000"));
    const { policyHash: legitHash } = await createPolicy(ownerA, agentA.address, ethers.keccak256(ethers.toUtf8Bytes("policy-A")));

    const intent: Intent = { agent: agentA.address, wallet: await wallet.getAddress(), target: targetAddress, value: 0n, data: "0x", nonce: 0n, deadline: FAR_DEADLINE, policyHash: attackerHash };
    const sig = await signIntent(agentA, intent);

    const substituted = { ...intent, policyHash: legitHash };
    await expect(submit(substituted, sig)).to.be.revertedWithCustomError(guard, "InvalidSignature");
  });

  // 11. No EIP-712 field substitution can bypass owner binding.
  it("11. Field substitution (target) with a legitimately-signed intent -> REVERT", async function () {
    const { policyHash } = await createPolicy(ownerA, agentA.address, ethers.keccak256(ethers.toUtf8Bytes("policy-A")));
    const RecordingTarget = await ethers.getContractFactory("RecordingTarget");
    const otherTarget = await RecordingTarget.deploy();
    await otherTarget.waitForDeployment();

    const intent: Intent = { agent: agentA.address, wallet: await wallet.getAddress(), target: targetAddress, value: 0n, data: "0x", nonce: 0n, deadline: FAR_DEADLINE, policyHash };
    const sig = await signIntent(agentA, intent);
    const tampered = { ...intent, target: await otherTarget.getAddress() };
    await expect(submit(tampered, sig)).to.be.reverted;
  });

  // 12. No nonce manipulation can bypass owner binding.
  it("12. An attacker-owned policy is rejected via PolicyOwnerMismatch regardless of nonce value", async function () {
    const salt = ethers.keccak256(ethers.toUtf8Bytes("attacker-policy"));
    const { policyHash } = await createPolicy(agentA, agentA.address, salt, ethers.parseEther("1000"));

    for (const nonce of [0n, 1n, 1_000_000n]) {
      const intent: Intent = { agent: agentA.address, wallet: await wallet.getAddress(), target: targetAddress, value: 0n, data: "0x", nonce, deadline: FAR_DEADLINE, policyHash };
      const sig = await signIntent(agentA, intent);
      await expect(submit(intent, sig))
        .to.be.revertedWithCustomError(guard, "PolicyOwnerMismatch")
        .withArgs(policyHash, ownerA.address, agentA.address);
    }
    expect(await guard.nextNonce(agentA.address)).to.equal(0n);
  });

  // 13. Reentrancy must not provide a path around the owner check.
  it("13. Reentrant attempt using an attacker-owned policy is blocked by nonReentrant", async function () {
    const Attacker = await ethers.getContractFactory("ReentrantAttacker");
    const attacker = await Attacker.deploy();
    await attacker.waitForDeployment();
    const attackerAddress = await attacker.getAddress();
    await attacker.setGuard(guardAddress);

    await policyRegistry.connect(ownerA).createPolicy(
      ethers.keccak256(ethers.toUtf8Bytes("policy-outer-native")), agentA.address,
      ethers.parseEther("1"), 0n, 0n, 0n, FAR_DEADLINE, [], [attackerAddress]
    );
    const outerPolicyId = await policyRegistry.computePolicyId(ownerA.address, ethers.keccak256(ethers.toUtf8Bytes("policy-outer-native")));
    const outerPolicyHash = await policyRegistry.policyHashOf(outerPolicyId);

    const attackerSalt = ethers.keccak256(ethers.toUtf8Bytes("reentry-attacker-policy"));
    const { policyHash: reentryHash } = await createPolicy(agentA, agentA.address, attackerSalt, ethers.parseEther("1000"));

    const reentryIntent: Intent = { agent: agentA.address, wallet: await wallet.getAddress(), target: attackerAddress, value: 0n, data: "0x", nonce: 0n, deadline: FAR_DEADLINE, policyHash: reentryHash };
    const reentrySig = await signIntent(agentA, reentryIntent);
    const reentryCalldata = guard.interface.encodeFunctionData("execute", [
      reentryIntent.agent, reentryIntent.wallet, reentryIntent.target, reentryIntent.value,
      reentryIntent.data, reentryIntent.nonce, reentryIntent.deadline, reentryIntent.policyHash, reentrySig,
    ]);
    await attacker.setReentryCalldata(reentryCalldata);

    const outerIntent: Intent = { agent: agentA.address, wallet: await wallet.getAddress(), target: attackerAddress, value: 0n, data: "0x", nonce: 0n, deadline: FAR_DEADLINE, policyHash: outerPolicyHash };
    const outerSig = await signIntent(agentA, outerIntent);
    await submit(outerIntent, outerSig);

    expect(await attacker.reentered()).to.equal(true);
    expect(await attacker.reentrySucceeded()).to.equal(false);
    expect(await guard.nextNonce(agentA.address)).to.equal(1n);
  });

  // 14. Failed owner check must not consume nonce or mutate execution
  // state.
  it("14. A PolicyOwnerMismatch revert leaves nonce and target state completely untouched", async function () {
    const salt = ethers.keccak256(ethers.toUtf8Bytes("attacker-policy"));
    const { policyHash } = await createPolicy(agentA, agentA.address, salt, ethers.parseEther("1000"));

    const value = ethers.parseEther("5");
    const intent: Intent = { agent: agentA.address, wallet: await wallet.getAddress(), target: targetAddress, value, data: "0x", nonce: 0n, deadline: FAR_DEADLINE, policyHash };
    const sig = await signIntent(agentA, intent);

    const balanceBefore = await ethers.provider.getBalance(targetAddress);
    await expect(submit(intent, sig)).to.be.revertedWithCustomError(guard, "PolicyOwnerMismatch");
    const balanceAfter = await ethers.provider.getBalance(targetAddress);

    expect(await guard.nextNonce(agentA.address)).to.equal(0n);
    expect(balanceAfter).to.equal(balanceBefore);
    expect(await ethers.provider.getBalance(guardAddress)).to.equal(0n);

    const { policyHash: legitHash } = await createPolicy(ownerA, agentA.address, ethers.keccak256(ethers.toUtf8Bytes("policy-A")));
    const legitIntent: Intent = { agent: agentA.address, wallet: await wallet.getAddress(), target: targetAddress, value: 0n, data: "0x", nonce: 0n, deadline: FAR_DEADLINE, policyHash: legitHash };
    const legitSig = await signIntent(agentA, legitIntent);
    await submit(legitIntent, legitSig);
    expect(await guard.nextNonce(agentA.address)).to.equal(1n);
  });
});


