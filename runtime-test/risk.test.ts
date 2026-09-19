import { expect } from "chai";
import { ethers } from "hardhat";
import { assessRisk, OnChainRiskProvider, RiskContext, StaticRiskProvider } from "../runtime/risk";

const RPC = process.env.CWF_TEST_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc";
const REAL_TARGET = process.env.CWF_TEST_TARGET ?? "0x368CCb83E91e9b8BD9FE4C7b54e8BD6998008429";

function context(chainId: bigint, target: string): RiskContext {
  return {
    chainId,
    intent: {
      agent: ethers.ZeroAddress, wallet: ethers.ZeroAddress, target, value: 0n,
      data: "0x12345678", nonce: 0n, deadline: 9999999999n,
      policyHash: ethers.keccak256(ethers.toUtf8Bytes("policy")),
    },
  };
}

describe("CWF risk intelligence layer", function () {
  it("never converts a missing provider into ALLOW", async function () {
    const result = await assessRisk(context(31337n, ethers.ZeroAddress), []);
    expect(result.status).to.equal("REVIEW");
    expect(result.degraded).to.equal(true);
    expect(result.signals[0].code).to.equal("NO_RISK_PROVIDER");
  });

  it("deterministic Guardian BLOCK dominates external intelligence", async function () {
    const clear = new StaticRiskProvider("test-clear", {
      status: "CLEAR", score: 0, confidence: 1, degraded: false, signals: [],
    });
    const result = await assessRisk(
      context(31337n, ethers.ZeroAddress),
      [clear],
      "policy target is not authorized",
    );
    expect(result.status).to.equal("BLOCK");
    expect(result.signals[0].code).to.equal("DETERMINISTIC_BLOCK");
  });

  it("contains evidence from the real Arbitrum Sepolia target", async function () {
    const provider = new OnChainRiskProvider({ rpcUrl: RPC });
    const result = await provider.assess(context(421614n, REAL_TARGET));
    expect(result.status).to.equal("CLEAR");
    expect(result.degraded).to.equal(false);
    expect(result.signals.some((s) => s.code === "TARGET_HAS_CODE")).to.equal(true);
    expect(result.signals.some((s) => s.code === "CALLDATA_INSPECTED")).to.equal(true);
  });

  it("fails closed when the RPC provider is unavailable", async function () {
    const provider = new OnChainRiskProvider({ rpcUrl: "http://127.0.0.1:1" });
    const result = await assessRisk(context(421614n, REAL_TARGET), [provider]);
    expect(result.status).to.equal("REVIEW");
    expect(result.degraded).to.equal(true);
    expect(result.signals.some((s) => s.code === "RISK_PROVIDER_UNAVAILABLE")).to.equal(true);
  });
});
