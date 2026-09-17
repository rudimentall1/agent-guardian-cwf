import { expect } from "chai";
import { deploySmartWallet, fundSmartWallet } from "./smartWalletTestHelpers";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Gate 7 (post-audit remediation): AgentSmartWallet custody wiring.
 *
 * Prior to this gate, `AgentSmartWallet.sol` existed but was never called
 * by `AgentExecutionGuard` — every `execute()` sourced native value from
 * `msg.value` attached by whoever submitted the transaction, never from
 * any wallet contract's own balance. This file proves the new
 * `executeFromWallet` / `executeWithApprovalFromWallet` entry points
 * actually move funds out of a real `AgentSmartWallet`, and that the
 * wallet's own `onlyExecutionGuard` binding is genuinely enforced (not
 * just assumed) by the Guard.
 *
 * It also proves the companion ERC-1271 fix: an agent identity that is
 * itself a smart contract (e.g. an AA wallet / TEE-attested signer
 * stand-in) can register in `AgentRegistry` and sign valid execution
 * intents in `AgentExecutionGuard` — previously impossible because both
 * contracts used raw `ECDSA.recover` instead of `SignatureChecker`.
 */
describe("Gate 7: AgentSmartWallet custody + ERC-1271 agent identity", function () {
  let owner: HardhatEthersSigner;
  let relayer: HardhatEthersSigner;
  let registry: any;
  let registryAddress: string;
  let policyRegistry: any;
  let policyRegistryAddress: string;
  let guard: any;
  let guardAddress: string;
  let target: any;
  let targetAddress: string;
  let smartWallet: any;
  let smartWalletAddress: string;
  let agent: ReturnType<typeof ethers.Wallet.createRandom>;

  const ZERO_HASH = ethers.ZeroHash;
  const FAR_DEADLINE = 4102444800n;

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

  async function domain() {
    const net = await ethers.provider.getNetwork();
    return { name: "AgentExecutionGuard", version: "1", chainId: net.chainId, verifyingContract: guardAddress };
  }

  async function signIntent(signer: any, agentAddr: string, walletAddr: string, value: bigint, nonce: bigint, data = "0x") {
    const d = await domain();
    return signer.signTypedData(d, intentTypes, {
      agent: agentAddr,
      wallet: walletAddr,
      target: targetAddress,
      value,
      calldataHash: ethers.keccak256(data),
      nonce,
      deadline: FAR_DEADLINE,
      policyHash: ZERO_HASH,
    });
  }

  beforeEach(async function () {
    [owner, relayer] = await ethers.getSigners();
    agent = ethers.Wallet.createRandom().connect(ethers.provider);

    const Registry = await ethers.getContractFactory("MockAgentRegistry");
    registry = await Registry.deploy();
    await registry.waitForDeployment();
    registryAddress = await registry.getAddress();
    await registry.setActive(agent.address, true);
    await registry.setOwner(agent.address, owner.address);

    const PolicyRegistry = await ethers.getContractFactory("MockPolicyRegistry");
    policyRegistry = await PolicyRegistry.deploy();
    await policyRegistry.waitForDeployment();
    policyRegistryAddress = await policyRegistry.getAddress();
    await policyRegistry.setFullBinding(ZERO_HASH, owner.address, agent.address, true, true, ethers.MaxUint256);
    await policyRegistry.authorizeNativeTransfer(ZERO_HASH, ethers.ZeroAddress); // placeholder, overwritten below

    const Target = await ethers.getContractFactory("RecordingTarget");
    target = await Target.deploy();
    await target.waitForDeployment();
    targetAddress = await target.getAddress();
    await policyRegistry.authorizeNativeTransfer(ZERO_HASH, targetAddress);

    const Guard = await ethers.getContractFactory("AgentExecutionGuard");
    guard = await Guard.deploy(registryAddress, policyRegistryAddress);
    await guard.waitForDeployment();
    guardAddress = await guard.getAddress();

    const SmartWallet = await ethers.getContractFactory("AgentSmartWallet");
    smartWallet = await SmartWallet.deploy(owner.address, guardAddress, agent.address);
    await smartWallet.waitForDeployment();
    smartWalletAddress = await smartWallet.getAddress();
    await registry.setWallet(agent.address, smartWalletAddress);
  });

  describe("executeFromWallet: funds come from the wallet, not the caller", function () {
    it("moves value out of AgentSmartWallet's own balance, not msg.value", async function () {
      await owner.sendTransaction({ to: smartWalletAddress, value: ethers.parseEther("1") });

      const value = ethers.parseEther("0.4");
      const sig = await signIntent(agent, agent.address, smartWalletAddress, value, 0n);

      const walletBalBefore = await ethers.provider.getBalance(smartWalletAddress);
      const targetBalBefore = await ethers.provider.getBalance(targetAddress);
      const guardBalBefore = await ethers.provider.getBalance(guardAddress);

      // relayer submits with ZERO attached ETH — this is the whole point
      await guard
        .connect(relayer)
        .executeFromWallet(agent.address, smartWalletAddress, targetAddress, value, "0x", 0n, FAR_DEADLINE, ZERO_HASH, sig);

      const walletBalAfter = await ethers.provider.getBalance(smartWalletAddress);
      const targetBalAfter = await ethers.provider.getBalance(targetAddress);
      const guardBalAfter = await ethers.provider.getBalance(guardAddress);

      expect(walletBalBefore - walletBalAfter).to.equal(value);
      expect(targetBalAfter - targetBalBefore).to.equal(value);
      expect(guardBalAfter).to.equal(guardBalBefore); // guard never holds funds
      expect(guardBalAfter).to.equal(0n);
      expect(await guard.nextNonce(agent.address)).to.equal(1n);
    });

    it("reverts if the wallet's executionGuard does not point at this guard (fails closed, not open)", async function () {
      const Guard2 = await ethers.getContractFactory("AgentExecutionGuard");
      const rogueGuard = await Guard2.deploy(registryAddress, policyRegistryAddress);
      await rogueGuard.waitForDeployment();
      // smartWallet is bound to `guard`, NOT `rogueGuard`

      await owner.sendTransaction({ to: smartWalletAddress, value: ethers.parseEther("1") });
      const value = ethers.parseEther("0.1");
      const d = await (async () => {
        const net = await ethers.provider.getNetwork();
        return { name: "AgentExecutionGuard", version: "1", chainId: net.chainId, verifyingContract: await rogueGuard.getAddress() };
      })();
      const sig = await agent.signTypedData(d, intentTypes, {
        agent: agent.address,
        wallet: smartWalletAddress,
        target: targetAddress,
        value,
        calldataHash: ethers.keccak256("0x"),
        nonce: 0n,
        deadline: FAR_DEADLINE,
        policyHash: ZERO_HASH,
      });

      await expect(
        rogueGuard.executeFromWallet(agent.address, smartWalletAddress, targetAddress, value, "0x", 0n, FAR_DEADLINE, ZERO_HASH, sig)
      ).to.be.revertedWithCustomError(rogueGuard, "WalletNotBoundToThisGuard");

      // and the wallet's balance must be untouched
      expect(await ethers.provider.getBalance(smartWalletAddress)).to.equal(ethers.parseEther("1"));
    });

    it("rejects any ETH attached directly to executeFromWallet (non-payable — value must come from the wallet)", async function () {
      await owner.sendTransaction({ to: smartWalletAddress, value: ethers.parseEther("1") });
      const value = ethers.parseEther("0.1");
      const sig = await signIntent(agent, agent.address, smartWalletAddress, value, 0n);

      await expect(
        guard.executeFromWallet(agent.address, smartWalletAddress, targetAddress, value, "0x", 0n, FAR_DEADLINE, ZERO_HASH, sig, {
          value: 1n,
        })
      ).to.be.reverted;
    });

    it("insufficient wallet balance fails closed and does not consume the nonce", async function () {
      // wallet holds less than the signed value
      await owner.sendTransaction({ to: smartWalletAddress, value: ethers.parseEther("0.05") });
      const value = ethers.parseEther("1");
      const sig = await signIntent(agent, agent.address, smartWalletAddress, value, 0n);

      await expect(
        guard.executeFromWallet(agent.address, smartWalletAddress, targetAddress, value, "0x", 0n, FAR_DEADLINE, ZERO_HASH, sig)
      ).to.be.revertedWithCustomError(guard, "ExecutionFailed");

      expect(await guard.nextNonce(agent.address)).to.equal(0n);
    });
  });

  describe("ERC-1271 agent identity (contract/TEE-signer stand-in)", function () {
    it("a contract agent can register in AgentRegistry and sign a valid execution intent", async function () {
      const RealRegistry = await ethers.getContractFactory("AgentRegistry");
      const realRegistry = await RealRegistry.deploy();
      await realRegistry.waitForDeployment();
      const realRegistryAddress = await realRegistry.getAddress();

      const RealPolicyRegistry = await ethers.getContractFactory("PolicyRegistry");
      const realPolicyRegistry = await RealPolicyRegistry.deploy();
      await realPolicyRegistry.waitForDeployment();

      const RealGuard = await ethers.getContractFactory("AgentExecutionGuard");
      const realGuard = await RealGuard.deploy(realRegistryAddress, await realPolicyRegistry.getAddress());
      await realGuard.waitForDeployment();
      const realGuardAddress = await realGuard.getAddress();

      // The "agent" identity is a contract; an underlying EOA key signs,
      // the contract's isValidSignature vouches for it (AA/TEE stand-in).
      const underlyingKey = ethers.Wallet.createRandom().connect(ethers.provider);
      const MockERC1271Owner = await ethers.getContractFactory("MockERC1271Owner");
      const contractAgent = await MockERC1271Owner.deploy(underlyingKey.address);
      await contractAgent.waitForDeployment();
      const contractAgentAddress = await contractAgent.getAddress();

      const smartWallet = await deploySmartWallet(owner.address, realGuardAddress, contractAgentAddress);
      await fundSmartWallet(smartWallet, ethers.parseEther("1"));
      const smartWalletAddress = await smartWallet.getAddress();

      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("contract-agent-v1"));
      const net = await ethers.provider.getNetwork();
      const regDomain = { name: "AgentRegistry", version: "1", chainId: net.chainId, verifyingContract: realRegistryAddress };
      const regTypes = {
        AgentRegistration: [
          { name: "agent", type: "address" },
          { name: "owner", type: "address" },
          { name: "metadataHash", type: "bytes32" },
        ],
      };
      const regSig = await underlyingKey.signTypedData(regDomain, regTypes, {
        agent: contractAgentAddress,
        owner: owner.address,
        metadataHash,
      });

      await realRegistry.register(contractAgentAddress, owner.address, metadataHash, regSig);
      await realRegistry.bindWallet(contractAgentAddress, smartWalletAddress);
      expect(await realRegistry.isActiveAgent(contractAgentAddress)).to.equal(true);

      // owner authorizes a native-transfer policy bound to the contract agent
      const RealTarget = await ethers.getContractFactory("RecordingTarget");
      const realTarget = await RealTarget.deploy();
      await realTarget.waitForDeployment();
      const realTargetAddress = await realTarget.getAddress();

      const salt = ethers.keccak256(ethers.toUtf8Bytes("salt-1"));
      const createTx = await realPolicyRegistry
        .connect(owner)
        .createPolicy(salt, contractAgentAddress, ethers.parseEther("1"), ethers.parseEther("1"), ethers.parseEther("1"), 0n, FAR_DEADLINE, [], [
          realTargetAddress,
        ]);
      await createTx.wait();
      const policyId = await realPolicyRegistry.computePolicyId(owner.address, salt);
      const policyHash = await realPolicyRegistry.policyHashOf(policyId);

      const intentDomain = { name: "AgentExecutionGuard", version: "1", chainId: net.chainId, verifyingContract: realGuardAddress };
      const value = ethers.parseEther("0.1");
      const intentSig = await underlyingKey.signTypedData(intentDomain, intentTypes, {
        agent: contractAgentAddress,
        wallet: smartWalletAddress,
        target: realTargetAddress,
        value,
        calldataHash: ethers.keccak256("0x"),
        nonce: 0n,
        deadline: FAR_DEADLINE,
        policyHash,
      });

      await expect(
        realGuard.executeFromWallet(contractAgentAddress, smartWalletAddress, realTargetAddress, value, "0x", 0n, FAR_DEADLINE, policyHash, intentSig)
      )
        .to.emit(realGuard, "IntentExecuted")
        .withArgs(contractAgentAddress, smartWalletAddress, realTargetAddress, 0n, policyHash);
    });

    it("rejects a signature from a key OTHER than the contract agent's registered signer", async function () {
      const RealRegistry = await ethers.getContractFactory("AgentRegistry");
      const realRegistry = await RealRegistry.deploy();
      await realRegistry.waitForDeployment();

      const legitKey = ethers.Wallet.createRandom().connect(ethers.provider);
      const attackerKey = ethers.Wallet.createRandom().connect(ethers.provider);
      const MockERC1271Owner = await ethers.getContractFactory("MockERC1271Owner");
      const contractAgent = await MockERC1271Owner.deploy(legitKey.address);
      await contractAgent.waitForDeployment();
      const contractAgentAddress = await contractAgent.getAddress();

      const net = await ethers.provider.getNetwork();
      const regDomain = { name: "AgentRegistry", version: "1", chainId: net.chainId, verifyingContract: await realRegistry.getAddress() };
      const regTypes = {
        AgentRegistration: [
          { name: "agent", type: "address" },
          { name: "owner", type: "address" },
          { name: "metadataHash", type: "bytes32" },
        ],
      };
      const metadataHash = ethers.ZeroHash;
      // signed by the WRONG key
      const badSig = await attackerKey.signTypedData(regDomain, regTypes, {
        agent: contractAgentAddress,
        owner: owner.address,
        metadataHash,
      });

      await expect(realRegistry.register(contractAgentAddress, owner.address, metadataHash, badSig)).to.be.revertedWithCustomError(
        realRegistry,
        "InvalidSignature"
      );
    });
  });
});
