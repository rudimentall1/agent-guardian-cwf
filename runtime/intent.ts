import { ethers } from "ethers";

export type TransactionIntent = {
  agent: string;
  wallet: string;
  target: string;
  value: bigint;
  data: string;
  nonce: bigint;
  deadline: bigint;
  policyHash: string;
};

export const EXECUTION_INTENT_TYPES = {
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

export function canonicalizeIntent(intent: TransactionIntent) {
  if (!ethers.isAddress(intent.agent)) {
    throw new Error("Invalid agent address");
  }

  if (!ethers.isAddress(intent.wallet)) {
    throw new Error("Invalid wallet address");
  }

  if (!ethers.isAddress(intent.target)) {
    throw new Error("Invalid target address");
  }

  if (!ethers.isHexString(intent.data)) {
    throw new Error("Invalid calldata");
  }

  if (!ethers.isHexString(intent.policyHash, 32)) {
    throw new Error("Invalid policyHash");
  }

  if (intent.value < 0n) {
    throw new Error("value cannot be negative");
  }

  if (intent.nonce < 0n) {
    throw new Error("nonce cannot be negative");
  }

  if (intent.deadline < 0n) {
    throw new Error("deadline cannot be negative");
  }

  return {
    agent: ethers.getAddress(intent.agent),
    wallet: ethers.getAddress(intent.wallet),
    target: ethers.getAddress(intent.target),
    value: intent.value,
    calldataHash: ethers.keccak256(intent.data),
    nonce: intent.nonce,
    deadline: intent.deadline,
    policyHash: intent.policyHash,
  };
}

export function buildIntentDomain(
  chainId: bigint,
  verifyingContract: string,
) {
  if (!ethers.isAddress(verifyingContract)) {
    throw new Error("Invalid verifying contract address");
  }

  return {
    name: "AgentExecutionGuard",
    version: "1",
    chainId,
    verifyingContract: ethers.getAddress(verifyingContract),
  };
}

export function intentDigest(
  intent: TransactionIntent,
  chainId: bigint,
  verifyingContract: string,
) {
  const canonical = canonicalizeIntent(intent);
  const domain = buildIntentDomain(chainId, verifyingContract);

  return ethers.TypedDataEncoder.hash(
    domain,
    EXECUTION_INTENT_TYPES,
    canonical,
  );
}

export async function signIntent(
  signer: ethers.Signer,
  intent: TransactionIntent,
  chainId: bigint,
  verifyingContract: string,
) {
  const canonical = canonicalizeIntent(intent);
  const domain = buildIntentDomain(chainId, verifyingContract);

  return signer.signTypedData(
    domain,
    EXECUTION_INTENT_TYPES,
    canonical,
  );
}
