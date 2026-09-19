import { expect } from "chai";
import { ethers } from "hardhat";

describe("Gate 6: agent recovery guardian", function () {
  it("owner can configure recovery guardian and guardian can emergency disable agent", async function () {
    const [owner, guardian] = await ethers.getSigners();

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    const registry = await AgentRegistry.deploy();
    await registry.waitForDeployment();

    const agent = ethers.Wallet.createRandom();

    const metadataHash = ethers.keccak256(
      ethers.toUtf8Bytes("agent")
    );

    const domain = {
      name: "AgentRegistry",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await registry.getAddress(),
    };

    const types = {
      AgentRegistration: [
        { name: "agent", type: "address" },
        { name: "owner", type: "address" },
        { name: "metadataHash", type: "bytes32" },
      ],
    };

    const signature = await agent.signTypedData(
      domain,
      types,
      {
        agent: agent.address,
        owner: owner.address,
        metadataHash,
      }
    );

    await registry.register(
      agent.address,
      owner.address,
      metadataHash,
      signature
    );

    await registry
      .connect(owner)
      .setRecoveryGuardian(agent.address, guardian.address);

    expect(
      (await registry.getAgent(agent.address)).recoveryAgent
    ).to.equal(guardian.address);

    await registry
      .connect(guardian)
      .executeRecovery(agent.address);

    expect(
      await registry.isActiveAgent(agent.address)
    ).to.equal(false);
  });


  it("does not resurrect the old guardian across an A-to-B-to-A ownership round trip", async function () {
    const [ownerA, ownerB, oldGuardian, newGuardian] = await ethers.getSigners();

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    const registry = await AgentRegistry.deploy();
    await registry.waitForDeployment();

    const agent = ethers.Wallet.createRandom();
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("agent"));

    const domain = {
      name: "AgentRegistry",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await registry.getAddress(),
    };
    const types = {
      AgentRegistration: [
        { name: "agent", type: "address" },
        { name: "owner", type: "address" },
        { name: "metadataHash", type: "bytes32" },
      ],
    };

    const signature = await agent.signTypedData(domain, types, {
      agent: agent.address,
      owner: ownerA.address,
      metadataHash,
    });

    await registry.register(agent.address, ownerA.address, metadataHash, signature);
    await registry.connect(ownerA).setRecoveryGuardian(agent.address, oldGuardian.address);

    await registry.connect(ownerA).transferAgentOwnership(agent.address, ownerB.address);
    expect((await registry.getAgent(agent.address)).recoveryAgent).to.equal(ethers.ZeroAddress);
    expect(await registry.isActiveAgent(agent.address)).to.equal(false);

    await registry.connect(ownerB).reactivate(agent.address);
    await expect(
      registry.connect(oldGuardian).executeRecovery(agent.address)
    ).to.be.revertedWithCustomError(registry, "NotRecoveryGuardian");

    await registry.connect(ownerB).setRecoveryGuardian(agent.address, newGuardian.address);
    await registry.connect(ownerB).transferAgentOwnership(agent.address, ownerA.address);
    expect((await registry.getAgent(agent.address)).recoveryAgent).to.equal(ethers.ZeroAddress);

    await registry.connect(ownerA).reactivate(agent.address);
    await expect(
      registry.connect(oldGuardian).executeRecovery(agent.address)
    ).to.be.revertedWithCustomError(registry, "NotRecoveryGuardian");

    await registry.connect(ownerA).setRecoveryGuardian(agent.address, newGuardian.address);
    await registry.connect(newGuardian).executeRecovery(agent.address);
    expect(await registry.isActiveAgent(agent.address)).to.equal(false);
  });

  it("a contract recovery guardian follows its current ERC-1271 controller, not a stale signer", async function () {
    const [owner, guardianSigner, replacementSigner] = await ethers.getSigners();

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    const registry = await AgentRegistry.deploy();
    await registry.waitForDeployment();

    const Guardian = await ethers.getContractFactory("MockERC1271Owner");
    const guardian = await Guardian.deploy(guardianSigner.address);
    await guardian.waitForDeployment();

    const agent = ethers.Wallet.createRandom();
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("agent"));
    const domain = {
      name: "AgentRegistry",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await registry.getAddress(),
    };
    const types = {
      AgentRegistration: [
        { name: "agent", type: "address" },
        { name: "owner", type: "address" },
        { name: "metadataHash", type: "bytes32" },
      ],
    };

    const signature = await agent.signTypedData(domain, types, {
      agent: agent.address,
      owner: owner.address,
      metadataHash,
    });
    await registry.register(agent.address, owner.address, metadataHash, signature);
    await registry.connect(owner).setRecoveryGuardian(agent.address, await guardian.getAddress());

    await guardian.connect(owner).setSigner(replacementSigner.address);

    await expect(
      guardian.connect(guardianSigner).execute(
        await registry.getAddress(),
        registry.interface.encodeFunctionData("executeRecovery", [agent.address])
      )
    ).to.be.reverted;

    await guardian.connect(replacementSigner).execute(
      await registry.getAddress(),
      registry.interface.encodeFunctionData("executeRecovery", [agent.address])
    );
    expect(await registry.isActiveAgent(agent.address)).to.equal(false);
  });

  it("non guardian cannot execute recovery", async function () {
    const [owner, attacker] = await ethers.getSigners();

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    const registry = await AgentRegistry.deploy();
    await registry.waitForDeployment();

    const agent = ethers.Wallet.createRandom();

    const metadataHash = ethers.keccak256(
      ethers.toUtf8Bytes("agent")
    );

    const domain = {
      name: "AgentRegistry",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await registry.getAddress(),
    };

    const types = {
      AgentRegistration: [
        { name: "agent", type: "address" },
        { name: "owner", type: "address" },
        { name: "metadataHash", type: "bytes32" },
      ],
    };

    const signature = await agent.signTypedData(
      domain,
      types,
      {
        agent: agent.address,
        owner: owner.address,
        metadataHash,
      }
    );

    await registry.register(
      agent.address,
      owner.address,
      metadataHash,
      signature
    );

    await registry
      .connect(owner)
      .setRecoveryGuardian(agent.address, attacker.address);

    await expect(
      registry
        .connect(owner)
        .executeRecovery(agent.address)
    ).to.be.reverted;
  });
});