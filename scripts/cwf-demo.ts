import { ethers } from "hardhat";

import {
  defineContractTool,
  resolveToolRequest,
} from "../runtime/tool-request";
import {
  signIntent,
  canonicalizeIntent,
} from "../runtime/intent";

const FAR_FUTURE = 4102444800n;

const approvalTypes = {
  ExecutionApproval: [
    { name: "agent", type: "address" },
    { name: "wallet", type: "address" },
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "calldataHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "policyHash", type: "bytes32" },
    { name: "approvalDeadline", type: "uint256" },
  ],
};

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

async function expectRevert(
  guard: any,
  action: Promise<unknown>,
  expectedReason: string,
  label: string,
) {
  try {
    await action;

    console.log(`  ERROR: ${label} was unexpectedly accepted`);
    process.exitCode = 1;
    throw new Error(`${label} should have reverted`);
  } catch (error: any) {
    const reason = decodeRevert(guard, error);

    if (reason !== expectedReason) {
      console.log(
        `  ERROR: ${label} reverted with ${reason}, expected ${expectedReason}`,
      );
      process.exitCode = 1;
      throw error;
    }

    blocked(`${label} rejected`);
    console.log("  Reason:", reason);
  }
}

async function main() {
  const [owner, relayer] = await ethers.getSigners();

  header("CWF — AI AGENT EXECUTION SECURITY DEMO");

  console.log("Security boundary:");
  console.log(
    "  ToolRequest -> Intent -> Signature -> Policy -> Guard -> Wallet -> Target",
  );

  // ------------------------------------------------------------------
  // Deploy stack
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
    agent.address,
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
  console.log("  Native recipient:   ", owner.address);

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

  await registry.bindWallet(agent.address, await wallet.getAddress());

  console.log(
    "  Agent active:",
    await registry.isActiveAgent(agent.address),
  );

  // ------------------------------------------------------------------
  // Policy
  // ------------------------------------------------------------------

  header("3. Creating execution policy");

  const salt = ethers.keccak256(
    ethers.toUtf8Bytes("cwf-demo-policy"),
  );

  const recordSelector = ethers.id("record(uint256)").slice(0, 10);

  const targetAAddress = await targetA.getAddress();
  const targetBAddress = await targetB.getAddress();

  const maxTxValue = ethers.parseEther("1");
  const dailyLimit = ethers.parseEther("1");
  const approvalThreshold = ethers.parseEther("0.5");

  await (
    await policyRegistry.connect(owner).createPolicy(
      salt,
      agent.address,
      maxTxValue,
      dailyLimit,
      approvalThreshold,
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
      [owner.address],
    )
  ).wait();

  const policyId = await policyRegistry.computePolicyId(
    owner.address,
    salt,
  );

  const policyHash = await policyRegistry.policyHashOf(policyId);

  console.log("  Target A authorized: ", targetAAddress);
  console.log("  Target B authorized: ", targetBAddress);
  console.log("  Native recipient:    ", owner.address);
  console.log("  Max tx value:        ", ethers.formatEther(maxTxValue), "ETH");
  console.log("  Daily limit:         ", ethers.formatEther(dailyLimit), "ETH");
  console.log(
    "  Approval threshold:  ",
    ethers.formatEther(approvalThreshold),
    "ETH",
  );
  console.log("  Policy hash:         ", policyHash);

  // ------------------------------------------------------------------
  // Fund wallet
  // ------------------------------------------------------------------

  header("4. Funding AgentSmartWallet");

  await (
    await owner.sendTransaction({
      to: await wallet.getAddress(),
      value: ethers.parseEther("2"),
    })
  ).wait();

  console.log(
    "  Wallet balance:",
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

  // ------------------------------------------------------------------
  // Tools
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
  // Scenario A — normal function call
  // ------------------------------------------------------------------

  header("5. Scenario A — legitimate AI request");

  console.log("  AI proposal: target A -> record(42)");

  const nonce0 = await guard.nextNonce(agent.address);

  const requestA = {
    agent: agent.address,
    wallet: await wallet.getAddress(),
    tool: "recording-target-a",
    action: "record",
    args: [42n],
    value: 0n,
    nonce: nonce0,
    deadline: FAR_FUTURE,
    policyHash,
  };

  const resolvedA = resolveToolRequest(toolA, requestA);

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

  ok("Target A function call accepted");

  // ------------------------------------------------------------------
  // Scenario B — calldata mutation
  // ------------------------------------------------------------------

  header("6. Scenario B — attacker mutates signed calldata");

  const nonce1 = await guard.nextNonce(agent.address);

  const signedFor42 = resolveToolRequest(toolA, {
    agent: agent.address,
    wallet: await wallet.getAddress(),
    tool: "recording-target-a",
    action: "record",
    args: [42n],
    value: 0n,
    nonce: nonce1,
    deadline: FAR_FUTURE,
    policyHash,
  });

  const signatureFor42 = await signIntent(
    agent,
    signedFor42.intent,
    network.chainId,
    await guard.getAddress(),
  );

  const modifiedCalldata = toolA.encode([999n]);

  console.log("  Signed calldata:   ", signedFor42.intent.data);
  console.log("  Modified calldata: ", modifiedCalldata);

  await expectRevert(
    guard,
    guard.connect(relayer).executeFromWallet(
      signedFor42.intent.agent,
      signedFor42.intent.wallet,
      signedFor42.intent.target,
      signedFor42.intent.value,
      modifiedCalldata,
      signedFor42.intent.nonce,
      signedFor42.intent.deadline,
      signedFor42.intent.policyHash,
      signatureFor42,
    ),
    "InvalidSignature",
    "Calldata mutation",
  );

  // ------------------------------------------------------------------
  // Scenario C — target substitution
  // ------------------------------------------------------------------

  header("7. Scenario C — attacker substitutes target contract");

  const nonce2 = await guard.nextNonce(agent.address);

  const signedForTargetA = resolveToolRequest(toolA, {
    agent: agent.address,
    wallet: await wallet.getAddress(),
    tool: "recording-target-a",
    action: "record",
    args: [77n],
    value: 0n,
    nonce: nonce2,
    deadline: FAR_FUTURE,
    policyHash,
  });

  const signatureForTargetA = await signIntent(
    agent,
    signedForTargetA.intent,
    network.chainId,
    await guard.getAddress(),
  );

  const targetBData = toolB.encode([77n]);

  console.log("  Signed target:", targetAAddress);
  console.log("  Attack target:", targetBAddress);

  await expectRevert(
    guard,
    guard.connect(relayer).executeFromWallet(
      signedForTargetA.intent.agent,
      signedForTargetA.intent.wallet,
      targetBAddress,
      0n,
      targetBData,
      signedForTargetA.intent.nonce,
      signedForTargetA.intent.deadline,
      signedForTargetA.intent.policyHash,
      signatureForTargetA,
    ),
    "InvalidSignature",
    "Target substitution",
  );

  // ------------------------------------------------------------------
  // Scenario D — normal native transfer below threshold
  // ------------------------------------------------------------------

  header("8. Scenario D — native transfer below approval threshold");

  const transferValue = ethers.parseEther("0.4");
  const nonce3 = await guard.nextNonce(agent.address);

  const transferIntent = {
    agent: agent.address,
    wallet: await wallet.getAddress(),
    target: owner.address,
    value: transferValue,
    data: "0x",
    nonce: nonce3,
    deadline: FAR_FUTURE,
    policyHash,
  };

  canonicalizeIntent(transferIntent);

  const transferSignature = await signIntent(
    agent,
    transferIntent,
    network.chainId,
    await guard.getAddress(),
  );

  const ownerBalanceBefore = await ethers.provider.getBalance(
    owner.address,
  );

  await (
    await guard.connect(relayer).executeFromWallet(
      transferIntent.agent,
      transferIntent.wallet,
      transferIntent.target,
      transferIntent.value,
      transferIntent.data,
      transferIntent.nonce,
      transferIntent.deadline,
      transferIntent.policyHash,
      transferSignature,
    )
  ).wait();

  const ownerBalanceAfter = await ethers.provider.getBalance(
    owner.address,
  );

  ok("0.4 ETH transfer accepted without owner approval");

  console.log(
    "  Owner received:",
    ethers.formatEther(ownerBalanceAfter - ownerBalanceBefore),
    "ETH before gas effects",
  );

  // ------------------------------------------------------------------
  // Scenario E — above threshold without approval
  // ------------------------------------------------------------------

  header("9. Scenario E — transfer above approval threshold");

  const approvalTransferValue = ethers.parseEther("0.6");
  const nonce4 = await guard.nextNonce(agent.address);

  const approvalIntent = {
    agent: agent.address,
    wallet: await wallet.getAddress(),
    target: owner.address,
    value: approvalTransferValue,
    data: "0x",
    nonce: nonce4,
    deadline: FAR_FUTURE,
    policyHash,
  };

  canonicalizeIntent(approvalIntent);

  const approvalIntentSignature = await signIntent(
    agent,
    approvalIntent,
    network.chainId,
    await guard.getAddress(),
  );

  await expectRevert(
    guard,
    guard.connect(relayer).executeFromWallet(
      approvalIntent.agent,
      approvalIntent.wallet,
      approvalIntent.target,
      approvalIntent.value,
      approvalIntent.data,
      approvalIntent.nonce,
      approvalIntent.deadline,
      approvalIntent.policyHash,
      approvalIntentSignature,
    ),
    "ApprovalRequired",
    "0.6 ETH transfer without owner approval",
  );

  // ------------------------------------------------------------------
  // Scenario F — same transfer with owner approval
  // ------------------------------------------------------------------

  header("10. Scenario F — owner approves the high-value transfer");

  const approvalDeadline = FAR_FUTURE;

  const ownerApprovalSignature = await owner.signTypedData(
    {
      name: "AgentExecutionGuard",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await guard.getAddress(),
    },
    approvalTypes,
    {
      agent: approvalIntent.agent,
      wallet: approvalIntent.wallet,
      target: approvalIntent.target,
      value: approvalIntent.value,
      calldataHash: ethers.keccak256(approvalIntent.data),
      nonce: approvalIntent.nonce,
      deadline: approvalIntent.deadline,
      policyHash: approvalIntent.policyHash,
      approvalDeadline,
    },
  );

  await (
    await guard.connect(relayer).executeWithApprovalFromWallet(
      approvalIntent.agent,
      approvalIntent.wallet,
      approvalIntent.target,
      approvalIntent.value,
      approvalIntent.data,
      approvalIntent.nonce,
      approvalIntent.deadline,
      approvalIntent.policyHash,
      approvalIntentSignature,
      approvalDeadline,
      ownerApprovalSignature,
    )
  ).wait();

  ok("0.6 ETH transfer accepted after owner approval");

  // ------------------------------------------------------------------
  // Scenario G — daily limit exhausted
  // ------------------------------------------------------------------

  header("11. Scenario G — daily limit enforcement");

  console.log("  Successful native spend: 0.4 + 0.6 = 1.0 ETH");
  console.log("  Policy daily limit:      1.0 ETH");
  console.log("  Next request:            0.1 ETH");

  const dailyLimitIntent = {
    agent: agent.address,
    wallet: await wallet.getAddress(),
    target: owner.address,
    value: ethers.parseEther("0.1"),
    data: "0x",
    nonce: await guard.nextNonce(agent.address),
    deadline: FAR_FUTURE,
    policyHash,
  };

  const dailyLimitSignature = await signIntent(
    agent,
    dailyLimitIntent,
    network.chainId,
    await guard.getAddress(),
  );

  await expectRevert(
    guard,
    guard.connect(relayer).executeFromWallet(
      dailyLimitIntent.agent,
      dailyLimitIntent.wallet,
      dailyLimitIntent.target,
      dailyLimitIntent.value,
      dailyLimitIntent.data,
      dailyLimitIntent.nonce,
      dailyLimitIntent.deadline,
      dailyLimitIntent.policyHash,
      dailyLimitSignature,
    ),
    "DailyLimitExceeded",
    "Daily limit overflow",
  );

  // ------------------------------------------------------------------
  // Final state
  // ------------------------------------------------------------------

  header("12. Final security state");

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
  console.log("  RESULT: POLICY + SIGNATURE SECURITY VERIFIED");
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
