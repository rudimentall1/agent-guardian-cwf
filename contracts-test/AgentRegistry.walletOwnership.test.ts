import { expect } from "chai";
import { ethers } from "hardhat";


describe("AgentRegistry: canonical wallet ownership lifecycle", function () {
  let registry: any;
  let owner: any;
  let newOwner: any;
  let agent: any;
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("wallet-transfer-lifecycle"));

  const registrationTypes = {
    AgentRegistration: [
      { name: "agent", type: "address" },
      { name: "owner", type: "address" },
      { name: "metadataHash", type: "bytes32" },
    ],
  };

  beforeEach(async function () {
    [owner, newOwner] = await ethers.getSigners();
    agent = ethers.Wallet.createRandom().connect(ethers.provider);

    const Registry = await ethers.getContractFactory("AgentRegistry");
    registry = await Registry.deploy();
    await registry.waitForDeployment();

    const network = await ethers.provider.getNetwork();
    const signature = await agent.signTypedData(
      {
        name: "AgentRegistry",
        version: "1",
        chainId: network.chainId,
        verifyingContract: await registry.getAddress(),
      },
      registrationTypes,
      { agent: agent.address, owner: owner.address, metadataHash }
    );
    await registry.register(agent.address, owner.address, metadataHash, signature);
  });

  it("rejects registry ownership transfer while the canonical wallet remains with the old owner", async function () {
    const Wallet = await ethers.getContractFactory("AgentSmartWallet");
    const wallet = await Wallet.deploy(owner.address, owner.address, agent.address);
    await wallet.waitForDeployment();
    const walletAddress = await wallet.getAddress();
    await registry.connect(owner).bindWallet(agent.address, walletAddress);

    await expect(
      registry.connect(owner).transferAgentOwnership(agent.address, newOwner.address)
    )
      .to.be.revertedWithCustomError(registry, "WalletOwnershipRequiredForTransfer")
      .withArgs(walletAddress, owner.address, newOwner.address);

    expect(await registry.ownerOf(agent.address)).to.equal(owner.address);
    expect(await registry.isActiveAgent(agent.address)).to.equal(true);
  });

  it("permits a safe two-step handoff and leaves registry owner and wallet owner aligned", async function () {
    const Wallet = await ethers.getContractFactory("AgentSmartWallet");
    const wallet = await Wallet.deploy(owner.address, owner.address, agent.address);
    await wallet.waitForDeployment();
    const walletAddress = await wallet.getAddress();
    await registry.connect(owner).bindWallet(agent.address, walletAddress);

    // Custody moves first.
    await wallet.connect(owner).transferOwnership(newOwner.address);

    // Registry ownership can now move without creating an inconsistent state.
    await expect(registry.connect(owner).transferAgentOwnership(agent.address, newOwner.address))
      .to.emit(registry, "AgentOwnershipTransferred")
      .withArgs(agent.address, owner.address, newOwner.address);

    expect(await registry.ownerOf(agent.address)).to.equal(newOwner.address);
    expect(await wallet.owner()).to.equal(newOwner.address);
    expect(await registry.isActiveAgent(agent.address)).to.equal(false);

    await registry.connect(newOwner).reactivate(agent.address);
    expect(await registry.isActiveAgent(agent.address)).to.equal(true);
  });

  it("cannot bypass the handoff requirement by calling through an inactive agent", async function () {
    const Wallet = await ethers.getContractFactory("AgentSmartWallet");
    const wallet = await Wallet.deploy(owner.address, owner.address, agent.address);
    await wallet.waitForDeployment();
    await registry.connect(owner).bindWallet(agent.address, await wallet.getAddress());
    await registry.connect(owner).deactivate(agent.address);

    await expect(
      registry.connect(owner).transferAgentOwnership(agent.address, newOwner.address)
    ).to.be.revertedWithCustomError(registry, "WalletOwnershipRequiredForTransfer");
  });
});
