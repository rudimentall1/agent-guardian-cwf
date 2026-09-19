import { RiskAssessment, RiskContext, RiskProvider } from "./types";
import { safeAssess } from "./provider";

export async function assessRisk(
  context: RiskContext,
  providers: readonly RiskProvider[],
  deterministicBlockReason?: string,
): Promise<RiskAssessment> {
  if (deterministicBlockReason) {
    return { status: "BLOCK", score: 100, confidence: 1, degraded: false, signals: [{
      source: "guardian", category: "deterministic", severity: "CRITICAL", confidence: 1,
      code: "DETERMINISTIC_BLOCK", message: deterministicBlockReason,
      evidence: { externalRiskCannotOverride: true }, observedAt: new Date().toISOString(),
    }] };
  }
  if (providers.length === 0) {
    return { status: "REVIEW", score: 50, confidence: 0, degraded: true, signals: [{
      source: "guardian", category: "deterministic", severity: "MEDIUM", confidence: 1,
      code: "NO_RISK_PROVIDER",
      message: "No risk intelligence provider is configured; fail closed.",
      evidence: { failClosed: true }, observedAt: new Date().toISOString(),
    }] };
  }
  const results = await Promise.all(providers.map((p) => safeAssess(p, context)));
  const signals = results.flatMap((r) => r.signals);
  const degraded = results.some((r) => r.degraded);
  const blocked = results.some((r) => r.status === "BLOCK");
  const review = results.some((r) => r.status === "REVIEW");
  const score = Math.max(...results.map((r) => r.score));
  const confidence = results.reduce((sum, r) => sum + r.confidence, 0) / results.length;
  return { status: blocked ? "BLOCK" : review || degraded ? "REVIEW" : "CLEAR", score, confidence, degraded, signals };
}
