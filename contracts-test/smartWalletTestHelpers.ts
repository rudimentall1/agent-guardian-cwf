import { ethers } from "hardhat";

export async function deploySmartWallet(owner: string, guard: string, agent: string): Promise<any> {
  const Wallet = await ethers.getContractFactory("AgentSmartWallet");
  const wallet = await Wallet.deploy(owner, guard, agent);
  await wallet.waitForDeployment();
  return wallet;
}

export async function fundSmartWallet(wallet: any, amount: bigint): Promise<void> {
  const [funder] = await ethers.getSigners();
  const tx = await funder.sendTransaction({ to: await wallet.getAddress(), value: amount });
  await tx.wait();
}
