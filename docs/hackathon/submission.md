# Agent Guardian

## Autonomous AI Agent Security Layer for Web3

Agent Guardian is an on-chain security layer for autonomous agents that need to execute blockchain transactions without giving the agent unlimited authority over the wallet.

The agent decides what it wants to do. The Guard decides whether the exact signed intent is authorized.

## The security boundary

```text
AI Agent
   |
   v
ToolRequest
   |
   v
Canonical TransactionIntent
   |
   | EIP-712
   v
Risk Intelligence (optional, fail-closed)
   |
   v
AgentExecutionGuard
   |
   +-- Agent identity
   +-- Policy
   +-- Exact target + selector
   +-- Per-transaction limit
   +-- Daily limit
   +-- Owner approval
   +-- Nonce / deadline
   +-- Recovery / pause state
   |
   v
AgentSmartWallet
   |
   v
Target contract / recipient
```

The security boundary is on-chain. Off-chain risk intelligence can add context and fail closed, but it cannot override a deterministic Guardian block.

## What is implemented

### AgentRegistry

Stores the agent identity and owner, handles activation/deactivation, ownership transfer and recovery controls.

The registry supports EOA and ERC-1271 agent identities and binds one canonical custody wallet to each agent.

### PolicyRegistry

Policies are immutable mandates. They support:

- exact (target, selector) function permissions
- separate native-transfer target permissions
- per-transaction limits
- daily limits
- owner approval thresholds
- validity windows
- immutable agent binding

### AgentExecutionGuard

The Guard validates:

- registered and active agent
- live policy owner binding
- policy validity and time window
- exact target and selector authorization
- transaction value
- daily spending limit
- nonce
- deadline
- EIP-712 agent signature
- owner approval when required
- canonical wallet, wallet owner, agent and Guard bindings
- pause state
- replay protection

Any mismatch reverts before the target execution can succeed.

### AgentSmartWallet

The SmartWallet is the custody layer for native value. It is immutably bound to one agent and one Guard. The registry records the canonical wallet, and the Guard verifies the live wallet owner before custody execution.

The Guard itself does not hold user funds.

## Risk Intelligence

The runtime includes a fail-closed risk layer.

The current real provider inspects the target on Arbitrum Sepolia for:

- deployed bytecode
- transaction history
- chain ID
- calldata selector/size
- intent value
- live eth_call simulation of the exact target calldata

A reverted target simulation produces REVIEW; provider failure produces REVIEW with degraded=true. Execution is not allowed through the HTTP execution path. Deterministic Guard enforcement remains the final authority.

This is deliberately not described as an AI risk model. The current implementation is deterministic on-chain intelligence plus a fail-closed provider interface that can be extended later.

## Real security evidence

### 10,000 authorization checks

The local benchmark evaluates the real AgentExecutionGuard against 10,000 deterministic signed-intent cases:

- 1,000 expected ALLOW
- 9,000 expected BLOCK
- false authorization rate: 0
- false block rate: 0
- p50 authorization latency: ~2.11 ms
- p95: ~3.59 ms
- p99: ~9.37 ms

This is an authorization benchmark, not 10,000 mined blockchain transactions.

### 100 real Arbitrum Sepolia executions

The recorded benchmark contains:

- 100 mined executions
- 50 successful ALLOW transactions
- 50 reverted BLOCK transactions
- false ALLOW: 0
- false BLOCK: 0
- 8,216,729 total gas
- 82,167 average gas
- p50 latency: ~3.02s
- p95: ~3.24s
- p99: ~7.52s

The evidence is stored in benchmark/real-100-latest.json.

### Live signed-intent tamper demo

The one-click demo performs a real ALLOW execution, then creates a new signed intent and modifies its calldata before submitting the original signature.

The Guard rejects the modified calldata with InvalidSignature.

The demo verifies that:

- the original real transaction was mined
- the modified intent was not executed
- the second transaction was never sent
- the Guardian nonce did not advance from the blocked tampered attempt

## Automated security validation

Current CI verifies:

- 208 Solidity/Hardhat contract tests
- 20 runtime/API tests
- compile + test
- coverage
- Slither static analysis

Current coverage report:

- statements: 97.65%
- branches: 87.07%
- functions: 92.41%
- lines: 95.35%

The latest CI Slither run passes with fail-on: high.

The suite includes adversarial cases for replay, cross-chain/cross-contract replay, target/selector/calldata/value mutation, policy mismatch, owner-approval abuse, daily-limit abuse, reentrancy, ERC-1271 signer rotation, wallet substitution, ownership handoff, recovery and pause controls.

Seeded randomized Hardhat tests are included. Foundry/Echidna and an independent audit are future hardening work.

## Deployment

Network: **Arbitrum Sepolia**

Chain ID: **421614**

Two current deployments are recorded separately in deployments.json:

- real100Benchmark
- agentDemo

The target contract is shared between both evidence sets.

## Current product scope

The current hackathon product is the on-chain execution security boundary plus a developer-facing runtime/API, integration SDK and evidence dashboard.

The SDK is intentionally small and integration-focused; it is not presented as a mature published npm ecosystem. The project does not claim an external connector ecosystem, independent audit, monitoring/alerting system or multi-chain production rollout.

## Current status

**Security core implemented and validated.**

The remaining hackathon work is product polish, final end-to-end verification, submission material and judge-facing demonstration.
