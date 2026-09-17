import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying from:", deployer.address);

  const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
  const agentRegistry = await AgentRegistry.deploy();
  await agentRegistry.waitForDeployment();

  console.log(
    "AgentRegistry:",
    await agentRegistry.getAddress()
  );

  const PolicyRegistry = await ethers.getContractFactory("PolicyRegistry");
  const policyRegistry = await PolicyRegistry.deploy();
  await policyRegistry.waitForDeployment();

  console.log(
    "PolicyRegistry:",
    await policyRegistry.getAddress()
  );

  const AgentExecutionGuard =
    await ethers.getContractFactory("AgentExecutionGuard");

  const guard = await AgentExecutionGuard.deploy(
    await agentRegistry.getAddress(),
    await policyRegistry.getAddress()
  );

  await guard.waitForDeployment();
  const guardAddress = await guard.getAddress();

  console.log(
    "AgentExecutionGuard:",
    guardAddress
  );

  // A SmartWallet is meaningful only after an agent identity exists. For a
  // reproducible end-to-end deployment, supply CWF_AGENT_PRIVATE_KEY; the
  // derived agent is registered to the deployer, then its wallet is deployed
  // and atomically bound as that agent's canonical custody wallet. Without an
  // agent key, this script intentionally deploys only the core registries and
  // Guard rather than creating a misleading unbound example wallet.
  let exampleWallet: any = null;
  let agentAddress: string | null = null;

  const agentPrivateKey = process.env.CWF_AGENT_PRIVATE_KEY;
  if (agentPrivateKey) {
    const agent = new ethers.Wallet(agentPrivateKey);
    agentAddress = agent.address;

    const metadataHash = process.env.CWF_AGENT_METADATA_HASH
      ? ethers.hexlify(process.env.CWF_AGENT_METADATA_HASH)
      : ethers.keccak256(ethers.toUtf8Bytes("agent-guardian-cwf"));

    const networkInfo = await ethers.provider.getNetwork();
    const registrationDomain = {
      name: "AgentRegistry",
      version: "1",
      chainId: networkInfo.chainId,
      verifyingContract: await agentRegistry.getAddress(),
    };
    const registrationTypes = {
      AgentRegistration: [
        { name: "agent", type: "address" },
        { name: "owner", type: "address" },
        { name: "metadataHash", type: "bytes32" },
      ],
    };
    const registrationSignature = await agent.signTypedData(
      registrationDomain,
      registrationTypes,
      { agent: agentAddress, owner: deployer.address, metadataHash },
    );

    await (await agentRegistry.register(
      agentAddress,
      deployer.address,
      metadataHash,
      registrationSignature,
    )).wait();

    const AgentSmartWallet = await ethers.getContractFactory("AgentSmartWallet");
    exampleWallet = await AgentSmartWallet.deploy(
      deployer.address,
      guardAddress,
      agentAddress,
    );
    await exampleWallet.waitForDeployment();

    await (await agentRegistry.bindWallet(
      agentAddress,
      await exampleWallet.getAddress(),
    )).wait();

    console.log("Registered agent:", agentAddress);
    console.log("AgentSmartWallet:", await exampleWallet.getAddress());
  } else {
    console.log("CWF_AGENT_PRIVATE_KEY not set: skipping wallet deployment; core stack only.");
  }

  const result = {
    agentRegistry: await agentRegistry.getAddress(),
    policyRegistry: await policyRegistry.getAddress(),
    agentExecutionGuard: guardAddress,
    ...(agentAddress && exampleWallet
      ? {
          agent: agentAddress,
          exampleAgentSmartWallet: await exampleWallet.getAddress(),
        }
      : {}),
  };

  // Single source of truth for "what is actually deployed where" — keyed
  // by network so a testnet run never silently overwrites another
  // network's record, and so docs/hackathon/*.md can be regenerated from
  // this file instead of hand-copied (the prior workaround: manually
  // maintaining deployments.json AND docs/hackathon/submission.md
  // separately let the two drift out of sync with each other).
  const deploymentsPath = path.join(__dirname, "..", "deployments.json");
  let deployments: Record<string, unknown> = {};
  if (fs.existsSync(deploymentsPath)) {
    deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  }
  deployments[network.name] = {
    ...result,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2) + "\n");
  console.log(`\nWrote deployment record for network "${network.name}" to deployments.json`);

  return result;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});