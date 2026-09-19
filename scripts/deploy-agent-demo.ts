import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";

const STATE = path.resolve("benchmark/agent-demo.json");
const ENV = path.resolve(".env");

async function main() {
  if (fs.existsSync(STATE)) {
    console.log("Agent demo already deployed:", STATE);
    return;
  }

  const [owner] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 421614n) throw new Error("Not Arbitrum Sepolia");

  let agentKey = process.env.AGENT_DEMO_PRIVATE_KEY;
  if (!agentKey) {
    agentKey = ethers.Wallet.createRandom().privateKey;
    fs.appendFileSync(ENV, `\nAGENT_DEMO_PRIVATE_KEY=${agentKey}\n`);
  }
  const agent = new ethers.Wallet(agentKey).connect(ethers.provider);

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

  const target = process.env.CWF_TOOL_TARGET ?? JSON.parse(
    fs.readFileSync(path.resolve("benchmark/real-100-latest.json"), "utf8")
  ).deployments.target;
  const registrationDomain = {
    name: "AgentRegistry",
    version: "1",
    chainId: network.chainId,
    verifyingContract: await registry.getAddress(),
  };
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("cwf-agent-demo-v1"));
  const registrationSignature = await agent.signTypedData(
    registrationDomain,
    { AgentRegistration: [
      { name: "agent", type: "address" },
      { name: "owner", type: "address" },
      { name: "metadataHash", type: "bytes32" },
    ]},
    { agent: agent.address, owner: owner.address, metadataHash },
  );
  await (await registry.register(
    agent.address, owner.address, metadataHash, registrationSignature
  )).wait();
  await (await registry.bindWallet(agent.address, await wallet.getAddress())).wait();

  const targetContract = await ethers.getContractAt("RealBenchmarkTarget", target);
  const selector = targetContract.interface.getFunction("ping")!.selector;
  const salt = ethers.keccak256(ethers.toUtf8Bytes("cwf-agent-demo-v1-" + Date.now()));
  const now = Math.floor(Date.now() / 1000);
  await (await policy.createPolicy(
    salt, agent.address, 0, 0, 0, now - 60, now + 30 * 86400,
    [{ target, selector }], []
  )).wait();
  const policyId = await policy.computePolicyId(owner.address, salt);
  const policyHash = await policy.policyHashOf(policyId);

  const state = {
    schemaVersion: 1,
    network: "arbitrumSepolia",
    chainId: 421614,
    owner: owner.address,
    agent: agent.address,
    wallet: await wallet.getAddress(),
    target,
    registry: await registry.getAddress(),
    policyRegistry: await policy.getAddress(),
    guard: await guard.getAddress(),
    policyId,
    policyHash,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
  console.log(JSON.stringify({
    ...state,
    agentPrivateKeyPersisted: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
