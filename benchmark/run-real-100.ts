import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const TOTAL = 100;
const ALLOWED = 50;
const BLOCKED = 50;
const EXPLORER = "https://sepolia.arbiscan.io/tx/";
const INTENT_TYPES = {
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

async function main() {
  const started = performance.now();
  const [owner] = await ethers.getSigners();
  const agent = ethers.Wallet.createRandom().connect(ethers.provider);
  console.log("Funder:", owner.address);
  console.log("Agent:", agent.address);
  const chain = await ethers.provider.getNetwork();
  if (Number(chain.chainId) !== 421614) throw new Error("Not Arbitrum Sepolia");

  const Registry = await ethers.getContractFactory("AgentRegistry");
  const registry = await Registry.deploy();
  await registry.waitForDeployment();
  const Policy = await ethers.getContractFactory("PolicyRegistry");
  const policy = await Policy.deploy();
  await policy.waitForDeployment();
  const Guard = await ethers.getContractFactory("AgentExecutionGuard");
  const guard = await Guard.deploy(await registry.getAddress(), await policy.getAddress());
  await guard.waitForDeployment();
  const Wallet = await ethers.getContractFactory("AgentSmartWallet");
  const wallet = await Wallet.deploy(owner.address, await guard.getAddress(), agent.address);
  await wallet.waitForDeployment();

  const Target = await ethers.getContractFactory("RealBenchmarkTarget");
  const target = await Target.deploy();
  await target.waitForDeployment();

  const network = await ethers.provider.getNetwork();
  const registrationDomain = {
    name: "AgentRegistry", version: "1", chainId: network.chainId,
    verifyingContract: await registry.getAddress(),
  };
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("cwf-real-100"));
  const registrationSig = await agent.signTypedData(registrationDomain, {
    AgentRegistration: [
      { name: "agent", type: "address" },
      { name: "owner", type: "address" },
      { name: "metadataHash", type: "bytes32" },
    ],
  }, { agent: agent.address, owner: owner.address, metadataHash });
  await (await registry.register(agent.address, owner.address, metadataHash, registrationSig)).wait();
  await (await registry.bindWallet(agent.address, await wallet.getAddress())).wait();

  const selector = target.interface.getFunction("ping")!.selector;
  const salt = ethers.keccak256(ethers.toUtf8Bytes("cwf-real-100-policy-" + Date.now()));
  const now = Math.floor(Date.now() / 1000);
  await (await policy.createPolicy(
    salt, agent.address, 0, 0, 0, now - 60, now + 86400,
    [{ target: await target.getAddress(), selector }], []
  )).wait();
  const policyId = await policy.computePolicyId(owner.address, salt);
  const policyHash = await policy.policyHashOf(policyId);
  const domain = {
    name: "AgentExecutionGuard", version: "1", chainId: network.chainId,
    verifyingContract: await guard.getAddress(),
  };
  const records: any[] = [];
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  let executionNonce = await guard.nextNonce(agent.address);

  for (let i = 0; i < TOTAL; i++) {
    const shouldAllow = i % 2 === 0;
    const value = 0n;
    const data = shouldAllow
      ? target.interface.encodeFunctionData("ping", [BigInt(i)])
      : target.interface.encodeFunctionData("blocked", [BigInt(i)]);
    const intent = {
      agent: agent.address, wallet: await wallet.getAddress(),
      target: await target.getAddress(), value,
      calldataHash: ethers.keccak256(data), nonce: executionNonce,
      deadline, policyHash,
    };
    const signature = await agent.signTypedData(domain, INTENT_TYPES, intent);
    const t0 = performance.now();
    let txHash = "";
    let blockNumber: number | null = null;
    let gasUsed = "0";
    let gasPrice = "0";
    let status: number | null = null;
    let result = "UNKNOWN";
    let error = "";
    try {
      const tx = await guard.execute(
        intent.agent, intent.wallet, intent.target, value, data,
        intent.nonce, intent.deadline, intent.policyHash, signature,
        { gasLimit: 1_000_000n }
      );
      txHash = tx.hash;
      const receipt = await tx.wait();
      blockNumber = receipt?.blockNumber ?? null;
      gasUsed = receipt?.gasUsed?.toString() ?? "0";
      gasPrice = receipt?.gasPrice?.toString() ?? tx.gasPrice?.toString() ?? "0";
      status = receipt?.status ?? null;
      result = status === 1 ? "SUCCESS" : "REVERTED";
    } catch (e: any) {
      txHash = e?.transaction?.hash ?? e?.receipt?.hash ?? "";
      if (e?.receipt) {
        blockNumber = e.receipt.blockNumber ?? null;
        gasUsed = e.receipt.gasUsed?.toString?.() ?? "0";
        gasPrice = e.receipt.gasPrice?.toString?.() ?? "0";
        status = e.receipt.status ?? 0;
      }
      result = "REVERTED";
      error = String(e?.shortMessage ?? e?.reason ?? e?.message ?? e).slice(0, 240);
    }
    const latencyMs = performance.now() - t0;
    if (shouldAllow && result === "SUCCESS") executionNonce++;
    records.push({
      index: i + 1, expected: shouldAllow ? "ALLOW" : "BLOCK",
      result, txHash, explorer: txHash ? EXPLORER + txHash : null,
      blockNumber, gasUsed, gasPrice, nonce: intent.nonce.toString(),
      guardianDecision: shouldAllow ? "ALLOW" : "BLOCK",
      latencyMs, error,
    });
    console.log(JSON.stringify(records[records.length - 1]));
  }
  const successes = records.filter(r => r.result === "SUCCESS");
  const reverted = records.filter(r => r.result === "REVERTED");
  const expectedAllow = records.filter(r => r.expected === "ALLOW");
  const expectedBlock = records.filter(r => r.expected === "BLOCK");
  const falseAllow = records.filter(r => r.expected === "BLOCK" && r.result === "SUCCESS");
  const falseBlock = records.filter(r => r.expected === "ALLOW" && r.result !== "SUCCESS");
  const latencies = records.map(r => r.latencyMs).sort((a,b) => a-b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
  const gas = records.map(r => BigInt(r.gasUsed));
  const gasTotal = gas.reduce((a,b) => a+b, 0n);
  const out = {
    schemaVersion: 1, benchmark: "agent-guardian-cwf-real-100",
    generatedAt: new Date().toISOString(), network: "arbitrumSepolia",
    chainId: Number(chain.chainId), total: records.length,
    expectedAllow: expectedAllow.length, expectedBlock: expectedBlock.length,
    successfulReceipts: successes.length, revertedReceipts: reverted.length,
    falseAllow: falseAllow.length, falseBlock: falseBlock.length,
    deployments: {
      registry: await registry.getAddress(), policy: await policy.getAddress(),
      guard: await guard.getAddress(), wallet: await wallet.getAddress(),
      target: await target.getAddress(), agent: agent.address,
      policyHash, policyId,
    },
    metrics: {
      latencyMs: { p50: pct(.50), p95: pct(.95), p99: pct(.99), max: latencies.at(-1) },
      gasUsedTotal: gasTotal.toString(),
      gasUsedAverage: Number(gasTotal) / records.length,
      elapsedMs: performance.now() - started,
    },
    records,
  };
  const outPath = path.resolve("benchmark/real-100-latest.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log("RESULT_FILE=" + outPath);
  console.log(JSON.stringify({
    total: records.length, successfulReceipts: successes.length,
    revertedReceipts: reverted.length, falseAllow: falseAllow.length,
    falseBlock: falseBlock.length, p50: pct(.5), p95: pct(.95), p99: pct(.99),
  }, null, 2));
  if (records.length !== TOTAL || falseAllow.length || falseBlock.length) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
