import { expect } from "chai";
import { ethers } from "hardhat";

describe("AgentSmartWallet: custody and ownership security", function () {
  async function deployFixture() {
    const [owner, newOwner, attacker, executionGuard] = await ethers.getSigners();
    const Wallet = await ethers.getContractFactory("AgentSmartWallet");
    const wallet = await Wallet.deploy(owner.address, executionGuard.address, attacker.address);
    await wallet.waitForDeployment();
    return { owner, newOwner, attacker, executionGuard, wallet };
  }

  it("rejects zero addresses in the constructor", async function () {
    const [owner, guard, agent] = await ethers.getSigners();
    const Wallet = await ethers.getContractFactory("AgentSmartWallet");

    await expect(Wallet.deploy(ethers.ZeroAddress, guard.address, agent.address))
      .to.be.revertedWithCustomError(Wallet, "ZeroAddress");
    await expect(Wallet.deploy(owner.address, ethers.ZeroAddress, agent.address))
      .to.be.revertedWithCustomError(Wallet, "ZeroAddress");
    await expect(Wallet.deploy(owner.address, guard.address, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(Wallet, "ZeroAddress");
  });

  it("rejects zero target and failed external calls at the wallet boundary", async function () {
    const { owner, executionGuard, wallet } = await deployFixture();
    const Target = await ethers.getContractFactory("AlwaysRevertingTarget");
    const target = await Target.deploy();
    await target.waitForDeployment();

    await expect(wallet.connect(executionGuard).execute(ethers.ZeroAddress, 0n, "0x"))
      .to.be.revertedWithCustomError(wallet, "ZeroAddress");

    await expect(wallet.connect(executionGuard).execute(await target.getAddress(), 0n, "0x"))
      .to.be.revertedWithCustomError(wallet, "CallFailed");

    await expect(wallet.connect(owner).execute(await target.getAddress(), 0n, "0x"))
      .to.be.revertedWithCustomError(wallet, "NotExecutionGuard");
  });

  it("transfers ownership, emits the event, and rejects the zero address", async function () {
    const { owner, newOwner, wallet } = await deployFixture();

    await expect(wallet.connect(owner).transferOwnership(newOwner.address))
      .to.emit(wallet, "OwnershipTransferred")
      .withArgs(owner.address, newOwner.address);

    expect(await wallet.owner()).to.equal(newOwner.address);

    await expect(wallet.connect(newOwner).transferOwnership(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(wallet, "ZeroAddress");

    await expect(wallet.connect(owner).transferOwnership(owner.address))
      .to.be.revertedWithCustomError(wallet, "NotOwner");
  });

  it("lets only the current owner recover native ETH", async function () {
    const { owner, newOwner, attacker, wallet } = await deployFixture();
    const walletAddress = await wallet.getAddress();

    await owner.sendTransaction({ to: walletAddress, value: ethers.parseEther("1") });
    const ownerBefore = await ethers.provider.getBalance(owner.address);

    const tx = await wallet.connect(owner).recoverNative(owner.address, ethers.parseEther("0.4"));
    const receipt = await tx.wait();
    const gasPrice = receipt!.gasPrice ?? 0n;
    const gasCost = receipt!.gasUsed * gasPrice;
    const ownerAfter = await ethers.provider.getBalance(owner.address);

    expect(ownerAfter + gasCost - ownerBefore).to.equal(ethers.parseEther("0.4"));
    expect(await ethers.provider.getBalance(walletAddress)).to.equal(ethers.parseEther("0.6"));

    await expect(wallet.connect(attacker).recoverNative(attacker.address, 0n))
      .to.be.revertedWithCustomError(wallet, "NotOwner");

    await wallet.connect(owner).transferOwnership(newOwner.address);
    await expect(wallet.connect(owner).recoverNative(owner.address, 0n))
      .to.be.revertedWithCustomError(wallet, "NotOwner");
  });

  it("rejects zero recipient and propagates a failed native recovery", async function () {
    const { owner, wallet } = await deployFixture();
    const Rejecting = await ethers.getContractFactory("AlwaysRevertingTarget");
    const rejecting = await Rejecting.deploy();
    await rejecting.waitForDeployment();

    await owner.sendTransaction({ to: await wallet.getAddress(), value: ethers.parseEther("0.1") });

    await expect(wallet.connect(owner).recoverNative(ethers.ZeroAddress, 0n))
      .to.be.revertedWithCustomError(wallet, "ZeroAddress");

    await expect(wallet.connect(owner).recoverNative(await rejecting.getAddress(), ethers.parseEther("0.1")))
      .to.be.revertedWithCustomError(wallet, "CallFailed");

    expect(await ethers.provider.getBalance(await wallet.getAddress())).to.equal(ethers.parseEther("0.1"));
  });

  it("recovers ERC20 only for the owner and emits the exact transfer", async function () {
    const { owner, newOwner, attacker, wallet } = await deployFixture();
    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy();
    await token.waitForDeployment();

    await token.mint(await wallet.getAddress(), 1_000n);
    await expect(wallet.connect(owner).recoverERC20(await token.getAddress(), newOwner.address, 400n))
      .to.emit(wallet, "ERC20Recovered")
      .withArgs(await token.getAddress(), newOwner.address, 400n);

    expect(await token.balanceOf(await wallet.getAddress())).to.equal(600n);
    expect(await token.balanceOf(newOwner.address)).to.equal(400n);

    await expect(wallet.connect(attacker).recoverERC20(await token.getAddress(), attacker.address, 1n))
      .to.be.revertedWithCustomError(wallet, "NotOwner");

    await expect(wallet.connect(owner).recoverERC20(ethers.ZeroAddress, newOwner.address, 0n))
      .to.be.revertedWithCustomError(wallet, "ZeroAddress");
    await expect(wallet.connect(owner).recoverERC20(await token.getAddress(), ethers.ZeroAddress, 0n))
      .to.be.revertedWithCustomError(wallet, "ZeroAddress");
  });

  it("reverts failed ERC20 recovery without changing wallet custody", async function () {
    const { owner, wallet } = await deployFixture();
    const BadToken = await ethers.getContractFactory("RevertingERC20");
    const badToken = await BadToken.deploy();
    await badToken.waitForDeployment();

    await expect(wallet.connect(owner).recoverERC20(await badToken.getAddress(), owner.address, 1n))
      .to.be.reverted;

    expect(await wallet.owner()).to.equal(owner.address);
  });

  it("keeps the agent and execution guard immutable across ownership changes", async function () {
    const { owner, newOwner, executionGuard, attacker, wallet } = await deployFixture();

    const originalAgent = await wallet.agent();
    await wallet.connect(owner).transferOwnership(newOwner.address);

    expect(await wallet.owner()).to.equal(newOwner.address);
    expect(await wallet.agent()).to.equal(originalAgent);
    expect(await wallet.executionGuard()).to.equal(executionGuard.address);

    const guardSelector = ethers.id("setExecutionGuard(address)").slice(0, 10);
    const forgedCall = guardSelector +
      ethers.AbiCoder.defaultAbiCoder().encode(["address"], [attacker.address]).slice(2);

    await expect(attacker.sendTransaction({
      to: await wallet.getAddress(),
      data: forgedCall,
    })).to.be.reverted;
    expect(await wallet.executionGuard()).to.equal(executionGuard.address);
  });

  it("allows owner recovery while the agent remains unable to bypass the execution guard", async function () {
    const { owner, attacker, executionGuard, wallet } = await deployFixture();
    const Target = await ethers.getContractFactory("RecordingTarget");
    const target = await Target.deploy();
    await target.waitForDeployment();

    await owner.sendTransaction({ to: await wallet.getAddress(), value: ethers.parseEther("0.2") });
    await wallet.connect(owner).recoverNative(owner.address, ethers.parseEther("0.1"));

    await expect(wallet.connect(attacker).execute(await target.getAddress(), ethers.parseEther("0.1"), "0x"))
      .to.be.revertedWithCustomError(wallet, "NotExecutionGuard");

    await expect(wallet.connect(executionGuard).execute(await target.getAddress(), ethers.parseEther("0.1"), "0x"))
      .to.emit(wallet, "Executed");
  });
});