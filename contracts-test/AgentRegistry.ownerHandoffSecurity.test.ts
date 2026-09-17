import { expect } from "chai";
import { ethers } from "hardhat";

describe("P1 hostile review: owner / wallet / guardian handoff", function () {
  let registry: any;
  let wallet: any;
  let owner: any;
  let newOwner: any;
  let oldGuardian: any;
  let newGuardian: any;
  let agent: any;

  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("p1-owner-handoff"));
  const registrationTypes = {
    AgentRegistration: [
      { name: "agent", type: "address" },
      { name: "owner", type: "address" },
      { name: "metadataHash", type: "bytes32" },
    ],
  };

  beforeEach(async function () {
    [owner, newOwner, oldGuardian, newGuardian] = await ethers.getSigners();
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

    const Wallet = await ethers.getContractFactory("AgentSmartWallet");
    wallet = await Wallet.deploy(owner.address, owner.address, agent.address);
    await wallet.waitForDeployment();
    await registry.connect(owner).bindWallet(agent.address, await wallet.getAddress());
  });

  it("clears the previous owner's recovery guardian during ownership transfer", async function () {
    await registry.connect(owner).setRecoveryGuardian(agent.address, oldGuardian.address);
    expect((await registry.getAgent(agent.address)).recoveryAgent).to.equal(oldGuardian.address);

    await wallet.connect(owner).transferOwnership(newOwner.address);
    await registry.connect(owner).transferAgentOwnership(agent.address, newOwner.address);

    const record = await registry.getAgent(agent.address);
    expect(record.owner).to.equal(newOwner.address);
    expect(record.wallet).to.equal(await wallet.getAddress());
    expect(record.recoveryAgent).to.equal(ethers.ZeroAddress);
    expect(record.active).to.equal(false);

    await registry.connect(newOwner).reactivate(agent.address);
    await expect(registry.connect(oldGuardian).executeRecovery(agent.address))
      .to.be.revertedWithCustomError(registry, "NotRecoveryGuardian");
  });

  it("lets the new owner establish a fresh guardian after handoff", async function () {
    await registry.connect(owner).setRecoveryGuardian(agent.address, oldGuardian.address);
    await wallet.connect(owner).transferOwnership(newOwner.address);
    await registry.connect(owner).transferAgentOwnership(agent.address, newOwner.address);
    await registry.connect(newOwner).reactivate(agent.address);

    await registry.connect(newOwner).setRecoveryGuardian(agent.address, newGuardian.address);
    expect((await registry.getAgent(agent.address)).recoveryAgent).to.equal(newGuardian.address);

    await registry.connect(newGuardian).executeRecovery(agent.address);
    expect(await registry.isActiveAgent(agent.address)).to.equal(false);
  });

  it("keeps the old owner unable to recover wallet custody after handoff", async function () {
    await wallet.connect(owner).transferOwnership(newOwner.address);
    await registry.connect(owner).transferAgentOwnership(agent.address, newOwner.address);
    await registry.connect(newOwner).reactivate(agent.address);

    await expect(wallet.connect(owner).recoverNative(owner.address, 0n))
      .to.be.revertedWithCustomError(wallet, "NotOwner");

    await registry.connect(newOwner).setRecoveryGuardian(agent.address, newGuardian.address);
    expect(await wallet.owner()).to.equal(newOwner.address);
    expect(await registry.ownerOf(agent.address)).to.equal(newOwner.address);
    expect(await registry.isActiveAgent(agent.address)).to.equal(true);
  });
});
