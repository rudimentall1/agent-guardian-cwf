import { ethers } from "ethers";
import { RiskContext, RiskProvider, RiskAssessment, RiskSignal } from "./types";
import { inspectCalldataRisk } from "./calldata";

export type OnChainRiskOptions = { rpcUrl: string; name?: string };

export class OnChainRiskProvider implements RiskProvider {
  readonly name: string;
  private readonly provider: ethers.JsonRpcProvider;

  constructor(options: OnChainRiskOptions) {
    if (!options.rpcUrl.trim()) throw new Error("rpcUrl is required");
    this.name = options.name ?? "onchain";
    this.provider = new ethers.JsonRpcProvider(options.rpcUrl);
  }

  async assess(context: RiskContext): Promise<RiskAssessment> {
    const target = ethers.getAddress(context.intent.target);
    const [code, balance, txCount, network] = await Promise.all([
      this.provider.getCode(target),
      this.provider.getBalance(target),
      this.provider.getTransactionCount(target),
      this.provider.getNetwork(),
    ]);

    if (network.chainId !== context.chainId) {
      return { status: "BLOCK", score: 100, confidence: 1, degraded: false, signals: [{
        source: this.name, category: "chain", severity: "CRITICAL", confidence: 1,
        code: "CHAIN_ID_MISMATCH", message: "RPC chain does not match the intent chain.",
        evidence: { expectedChainId: context.chainId.toString(), observedChainId: network.chainId.toString() },
        observedAt: new Date().toISOString(),
      }] };
    }

    const hasCode = code !== "0x";
    const selector = context.intent.data.length >= 10 ? context.intent.data.slice(0, 10) : "0x";
    let simulationOk = false;
    let simulationReason = "";
    if (hasCode) {
      try {
        await this.provider.call({ to: target, data: context.intent.data, value: context.intent.value });
        simulationOk = true;
      } catch (error) {
        simulationReason = error instanceof Error ? error.message : "target call reverted";
      }
    }

    const calldataSignals = inspectCalldataRisk(context.intent.data);
    const signals: RiskSignal[] = [
      { source: this.name, category: "contract", severity: hasCode ? "INFO" as const : "MEDIUM" as const,
        confidence: 1, code: hasCode ? "TARGET_HAS_CODE" : "TARGET_HAS_NO_CODE",
        message: hasCode ? "Target has deployed bytecode." : "Target has no deployed bytecode.",
        evidence: { target, bytecodeBytes: hasCode ? (code.length - 2) / 2 : 0, codeHash: hasCode ? ethers.keccak256(code) : null },
        observedAt: new Date().toISOString() },
      { source: this.name, category: "activity", severity: txCount > 0 ? "INFO" as const : "LOW" as const,
        confidence: 1, code: txCount > 0 ? "TARGET_HAS_HISTORY" : "TARGET_NO_TRANSACTION_HISTORY",
        message: txCount > 0 ? "Target has observed transaction history." : "Target has no observed transaction history.",
        evidence: { transactionCount: txCount, balanceWei: balance.toString() },
        observedAt: new Date().toISOString() },
      { source: this.name, category: "intent", severity: "INFO" as const, confidence: 1,
        code: "CALLDATA_INSPECTED", message: "Intent calldata was inspected at the transaction boundary.",
        evidence: { selector, calldataBytes: (context.intent.data.length - 2) / 2, valueWei: context.intent.value.toString() },
        observedAt: new Date().toISOString() },
      { source: this.name, category: "simulation", severity: simulationOk ? "INFO" as const : "HIGH" as const,
        confidence: simulationOk ? 0.95 : 0.9,
        code: simulationOk ? "TARGET_CALL_SIMULATION_OK" : "TARGET_CALL_SIMULATION_REVERTED",
        message: simulationOk ? "The exact target calldata was accepted by an eth_call simulation." : "The exact target calldata reverted during eth_call simulation.",
        evidence: { simulated: hasCode, reverted: hasCode && !simulationOk, reason: simulationReason || null },
        observedAt: new Date().toISOString() },
      ...calldataSignals.map((signal) => ({
        source: this.name,
        category: "calldata" as const,
        severity: signal.severity,
        confidence: signal.confidence,
        code: signal.code,
        message: signal.message,
        evidence: signal.evidence,
        observedAt: new Date().toISOString(),
      })),
    ];

    const hasHighCalldataRisk = calldataSignals.some(
      (signal) => signal.severity === "HIGH" || signal.severity === "CRITICAL",
    );

    return {
      status: !hasCode || !simulationOk || hasHighCalldataRisk ? "REVIEW" : "CLEAR",
      score: hasHighCalldataRisk ? 85 : hasCode && simulationOk ? 10 : hasCode ? 70 : 55,
      confidence: hasHighCalldataRisk ? 0.9 : hasCode && simulationOk ? 0.95 : 0.8,
      degraded: false,
      signals,
    };
  }
}
