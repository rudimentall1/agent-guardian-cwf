import { ethers } from "hardhat";

import {
  defineContractTool,
  resolveToolRequest,
} from "../runtime/tool-request";
import { signIntent } from "../runtime/intent";

const FAR_FUTURE = 4102444800n;

function header(title: string) {
  console.log("");
  console.log("=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
}

function ok(message: string) {
  console.log(`  [ALLOW] ${message}`);
}

function blocked(message: string) {
  console.log(`  [BLOCKED] ${message}`);
}

function decodeRevert(guard: any, error: any): string {
  const data =
    error?.data ??
    error?.error?.data ??
    error?.info?.error?.data;

  if (typeof data === "string") {
    try {
      const parsed = guard.interface.parseError(data);
      if (parsed) {
        return parsed.name;
      }
    } catch {
      // Fall through to the generic error message.
    }
  }

  return error?.shortMessage ?? error?.message ?? "Unknown error";
}

async function main() {
  const [owner, relayer] = await ethers.getSigners();

  header("CWF — AI AGENT EXECUTION SECURITY DEMO");

  console.log("Security boundary:");
  console.log("  ToolRequest -> Intent -> Signature -> Policy -> Guard -> Target");

  // ------------------------------------------------------------------
  // Deploy local demo stack
  // ------------------------------------------------------------------

  header("1. Deploying security stack");

  const agent = ethers.Wallet.createRandom().connect(ethers.provider);

  const registry = await (
    await ethers.getContractFactory("AgentRegistry")
  ).deploy();
  await registry.waitForDeployment();

  const policyRegistry = await (
    await ethers.getContractFactory("PolicyRegistry")
  ).deploy();
  await policyRegistry.waitForDeployment();

  const guard = await (
    await ethers.getContractFactory("AgentExecutionGuard")
  ).deploy(
    await registry.getAddress(),
    await policyRegistry.getAddress(),
  );
  await guard.waitForDeployment();

  const wallet = await (
    await ethers.getContractFactory("AgentSmartWallet")
  ).deploy(
    owner.address,
    await guard.getAddress(),
  );
  await wallet.waitForDeployment();

  const target = await (
    await ethers.getContractFactory("RecordingTarget")
  ).deploy();
  await target.waitForDeployment();

  console.log("  Agent:              ", agent.address);
  console.log("  AgentExecutionGuard:", await guard.getAddress());
  console.log("  AgentSmartWallet:   ", await wallet.getAddress());
  console.log("  Target:             ", await target.getAddress());

  // ------------------------------------------------------------------
  // Register agent
  // ------------------------------------------------------------------

  header("2. Registering agent identity");

  const network = await ethers.provider.getNetwork();

  const registryDomain = {
    name: "AgentRegistry",
    version: "1",
    chainId: network.chainId,
    verifyingContract: await registry.getAddress(),
  };

  const metadataHash = ethers.keccak256(
    ethers.toUtf8Bytes("cwf-demo-agent"),
  );

  const registrationSignature = await agent.signTypedData(
    registryDomain,
    {
      AgentRegistration: [
        { name: "agent", type: "address" },
        { name: "owner", type: "address" },
        { name: "metadataHash", type: "bytes32" },
      ],
    },
    {
      agent: agent.address,
      owner: owner.address,
      metadataHash,
    },
  );

  await (
    await registry.register(
      agent.address,
      owner.address,
      metadataHash,
      registrationSignature,
    )
  ).wait();

  console.log(
    "  Agent active:",
    await registry.isActiveAgent(agent.address),
  );

  // ------------------------------------------------------------------
  // Create policy
  // ------------------------------------------------------------------

  header("3. Creating exact execution policy");

  const salt = ethers.keccak256(
    ethers.toUtf8Bytes("cwf-demo-policy"),
  );

  const recordSelector = ethers.id("record(uint256)").slice(0, 10);
  const targetAddress = await target.getAddress();

  await (
    await policyRegistry.connect(owner).createPolicy(
      salt,
      agent.address,
      0n,
      0n,
      ethers.parseEther("1"),
      0n,
      FAR_FUTURE,
      [
        {
          target: targetAddress,
          selector: recordSelector,
        },
      ],
      [],
    )
  ).wait();

  const policyId = await policyRegistry.computePolicyId(
    owner.address,
    salt,
  );

  const policyHash = await policyRegistry.policyHashOf(policyId);

  console.log("  Authorized target: ", targetAddress);
  console.log("  Authorized action: record(uint256)");
  console.log("  Selector:          ", recordSelector);
  console.log("  Policy hash:       ", policyHash);

  // ------------------------------------------------------------------
  // Build tool definition
  // ------------------------------------------------------------------

  const tool = defineContractTool(
    "recording-target",
    "record",
    targetAddress,
    "function record(uint256 amount)",
  );

  // ------------------------------------------------------------------
  // Scenario A — legitimate AI request
  // ------------------------------------------------------------------

  header("4. Scenario A — legitimate AI request");

  console.log("  AI proposal: record(42)");

  const request = {
    agent: agent.address,
    wallet: await wallet.getAddress(),
    tool: "recording-target",
    action: "record",
    args: [42n],
    value: 0n,
    nonce: 0n,
    deadline: FAR_FUTURE,
    policyHash,
  };

  const resolved = resolveToolRequest(tool, request);

  console.log("  Canonical target:   ", resolved.intent.target);
  console.log("  Calldata:           ", resolved.intent.data);
  console.log(
    "  Calldata hash:      ",
    ethers.keccak256(resolved.intent.data),
  );

  const signature = await signIntent(
    agent,
    resolved.intent,
    network.chainId,
    await guard.getAddress(),
  );

  console.log("  Agent signature:     created");

  await (
    await guard.connect(relayer).executeFromWallet(
      resolved.intent.agent,
      resolved.intent.wallet,
      resolved.intent.target,
      resolved.intent.value,
      resolved.intent.data,
      resolved.intent.nonce,
      resolved.intent.deadline,
      resolved.intent.policyHash,
      signature,
    )
  ).wait();

  ok("Intent accepted by Guard and executed by SmartWallet");

  console.log(
    "  Target call count:  ",
    (await target.callCount()).toString(),
  );

  // ------------------------------------------------------------------
  // Scenario B — attacker changes calldata after signing
  // ------------------------------------------------------------------

  header("5. Scenario B — attacker mutates signed calldata");

  console.log("  New signed intent nonce: 1");
  console.log("  Original AI proposal:     record(42)");
  console.log("  Attacker mutation:        record(999)");

  const attackRequest = {
    agent: agent.address,
    wallet: await wallet.getAddress(),
    tool: "recording-target",
    action: "record",
    args: [42n],
    value: 0n,
    nonce: 1n,
    deadline: FAR_FUTURE,
    policyHash,
  };

  const signedIntent = resolveToolRequest(
    tool,
    attackRequest,
  );

  const attackSignature = await signIntent(
    agent,
    signedIntent.intent,
    network.chainId,
    await guard.getAddress(),
  );

  const modifiedData = tool.encode([999n]);

  console.log(
    "  Signed calldata:        ",
    signedIntent.intent.data,
  );
  console.log(
    "  Modified calldata:      ",
    modifiedData,
  );

  try {
    await guard.connect(relayer).executeFromWallet(
      signedIntent.intent.agent,
      signedIntent.intent.wallet,
      signedIntent.intent.target,
      signedIntent.intent.value,
      modifiedData,
      signedIntent.intent.nonce,
      signedIntent.intent.deadline,
      signedIntent.intent.policyHash,
      attackSignature,
    );

    console.log("  ERROR: modified intent was unexpectedly accepted");
    process.exitCode = 1;
    return;
  } catch (error: any) {
    const reason = decodeRevert(guard, error);

    if (reason !== "InvalidSignature") {
      console.log(`  ERROR: unexpected rejection reason: ${reason}`);
      process.exitCode = 1;
      return;
    }

    blocked("Modified calldata rejected by the Guard");
    console.log("  Reason:                ", reason);
  }

  // ------------------------------------------------------------------
  // Final state
  // ------------------------------------------------------------------

  header("6. Final security state");

  console.log(
    "  Successful target calls:",
    (await target.callCount()).toString(),
  );

  console.log(
    "  Agent nonce:",
    (await guard.nextNonce(agent.address)).toString(),
  );

  console.log(
    "  SmartWallet balance:",
    ethers.formatEther(
      await ethers.provider.getBalance(await wallet.getAddress()),
    ),
    "ETH",
  );

  console.log(
    "  Guard balance:",
    ethers.formatEther(
      await ethers.provider.getBalance(await guard.getAddress()),
    ),
    "ETH",
  );

  console.log("");
  console.log("  RESULT: SECURITY BOUNDARY VERIFIED");
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
