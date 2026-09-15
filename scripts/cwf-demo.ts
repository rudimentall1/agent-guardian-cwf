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

  const targetA = await (
    await ethers.getContractFactory("RecordingTarget")
  ).deploy();
  await targetA.waitForDeployment();

  const targetB = await (
    await ethers.getContractFactory("RecordingTarget")
  ).deploy();
  await targetB.waitForDeployment();

  console.log("  Agent:              ", agent.address);
  console.log("  AgentExecutionGuard:", await guard.getAddress());
  console.log("  AgentSmartWallet:   ", await wallet.getAddress());
  console.log("  Target A:           ", await targetA.getAddress());
  console.log("  Target B:           ", await targetB.getAddress());

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

  const targetAAddress = await targetA.getAddress();
  const targetBAddress = await targetB.getAddress();

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
          target: targetAAddress,
          selector: recordSelector,
        },
        {
          target: targetBAddress,
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

  console.log("  Authorized target A:", targetAAddress);
  console.log("  Authorized target B:", targetBAddress);
  console.log("  Authorized action: record(uint256)");
  console.log("  Selector:           ", recordSelector);
  console.log("  Policy hash:        ", policyHash);

  // ------------------------------------------------------------------
  // Build tool definitions
  // ------------------------------------------------------------------

  const toolA = defineContractTool(
    "recording-target-a",
    "record",
    targetAAddress,
    "function record(uint256 amount)",
  );

  const toolB = defineContractTool(
    "recording-target-b",
    "record",
    targetBAddress,
    "function record(uint256 amount)",
  );

  // ------------------------------------------------------------------
  // Scenario A — legitimate execution on target A
  // ------------------------------------------------------------------

  header("4. Scenario A — legitimate AI request");

  console.log("  AI proposal: target A -> record(42)");

  const requestA = {
    agent: agent.address,
    wallet: await wallet.getAddress(),
    tool: "recording-target-a",
    action: "record",
    args: [42n],
    value: 0n,
    nonce: 0n,
    deadline: FAR_FUTURE,
    policyHash,
  };

  const resolvedA = resolveToolRequest(toolA, requestA);

  console.log("  Signed target:       ", resolvedA.intent.target);
  console.log("  Calldata:            ", resolvedA.intent.data);
  console.log(
    "  Calldata hash:       ",
    ethers.keccak256(resolvedA.intent.data),
  );

  const signatureA = await signIntent(
    agent,
    resolvedA.intent,
    network.chainId,
    await guard.getAddress(),
  );

  await (
    await guard.connect(relayer).executeFromWallet(
      resolvedA.intent.agent,
      resolvedA.intent.wallet,
      resolvedA.intent.target,
      resolvedA.intent.value,
      resolvedA.intent.data,
      resolvedA.intent.nonce,
      resolvedA.intent.deadline,
      resolvedA.intent.policyHash,
      signatureA,
    )
  ).wait();

  ok("Target A execution accepted");

  console.log(
    "  Target A call count: ",
    (await targetA.callCount()).toString(),
  );
  console.log(
    "  Target B call count: ",
    (await targetB.callCount()).toString(),
  );

  // ------------------------------------------------------------------
  // Scenario B — calldata mutation
  // ------------------------------------------------------------------

  header("5. Scenario B — attacker mutates signed calldata");

  console.log("  Signed:       target A -> record(42)");
  console.log("  Attack:       target A -> record(999)");

  const attackRequest = {
    agent: agent.address,
    wallet: await wallet.getAddress(),
    tool: "recording-target-a",
    action: "record",
    args: [42n],
    value: 0n,
    nonce: 1n,
    deadline: FAR_FUTURE,
    policyHash,
  };

  const signedIntent = resolveToolRequest(
    toolA,
    attackRequest,
  );

  const attackSignature = await signIntent(
    agent,
    signedIntent.intent,
    network.chainId,
    await guard.getAddress(),
  );

  const modifiedData = toolA.encode([999n]);

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

    console.log("  ERROR: modified calldata was accepted");
    process.exitCode = 1;
    return;
  } catch (error: any) {
    const reason = decodeRevert(guard, error);

    if (reason !== "InvalidSignature") {
      console.log(`  ERROR: unexpected rejection reason: ${reason}`);
      process.exitCode = 1;
      return;
    }

    blocked("Calldata mutation rejected");
    console.log("  Reason:", reason);
  }

  // ------------------------------------------------------------------
  // Scenario C1 — target substitution
  // ------------------------------------------------------------------

  header("6. Scenario C1 — attacker substitutes target contract");

  console.log("  Signed target:     Target A");
  console.log("  Attack target:     Target B");
  console.log("  Both are allowed by the policy.");

  const targetSwapRequest = {
    agent: agent.address,
    wallet: await wallet.getAddress(),
    tool: "recording-target-a",
    action: "record",
    args: [77n],
    value: 0n,
    nonce: 1n,
    deadline: FAR_FUTURE,
    policyHash,
  };

  const signedTargetIntent = resolveToolRequest(
    toolA,
    targetSwapRequest,
  );

  const targetSwapSignature = await signIntent(
    agent,
    signedTargetIntent.intent,
    network.chainId,
    await guard.getAddress(),
  );

  const targetBData = toolB.encode([77n]);

  try {
    await guard.connect(relayer).executeFromWallet(
      signedTargetIntent.intent.agent,
      signedTargetIntent.intent.wallet,
      targetBAddress,
      signedTargetIntent.intent.value,
      targetBData,
      signedTargetIntent.intent.nonce,
      signedTargetIntent.intent.deadline,
      signedTargetIntent.intent.policyHash,
      targetSwapSignature,
    );

    console.log("  ERROR: target substitution was accepted");
    process.exitCode = 1;
    return;
  } catch (error: any) {
    const reason = decodeRevert(guard, error);

    if (reason !== "InvalidSignature") {
      console.log(`  ERROR: unexpected rejection reason: ${reason}`);
      process.exitCode = 1;
      return;
    }

    blocked("Target substitution rejected by signed intent");
    console.log("  Reason:", reason);
  }

  // ------------------------------------------------------------------
  // Final state
  // ------------------------------------------------------------------

  header("7. Final security state");

  console.log(
    "  Target A successful calls:",
    (await targetA.callCount()).toString(),
  );

  console.log(
    "  Target B successful calls:",
    (await targetB.callCount()).toString(),
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
  console.log("  RESULT: TARGET + CALLDATA BINDING VERIFIED");
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
