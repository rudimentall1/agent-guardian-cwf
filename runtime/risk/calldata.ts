import { ethers } from "ethers";

const ERC20_APPROVE_SELECTOR = ethers.id("approve(address,uint256)").slice(0, 10);

export type CalldataRiskSignal = {
  code: string;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  confidence: number;
  message: string;
  evidence: Record<string, string>;
};

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
  if (selector !== ERC20_APPROVE_SELECTOR.toLowerCase()) return [];

  const body = data.slice(10);
  if (body.length !== 64 * 2) return [{
    code: "APPROVE_CALLDATA_MALFORMED",
    severity: "HIGH",
    confidence: 1,
    message: "Calldata matches the ERC-20 approve selector but has an invalid ABI payload length.",
    evidence: { selector, calldataBytes: String((data.length - 2) / 2) },
  }];

  const amount = BigInt("0x" + body.slice(64, 128));
  if (amount !== ethers.MaxUint256) return [];

  const spender = ethers.getAddress("0x" + body.slice(24, 64));
  return [{
    code: "UNLIMITED_APPROVAL_REQUESTED",
    severity: "HIGH",
    confidence: 0.9,
    message: "The intent requests an unlimited ERC-20 approval. Risk review is required before granting it.",
    evidence: {
      selector,
      spender,
      allowance: ethers.MaxUint256.toString(),
    },
  }];
}
