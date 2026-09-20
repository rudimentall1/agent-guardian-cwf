# Crypto World’s Fair development ledger

This document separates the pre-hackathon foundation from work completed during Crypto World’s Fair (CWF).

## Competition window

- CWF competition: 2026-09-14 through 2026-10-12
- Repository: agent-guardian-cwf
- Baseline before the competition: b76d1b9
- First CWF development commit: 6a8f995
- Product scope: security boundary between autonomous agent requests and blockchain execution

## Disclosure

Agent Guardian CWF is based on an earlier Agent Guardian / Arbitrum codebase. The pre-existing foundation is not presented as CWF-created work. The submission should explicitly disclose that lineage and identify the material features implemented during CWF.

Colosseum permits pre-existing code but requires relevant past development to be disclosed. The product is judged on work completed during the competition period.

## Pre-CWF foundation

The baseline at b76d1b9 already contained the earlier Agent Guardian smart-contract foundation and prior deployment/demo material.

That foundation is retained as the security substrate. It is not counted here as new CWF development.

## CWF development

The following commits document material work completed after the competition began.

### 2026-09-15 — execution boundary

- 6a8f995 — CWF architecture and roadmap
- 10c13d4 — canonical transaction intent layer
- b6a74ac — CWF package metadata
- 9aaf206 — ToolRequest to transaction-intent boundary
- b155f53 — tool request execution-boundary test
- a2fe18c — CWF execution security demo
- 5669b58 — target and calldata binding
- c052ad5 — policy and spending enforcement
- 82fe7d9 — reusable intent executor
- 98a91a0 — signed intent API execution
- 47968e2 — Guard-backed intent preflight
- c5e88d3 — API policy enforcement tests
- 06cfc1b — API execution security demo

These changes establish the developer/runtime boundary from an agent tool request to a canonical signed transaction intent and then to deterministic Guard authorization.

### 2026-09-17 — custody and lifecycle hardening

- 7992f0f — bind agents to canonical wallets
- 217ea5e — enforce wallet ownership during agent handoff
- 7b1bd7b — reset recovery guardian on owner handoff
- 541e777 — invalidate stale intents across ownership epochs
- 27fb505 — require Guardian preflight before API execution

These changes harden wallet identity, handoff, recovery, replay resistance, and the execution boundary.
### 2026-09-19 — evidence and live execution

- 0997de6 — protocol threat model
- af5221d — 10k security benchmark
- 1190cae — reproducible 100-execution Arbitrum Sepolia benchmark
- f844a11 — evidence-backed security dashboard
- 8f586dc — live risk evidence in dashboard
- fdca59d — evidence-backed risk intelligence
- b25e512 — agent flow connected to live risk intelligence
- d0f221d — live agent preflight demo
- 182e095 — real signed agent execution demo
- 94427d4 — signed-intent tamper blocking

These changes turn the project from a contract-only security foundation into an observable agent transaction-security product with reproducible evidence and real-chain execution.

### 2026-09-20 — judge path and target-call simulation

- 5c3d6cf — one-click judge security demo
- bcca228 — protocol and judge-demo flows separated
- 979699f — smart-wallet custody paths hardened
- aa9bf2c — security evidence metrics synchronized
- 1cf533b — live target-call simulation in risk intelligence

The latest risk layer performs a real eth_call against the intended target and calldata. A deployed target whose exact call reverts is surfaced as a review condition; a successful simulation produces explicit simulation evidence before execution.
## CWF security boundary delivered

The current architecture is:

Agent ToolRequest
→ ToolDefinition
→ canonical TransactionIntent
→ risk/simulation preflight
→ EIP-712 authorization
→ AgentExecutionGuard
→ canonical AgentSmartWallet
→ target contract

The important design property is that off-chain risk intelligence is not the final authority over funds. The deterministic on-chain Guard remains the execution authority, while risk intelligence is fail-closed preflight.

## Evidence

Current repository evidence includes:

- deterministic 10,000-case authorization benchmark
- 100 real Arbitrum Sepolia executions
- signed-intent tamper rejection
- live risk intelligence
- exact target-call simulation
- automated Hardhat/runtime tests
- coverage and Slither validation
- one-click judge security demo

Benchmark numbers must always be described as the artifact currently committed to the repository, not as a claim of production-scale traffic.

## What is still not claimed

The product does not claim:

- independent security audit
- production monitoring/alerting
- broad production multi-chain rollout
- a mature public SDK ecosystem

Those are future product expansion areas, not hidden limitations.

## Judge verification path

A judge should be able to verify the CWF work by following this ledger into the referenced commits, then running the repository tests and the judge demo.

The Git history is part of the development evidence: the CWF implementation is not represented as if the entire Agent Guardian foundation was created during this competition.
