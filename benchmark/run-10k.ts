import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const TOTAL = 10_000;
const DEFAULT_CLASS_COUNT = 1_000;
const CLASS_COUNTS: Record<CaseKind, number> = {
  valid: 1_000,
  replay: 1_000,
  expired: 1_000,
  wrong_target: 1_000,
  wrong_selector: 1_000,
  malformed_calldata: 1_000,
  wrong_wallet: 1_000,
  inactive_policy: 1_000,
  policy_agent_mismatch: 500,
  invalid_signature: 500,
  max_value: 1_000,
};
const SEED = 0xA3615EED;

type CaseKind =
  | "valid"
  | "replay"
  | "expired"
  | "wrong_target"
  | "wrong_selector"
  | "malformed_calldata"
  | "wrong_wallet"
  | "inactive_policy"
  | "policy_agent_mismatch"
  | "invalid_signature"
  | "max_value";

type Case = {
  kind: CaseKind;
  expected: "ALLOW" | "BLOCK";
  target: string;
  wallet: string;
  data: string;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
  policyHash: string;
  signature: string;
};

const TYPES = {
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

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const started = performance.now();
  const [funder] = await ethers.getSigners();
  const agent = ethers.Wallet.createRandom().connect(ethers.provider);
  const otherAgent = ethers.Wallet.createRandom().connect(ethers.provider);

  const Registry = await ethers.getContractFactory("MockAgentRegistry");
  const registry = await Registry.deploy();
  await registry.waitForDeployment();
  await registry.setActive(agent.address, true);
  await registry.setOwner(agent.address, agent.address);

  const Policy = await ethers.getContractFactory("MockPolicyRegistry");
  const policy = await Policy.deploy();
  await policy.waitForDeployment();

  const Guard = await ethers.getContractFactory("AgentExecutionGuard");
  const guard = await Guard.deploy(await registry.getAddress(), await policy.getAddress());
  await guard.waitForDeployment();

  const Wallet = await ethers.getContractFactory("AgentSmartWallet");
  const wallet = await Wallet.deploy(agent.address, await guard.getAddress(), agent.address);
  await wallet.waitForDeployment();
  const walletAddress = await wallet.getAddress();
  await registry.setWallet(agent.address, walletAddress);

  const alternateWallet = await Wallet.deploy(agent.address, await guard.getAddress(), agent.address);
  await alternateWallet.waitForDeployment();
  const alternateWalletAddress = await alternateWallet.getAddress();

  const Target = await ethers.getContractFactory("SelectorTarget");
  const target = await Target.deploy();
  await target.waitForDeployment();
  const targetAddress = await target.getAddress();

  const otherTarget = await Target.deploy();
  await otherTarget.waitForDeployment();
  const otherTargetAddress = await otherTarget.getAddress();

  const policyHash = ethers.keccak256(ethers.toUtf8Bytes("benchmark-policy"));
  const inactivePolicyHash = ethers.keccak256(ethers.toUtf8Bytes("benchmark-inactive"));
  const mismatchPolicyHash = ethers.keccak256(ethers.toUtf8Bytes("benchmark-mismatch"));
  const maxValuePolicyHash = ethers.keccak256(ethers.toUtf8Bytes("benchmark-max-value"));

  await policy.setBinding(policyHash, agent.address, true);
  await policy.authorizeCall(policyHash, targetAddress, target.interface.getFunction("foo")!.selector);

  await policy.setBinding(inactivePolicyHash, agent.address, false);
  await policy.authorizeCall(inactivePolicyHash, targetAddress, target.interface.getFunction("foo")!.selector);

  await policy.setBinding(mismatchPolicyHash, otherAgent.address, true);
  await policy.authorizeCall(mismatchPolicyHash, targetAddress, target.interface.getFunction("foo")!.selector);

  await policy.setFullBinding(maxValuePolicyHash, agent.address, agent.address, true, true, 0);
  await policy.authorizeCall(maxValuePolicyHash, targetAddress, target.interface.getFunction("foo")!.selector);

  const chain = await ethers.provider.getNetwork();
  const domain = {
    name: "AgentExecutionGuard",
    version: "1",
    chainId: chain.chainId,
    verifyingContract: await guard.getAddress(),
  };

  const farDeadline = 4_102_444_800n;
  const latest = await ethers.provider.getBlock("latest");
  const expiredDeadline = BigInt(latest!.timestamp);

  const validData = target.interface.encodeFunctionData("foo", [1n]);
  const bootstrapDigest = {
    agent: agent.address,
    wallet: walletAddress,
    target: targetAddress,
    value: 0n,
    calldataHash: ethers.keccak256(validData),
    nonce: 0n,
    deadline: farDeadline,
    policyHash,
  };
  const bootstrapSig = await agent.signTypedData(domain, TYPES, bootstrapDigest);
  await guard.execute(
    agent.address, walletAddress, targetAddress, 0n, validData, 0n,
    farDeadline, policyHash, bootstrapSig
  );

  const rand = mulberry32(SEED);
  const classes: CaseKind[] = [
    "valid", "replay", "expired", "wrong_target", "wrong_selector",
    "malformed_calldata", "wrong_wallet", "inactive_policy",
    "policy_agent_mismatch", "invalid_signature", "max_value",
  ];
  const cases: Case[] = [];
  const baseNonce = 1n;

  for (const kind of classes) {
    const classCount = CLASS_COUNTS[kind] ?? DEFAULT_CLASS_COUNT;
    for (let i = 0; i < classCount; i++) {
      const n = Math.floor(rand() * 0xffffffff);
      const data = kind === "wrong_selector"
        ? target.interface.encodeFunctionData("bar", [agent.address])
        : kind === "malformed_calldata"
          ? ethers.hexlify(Uint8Array.from([0x12, n & 0xff]))
          : target.interface.encodeFunctionData("foo", [BigInt(n)]);

      const targetForCase = kind === "wrong_target" ? otherTargetAddress : targetAddress;
      const walletForCase = kind === "wrong_wallet" ? alternateWalletAddress : walletAddress;
      const value = kind === "max_value" ? 1n : 0n;
      const nonce = kind === "replay" ? 0n : baseNonce;
      const deadline = kind === "expired" ? expiredDeadline : farDeadline;
      const selectedPolicy =
        kind === "inactive_policy" ? inactivePolicyHash :
        kind === "policy_agent_mismatch" ? mismatchPolicyHash :
        kind === "max_value" ? maxValuePolicyHash :
        policyHash;

      const intent = {
        agent: agent.address,
        wallet: walletForCase,
        target: targetForCase,
        value,
        calldataHash: ethers.keccak256(data),
        nonce,
        deadline,
        policyHash: selectedPolicy,
      };

      let signature = await agent.signTypedData(domain, TYPES, intent);
      if (kind === "invalid_signature") {
        const attacker = ethers.Wallet.createRandom();
        signature = await attacker.signTypedData(domain, TYPES, intent);
      }
      if (kind === "wrong_wallet") {
        // Keep the signature valid for the substituted wallet. The Guard must
        // reject because the wallet is not canonical, not because of crypto.
      }
      if (kind === "wrong_selector") {
        // The policy authorizes foo only; bar must be rejected.
      }
      if (kind === "wrong_target") {
        // The policy authorizes targetAddress only.
      }
      if (kind === "inactive_policy") {
        // Signature is valid; policy state is the reason for rejection.
      }
      if (kind === "policy_agent_mismatch") {
        // Signature is valid; policy is bound to a different agent.
      }
      if (kind === "max_value") {
        // Signature is valid; maxTxValue is the reason for rejection.
      }
      if (kind === "malformed_calldata") {
        // Signature is valid; malformed calldata must not become authorized.
      }
      if (kind === "expired") {
        // Signature is valid but deadline has passed.
      }
      if (kind === "replay") {
        // Signature is valid for the already-consumed nonce 0.
      }

      cases.push({
        kind,
        expected: kind === "valid" ? "ALLOW" : "BLOCK",
        target: targetForCase,
        wallet: walletForCase,
        data,
        value,
        nonce,
        deadline,
        policyHash: selectedPolicy,
        signature,
      });
    }
  }

  // Deterministically shuffle the corpus so category ordering cannot influence
  // observed latency. The state-changing bootstrap remains the only mined call.
  for (let i = cases.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cases[i], cases[j]] = [cases[j], cases[i]];
  }

  const latencies: number[] = [];
  const byClass: Record<string, {
    total: number; expectedAllow: number; expectedBlock: number;
    actualAllow: number; actualBlock: number; falseAllow: number;
    falseBlock: number; errors: Record<string, number>; totalMs: number;
  }> = {};

  let actualAllow = 0;
  let actualBlock = 0;
  let falseAllow = 0;
  let falseBlock = 0;

  for (const c of cases) {
    const bucket = byClass[c.kind] ??= {
      total: 0, expectedAllow: 0, expectedBlock: 0, actualAllow: 0,
      actualBlock: 0, falseAllow: 0, falseBlock: 0, errors: {}, totalMs: 0,
    };
    bucket.total++;
    if (c.expected === "ALLOW") bucket.expectedAllow++;
    else bucket.expectedBlock++;

    const t0 = performance.now();
    let allowed = false;
    let errorName = "NONE";
    try {
      await guard.execute.staticCall(
        agent.address, c.wallet, c.target, c.value, c.data, c.nonce,
        c.deadline, c.policyHash, c.signature
      );
      allowed = true;
    } catch (error: any) {
      errorName = error?.revert?.name ?? error?.shortMessage ?? error?.reason ?? "REVERT";
      errorName = String(errorName).slice(0, 120);
    }
    const elapsed = performance.now() - t0;
    latencies.push(elapsed);
    bucket.totalMs += elapsed;

    if (allowed) actualAllow++;
    else actualBlock++;
    if (allowed && c.expected === "BLOCK") falseAllow++;
    if (!allowed && c.expected === "ALLOW") falseBlock++;

    if (allowed) bucket.actualAllow++;
    else {
      bucket.actualBlock++;
      bucket.errors[errorName] = (bucket.errors[errorName] ?? 0) + 1;
    }
    if (allowed && c.expected === "BLOCK") bucket.falseAllow++;
    if (!allowed && c.expected === "ALLOW") bucket.falseBlock++;
  }

  latencies.sort((a, b) => a - b);
  const percentile = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
  const totalMs = performance.now() - started;

  const result = {
    schemaVersion: 1,
    benchmark: "agent-guardian-cwf-10k",
    seed: SEED,
    generatedAt: new Date().toISOString(),
    network: "hardhat",
    chainId: Number(chain.chainId),
    total: TOTAL,
    statefulBootstrapTransactions: 1,
    staticAuthorizationChecks: TOTAL,
    falseAuthorizationRate: falseAllow / TOTAL,
    falseBlockRate: falseBlock / TOTAL,
    expectedAllows: cases.filter(c => c.expected === "ALLOW").length,
    expectedBlocks: cases.filter(c => c.expected === "BLOCK").length,
    classes: Object.fromEntries(classes.map(kind => [kind, CLASS_COUNTS[kind]])),
    actualAllows: actualAllow,
    actualBlocks: actualBlock,
    latencyMs: {
      min: latencies[0],
      mean: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p50: percentile(0.50),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: latencies[latencies.length - 1],
      total: totalMs,
    },
    byClass,
    methodology: {
      description: "10,000 deterministic signed TransactionIntent authorization checks against the real AgentExecutionGuard on a local Hardhat EVM.",
      statefulReplayBootstrap: "One real execution consumes nonce 0; replay cases submit signed nonce 0 after consumption.",
      allowCriterion: "Guard staticCall completes without revert.",
      blockCriterion: "Guard staticCall reverts.",
      note: "This benchmark measures authorization evaluation. It is not 10,000 mined blockchain transactions and does not claim Foundry/Echidna fuzzing.",
    },
  };

  const outDir = path.resolve("benchmark");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  if (falseAllow !== 0 || falseBlock !== 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
