import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";
import { AgentGuardianClient, PreparedIntent } from "../sdk";

async function main() {
const root = process.env.CWF_PROJECT_ROOT ?? process.cwd();
const state = JSON.parse(
  readFileSync(join(root, "benchmark", "agent-demo.json"), "utf8"),
) as {
  agent: string;
  wallet: string;
  policyHash: string;
  guard: string;
};

const rpcUrl = process.env.CWF_RISK_RPC_URL ?? process.env.ARB_SEPOLIA_RPC ?? "https://sepolia-rollup.arbitrum.io/rpc";
const apiUrl = process.env.CWF_API_URL ?? "http://127.0.0.1:8787";
const privateKey = process.env.AGENT_DEMO_PRIVATE_KEY;
if (!privateKey) throw new Error("AGENT_DEMO_PRIVATE_KEY is required");

const provider = new ethers.JsonRpcProvider(rpcUrl);
const signer = new ethers.Wallet(privateKey, provider);
if (ethers.getAddress(signer.address) !== ethers.getAddress(state.agent)) {
  throw new Error("AGENT_DEMO_PRIVATE_KEY does not match benchmark agent");
}

const guard = new ethers.Contract(
  state.guard,
  ["function nextNonce(address agent) view returns (uint256)"],
  provider,
);

const nonce = BigInt((await guard.nextNonce(state.agent)).toString());
const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);

const client = new AgentGuardianClient({ baseUrl: apiUrl });
const request = {
  agent: state.agent,
  wallet: state.wallet,
  tool: "demo",
  action: "ping",
  args: [123],
  value: "0",
  nonce: nonce.toString(),
  deadline: deadline.toString(),
  policyHash: state.policyHash,
};

console.log("=== AGENT GUARDIAN SDK INTEGRATION ===");
console.log("Agent:", state.agent);
console.log("ToolRequest: demo:ping(123)");
console.log("Nonce:", nonce.toString());

const result = await client.guardedExecute(request, signer);
const { prepared, signature, preflight, execution } = result;
console.log("Risk:", JSON.stringify(prepared.risk ?? null));
console.log("Intent target:", prepared.intent.target);
console.log("Intent calldata:", prepared.intent.data);
console.log("Preflight:", preflight.decision, preflight.reason ?? "");
console.log("Execution:", execution.decision);
console.log("Transaction:", execution.transactionHash ?? "none");

if (preflight.decision !== "ALLOW" || execution.decision !== "ALLOW") {
  throw new Error("Guardian refused the valid agent request");
}

const tampered: PreparedIntent = {
  ...prepared.intent,
  data: ethers.concat([
    ethers.dataSlice(prepared.intent.data, 0, 4),
    ethers.zeroPadValue(ethers.toBeHex(999), 32),
  ]),
};

const tamperedPreflight = await client.preflight(tampered, signature);
console.log("Tampered calldata:", tampered.data);
console.log("Tampered preflight:", tamperedPreflight.decision);
console.log("Tampered reason:", tamperedPreflight.reason ?? "none");

if (tamperedPreflight.decision !== "BLOCK") {
  throw new Error("Guardian failed to block modified calldata");
}

console.log("RESULT: real agent execution allowed; signed calldata tamper blocked before submission");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
