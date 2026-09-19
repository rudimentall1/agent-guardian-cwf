import { TransactionIntent } from "../intent";

export type RiskStatus = "CLEAR" | "REVIEW" | "BLOCK";
export type RiskSeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type RiskSignal = {
  source: string;
  category: string;
  severity: RiskSeverity;
  confidence: number;
  code: string;
  message: string;
  evidence: Record<string, string | number | boolean | null>;
  observedAt: string;
};

export type RiskContext = {
  intent: TransactionIntent;
  chainId: bigint;
};

export type RiskAssessment = {
  status: RiskStatus;
  score: number;
  confidence: number;
  degraded: boolean;
  signals: RiskSignal[];
};

export interface RiskProvider {
  readonly name: string;
  assess(context: RiskContext): Promise<RiskAssessment>;
}
