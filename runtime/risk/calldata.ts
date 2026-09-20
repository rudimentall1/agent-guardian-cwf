import { ethers } from "ethers";

const SELECTORS = {
  approve: ethers.id("approve(address,uint256)").slice(0, 10).toLowerCase(),
  setApprovalForAll: ethers.id("setApprovalForAll(address,bool)").slice(0, 10).toLowerCase(),
};

export type CalldataRiskSignal = {
  code: string;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  confidence: number;
  message: string;
  evidence: Record<string, string>;
};

function malformed(code: string, selector: string, bytes: number): CalldataRiskSignal {
  return {
    code,
    severity: "HIGH",
    confidence: 1,
    message: "Calldata matches a sensitive authorization selector but has an invalid ABI payload.",
    evidence: { selector, calldataBytes: String(bytes) },
  };
}

export function inspectCalldataRisk(data: string): CalldataRiskSignal[] {
  if (!ethers.isHexString(data) || data.length < 10) {
    return [{
      code: "CALLDATA_MALFORMED",
      severity: "HIGH",
      confidence: 1,
      message: "Calldata is too short or not valid hex.",
      evidence: { calldataBytes: "0" },
    }];
  }

  const selector = data.slice(0, 10).toLowerCase();
  const body = data.slice(10);

  if (selector === SELECTORS.approve) {
    if (body.length !== 64 * 2) {
      return [malformed("APPROVE_CALLDATA_MALFORMED", selector, (data.length - 2) / 2)];
    }

    const amount = BigInt("0x" + body.slice(64, 128));
    if (amount !== ethers.MaxUint256) return [];

    const spender = ethers.getAddress("0x" + body.slice(24, 64));
    return [{
      code: "UNLIMITED_APPROVAL_REQUESTED",
      severity: "HIGH",
      confidence: 0.9,
      message: "The intent requests an unlimited ERC-20 approval. Risk review is required before granting it.",
      evidence: { selector, spender, allowance: ethers.MaxUint256.toString() },
    }];
  }

  if (selector === SELECTORS.setApprovalForAll) {
    if (body.length !== 64 * 2) {
      return [malformed("SET_APPROVAL_FOR_ALL_CALLDATA_MALFORMED", selector, (data.length - 2) / 2)];
    }

    const approved = BigInt("0x" + body.slice(64, 128));
    if (approved === 0n) return [];

    const operator = ethers.getAddress("0x" + body.slice(24, 64));
    return [{
      code: "NFT_OPERATOR_APPROVAL_REQUESTED",
      severity: "HIGH",
      confidence: 0.95,
      message: "The intent grants an NFT operator approval. Risk review is required before granting operator access.",
      evidence: { selector, operator, approved: "true" },
    }];
  }

  return [];
}
