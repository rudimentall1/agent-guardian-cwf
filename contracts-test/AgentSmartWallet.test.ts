import { expect } from "chai";
import { ethers } from "hardhat";

describe("AgentSmartWallet: execution boundary", function () {
  it("rejects direct execution by an EOA", async function () {
    const [owner, attacker] = await ethers.getSigners();
    const Guard = await ethers.getContractFactory("AgentExecutionGuard");
    const guard = await Guard.deploy(owner.address, owner.address);
    await guard.waitForDeployment();
    const Wallet = await ethers.getContractFactory("AgentSmartWallet");
    const wallet = await Wallet.deploy(owner.address, await guard.getAddress(), owner.address);
    await wallet.waitForDeployment();
    const Target = await ethers.getContractFactory("RecordingTarget");
    const target = await Target.deploy();
    await target.waitForDeployment();
    await expect(wallet.connect(attacker).execute(await target.getAddress(), 0n, "0x")).to.be.revertedWithCustomError(wallet, "NotExecutionGuard");
  });

  it("lets the owner recover native ETH without going through the agent", async function () {
    const [owner] = await ethers.getSigners();
    const Guard = await ethers.getContractFactory("AgentExecutionGuard");
    const guard = await Guard.deploy(owner.address, owner.address);
    await guard.waitForDeployment();
    const Wallet = await ethers.getContractFactory("AgentSmartWallet");
    const wallet = await Wallet.deploy(owner.address, await guard.getAddress(), owner.address);
    await wallet.waitForDeployment();
    await owner.sendTransaction({ to: await wallet.getAddress(), value: ethers.parseEther("1") });
    const before = await ethers.provider.getBalance(owner.address);
    const tx = await wallet.connect(owner).recoverNative(owner.address, ethers.parseEther("1"));
    await tx.wait();
    const after = await ethers.provider.getBalance(owner.address);
    expect(after).to.be.gt(before - ethers.parseEther("0.01"));
  });

  it("rejects an EOA wallet substituted into the Guard", async function () {
    const [owner] = await ethers.getSigners();
    const Guard = await ethers.getContractFactory("AgentExecutionGuard");
    const guard = await Guard.deploy(owner.address, owner.address);
    await guard.waitForDeployment();
    const agent = ethers.Wallet.createRandom().connect(ethers.provider);
    const registry = await (await ethers.getContractFactory("MockAgentRegistry")).deploy();
    await registry.waitForDeployment();
    await registry.setActive(agent.address, true);
    const policy = await (await ethers.getContractFactory("MockPolicyRegistry")).deploy();
    await policy.waitForDeployment();
    const target = await (await ethers.getContractFactory("RecordingTarget")).deploy();
    await target.waitForDeployment();
    const hash = ethers.ZeroHash;
    await policy.setBinding(hash, agent.address, true);
    await policy.authorizeNativeTransfer(hash, await target.getAddress());
    const g = await (await ethers.getContractFactory("AgentExecutionGuard")).deploy(await registry.getAddress(), await policy.getAddress());
    await g.waitForDeployment();
    const net = await ethers.provider.getNetwork();
    const sig = await agent.signTypedData({name:"AgentExecutionGuard",version:"1",chainId:net.chainId,verifyingContract:await g.getAddress()}, {ExecutionIntent:[{name:"agent",type:"address"},{name:"wallet",type:"address"},{name:"target",type:"address"},{name:"value",type:"uint256"},{name:"calldataHash",type:"bytes32"},{name:"nonce",type:"uint256"},{name:"deadline",type:"uint256"},{name:"policyHash",type:"bytes32"}]}, {agent:agent.address,wallet:owner.address,target:await target.getAddress(),value:0n,calldataHash:ethers.keccak256("0x"),nonce:0n,deadline:4102444800n,policyHash:hash});
    await expect(g.execute(agent.address, owner.address, await target.getAddress(), 0n, "0x", 0n, 4102444800n, hash, sig)).to.be.revertedWithCustomError(g, "WalletNotContract");
  });
});
