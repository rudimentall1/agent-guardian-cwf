import { ethers } from "hardhat";

const FAR_FUTURE = 4102444800n; // 2100-01-01

const intentTypes = {
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

function section(title: string) {
  console.log("\n" + "=".repeat(70));
  console.log(title);
  console.log("=".repeat(70));
}

function decodeRevert(guardIface: any, e: any): string {
  const data = e?.data ?? e?.error?.data ?? e?.info?.error?.data;
  if (typeof data === "string") {
    try {
      const parsed = guardIface.parseError(data);
      if (parsed) return `${parsed.name}(${parsed.args.map((a: any) => a.toString()).join(", ")})`;
    } catch {
      /* fall through to raw message below */
    }
  }
  return e.shortMessage ?? e.message;
}

async function main() {
  const [owner, guardian, relayer] = await ethers.getSigners();
  const agent = ethers.Wallet.createRandom().connect(ethers.provider);
  await owner.sendTransaction({ to: agent.address, value: ethers.parseEther("1") });

  section("Agent Guardian — full-stack live demo (Arbitrum)");
  console.log("Owner:   ", owner.address);
  console.log("Agent:   ", agent.address, "(freshly generated key)");
  console.log("Guardian:", guardian.address);
  console.log("Relayer: ", relayer.address, "(submits transactions, funds nothing)");

  // ---- Deploy the full stack ----
  section("0. Deploying AgentRegistry, PolicyRegistry, AgentExecutionGuard, AgentSmartWallet");
  const registry = await (await ethers.getContractFactory("AgentRegistry")).deploy();
  await registry.waitForDeployment();
  const policyRegistry = await (await ethers.getContractFactory("PolicyRegistry")).deploy();
  await policyRegistry.waitForDeployment();
  const guard = await (await ethers.getContractFactory("AgentExecutionGuard")).deploy(
    await registry.getAddress(),
    await policyRegistry.getAddress()
  );
  await guard.waitForDeployment();
  const guardAddress = await guard.getAddress();
  const wallet = await (await ethers.getContractFactory("AgentSmartWallet")).deploy(owner.address, guardAddress, agent.address);
  await wallet.waitForDeployment();
  const walletAddress = await wallet.getAddress();
  const target = await (await ethers.getContractFactory("RecordingTarget")).deploy();
  await target.waitForDeployment();
  const targetAddress = await target.getAddress();

  console.log("AgentRegistry:      ", await registry.getAddress());
  console.log("PolicyRegistry:     ", await policyRegistry.getAddress());
  console.log("AgentExecutionGuard:", guardAddress);
  console.log("AgentSmartWallet:   ", walletAddress, "(owner's funds live here, not in the Guard)");
  console.log("Demo target:        ", targetAddress, "(stand-in for a DeFi protocol / recipient)");

  const net = await ethers.provider.getNetwork();
  const intentDomain = { name: "AgentExecutionGuard", version: "1", chainId: net.chainId, verifyingContract: guardAddress };
  const registryDomain = { name: "AgentRegistry", version: "1", chainId: net.chainId, verifyingContract: await registry.getAddress() };

  // ---- 1. Register agent identity ----
  section("1. Owner registers the agent's on-chain identity (EIP-712 signed)");
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("demo-agent-v1"));
  const regSig = await agent.signTypedData(registryDomain, {
    AgentRegistration: [
      { name: "agent", type: "address" },
      { name: "owner", type: "address" },
      { name: "metadataHash", type: "bytes32" },
    ],
  }, { agent: agent.address, owner: owner.address, metadataHash });
  await (await registry.register(agent.address, owner.address, metadataHash, regSig)).wait();
  await (await registry.bindWallet(agent.address, walletAddress)).wait();
  console.log("Agent active:", await registry.isActiveAgent(agent.address));

  // ---- 2. Owner creates a financial mandate ----
  section("2. Owner creates a policy: what the agent is actually allowed to do");
  const maxTxValue = ethers.parseEther("0.5");
  const dailyLimit = ethers.parseEther("0.6");
  const approvalThreshold = ethers.parseEther("0.3");
  const salt = ethers.keccak256(ethers.toUtf8Bytes("demo-policy-1"));
  await (await policyRegistry.connect(owner).createPolicy(
    salt, agent.address, maxTxValue, dailyLimit, approvalThreshold, 0n, FAR_FUTURE, [], [targetAddress]
  )).wait();
  const policyId = await policyRegistry.computePolicyId(owner.address, salt);
  const policyHash = await policyRegistry.policyHashOf(policyId);
  console.log("Policy:", { maxTxValue: "0.5 ETH", dailyLimit: "0.6 ETH", approvalThreshold: "0.3 ETH", authorizedTarget: targetAddress });
  console.log("policyHash:", policyHash);

  // ---- 3. Fund the wallet (NOT the Guard) ----
  section("3. Owner funds the AgentSmartWallet — the Guard itself never holds a balance");
  await (await owner.sendTransaction({ to: walletAddress, value: ethers.parseEther("2") })).wait();
  console.log("AgentSmartWallet balance:", ethers.formatEther(await ethers.provider.getBalance(walletAddress)), "ETH");
  console.log("AgentExecutionGuard balance:", ethers.formatEther(await ethers.provider.getBalance(guardAddress)), "ETH (always zero, by design)");

  let nonce = 0n;
  async function signIntent(value: bigint, deadline = FAR_FUTURE) {
    return agent.signTypedData(intentDomain, intentTypes, {
      agent: agent.address, wallet: walletAddress, target: targetAddress, value,
      calldataHash: ethers.keccak256("0x"), nonce, deadline, policyHash,
    });
  }

  // ---- 4. Below the approval threshold: executes immediately ----
  section("4. Agent signs a 0.1 ETH transfer (below the 0.3 ETH approval threshold) — executes with no owner in the loop");
  const sig1 = await signIntent(ethers.parseEther("0.1"));
  await (await guard.connect(relayer).executeFromWallet(
    agent.address, walletAddress, targetAddress, ethers.parseEther("0.1"), "0x", nonce, FAR_FUTURE, policyHash, sig1
  )).wait();
  nonce++;
  console.log("OK — relayer submitted, funded entirely from the wallet, zero ETH from the relayer's own pocket.");
  console.log("Target has now received", await target.callCount(), "call(s).");

  // ---- 5. Above the threshold, no approval: rejected ----
  section("5. Agent signs a 0.4 ETH transfer (above threshold) and tries WITHOUT an owner approval");
  const sig2 = await signIntent(ethers.parseEther("0.4"));
  try {
    await guard.connect(relayer).executeFromWallet(
      agent.address, walletAddress, targetAddress, ethers.parseEther("0.4"), "0x", nonce, FAR_FUTURE, policyHash, sig2
    );
    console.log("UNEXPECTED: this should have reverted");
  } catch (e: any) {
    console.log("Correctly rejected:", decodeRevert(guard.interface, e));
  }

  // ---- 6. Same transfer, WITH owner approval: succeeds ----
  section("6. Same 0.4 ETH transfer, this time with a fresh owner-signed approval");
  const approvalDeadline = FAR_FUTURE;
  const approvalSig = await owner.signTypedData(intentDomain, approvalTypes, {
    agent: agent.address, wallet: walletAddress, target: targetAddress, value: ethers.parseEther("0.4"),
    calldataHash: ethers.keccak256("0x"), nonce, deadline: FAR_FUTURE, policyHash, approvalDeadline,
  });
  await (await guard.connect(relayer).executeWithApprovalFromWallet(
    agent.address, walletAddress, targetAddress, ethers.parseEther("0.4"), "0x", nonce, FAR_FUTURE, policyHash, sig2, approvalDeadline, approvalSig
  )).wait();
  nonce++;
  console.log("OK — owner approval verified, transfer executed. Cumulative spend today: 0.5 ETH.");

  // ---- 7. Daily limit: next transfer would breach it ----
  section("7. Agent tries a 0.2 ETH transfer — individually fine, but 0.5 + 0.2 > the 0.6 ETH daily limit");
  const sig3 = await signIntent(ethers.parseEther("0.2"));
  try {
    await guard.connect(relayer).executeFromWallet(
      agent.address, walletAddress, targetAddress, ethers.parseEther("0.2"), "0x", nonce, FAR_FUTURE, policyHash, sig3
    );
    console.log("UNEXPECTED: this should have reverted");
  } catch (e: any) {
    console.log("Correctly rejected:", decodeRevert(guard.interface, e));
  }

  // ---- 8. Owner pauses the agent (compromised-key scenario) ----
  section("8. Owner suspects the agent's key is compromised and pauses it immediately");
  await (await guard.connect(owner).pauseAgent(agent.address)).wait();
  const sig4 = await signIntent(ethers.parseEther("0.01"));
  try {
    await guard.connect(relayer).executeFromWallet(
      agent.address, walletAddress, targetAddress, ethers.parseEther("0.01"), "0x", nonce, FAR_FUTURE, policyHash, sig4
    );
    console.log("UNEXPECTED: this should have reverted");
  } catch (e: any) {
    console.log("Correctly rejected even for a tiny, otherwise-valid transfer:", decodeRevert(guard.interface, e));
  }

  // ---- 9. Guardian-level emergency recovery (identity-level kill switch) ----
  section("9. Separately: owner had already assigned a recovery guardian, who can deactivate the agent's identity entirely");
  await (await registry.connect(owner).setRecoveryGuardian(agent.address, guardian.address)).wait();
  console.log("Agent active before recovery:", await registry.isActiveAgent(agent.address));
  await (await registry.connect(guardian).executeRecovery(agent.address)).wait();
  console.log("Agent active after recovery: ", await registry.isActiveAgent(agent.address));

  section("Demo complete");
  console.log("Final AgentSmartWallet balance:", ethers.formatEther(await ethers.provider.getBalance(walletAddress)), "ETH");
  console.log("Final AgentExecutionGuard balance:", ethers.formatEther(await ethers.provider.getBalance(guardAddress)), "ETH");
  console.log("Successful transfers reaching the target:", (await target.callCount()).toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
