import { RiskAssessment, RiskContext, RiskProvider } from "./types";

export class StaticRiskProvider implements RiskProvider {
  readonly name: string;
  constructor(name: string, private readonly assessment: RiskAssessment) { this.name = name; }
  async assess(_context: RiskContext): Promise<RiskAssessment> {
    return { ...this.assessment, signals: [...this.assessment.signals] };
  }
}

export async function safeAssess(provider: RiskProvider, context: RiskContext): Promise<RiskAssessment> {
  try {
    const result = await provider.assess(context);
    if (!Number.isFinite(result.score) || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
      throw new Error("provider returned invalid assessment");
    }
    return { ...result, score: Math.max(0, Math.min(100, result.score)), signals: [...result.signals] };
  } catch (error) {
    return {
      status: "REVIEW", score: 50, confidence: 0, degraded: true,
      signals: [{
        source: provider.name, category: "provider", severity: "HIGH", confidence: 1,
        code: "RISK_PROVIDER_UNAVAILABLE",
        message: error instanceof Error ? error.message : "risk provider failed",
        evidence: { failClosed: true }, observedAt: new Date().toISOString(),
      }],
    };
  }
}
