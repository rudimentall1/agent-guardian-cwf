import { expect } from "chai";
import { ethers } from "hardhat";
import { signTypedDataDigest } from "./typedDataTestHelpers";
import { deploySmartWallet, fundSmartWallet } from "./smartWalletTestHelpers";

/**
 * Property-based tests for AgentExecutionGuard's core nonce invariants.
 *
 * This is NOT Foundry fuzzing. Foundry could not be installed in this
 * sandbox (network egress to foundry.paradigm.xyz is blocked — see
 * docs/gate-2-execution-guard.md). This file substitutes a seeded
 * pseudo-random JS loop over a real Hardhat-network contract instance,
 * checking the same invariants Foundry fuzz/invariant tests would:
 *
 *   INVARIANT 1: for a given agent, exactly one nonce value is ever
 *   accepted at any point in time — nextNonce[agent] — regardless of
 *   what value is attempted.
 *
 *   INVARIANT 2: a successful execute() call consumes exactly one nonce
 *   (nextNonce increases by exactly 1, never more, never less, never on
 *   a failed call).
 *
 *   INVARIANT 3: a failed execute() call (expired deadline, wrong nonce,
 *   bad signature, inactive agent, reverting target) never changes
 *   nextNonce at all.
 *
 * Runs are deterministic (seeded) so a failure is reproducible by
 * re-running this file — this matters more here than in real Foundry
 * fuzzing, since there is no shrinking support in this substitute.
 */
