import { expect } from "chai";
import { ethers } from "hardhat";
import { deploySmartWallet, fundSmartWallet } from "./smartWalletTestHelpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Remediation gate:
 *
 * 1. Policy ownership binding:
 *    policyHash must belong to the same agent and policy owner must match
 *    AgentRegistry.ownerOf(agent).
 *
 * 2. Execution boundary:
 *    AgentExecutionGuard MUST NOT receive msg.value.
 *    ETH is held by AgentSmartWallet and forwarded by the Guard after
 *    authorization succeeds.
 *
 * 3. Intent value binding:
 *    value is committed into the EIP-712 signature. Rewriting value invalidates
 *    the signature.
 */
describe("Remediation gate: SmartWallet execution + policy ownership binding", function () {
  let agentRegistry: any;
  let agentRegistryAddress: string;
  let policyRegistry: any;
  let policyRegistryAddress: string;
  let guard: any;
  let guardAddress: string;
  let target: any;
  let targetAddress: string;

  let owner: HardhatEthersSigner;
  let walletA: any;
  let walletB: any;
  let agentA: ReturnType<typeof ethers.Wallet.createRandom>;
  let agentB: ReturnType<typeof ethers.Wallet.createRandom>;

  let policyIdA: string;
  let policyIdB: string;
  let policyHashA: string;
  let policyHashB: string;

  const FAR_DEADLINE = 4102444800n;

  const registrationTypes = {
    AgentRegistration: [
      { name: "agent", type: "address" },
      { name: "owner", type: "address" },
      { name: "metadataHash", type: "bytes32" },
    ],
  };

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

  async function registerAgent(agentWallet: any, ownerAddr: string) {
    const net = await ethers.provider.getNetwork();

    const domain = {
      name: "AgentRegistry",
      version: "1",
      chainId: net.chainId,
      verifyingContract: agentRegistryAddress,
    };

    const metadataHash = ethers.keccak256(
      ethers.toUtf8Bytes("config")
    );

    const sig = await agentWallet.signTypedData(domain, registrationTypes, {
      agent: agentWallet.address,
      owner: ownerAddr,
      metadataHash,
    });

    await agentRegistry.register(
      agentWallet.address,
      ownerAddr,
      metadataHash,
      sig
    );
  }

  async function createPolicyFor(agentAddr: string, salt: string) {
    const tx = await policyRegistry
      .connect(owner)
      .createPolicy(
        salt,
        agentAddr,
        ethers.parseEther("10"),
        ethers.parseEther("100"),
        ethers.parseEther("50"),
        0n,
        FAR_DEADLINE,
        [],
        [targetAddress]
      );

    await tx.wait();

    const policyId = await policyRegistry.computePolicyId(
      owner.address,
      salt
    );

    const policyHash = await policyRegistry.policyHashOf(policyId);

    return { policyId, policyHash };
  }

  async function intentDomain() {
    const net = await ethers.provider.getNetwork();

    return {
      name: "AgentExecutionGuard",
      version: "1",
      chainId: net.chainId,
      verifyingContract: guardAddress,
    };
  }

  async function signIntent(
    signerWallet: any,
    params: {
      agent: string;
      wallet: string;
      target: string;
      value: bigint;
      data: string;
      nonce: bigint;
      deadline: bigint;
      policyHash: string;
    }
  ) {
    const d = await intentDomain();
    const calldataHash = ethers.keccak256(params.data);

    const value = {
      agent: params.agent,
      wallet: params.wallet,
      target: params.target,
      value: params.value,
      calldataHash,
      nonce: params.nonce,
      deadline: params.deadline,
      policyHash: params.policyHash,
    };

    const digest = ethers.TypedDataEncoder.hash(
      d,
      intentTypes,
      value
    );

    const signature = signerWallet.signingKey.sign(digest);

    return ethers.Signature.from(signature).serialized;
  }

  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    agentA = ethers.Wallet.createRandom().connect(ethers.provider);
    agentB = ethers.Wallet.createRandom().connect(ethers.provider);

    const Registry = await ethers.getContractFactory("AgentRegistry");
    agentRegistry = await Registry.deploy();
    await agentRegistry.waitForDeployment();

    agentRegistryAddress = await agentRegistry.getAddress();

    await registerAgent(agentA, owner.address);
    await registerAgent(agentB, owner.address);

    const PolicyRegistry = await ethers.getContractFactory("PolicyRegistry");
    policyRegistry = await PolicyRegistry.deploy();
    await policyRegistry.waitForDeployment();

    policyRegistryAddress = await policyRegistry.getAddress();

    const Guard = await ethers.getContractFactory("AgentExecutionGuard");
    guard = await Guard.deploy(
      agentRegistryAddress,
      policyRegistryAddress
    );
    await guard.waitForDeployment();

    guardAddress = await guard.getAddress();

    /*
     * SmartWallets are deployed AFTER the Guard because the wallet stores
     * the Guard address as its only execution authority.
     */
    walletA = await deploySmartWallet(
      owner.address,
      guardAddress,
      agentA.address
    );
    await agentRegistry.bindWallet(agentA.address, await walletA.getAddress());

    walletB = await deploySmartWallet(
      owner.address,
      guardAddress,
      agentB.address
    );
    await agentRegistry.bindWallet(agentB.address, await walletB.getAddress());

    const Target = await ethers.getContractFactory("RecordingTarget");
    target = await Target.deploy();
    await target.waitForDeployment();

    targetAddress = await target.getAddress();

    const resA = await createPolicyFor(
      agentA.address,
      ethers.keccak256(ethers.toUtf8Bytes("policy-A"))
    );

    policyIdA = resA.policyId;
    policyHashA = resA.policyHash;

    const resB = await createPolicyFor(
      agentB.address,
      ethers.keccak256(ethers.toUtf8Bytes("policy-B"))
    );

    policyIdB = resB.policyId;
    policyHashB = resB.policyHash;
  });

  describe(
    "FIX 2 � policy ownership binding (real AgentRegistry + real PolicyRegistry)",
    function () {
      it("Agent A + Policy A => PASS", async function () {
        const walletAddress = await walletA.getAddress();

        const params = {
          agent: agentA.address,
          wallet: walletAddress,
          target: targetAddress,
          value: 0n,
          data: "0x",
          nonce: 0n,
          deadline: FAR_DEADLINE,
          policyHash: policyHashA,
        };

        const sig = await signIntent(agentA, params);

        await guard.execute(
          params.agent,
          params.wallet,
          params.target,
          params.value,
          params.data,
          params.nonce,
          params.deadline,
          params.policyHash,
          sig
        );

        expect(
          await guard.nextNonce(agentA.address)
        ).to.equal(1n);
      });

      it("Agent A + Policy B => REVERT", async function () {
        const walletAddress = await walletA.getAddress();

        const params = {
          agent: agentA.address,
          wallet: walletAddress,
          target: targetAddress,
          value: 0n,
          data: "0x",
          nonce: 0n,
          deadline: FAR_DEADLINE,
          policyHash: policyHashB,
        };

        const sig = await signIntent(agentA, params);

        await expect(
          guard.execute(
            params.agent,
            params.wallet,
            params.target,
            params.value,
            params.data,
            params.nonce,
            params.deadline,
            params.policyHash,
            sig
          )
        )
          .to.be.revertedWithCustomError(
            guard,
            "PolicyAgentMismatch"
          )
          .withArgs(
            policyHashB,
            agentA.address,
            agentB.address
          );

        expect(
          await guard.nextNonce(agentA.address)
        ).to.equal(0n);
      });

      it("Agent B + Policy A => REVERT", async function () {
        const walletAddress = await walletB.getAddress();

        const params = {
          agent: agentB.address,
          wallet: walletAddress,
          target: targetAddress,
          value: 0n,
          data: "0x",
          nonce: 0n,
          deadline: FAR_DEADLINE,
          policyHash: policyHashA,
        };

        const sig = await signIntent(agentB, params);

        await expect(
          guard.execute(
            params.agent,
            params.wallet,
            params.target,
            params.value,
            params.data,
            params.nonce,
            params.deadline,
            params.policyHash,
            sig
          )
        )
          .to.be.revertedWithCustomError(
            guard,
            "PolicyAgentMismatch"
          )
          .withArgs(
            policyHashA,
            agentB.address,
            agentA.address
          );

        expect(
          await guard.nextNonce(agentB.address)
        ).to.equal(0n);
      });

      it("a revoked policy is rejected even when the agent binding is otherwise correct", async function () {
        await policyRegistry
          .connect(owner)
          .revokePolicy(policyIdA);

        const walletAddress = await walletA.getAddress();

        const params = {
          agent: agentA.address,
          wallet: walletAddress,
          target: targetAddress,
          value: 0n,
          data: "0x",
          nonce: 0n,
          deadline: FAR_DEADLINE,
          policyHash: policyHashA,
        };

        const sig = await signIntent(agentA, params);

        await expect(
          guard.execute(
            params.agent,
            params.wallet,
            params.target,
            params.value,
            params.data,
            params.nonce,
            params.deadline,
            params.policyHash,
            sig
          )
        )
          .to.be.revertedWithCustomError(
            guard,
            "PolicyNotActive"
          )
          .withArgs(policyHashA);
      });

      it("an unknown policyHash is rejected, not silently treated as no policy", async function () {
        const fakeHash = ethers.keccak256(
          ethers.toUtf8Bytes("never-created")
        );

        const walletAddress = await walletA.getAddress();

        const params = {
          agent: agentA.address,
          wallet: walletAddress,
          target: targetAddress,
          value: 0n,
          data: "0x",
          nonce: 0n,
          deadline: FAR_DEADLINE,
          policyHash: fakeHash,
        };

        const sig = await signIntent(agentA, params);

        await expect(
          guard.execute(
            params.agent,
            params.wallet,
            params.target,
            params.value,
            params.data,
            params.nonce,
            params.deadline,
            params.policyHash,
            sig
          )
        )
          .to.be.revertedWithCustomError(
            guard,
            "PolicyAgentMismatch"
          )
          .withArgs(
            fakeHash,
            agentA.address,
            ethers.ZeroAddress
          );
      });
    }
  );

  describe(
    "FIX 1 � SmartWallet execution boundary + signed value binding",
    function () {
      async function signedIntent(
        agentWallet: any,
        value: bigint,
        nonce: bigint,
        policyHash: string
      ) {
        const walletAddress = await walletA.getAddress();

        const params = {
          agent: agentWallet.address,
          wallet: walletAddress,
          target: targetAddress,
          value,
          data: "0x",
          nonce,
          deadline: FAR_DEADLINE,
          policyHash,
        };

        const sig = await signIntent(agentWallet, params);

        return { params, sig };
      }

      it("Guard rejects direct ETH sent to it", async function () {
        await expect(
          owner.sendTransaction({
            to: guardAddress,
            value: ethers.parseEther("1"),
          })
        ).to.be.reverted;

        expect(
          await ethers.provider.getBalance(guardAddress)
        ).to.equal(0n);
      });

      it("rewriting signed value invalidates the intent signature", async function () {
        const signedValue = ethers.parseEther("2");

        const { params, sig } = await signedIntent(
          agentA,
          signedValue,
          0n,
          policyHashA
        );

        const modifiedValue = ethers.parseEther("1");

        await fundSmartWallet(
          walletA,
          modifiedValue
        );

        await expect(
          guard.execute(
            params.agent,
            params.wallet,
            params.target,
            modifiedValue,
            params.data,
            params.nonce,
            params.deadline,
            params.policyHash,
            sig
          )
        ).to.be.revertedWithCustomError(
          guard,
          "InvalidSignature"
        );

        expect(
          await guard.nextNonce(agentA.address)
        ).to.equal(0n);

        expect(
          await ethers.provider.getBalance(guardAddress)
        ).to.equal(0n);
      });

      it("a signed value above the policy maximum is rejected", async function () {
        const excessiveValue = ethers.parseEther("11");

        const { params, sig } = await signedIntent(
          agentA,
          excessiveValue,
          0n,
          policyHashA
        );

        await fundSmartWallet(
          walletA,
          excessiveValue
        );

        await expect(
          guard.execute(
            params.agent,
            params.wallet,
            params.target,
            params.value,
            params.data,
            params.nonce,
            params.deadline,
            params.policyHash,
            sig
          )
        ).to.be.revertedWithCustomError(
          guard,
          "MaxTxValueExceeded"
        );

        expect(
          await guard.nextNonce(agentA.address)
        ).to.equal(0n);
      });

      it("a consumed nonce cannot be replayed", async function () {
        const value = ethers.parseEther("1");

        const { params, sig } = await signedIntent(
          agentA,
          value,
          0n,
          policyHashA
        );

        await fundSmartWallet(walletA, value);

        await guard.executeFromWallet(
          params.agent,
          params.wallet,
          params.target,
          params.value,
          params.data,
          params.nonce,
          params.deadline,
          params.policyHash,
          sig
        );

        expect(
          await guard.nextNonce(agentA.address)
        ).to.equal(1n);

        await expect(
          guard.execute(
            params.agent,
            params.wallet,
            params.target,
            params.value,
            params.data,
            params.nonce,
            params.deadline,
            params.policyHash,
            sig
          )
        )
          .to.be.revertedWithCustomError(
            guard,
            "InvalidNonce"
          )
          .withArgs(0n, 1n);

        expect(
          await ethers.provider.getBalance(guardAddress)
        ).to.equal(0n);
      });

      it("value-matched execution spends SmartWallet funds and leaves zero ETH on Guard", async function () {
        const value = ethers.parseEther("0.5");

        const { params, sig } = await signedIntent(
          agentA,
          value,
          0n,
          policyHashA
        );

        await fundSmartWallet(walletA, value);

        const walletAddress = await walletA.getAddress();

        const walletBalanceBefore =
          await ethers.provider.getBalance(walletAddress);

        const targetBalanceBefore =
          await ethers.provider.getBalance(targetAddress);

        expect(walletBalanceBefore).to.equal(value);

        await guard.executeFromWallet(
          params.agent,
          params.wallet,
          params.target,
          params.value,
          params.data,
          params.nonce,
          params.deadline,
          params.policyHash,
          sig
        );

        expect(
          await ethers.provider.getBalance(targetAddress)
        ).to.equal(
          targetBalanceBefore + value
        );

        expect(
          await ethers.provider.getBalance(walletAddress)
        ).to.equal(0n);

        expect(
          await ethers.provider.getBalance(guardAddress)
        ).to.equal(0n);

        expect(
          await guard.nextNonce(agentA.address)
        ).to.equal(1n);
      });
    }
  );

  describe("both fixes combined", function () {
    it("a correctly funded value-matched intent still fails with the wrong agent policy", async function () {
      const value = ethers.parseEther("1");
      const walletAddress = await walletA.getAddress();

      const params = {
        agent: agentA.address,
        wallet: walletAddress,
        target: targetAddress,
        value,
        data: "0x",
        nonce: 0n,
        deadline: FAR_DEADLINE,
        policyHash: policyHashB,
      };

      const sig = await signIntent(agentA, params);

      await fundSmartWallet(walletA, value);

      await expect(
        guard.execute(
          params.agent,
          params.wallet,
          params.target,
          params.value,
          params.data,
          params.nonce,
          params.deadline,
          params.policyHash,
          sig
        )
      ).to.be.revertedWithCustomError(
        guard,
        "PolicyAgentMismatch"
      );

      expect(
        await ethers.provider.getBalance(guardAddress)
      ).to.equal(0n);

      expect(
        await guard.nextNonce(agentA.address)
      ).to.equal(0n);
    });
  });
});
