import { expect } from "chai";
import { ethers } from "hardhat";
import { signTypedDataDigest } from "./typedDataTestHelpers";
import { deploySmartWallet, fundSmartWallet } from "./smartWalletTestHelpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Integration between the real Gate 1 AgentRegistry and Gate 2
 * AgentExecutionGuard — exercises the actual registration flow, not the
 * MockAgentRegistry used by AgentExecutionGuard.test.ts, and specifically
 * the ownership-transfer lifecycle edge case the Gate 2 brief calls out.
 */
describe("AgentExecutionGuard + AgentRegistry integration", function () {
  let registry: any;
  let registryAddress: string;
  let guard: any;
  let guardAddress: string;
  let policyRegistry: any;
  let policyRegistryAddress: string;
  let target: any;
  let targetAddress: string;
  let owner: HardhatEthersSigner;
  let newOwner: HardhatEthersSigner;
  let wallet: any;
  let agent: ReturnType<typeof ethers.Wallet.createRandom>;

  const METADATA_HASH = ethers.keccak256(ethers.toUtf8Bytes("agent-v1-config"));
  const ZERO_HASH = ethers.ZeroHash;
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

  async function registrationDomain() {
    const net = await ethers.provider.getNetwork();
    return { name: "AgentRegistry", version: "1", chainId: net.chainId, verifyingContract: registryAddress };
  }

  async function intentDomain() {
    const net = await ethers.provider.getNetwork();
    return { name: "AgentExecutionGuard", version: "1", chainId: net.chainId, verifyingContract: guardAddress };
  }

  async function signIntent(nonce: bigint, deadline = FAR_DEADLINE, policyHash = ZERO_HASH) {
    const d = await intentDomain();
    const calldataHash = ethers.keccak256("0x");
    return await signTypedDataDigest(agent, d, intentTypes, {
      agent: agent.address,
      wallet: await wallet.getAddress(),
      target: targetAddress,
      value: 0n,
      calldataHash,
      nonce,
      deadline,
      policyHash,
    });
  }

  async function execute(nonce: bigint, deadline = FAR_DEADLINE) {
    const sig = await signIntent(nonce, deadline);
    return guard.execute(agent.address, await wallet.getAddress(), targetAddress, 0n, "0x", nonce, deadline, ZERO_HASH, sig);
  }

  beforeEach(async function () {
    [owner, newOwner] = await ethers.getSigners();
    agent = ethers.Wallet.createRandom().connect(ethers.provider);

    const Registry = await ethers.getContractFactory("AgentRegistry");
    registry = await Registry.deploy();
    await registry.waitForDeployment();
    registryAddress = await registry.getAddress();

    const Guard = await ethers.getContractFactory("AgentExecutionGuard");
    const MockPolicyRegistry = await ethers.getContractFactory("MockPolicyRegistry");
    policyRegistry = await MockPolicyRegistry.deploy();
    await policyRegistry.waitForDeployment();
    policyRegistryAddress = await policyRegistry.getAddress();

    const Target = await ethers.getContractFactory("RecordingTarget");
    target = await Target.deploy();
    await target.waitForDeployment();
    targetAddress = await target.getAddress();

    // owner=owner.address matches the REAL AgentRegistry's registered
    // owner for `agent` (this file registers agent under `owner` a few
    // lines below) — using the 3-arg setBinding convenience default
    // (owner==agent) would not match, since this file exercises the
    // real registry's actual owner/agent distinction, not the mock's
    // simplifying default.
    await policyRegistry.setFullBinding(ZERO_HASH, owner.address, agent.address, true, true, ethers.MaxUint256);
    await policyRegistry.authorizeNativeTransfer(ZERO_HASH, targetAddress);
    guard = await Guard.deploy(registryAddress, policyRegistryAddress);
    await guard.waitForDeployment();
    guardAddress = await guard.getAddress();
    wallet = await deploySmartWallet(owner.address, guardAddress, agent.address);
    await fundSmartWallet(wallet, ethers.parseEther("10"));

    const rd = await registrationDomain();
    const regSig = await signTypedDataDigest(agent, rd, registrationTypes, {
      agent: agent.address,
      owner: owner.address,
      metadataHash: METADATA_HASH,
    });
    await registry.register(agent.address, owner.address, METADATA_HASH, regSig);
    await registry.bindWallet(agent.address, await wallet.getAddress());
  });

  it("executes through the guard once genuinely registered and active", async function () {
    await execute(0n);
    expect(await guard.nextNonce(agent.address)).to.equal(1n);
  });

  it("rejects execution for an agent that was never registered", async function () {
    const strangerAgent = ethers.Wallet.createRandom().connect(ethers.provider);
    const d = await intentDomain();
    const sig = await signTypedDataDigest(strangerAgent, d, intentTypes, {
      agent: strangerAgent.address,
      wallet: await wallet.getAddress(),
      target: targetAddress,
      value: 0n,
      calldataHash: ethers.keccak256("0x"),
      nonce: 0n,
      deadline: FAR_DEADLINE,
      policyHash: ZERO_HASH,
    });
    await expect(
      guard.execute(strangerAgent.address, await wallet.getAddress(), targetAddress, 0n, "0x", 0n, FAR_DEADLINE, ZERO_HASH, sig)
    ).to.be.revertedWithCustomError(guard, "AgentNotActive");
  });

  it("rejects execution once the owner deactivates the agent via the real registry", async function () {
    await registry.connect(owner).deactivate(agent.address);
    await expect(execute(0n)).to.be.revertedWithCustomError(guard, "AgentNotActive");
  });

  describe("ownership transfer lifecycle edge case", function () {
    it("a signed-but-not-yet-submitted intent becomes unusable the instant ownership transfers, with no guard-side revocation needed", async function () {
      // agent's operator prepares a signature for nonce 0 but hasn't
      // submitted it yet
      const sig = await signIntent(0n);

      // Custody must move before registry ownership can move.
      await wallet.connect(owner).transferOwnership(newOwner.address);
      // original owner transfers the agent away (Gate 1 forces inactive
      // on transfer)
      await registry.connect(owner).transferAgentOwnership(agent.address, newOwner.address);

      // the previously-valid signature is now rejected purely because
      // AgentRegistry.isActiveAgent is checked live at execution time —
      // AgentExecutionGuard needed no explicit revocation logic of its own.
      await expect(
        guard.execute(agent.address, await wallet.getAddress(), targetAddress, 0n, "0x", 0n, FAR_DEADLINE, ZERO_HASH, sig)
      ).to.be.revertedWithCustomError(guard, "AgentNotActive");
    });

    it("the OLD policy (bound to the old owner) remains permanently unusable even after the new owner reactivates the agent — this is the correct, intended P1 consequence", async function () {
      const sig = await signIntent(0n);
      await wallet.connect(owner).transferOwnership(newOwner.address);
      await registry.connect(owner).transferAgentOwnership(agent.address, newOwner.address);
      await registry.connect(newOwner).reactivate(agent.address);

      // [P1 fix] The mock policy binding set up in beforeEach still
      // records `owner: owner.address` (the ORIGINAL owner) — that
      // binding is immutable in the real PolicyRegistry (see ADR-0003),
      // and AgentRegistry.ownerOf(agent) now live-reports `newOwner`.
      // The agent's signing key never changed and the signature is
      // still cryptographically valid, but the POLICY it references was
      // never authorized by the current owner — this must fail, by
      // design, exactly the same way a stale AgentRegistry activity
      // check would. Reactivating the AGENT does not, and must not,
      // resurrect a policy that belongs to a since-departed owner.
      await expect(
        guard.execute(agent.address, await wallet.getAddress(), targetAddress, 0n, "0x", 0n, FAR_DEADLINE, ZERO_HASH, sig)
      ).to.be.revertedWithCustomError(guard, "PolicyOwnerMismatch").withArgs(ZERO_HASH, newOwner.address, owner.address);
    });

    it("the agent's signing key itself is unaffected by ownership transfer — a policy the NEW owner establishes works immediately with the SAME key", async function () {
      const sig = await signIntent(0n);
      await wallet.connect(owner).transferOwnership(newOwner.address);
      await registry.connect(owner).transferAgentOwnership(agent.address, newOwner.address);
      await registry.connect(newOwner).reactivate(agent.address);

      // old policy: still correctly dead (see previous test)
      await expect(
        guard.execute(agent.address, await wallet.getAddress(), targetAddress, 0n, "0x", 0n, FAR_DEADLINE, ZERO_HASH, sig)
      ).to.be.reverted;

      // the new owner establishes their OWN policy for the same agent
      // (in real PolicyRegistry this is a fresh createPolicy call under
      // `newOwner`; the mock models the same fact directly) — no agent
      // re-registration, no new signing key, nothing about the agent
      // itself changes.
      const newPolicyHash = ethers.keccak256(ethers.toUtf8Bytes("new-owner-policy"));
      await policyRegistry.setFullBinding(newPolicyHash, newOwner.address, agent.address, true, true, ethers.MaxUint256);
      await policyRegistry.authorizeNativeTransfer(newPolicyHash, targetAddress);

      // the SAME agent key signs a new intent referencing the new
      // policy — succeeds immediately.
      const newNonce = await guard.nextNonce(agent.address);
      const newSig = await signIntent(newNonce, FAR_DEADLINE, newPolicyHash);
      await guard.execute(agent.address, await wallet.getAddress(), targetAddress, 0n, "0x", newNonce, FAR_DEADLINE, newPolicyHash, newSig);
      expect(await guard.nextNonce(agent.address)).to.equal(newNonce + 1n);
    });

    it("nonce state is not reset by ownership transfer or reactivation", async function () {
      await execute(0n);
      await execute(1n);
      expect(await guard.nextNonce(agent.address)).to.equal(2n);

      await wallet.connect(owner).transferOwnership(newOwner.address);
      await registry.connect(owner).transferAgentOwnership(agent.address, newOwner.address);
      await registry.connect(newOwner).reactivate(agent.address);
      // [P1 fix] update the mock policy binding to the new owner so this
      // test continues to isolate nonce behavior specifically, rather
      // than being masked by the (separately, and correctly) unrelated
      // PolicyOwnerMismatch that the two tests above cover on their own.
      await policyRegistry.setFullBinding(ZERO_HASH, newOwner.address, agent.address, true, true, ethers.MaxUint256);

      // Ownership handoff moves the nonce into a new epoch. The old
      // nonce 2 is permanently stale; the next valid nonce is the epoch-1
      // base, preserving the sequential counter inside that epoch.
      const epochNonce = await guard.nextNonce(agent.address);
      expect(epochNonce).to.equal(1n << 192n);
      await expect(execute(2n)).to.be.revertedWithCustomError(guard, "InvalidNonce").withArgs(2n, epochNonce);
      await execute(epochNonce);
      expect(await guard.nextNonce(agent.address)).to.equal(epochNonce + 1n);
    });
  });
});