describe("AgentExecutionGuard: nonce invariants (seeded property tests)", function () {
  // Minimal deterministic PRNG (mulberry32) so failures are reproducible
  // without depending on Math.random() or any external fuzzing library.
  function mulberry32(seed: number) {
    let a = seed;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SEED = 0xC0FFEE;
  const ITERATIONS = 60;

  let guard: any;
  let guardAddress: string;
  let registry: any;
  let policyRegistry: any;
  let target: any;
  let targetAddress: string;
  let reverter: any;
  let reverterAddress: string;
  let agent: ReturnType<typeof ethers.Wallet.createRandom>;
  let wallet: any;

  const ZERO_HASH = ethers.ZeroHash;

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
    return { name: "AgentExecutionGuard", version: "1", chainId: net.chainId, verifyingContract: guardAddress };
  }

  beforeEach(async function () {
    const [walletOwner] = await ethers.getSigners();
    agent = ethers.Wallet.createRandom().connect(ethers.provider);

    const MockRegistry = await ethers.getContractFactory("MockAgentRegistry");
    registry = await MockRegistry.deploy();
    await registry.waitForDeployment();
    await registry.setActive(agent.address, true);

    const Target = await ethers.getContractFactory("RecordingTarget");
    target = await Target.deploy();
    await target.waitForDeployment();
    targetAddress = await target.getAddress();

    const Reverter = await ethers.getContractFactory("AlwaysRevertingTarget");
    reverter = await Reverter.deploy();
    await reverter.waitForDeployment();
    reverterAddress = await reverter.getAddress();

    const Guard = await ethers.getContractFactory("AgentExecutionGuard");
    const MockPolicyRegistry = await ethers.getContractFactory("MockPolicyRegistry");
    policyRegistry = await MockPolicyRegistry.deploy();
    await policyRegistry.waitForDeployment();
    await policyRegistry.setBinding(ZERO_HASH, agent.address, true);
    await policyRegistry.authorizeNativeTransfer(ZERO_HASH, targetAddress);
    await policyRegistry.authorizeNativeTransfer(ZERO_HASH, reverterAddress);
    guard = await Guard.deploy(await registry.getAddress(), await policyRegistry.getAddress());
    await guard.waitForDeployment();
    guardAddress = await guard.getAddress();
    wallet = await deploySmartWallet(agent.address, guardAddress, agent.address);
    await registry.setWallet(agent.address, await wallet.getAddress());
    await fundSmartWallet(wallet, ethers.parseEther("100"));
  });

  it(`holds across ${ITERATIONS} randomized nonce attempts (seed 0x${SEED.toString(16)})`, async function () {
    const rand = mulberry32(SEED);
    let expectedNonce = 0n;
    let successCount = 0;
    let rejectCount = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const roll = rand();
      const farDeadline = 4102444800n;

      // Choose what kind of attempt to make this round:
      //  0-0.35 : correct current nonce, working target -> should SUCCEED
      //  0.35-0.55: correct current nonce, but reverting target -> should FAIL, nonce unchanged
      //  0.55-0.75: stale nonce (below current) -> should FAIL
      //  0.75-0.95: future nonce (above current, random offset) -> should FAIL
      //  0.95-1.0 : correct nonce but expired deadline -> should FAIL
      let attemptedNonce: bigint;
      let useTarget = targetAddress;
      let deadline = farDeadline;
      let expectSuccess = false;

      if (roll < 0.35) {
        attemptedNonce = expectedNonce;
        expectSuccess = true;
      } else if (roll < 0.55) {
        attemptedNonce = expectedNonce;
        useTarget = reverterAddress;
      } else if (roll < 0.75) {
        // stale: any value strictly less than expectedNonce, or skip round if expectedNonce is 0
        if (expectedNonce === 0n) {
          attemptedNonce = expectedNonce; // falls back to a valid attempt
          expectSuccess = true;
        } else {
          const staleOffset = BigInt(1 + Math.floor(rand() * Number(expectedNonce > 1000n ? 1000n : expectedNonce)));
          attemptedNonce = expectedNonce - staleOffset;
        }
      } else if (roll < 0.95) {
        const futureOffset = BigInt(1 + Math.floor(rand() * 1_000_000));
        attemptedNonce = expectedNonce + futureOffset;
      } else {
        attemptedNonce = expectedNonce;
        const latest = await ethers.provider.getBlock("latest");
        deadline = BigInt(latest!.timestamp); // already in the past relative to the tx that will land
      }

      const d = await domain();
      const calldataHash = ethers.keccak256("0x");
      const sig = await signTypedDataDigest(agent, d, types, {
        agent: agent.address,
        wallet: await wallet.getAddress(),
        target: useTarget,
        value: 0n,
        calldataHash,
        nonce: attemptedNonce,
        deadline,
        policyHash: ZERO_HASH,
      });

      const before = await guard.nextNonce(agent.address);

      let reverted = false;
      try {
        await guard.execute(agent.address, await wallet.getAddress(), useTarget, 0n, "0x", attemptedNonce, deadline, ZERO_HASH, sig);
      } catch (e) {
        reverted = true;
      }

      const after = await guard.nextNonce(agent.address);

      if (expectSuccess) {
        expect(reverted, `iteration ${i}: expected success (nonce ${attemptedNonce}, expected ${expectedNonce})`).to.equal(false);
        expect(after).to.equal(before + 1n);
        expectedNonce += 1n;
        successCount++;
      } else {
        expect(reverted, `iteration ${i}: expected revert (nonce ${attemptedNonce}, expected ${expectedNonce}, target=${useTarget === reverterAddress ? "reverter" : "ok"}, deadline=${deadline})`).to.equal(true);
        // INVARIANT 3: no state change whatsoever on a failed attempt
        expect(after).to.equal(before);
        expect(after).to.equal(expectedNonce);
        rejectCount++;
      }
    }

    // sanity: the randomized run actually exercised both outcomes,
    // otherwise this test would be vacuous
    expect(successCount).to.be.greaterThan(0);
    expect(rejectCount).to.be.greaterThan(0);
    expect(await guard.nextNonce(agent.address)).to.equal(expectedNonce);
  });

  it("random calldata/value combinations are forwarded verbatim and each consumes exactly one nonce", async function () {
    const rand = mulberry32(SEED ^ 0xdeadbeef);
    let expectedNonce = 0n;

    for (let i = 0; i < 15; i++) {
      let byteLen = Math.floor(rand() * 64);
      // avoid the 1-3 byte "Malformed" calldata-shape band for this
      // particular test — it exists to test forwarding fidelity of
      // legitimately authorized calls, not the Malformed-is-never-
      // authorized rule (which has its own dedicated coverage in
      // AgentExecutionGuard.gate4a.test.ts). Round up into FunctionCall
      // range instead of skipping the iteration, to keep exactly 15
      // real executions.
      if (byteLen > 0 && byteLen < 4) byteLen = 4;
      const bytes = new Uint8Array(byteLen);
      for (let j = 0; j < byteLen; j++) bytes[j] = Math.floor(rand() * 256);
      const data = ethers.hexlify(bytes);
      const value = ethers.parseEther((rand() * 2).toFixed(6));

      if (data !== "0x") {
        const selector = ethers.dataSlice(data, 0, 4);
        await policyRegistry.authorizeCall(ZERO_HASH, targetAddress, selector);
      }

      const d = await domain();
      const sig = await signTypedDataDigest(agent, d, types, {
        agent: agent.address,
        wallet: await wallet.getAddress(),
        target: targetAddress,
        value,
        calldataHash: ethers.keccak256(data),
        nonce: expectedNonce,
        deadline: 4102444800n,
        policyHash: ZERO_HASH,
      });

      await guard.executeFromWallet(agent.address, await wallet.getAddress(), targetAddress, value, data, expectedNonce, 4102444800n, ZERO_HASH, sig);

      const call = await target.calls(i);
      expect(call.data).to.equal(data === "0x" ? "0x" : data);
      expect(call.value).to.equal(value);

      expectedNonce += 1n;
      expect(await guard.nextNonce(agent.address)).to.equal(expectedNonce);
    }
  });
});
