import { expect } from "chai";
import { ethers } from "hardhat";
import { deploySmartWallet, fundSmartWallet } from "./smartWalletTestHelpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("AgentExecutionGuard", function () {
  let guard: any;
  let guardAddress: string;
  let registry: any;
  let registryAddress: string;
  let policyRegistry: any;
  let policyRegistryAddress: string;
  let target: any;
  let targetAddress: string;
  let reverter: any;
  let reverterAddress: string;
  let relayer: HardhatEthersSigner;
  let agentA: ReturnType<typeof ethers.Wallet.createRandom>;
  let agentB: ReturnType<typeof ethers.Wallet.createRandom>;
  let walletA: any;
  let walletB: any;
  let walletAlias: any;

  const ZERO_HASH = ethers.ZeroHash;
  const FAR_DEADLINE = 4102444800n; // 2100-01-01, far enough for all tests

  // Deterministic per-agent default policyHash, so most tests get a
  // pre-bound, active policy "for free" without needing to think about
  // the remediation gate's policy-agent binding check. Tests that
  // specifically exercise that check use their own explicit hashes.
  function defaultPolicyHashFor(agentAddr: string) {
    return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "string"], [agentAddr, "default-policy"]));
  }

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

  async function domain() {
    const net = await ethers.provider.getNetwork();
    return {
      name: "AgentExecutionGuard",
      version: "1",
      chainId: net.chainId,
      verifyingContract: guardAddress,
    };
  }

  interface IntentParams {
    agent: string;
    wallet: string;
    target: string;
    value: bigint;
    data: string;
    nonce: bigint;
    deadline: bigint;
    policyHash: string;
  }

  async function signIntent(signerWallet: any, p: IntentParams) {
    const d = await domain();
    const calldataHash = ethers.keccak256(p.data);

    const value = {
      agent: p.agent,
      wallet: p.wallet,
      target: p.target,
      value: p.value,
      calldataHash,
      nonce: p.nonce,
      deadline: p.deadline,
      policyHash: p.policyHash,
    };

    const digest = ethers.TypedDataEncoder.hash(d, types, value);
    const signature = signerWallet.signingKey.sign(digest);

    return ethers.Signature.from(signature).serialized;
  }
  async function execute(p: IntentParams, signature: string) {
    return guard.executeFromWallet(
      p.agent,
      p.wallet,
      p.target,
      p.value,
      p.data,
      p.nonce,
      p.deadline,
      p.policyHash,
      signature
    );
  }

  async function baseIntent(agentAddr: string, walletAddr: string, nonce: bigint, overrides: Partial<IntentParams> = {}): Promise<IntentParams> {
    return {
      agent: agentAddr,
      wallet: walletAddr,
      target: targetAddress,
      value: 0n,
      data: "0x",
      nonce,
      deadline: FAR_DEADLINE,
      policyHash: defaultPolicyHashFor(agentAddr),
      ...overrides,
    };

  }
  beforeEach(async function () {
    [relayer] = await ethers.getSigners();
    agentA = ethers.Wallet.createRandom().connect(ethers.provider);
    agentB = ethers.Wallet.createRandom().connect(ethers.provider);

    const MockRegistry = await ethers.getContractFactory("MockAgentRegistry");
    registry = await MockRegistry.deploy();
    await registry.waitForDeployment();
    registryAddress = await registry.getAddress();
    await registry.setActive(agentA.address, true);
    await registry.setActive(agentB.address, true);

    const Target = await ethers.getContractFactory("RecordingTarget");
    target = await Target.deploy();
    await target.waitForDeployment();
    targetAddress = await target.getAddress();

    const Reverter = await ethers.getContractFactory("AlwaysRevertingTarget");
    reverter = await Reverter.deploy();
    await reverter.waitForDeployment();
    reverterAddress = await reverter.getAddress();

    const MockPolicyRegistry = await ethers.getContractFactory("MockPolicyRegistry");
    policyRegistry = await MockPolicyRegistry.deploy();
    await policyRegistry.waitForDeployment();
    policyRegistryAddress = await policyRegistry.getAddress();
    await policyRegistry.setBinding(defaultPolicyHashFor(agentA.address), agentA.address, true);
    await policyRegistry.setBinding(defaultPolicyHashFor(agentB.address), agentB.address, true);
    // Most tests in this file use empty calldata (data: "0x") by default
    // — a NativeTransfer-kind call. Pre-authorize the two most commonly
    // used targets so tests that aren't specifically about target/
    // selector authorization don't each need their own setup. Tests
    // that ARE about that (Gate 4A) authorize their own targets/
    // selectors explicitly and don't rely on this default.
    for (const agent of [agentA, agentB]) {
      await policyRegistry.authorizeNativeTransfer(defaultPolicyHashFor(agent.address), targetAddress);
      await policyRegistry.authorizeNativeTransfer(defaultPolicyHashFor(agent.address), reverterAddress);
    }

    const Guard = await ethers.getContractFactory("AgentExecutionGuard");
    guard = await Guard.deploy(registryAddress, policyRegistryAddress);
    await guard.waitForDeployment();
    guardAddress = await guard.getAddress();

    walletA = await deploySmartWallet(agentA.address, guardAddress, agentA.address);
    walletB = await deploySmartWallet(agentB.address, guardAddress, agentB.address);
    walletAlias = await deploySmartWallet(agentA.address, guardAddress, agentA.address);
    await registry.setWallet(agentA.address, await walletA.getAddress());
    await registry.setWallet(agentB.address, await walletB.getAddress());
  });

  describe("happy path", function () {
    it("executes a valid intent at nonce 0 and advances the nonce", async function () {
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n);
      const sig = await signIntent(agentA, intent);

      await expect(execute(intent, sig))
        .to.emit(guard, "IntentExecuted")
        .withArgs(agentA.address, (await walletA.getAddress()), targetAddress, 0n, defaultPolicyHashFor(agentA.address));

      expect(await guard.nextNonce(agentA.address)).to.equal(1n);
      expect(await target.callCount()).to.equal(1n);
    });

    it("forwards calldata and value exactly as authorized", async function () {
      const data = "0xdeadbeef";
      const value = ethers.parseEther("1");
      await policyRegistry.authorizeCall(defaultPolicyHashFor(agentA.address), targetAddress, "0xdeadbeef");
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n, { data, value });
      const sig = await signIntent(agentA, intent);

      await fundSmartWallet(walletA, value);
      await execute(intent, sig);

      const call = await target.calls(0);
      expect(call.data).to.equal(data);
      expect(call.value).to.equal(value);
    });

    it("allows sequential execution as the nonce advances", async function () {
      for (let i = 0n; i < 3n; i++) {
        const intent = await baseIntent(agentA.address, (await walletA.getAddress()), i);
        const sig = await signIntent(agentA, intent);
        await execute(intent, sig);
      }
      expect(await guard.nextNonce(agentA.address)).to.equal(3n);
      expect(await target.callCount()).to.equal(3n);
    });

    it("keeps agent nonces independent of each other", async function () {
      const intentA = await baseIntent(agentA.address, (await walletA.getAddress()), 0n);
      const sigA = await signIntent(agentA, intentA);
      await execute(intentA, sigA);

      // agent B's nonce is untouched and still starts at 0
      const intentB = await baseIntent(agentB.address, (await walletB.getAddress()), 0n);
      const sigB = await signIntent(agentB, intentB);
      await execute(intentB, sigB);

      expect(await guard.nextNonce(agentA.address)).to.equal(1n);
      expect(await guard.nextNonce(agentB.address)).to.equal(1n);
    });

    it("is relayer-agnostic: anyone can submit a validly signed intent", async function () {
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n);
      const sig = await signIntent(agentA, intent);
      // relayer (not walletA, not agentA) submits the tx
      await guard
        .connect(relayer)
        .execute(intent.agent, intent.wallet, intent.target, intent.value, intent.data, intent.nonce, intent.deadline, intent.policyHash, sig);
      expect(await guard.nextNonce(agentA.address)).to.equal(1n);
    });
  });

  describe("attack 1: same-nonce replay", function () {
    it("reverts on exact replay of an already-executed intent", async function () {
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n);
      const sig = await signIntent(agentA, intent);
      await execute(intent, sig);

      await expect(execute(intent, sig))
        .to.be.revertedWithCustomError(guard, "InvalidNonce")
        .withArgs(0n, 1n);
    });
  });

  describe("attack 2: stale nonce", function () {
    it("reverts when resubmitting nonce N after nonce N+1 has already executed", async function () {
      const intent0 = await baseIntent(agentA.address, (await walletA.getAddress()), 0n);
      const sig0 = await signIntent(agentA, intent0);
      await execute(intent0, sig0);

      const intent1 = await baseIntent(agentA.address, (await walletA.getAddress()), 1n);
      const sig1 = await signIntent(agentA, intent1);
      await execute(intent1, sig1);

      // attacker resubmits the original nonce-0 intent again
      await expect(execute(intent0, sig0))
        .to.be.revertedWithCustomError(guard, "InvalidNonce")
        .withArgs(0n, 2n);
    });
  });

  describe("attack 3 & 4: future nonce", function () {
    it("reverts on nonce N+1 when current is N", async function () {
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 1n);
      const sig = await signIntent(agentA, intent);
      await expect(execute(intent, sig)).to.be.revertedWithCustomError(guard, "InvalidNonce").withArgs(1n, 0n);
    });

    it("reverts on nonce N+100", async function () {
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 100n);
      const sig = await signIntent(agentA, intent);
      await expect(execute(intent, sig)).to.be.revertedWithCustomError(guard, "InvalidNonce").withArgs(100n, 0n);
    });

    it("reverts on nonce N+1_000_000", async function () {
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 1_000_000n);
      const sig = await signIntent(agentA, intent);
      await expect(execute(intent, sig)).to.be.revertedWithCustomError(guard, "InvalidNonce").withArgs(1_000_000n, 0n);
    });
  });

  describe("attack 5: cross-agent confusion", function () {
    it("rejects an intent signed by A when submitted claiming to be B", async function () {
      const intent = await baseIntent(agentB.address, (await walletB.getAddress()), 0n);
      // signed by A's key, not B's, even though the `agent` field says B
      const sig = await signIntent(agentA, intent);
      await expect(execute(intent, sig)).to.be.revertedWithCustomError(guard, "InvalidSignature");
      expect(await guard.nextNonce(agentA.address)).to.equal(0n);
    });

    it("rejects an intent validly signed by A when the agent field is swapped to B after signing", async function () {
      const intentForA = await baseIntent(agentA.address, (await walletA.getAddress()), 0n);
      const sig = await signIntent(agentA, intentForA);
      const tampered = { ...intentForA, agent: agentB.address };
      // this now fails at the remediation gate's policy-agent binding
      // check before even reaching signature verification: the
      // (unchanged) policyHash is bound to agentA, not agentB. Either
      // check independently prevents the attack; PolicyAgentMismatch
      // simply runs first in the check ordering.
      await expect(execute(tampered, sig)).to.be.revertedWithCustomError(guard, "PolicyAgentMismatch");
    });
  });

  describe("attack 6: cross-chain replay (domain separation)", function () {
    it("rejects a signature produced for a different chain id", async function () {
      const wrongDomain = {
        name: "AgentExecutionGuard",
        version: "1",
        chainId: 999999n,
        verifyingContract: guardAddress,
      };
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n);
      const sig = await agentA.signTypedData(wrongDomain, types, {
        agent: intent.agent,
        wallet: intent.wallet,
        target: intent.target,
        value: intent.value,
        calldataHash: ethers.keccak256(intent.data),
        nonce: intent.nonce,
        deadline: intent.deadline,
        policyHash: intent.policyHash,
      });
      await expect(execute(intent, sig)).to.be.revertedWithCustomError(guard, "InvalidSignature");
      expect(await guard.nextNonce(agentA.address)).to.equal(0n);
    });
  });

  describe("attack 7: cross-contract replay", function () {
    it("rejects a signature produced for a different guard deployment", async function () {
      const Guard = await ethers.getContractFactory("AgentExecutionGuard");
      const otherGuard = await Guard.deploy(registryAddress, policyRegistryAddress);
      await otherGuard.waitForDeployment();
      const otherGuardAddress = await otherGuard.getAddress();

      const net = await ethers.provider.getNetwork();
      const otherDomain = {
        name: "AgentExecutionGuard",
        version: "1",
        chainId: net.chainId,
        verifyingContract: otherGuardAddress, // signed for the OTHER deployment
      };
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n);
      const sig = await agentA.signTypedData(otherDomain, types, {
        agent: intent.agent,
        wallet: intent.wallet,
        target: intent.target,
        value: intent.value,
        calldataHash: ethers.keccak256(intent.data),
        nonce: intent.nonce,
        deadline: intent.deadline,
        policyHash: intent.policyHash,
      });

      await expect(execute(intent, sig)).to.be.revertedWithCustomError(guard, "InvalidSignature");
      expect(await guard.nextNonce(agentA.address)).to.equal(0n);
    });
  });

  describe("attack 8: modified field after signing", function () {
    it("rejects an attempt to rewrite a future-nonce intent's nonce down to the current counter", async function () {
      // agent signs an intent for nonce 5 (not yet valid); attacker
      // rewrites the nonce field to 0 to make the nonce-check pass
      // immediately. The nonce check alone would accept it — only the
      // signature (which commits to nonce=5) catches the tamper.
      const futureIntent = await baseIntent(agentA.address, (await walletA.getAddress()), 5n);
      const sig = await signIntent(agentA, futureIntent);
      const rewritten = { ...futureIntent, nonce: 0n };
      await expect(execute(rewritten, sig)).to.be.revertedWithCustomError(guard, "InvalidSignature");
    });

    it("rejects a signed intent with only the target field changed", async function () {
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n);
      const sig = await signIntent(agentA, intent);
      const tampered = { ...intent, target: reverterAddress };
      await expect(execute(tampered, sig)).to.be.revertedWithCustomError(guard, "InvalidSignature");
    });

    it("rejects a signed intent with only the value field changed", async function () {
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n);
      const sig = await signIntent(agentA, intent);
      const tampered = { ...intent, value: ethers.parseEther("1") };
      await expect(execute(tampered, sig)).to.be.revertedWithCustomError(
        guard,
        "InvalidSignature"
      );
    });

    it("rejects a signed intent with only the calldata changed", async function () {
      // use real 4-byte selectors (not the 1-byte "malformed" case, which
      // is unconditionally unauthorized regardless of signature validity
      // and would test the wrong thing here) so the only reason for
      // rejection is the signature, not calldata-shape classification.
      await policyRegistry.authorizeCall(defaultPolicyHashFor(agentA.address), targetAddress, "0x11111111");
      await policyRegistry.authorizeCall(defaultPolicyHashFor(agentA.address), targetAddress, "0x22222222");
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n, { data: "0x11111111" });
      const sig = await signIntent(agentA, intent);
      const tampered = { ...intent, data: "0x22222222" };
      await expect(execute(tampered, sig)).to.be.revertedWithCustomError(guard, "InvalidSignature");
    });

    it("rejects a signed intent with only the deadline changed", async function () {
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n);
      const sig = await signIntent(agentA, intent);
      const tampered = { ...intent, deadline: FAR_DEADLINE + 1n };
      await expect(execute(tampered, sig)).to.be.revertedWithCustomError(guard, "InvalidSignature");
    });

    it("rejects a signed intent with only the policyHash changed", async function () {
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n);
      const sig = await signIntent(agentA, intent);
      const tampered = { ...intent, policyHash: ethers.keccak256(ethers.toUtf8Bytes("different-policy")) };
      // the substituted policyHash was never registered with any agent
      // binding, so the remediation gate's policy-agent check rejects it
      // (boundAgent == address(0) != agentA) before signature
      // verification is even reached. The signature itself would have
      // failed too (digest commits to the original policyHash) — this
      // test only confirms which check surfaces first, not that the
      // attack succeeds by either path.
      await expect(execute(tampered, sig)).to.be.revertedWithCustomError(guard, "PolicyAgentMismatch");
    });

    it("rejects a signed intent with only the wallet field changed", async function () {
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n);
      const sig = await signIntent(agentA, intent);
      const tampered = { ...intent, wallet: (await walletAlias.getAddress()) };
      await expect(execute(tampered, sig)).to.be.revertedWithCustomError(guard, "InvalidSignature");
    });
  });

  describe("attack 9: failed external call", function () {
    it("reverts the whole transaction and does NOT consume the nonce", async function () {
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n, { target: reverterAddress });
      const sig = await signIntent(agentA, intent);

      await expect(execute(intent, sig)).to.be.reverted;
      // nonce must be untouched — the same intent can be retried later
      // (e.g. after the target contract's state changes)
      expect(await guard.nextNonce(agentA.address)).to.equal(0n);
    });

    it("the same intent succeeds once retried against a working target", async function () {
      const failingIntent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n, { target: reverterAddress });
      const failSig = await signIntent(agentA, failingIntent);
      await expect(execute(failingIntent, failSig)).to.be.reverted;

      const workingIntent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n, { target: targetAddress });
      const workSig = await signIntent(agentA, workingIntent);
      await execute(workingIntent, workSig);
      expect(await guard.nextNonce(agentA.address)).to.equal(1n);
    });
  });

  describe("attack 10: reentrancy", function () {
    async function deployAttacker() {
      const Attacker = await ethers.getContractFactory("ReentrantAttacker");
      const attacker = await Attacker.deploy();
      await attacker.waitForDeployment();
      await attacker.setGuard(guardAddress);
      const attackerAddress = await attacker.getAddress();
      // outer intents in this block target the attacker contract with
      // empty calldata (NativeTransfer) — authorize it under both
      // agents' default policies so the reentrancy guard is the only
      // thing being tested, not an incidental authorization failure.
      await policyRegistry.authorizeNativeTransfer(defaultPolicyHashFor(agentA.address), attackerAddress);
      await policyRegistry.authorizeNativeTransfer(defaultPolicyHashFor(agentB.address), attackerAddress);
      return attacker;
    }

    it("blocks same-agent, same-nonce reentrancy", async function () {
      const attacker = await deployAttacker();
      const attackerAddress = await attacker.getAddress();

      // outer intent: agent A, nonce 0, target = attacker
      const outerIntent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n, { target: attackerAddress });
      const outerSig = await signIntent(agentA, outerIntent);

      // reentry attempt: agent A tries nonce 0 AGAIN, from inside the call
      const reentryIntent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n, { target: attackerAddress });
      const reentrySig = await signIntent(agentA, reentryIntent);
      const reentryCalldata = guard.interface.encodeFunctionData("execute", [
        reentryIntent.agent, reentryIntent.wallet, reentryIntent.target, reentryIntent.value,
        reentryIntent.data, reentryIntent.nonce, reentryIntent.deadline, reentryIntent.policyHash, reentrySig,
      ]);
      await attacker.setReentryCalldata(reentryCalldata);

      await execute(outerIntent, outerSig);

      expect(await attacker.reentered()).to.equal(true);
      expect(await attacker.reentrySucceeded()).to.equal(false);
      // only the outer call's nonce was consumed
      expect(await guard.nextNonce(agentA.address)).to.equal(1n);
    });

    it("blocks reentrancy attempting the NEXT nonce for the same agent", async function () {
      const attacker = await deployAttacker();
      const attackerAddress = await attacker.getAddress();

      const outerIntent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n, { target: attackerAddress });
      const outerSig = await signIntent(agentA, outerIntent);

      // reentry attempt: agent A, nonce 1 — looks like it SHOULD be valid
      // once the outer call's effects (nonce -> 1) have already landed,
      // but nonReentrant must block it regardless.
      const reentryIntent = await baseIntent(agentA.address, (await walletA.getAddress()), 1n, { target: targetAddress });
      const reentrySig = await signIntent(agentA, reentryIntent);
      const reentryCalldata = guard.interface.encodeFunctionData("execute", [
        reentryIntent.agent, reentryIntent.wallet, reentryIntent.target, reentryIntent.value,
        reentryIntent.data, reentryIntent.nonce, reentryIntent.deadline, reentryIntent.policyHash, reentrySig,
      ]);
      await attacker.setReentryCalldata(reentryCalldata);

      await execute(outerIntent, outerSig);

      expect(await attacker.reentered()).to.equal(true);
      expect(await attacker.reentrySucceeded()).to.equal(false);
      expect(await guard.nextNonce(agentA.address)).to.equal(1n);
    });

    it("blocks reentrancy using a completely different, otherwise-valid agent", async function () {
      const attacker = await deployAttacker();
      const attackerAddress = await attacker.getAddress();

      const outerIntent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n, { target: attackerAddress });
      const outerSig = await signIntent(agentA, outerIntent);

      // reentry attempt: agent B, nonce 0, everything about it is
      // independently valid — the ONLY reason it must fail is that we
      // are inside another execute() call.
      const reentryIntent = await baseIntent(agentB.address, (await walletB.getAddress()), 0n, { target: targetAddress });
      const reentrySig = await signIntent(agentB, reentryIntent);
      const reentryCalldata = guard.interface.encodeFunctionData("execute", [
        reentryIntent.agent, reentryIntent.wallet, reentryIntent.target, reentryIntent.value,
        reentryIntent.data, reentryIntent.nonce, reentryIntent.deadline, reentryIntent.policyHash, reentrySig,
      ]);
      await attacker.setReentryCalldata(reentryCalldata);

      await execute(outerIntent, outerSig);

      expect(await attacker.reentered()).to.equal(true);
      expect(await attacker.reentrySucceeded()).to.equal(false);
      // agent B's nonce is untouched — it can still execute nonce 0 as a
      // normal top-level transaction afterwards.
      expect(await guard.nextNonce(agentB.address)).to.equal(0n);
      const freshSig = await signIntent(agentB, reentryIntent);
      await execute(reentryIntent, freshSig);
      expect(await guard.nextNonce(agentB.address)).to.equal(1n);
    });
  });

  describe("attack 11: uint256 nonce boundary", function () {
    it("reverts (fails closed) rather than wrapping when nonce is type(uint256).max", async function () {
      const maxUint = ethers.MaxUint256;
      // force the agent's nonce counter to MAX via storage manipulation —
      // reaching it through 2^256 real executions is not feasible to set
      // up honestly in a test, but the boundary behavior of the exact
      // increment operation is what we're verifying.
      const nextNonceSlot = 1; // mapping(address => uint256) nextNonce is the 2nd declared storage var (slot 0 unused by immutable REGISTRY, EIP712 uses its own layout via ERC-7201-free simple slots before it — verified empirically below instead of assumed)
      // Rather than guessing the slot, drive the agent's nonce to MAX by
      // reading/writing through a purpose-built path: deploy a fresh
      // guard+registry pair and directly set storage using hardhat_setStorageAt
      // at the correct slot, found via brute force scan for correctness.
      let foundSlot = -1;
      for (let slot = 0; slot < 10; slot++) {
        const mappingSlot = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [agentA.address, slot])
        );
        await ethers.provider.send("hardhat_setStorageAt", [
          guardAddress,
          mappingSlot,
          ethers.zeroPadValue(ethers.toBeHex(12345n), 32),
        ]);
        const val = await guard.nextNonce(agentA.address);
        if (val === 12345n) {
          foundSlot = slot;
          // reset before real assertions
          await ethers.provider.send("hardhat_setStorageAt", [
            guardAddress,
            mappingSlot,
            ethers.zeroPadValue(ethers.toBeHex(0n), 32),
          ]);
          break;
        }
      }
      expect(foundSlot).to.be.greaterThanOrEqual(0);

      const maxSlot = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [agentA.address, foundSlot])
      );
      await ethers.provider.send("hardhat_setStorageAt", [guardAddress, maxSlot, ethers.zeroPadValue(ethers.toBeHex(maxUint), 32)]);
      expect(await guard.nextNonce(agentA.address)).to.equal(maxUint);

      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), maxUint);
      const sig = await signIntent(agentA, intent);

      // nonce + 1 at type(uint256).max must revert (checked arithmetic),
      // NOT wrap around to 0 and silently re-permit nonce 0.
      await expect(execute(intent, sig)).to.be.reverted;
    });
  });

  describe("attack 12: disabled agent", function () {
    it("rejects execution once the agent is deactivated, even with a previously valid signature", async function () {
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n);
      const sig = await signIntent(agentA, intent);

      await registry.setActive(agentA.address, false);

      await expect(execute(intent, sig)).to.be.revertedWithCustomError(guard, "AgentNotActive").withArgs(agentA.address);
    });

    it("a signature produced while active but submitted after deactivation is still rejected", async function () {
      // sign first (agent believes itself active)
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n);
      const sig = await signIntent(agentA, intent);
      // deactivated before the tx lands on-chain
      await registry.setActive(agentA.address, false);
      await expect(execute(intent, sig)).to.be.revertedWithCustomError(guard, "AgentNotActive");
      // and the nonce was never consumed, so reactivating restores full authority
      await registry.setActive(agentA.address, true);
      await execute(intent, sig);
      expect(await guard.nextNonce(agentA.address)).to.equal(1n);
    });
  });

  describe("deadline handling", function () {
    it("rejects an intent past its deadline", async function () {
      const latest = await ethers.provider.getBlock("latest");
      const pastDeadline = BigInt(latest!.timestamp) - 1n;
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n, { deadline: pastDeadline });
      const sig = await signIntent(agentA, intent);
      await expect(execute(intent, sig)).to.be.revertedWithCustomError(guard, "IntentExpired");
    });

    it("accepts an intent exactly at its deadline", async function () {
      const latest = await ethers.provider.getBlock("latest");
      const nextTimestamp = BigInt(latest!.timestamp) + 10n;
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(nextTimestamp)]);
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n, { deadline: nextTimestamp });
      const sig = await signIntent(agentA, intent);
      await execute(intent, sig);
      expect(await guard.nextNonce(agentA.address)).to.equal(1n);
    });
  });

  describe("zero address handling", function () {
    it("rejects a zero agent address", async function () {
      const intent = await baseIntent(ethers.ZeroAddress, (await walletA.getAddress()), 0n);
      const sig = await signIntent(agentA, intent);
      await expect(execute(intent, sig)).to.be.revertedWithCustomError(guard, "ZeroAddress");
    });

    it("rejects a zero wallet address", async function () {
      const intent = await baseIntent(agentA.address, ethers.ZeroAddress, 0n);
      const sig = await signIntent(agentA, intent);
      await expect(execute(intent, sig)).to.be.revertedWithCustomError(guard, "ZeroAddress");
    });

    it("rejects a zero target address", async function () {
      const intent = await baseIntent(agentA.address, (await walletA.getAddress()), 0n, { target: ethers.ZeroAddress });
      const sig = await signIntent(agentA, intent);
      await expect(execute(intent, sig)).to.be.revertedWithCustomError(guard, "ZeroAddress");
    });

    it("constructor rejects a zero registry address", async function () {
      const Guard = await ethers.getContractFactory("AgentExecutionGuard");
      await expect(Guard.deploy(ethers.ZeroAddress, policyRegistryAddress)).to.be.revertedWithCustomError(Guard, "ZeroAddress");
    });

    it("constructor rejects a zero policy registry address", async function () {
      const Guard = await ethers.getContractFactory("AgentExecutionGuard");
      await expect(Guard.deploy(registryAddress, ethers.ZeroAddress)).to.be.revertedWithCustomError(Guard, "ZeroAddress");
    });
  });
});
