import { ethers } from "ethers";

import { TransactionIntent } from "./intent";

export type ExecutionRequest = {
  intent: TransactionIntent;
  signature: string;
};

export type GuardExecutor = {
  executeFromWallet(
    agent: string,
    wallet: string,
    target: string,
    value: bigint,
    data: string,
    nonce: bigint,
    deadline: bigint,
    policyHash: string,
    signature: string,
  ): Promise<{
    wait(): Promise<unknown>;
  }>;
};

export async function executeIntent(
  guard: GuardExecutor,
  request: ExecutionRequest,
) {
  const { intent, signature } = request;

  if (!ethers.isAddress(intent.agent)) {
    throw new Error("Invalid intent agent");
  }

  if (!ethers.isAddress(intent.wallet)) {
    throw new Error("Invalid intent wallet");
  }

  if (!ethers.isAddress(intent.target)) {
    throw new Error("Invalid intent target");
  }

  if (!ethers.isHexString(intent.data)) {
    throw new Error("Invalid intent calldata");
  }

  if (!ethers.isHexString(intent.policyHash, 32)) {
    throw new Error("Invalid intent policyHash");
  }

  if (!ethers.isHexString(signature)) {
    throw new Error("Invalid intent signature");
  }

  const tx = await guard.executeFromWallet(
    intent.agent,
    intent.wallet,
    intent.target,
    intent.value,
    intent.data,
    intent.nonce,
    intent.deadline,
    intent.policyHash,
    signature,
  );

  return tx.wait();
}
