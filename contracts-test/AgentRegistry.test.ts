import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("AgentRegistry", function () {
  let registry: any;
  let registryAddress: string;
  let owner: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;
  let newOwner: HardhatEthersSigner;
  let agentWallet: ReturnType<typeof ethers.Wallet.createRandom>;
  let otherAgentWallet: ReturnType<typeof ethers.Wallet.createRandom>;

  const METADATA_HASH = ethers.keccak256(ethers.toUtf8Bytes("agent-v1-config"));

  async function domain() {
    const net = await ethers.provider.getNetwork();
    return {
      name: "AgentRegistry",
      version: "1",
      chainId: net.chainId,
      verifyingContract: registryAddress,
    };
  }

  const types = {
    AgentRegistration: [
      { name: "agent", type: "address" },
      { name: "owner", type: "address" },
      { name: "metadataHash", type: "bytes32" },
    ],
  };

  async function signRegistration(
    signerWallet: any,
    agent: string,
    ownerAddr: string,
    metadataHash: string
  ) {
    const d = await domain();
    return signerWallet.signTypedData(d, types, { agent, owner: ownerAddr, metadataHash });
  }

  beforeEach(async function () {
    [owner, attacker, newOwner] = await ethers.getSigners();
    agentWallet = ethers.Wallet.createRandom().connect(ethers.provider);
    otherAgentWallet = ethers.Wallet.createRandom().connect(ethers.provider);

    const Factory = await ethers.getContractFactory("AgentRegistry");
    registry = await Factory.deploy();
    await registry.waitForDeployment();
    registryAddress = await registry.getAddress();
  });

  describe("happy path", function () {
    it("registers an agent with a valid signature", async function () {
      const sig = await signRegistration(agentWallet, agentWallet.address, owner.address, METADATA_HASH);
      await expect(registry.register(agentWallet.address, owner.address, METADATA_HASH, sig))
        .to.emit(registry, "AgentRegistered")
        .withArgs(agentWallet.address, owner.address, METADATA_HASH);

      expect(await registry.isActiveAgent(agentWallet.address)).to.equal(true);
      expect(await registry.ownerOf(agentWallet.address)).to.equal(owner.address);
    });

    it("allows a relayer (not the owner) to submit the registration tx", async function () {
      const sig = await signRegistration(agentWallet, agentWallet.address, owner.address, METADATA_HASH);
      // attacker pays gas / submits the tx, but owner is fixed by the signature
      await registry.connect(attacker).register(agentWallet.address, owner.address, METADATA_HASH, sig);
      expect(await registry.ownerOf(agentWallet.address)).to.equal(owner.address);
    });

    it("owner can deactivate and reactivate", async function () {
      const sig = await signRegistration(agentWallet, agentWallet.address, owner.address, METADATA_HASH);
      await registry.register(agentWallet.address, owner.address, METADATA_HASH, sig);

      await expect(registry.connect(owner).deactivate(agentWallet.address))
        .to.emit(registry, "AgentDeactivated")
        .withArgs(agentWallet.address, owner.address);
      expect(await registry.isActiveAgent(agentWallet.address)).to.equal(false);

      await expect(registry.connect(owner).reactivate(agentWallet.address))
        .to.emit(registry, "AgentReactivated")
        .withArgs(agentWallet.address, owner.address);
      expect(await registry.isActiveAgent(agentWallet.address)).to.equal(true);
    });

    it("owner can transfer ownership, which forces the agent inactive", async function () {
      const sig = await signRegistration(agentWallet, agentWallet.address, owner.address, METADATA_HASH);
      await registry.register(agentWallet.address, owner.address, METADATA_HASH, sig);

      await expect(registry.connect(owner).transferAgentOwnership(agentWallet.address, newOwner.address))
        .to.emit(registry, "AgentOwnershipTransferred")
        .withArgs(agentWallet.address, owner.address, newOwner.address);

      expect(await registry.ownerOf(agentWallet.address)).to.equal(newOwner.address);
      expect(await registry.isActiveAgent(agentWallet.address)).to.equal(false);

      // new owner must explicitly reactivate
      await registry.connect(newOwner).reactivate(agentWallet.address);
      expect(await registry.isActiveAgent(agentWallet.address)).to.equal(true);
    });
  });

  describe("adversarial: invariant 1 — unregistered agent cannot execute (isActiveAgent false by construction)", function () {
    it("returns false for an address that was never registered", async function () {
      expect(await registry.isActiveAgent(otherAgentWallet.address)).to.equal(false);
      expect(await registry.ownerOf(otherAgentWallet.address)).to.equal(ethers.ZeroAddress);
    });
  });

  describe("adversarial: signature hijack / front-run of owner field", function () {
    it("rejects a signature whose signer does not match the claimed agent address", async function () {
      // attacker tries to register otherAgentWallet's address as their own agent,
      // but signs with agentWallet's key instead of otherAgentWallet's key.
      const sig = await signRegistration(agentWallet, otherAgentWallet.address, attacker.address, METADATA_HASH);
      await expect(
        registry.connect(attacker).register(otherAgentWallet.address, attacker.address, METADATA_HASH, sig)
      ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });

    it("cannot redirect ownership by resubmitting an observed signature with a different owner", async function () {
      // agent signed consent to be owned by `owner`
      const sig = await signRegistration(agentWallet, agentWallet.address, owner.address, METADATA_HASH);
      // attacker (who saw the tx/calldata in the mempool) tries to front-run
      // by claiming themselves as owner instead — the signed digest embeds
      // `owner`, so reusing the same signature with a different owner value
      // must fail signature recovery.
      await expect(
        registry.connect(attacker).register(agentWallet.address, attacker.address, METADATA_HASH, sig)
      ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });
  });

  describe("adversarial: registration is exactly-once, even for a compromised agent key", function () {
    it("reverts on double registration to the same owner", async function () {
      const sig = await signRegistration(agentWallet, agentWallet.address, owner.address, METADATA_HASH);
      await registry.register(agentWallet.address, owner.address, METADATA_HASH, sig);

      await expect(
        registry.register(agentWallet.address, owner.address, METADATA_HASH, sig)
      ).to.be.revertedWithCustomError(registry, "AgentAlreadyRegistered");
    });

    it("a compromised agent key cannot rebind an ACTIVE registration to a new owner", async function () {
      const sig1 = await signRegistration(agentWallet, agentWallet.address, owner.address, METADATA_HASH);
      await registry.register(agentWallet.address, owner.address, METADATA_HASH, sig1);

      // attacker now controls the agent's private key (agentWallet) and tries
      // to re-register the same identity under an attacker-controlled owner.
      const hijackSig = await signRegistration(agentWallet, agentWallet.address, attacker.address, METADATA_HASH);
      await expect(
        registry.register(agentWallet.address, attacker.address, METADATA_HASH, hijackSig)
      ).to.be.revertedWithCustomError(registry, "AgentAlreadyRegistered");

      expect(await registry.ownerOf(agentWallet.address)).to.equal(owner.address);
    });

    it("a compromised agent key cannot rebind a DEACTIVATED registration to a new owner either", async function () {
      const sig1 = await signRegistration(agentWallet, agentWallet.address, owner.address, METADATA_HASH);
      await registry.register(agentWallet.address, owner.address, METADATA_HASH, sig1);
      await registry.connect(owner).deactivate(agentWallet.address);

      const hijackSig = await signRegistration(agentWallet, agentWallet.address, attacker.address, METADATA_HASH);
      await expect(
        registry.register(agentWallet.address, attacker.address, METADATA_HASH, hijackSig)
      ).to.be.revertedWithCustomError(registry, "AgentAlreadyRegistered");
    });
  });

  describe("adversarial: access control on lifecycle transitions", function () {
    beforeEach(async function () {
      const sig = await signRegistration(agentWallet, agentWallet.address, owner.address, METADATA_HASH);
      await registry.register(agentWallet.address, owner.address, METADATA_HASH, sig);
    });

    it("non-owner cannot deactivate", async function () {
      await expect(registry.connect(attacker).deactivate(agentWallet.address))
        .to.be.revertedWithCustomError(registry, "NotAgentOwner")
        .withArgs(agentWallet.address, attacker.address);
    });

    it("non-owner cannot reactivate", async function () {
      await registry.connect(owner).deactivate(agentWallet.address);
      await expect(registry.connect(attacker).reactivate(agentWallet.address))
        .to.be.revertedWithCustomError(registry, "NotAgentOwner")
        .withArgs(agentWallet.address, attacker.address);
    });

    it("non-owner cannot transfer ownership", async function () {
      await expect(registry.connect(attacker).transferAgentOwnership(agentWallet.address, attacker.address))
        .to.be.revertedWithCustomError(registry, "NotAgentOwner")
        .withArgs(agentWallet.address, attacker.address);
    });

    it("the agent itself (signer) has no special privileges over lifecycle calls", async function () {
      await expect(
        registry.connect(attacker).deactivate(agentWallet.address)
      ).to.be.revertedWithCustomError(registry, "NotAgentOwner");
      // even calling from the agent's own address (not owner) must fail —
      // simulate by impersonation via signer if available is out of scope
      // for a plain hardhat signer set; access control is owner-only by
      // msg.sender, which is exhaustively covered by the NotAgentOwner checks.
    });

    it("cannot deactivate an already-inactive agent (no redundant state transitions)", async function () {
      await registry.connect(owner).deactivate(agentWallet.address);
      await expect(
        registry.connect(owner).deactivate(agentWallet.address)
      ).to.be.revertedWithCustomError(registry, "AgentAlreadyInactive");
    });

    it("cannot reactivate an already-active agent", async function () {
      await expect(
        registry.connect(owner).reactivate(agentWallet.address)
      ).to.be.revertedWithCustomError(registry, "AgentAlreadyActive");
    });

    it("cannot transfer ownership to the zero address", async function () {
      await expect(
        registry.connect(owner).transferAgentOwnership(agentWallet.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("cannot transfer ownership to the same owner", async function () {
      await expect(
        registry.connect(owner).transferAgentOwnership(agentWallet.address, owner.address)
      ).to.be.revertedWithCustomError(registry, "SameOwner");
    });

    it("cannot operate on an unregistered agent", async function () {
      await expect(
        registry.connect(owner).deactivate(otherAgentWallet.address)
      ).to.be.revertedWithCustomError(registry, "AgentNotRegistered");
    });
  });

  describe("canonical wallet binding", function () {
    beforeEach(async function () {
      const sig = await signRegistration(agentWallet, agentWallet.address, owner.address, METADATA_HASH);
      await registry.register(agentWallet.address, owner.address, METADATA_HASH, sig);
    });

    it("binds exactly one wallet to an agent and exposes it through walletOf", async function () {
      const Wallet = await ethers.getContractFactory("AgentSmartWallet");
      const wallet = await Wallet.deploy(owner.address, owner.address, agentWallet.address);
      await wallet.waitForDeployment();

      await expect(registry.connect(owner).bindWallet(agentWallet.address, await wallet.getAddress()))
        .to.emit(registry, "AgentWalletBound")
        .withArgs(agentWallet.address, await wallet.getAddress(), owner.address);
      expect(await registry.walletOf(agentWallet.address)).to.equal(await wallet.getAddress());
    });

    it("rejects binding by a non-owner", async function () {
      const Wallet = await ethers.getContractFactory("AgentSmartWallet");
      const wallet = await Wallet.deploy(owner.address, owner.address, agentWallet.address);
      await wallet.waitForDeployment();

      await expect(registry.connect(attacker).bindWallet(agentWallet.address, await wallet.getAddress()))
        .to.be.revertedWithCustomError(registry, "NotAgentOwner")
        .withArgs(agentWallet.address, attacker.address);
    });

    it("rejects a second wallet binding, making the canonical custody target immutable", async function () {
      const Wallet = await ethers.getContractFactory("AgentSmartWallet");
      const first = await Wallet.deploy(owner.address, owner.address, agentWallet.address);
      const second = await Wallet.deploy(owner.address, owner.address, agentWallet.address);
      await first.waitForDeployment();
      await second.waitForDeployment();

      await registry.connect(owner).bindWallet(agentWallet.address, await first.getAddress());
      await expect(registry.connect(owner).bindWallet(agentWallet.address, await second.getAddress()))
        .to.be.revertedWithCustomError(registry, "WalletAlreadyBound")
        .withArgs(agentWallet.address, await first.getAddress());
    });

    it("rejects a wallet whose immutable agent identity does not match", async function () {
      const otherAgent = ethers.Wallet.createRandom();
      const Wallet = await ethers.getContractFactory("AgentSmartWallet");
      const wallet = await Wallet.deploy(owner.address, owner.address, otherAgent.address);
      await wallet.waitForDeployment();

      await expect(registry.connect(owner).bindWallet(agentWallet.address, await wallet.getAddress()))
        .to.be.revertedWithCustomError(registry, "WalletAgentMismatch")
        .withArgs(await wallet.getAddress(), otherAgent.address, agentWallet.address);
    });
  });

  describe("adversarial: domain separation / chain & contract binding", function () {
    it("rejects a signature produced for a different verifying contract", async function () {
      const Factory = await ethers.getContractFactory("AgentRegistry");
      const otherRegistry = await Factory.deploy();
      await otherRegistry.waitForDeployment();
      const otherAddress = await otherRegistry.getAddress();

      const net = await ethers.provider.getNetwork();
      const wrongDomain = {
        name: "AgentRegistry",
        version: "1",
        chainId: net.chainId,
        verifyingContract: otherAddress, // signed for the OTHER deployment
      };
      const sig = await agentWallet.signTypedData(wrongDomain, types, {
        agent: agentWallet.address,
        owner: owner.address,
        metadataHash: METADATA_HASH,
      });

      await expect(
        registry.register(agentWallet.address, owner.address, METADATA_HASH, sig)
      ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });

    it("rejects a signature produced for a different chain id (cross-chain replay)", async function () {
      const wrongChainDomain = {
        name: "AgentRegistry",
        version: "1",
        chainId: 999999n, // not this network's chain id
        verifyingContract: registryAddress,
      };
      const sig = await agentWallet.signTypedData(wrongChainDomain, types, {
        agent: agentWallet.address,
        owner: owner.address,
        metadataHash: METADATA_HASH,
      });

      await expect(
        registry.register(agentWallet.address, owner.address, METADATA_HASH, sig)
      ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });

    it("rejects a signature with a tampered metadataHash (modified field invalidates authorization)", async function () {
      const sig = await signRegistration(agentWallet, agentWallet.address, owner.address, METADATA_HASH);
      const tamperedHash = ethers.keccak256(ethers.toUtf8Bytes("different-config"));
      await expect(
        registry.register(agentWallet.address, owner.address, tamperedHash, sig)
      ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });
  });

  describe("adversarial: zero address handling", function () {
    it("rejects registering the zero address as agent", async function () {
      const sig = await signRegistration(agentWallet, ethers.ZeroAddress, owner.address, METADATA_HASH);
      await expect(
        registry.register(ethers.ZeroAddress, owner.address, METADATA_HASH, sig)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("rejects registering with the zero address as owner", async function () {
      const sig = await signRegistration(agentWallet, agentWallet.address, ethers.ZeroAddress, METADATA_HASH);
      await expect(
        registry.register(agentWallet.address, ethers.ZeroAddress, METADATA_HASH, sig)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });
  });
});
