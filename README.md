# Agent Guardian CWF

## Security boundary for autonomous AI agent transactions

Agent Guardian CWF is a transaction security layer for AI agents interacting with blockchain contracts.

The product combines deterministic on-chain authorization, a developer-facing request/runtime layer, fail-closed risk intelligence, and a real-chain security evidence dashboard.

## Live demo

Public security evidence dashboard: http://77.239.125.37:8787/

It exposes the recorded 10,000 authorization benchmark, 100 real Arbitrum Sepolia executions, live RPC risk evidence, deployment addresses, and recent transaction hashes.

## Execution flow

1. An agent creates a ToolRequest.
2. The registered ToolDefinition determines the target and calldata encoding.
3. The request is converted into a canonical TransactionIntent.
4. Optional risk intelligence evaluates the target and intent.
5. The intent is signed with EIP-712.
6. The signed intent can be checked through API preflight.
7. AgentExecutionGuard performs the final authorization checks.
8. AgentSmartWallet provides wallet custody when native value is moved.
9. The authorized call reaches the target contract.

The agent request does not provide an arbitrary target address. The target comes from the registered tool definition.

## Implemented components

### ToolRequest and TransactionIntent

`runtime/tool-request.ts` converts a tool request into a canonical `TransactionIntent`.

A ToolDefinition contains the tool name, action name, target contract and ABI fragment used to encode calldata.

The resulting intent contains the agent, wallet, target, value, calldata, nonce, deadline and policy hash.

The intent is signed with EIP-712.

### Agent Guardian SDK

`sdk/index.ts` exposes a small integration client for external agents. It calls the public `/v1/agent/prepare` boundary, signs the returned EIP-712 typed data with the agent signer, then sends the signed intent through Guardian preflight or `/v1/agent/execute`.

The integration path is therefore:

`Agent -> AgentGuardianClient -> ToolRequest -> Canonical Intent -> Risk -> EIP-712 -> Guardian -> Wallet -> Target`

The SDK also exposes `guardedExecute(request, signer)`, which performs prepare, EIP-712 signing, Guardian preflight and execution as one fail-closed call. If preflight returns BLOCK, the SDK does not call the execution endpoint.

See `runtime-test/sdk-client.test.ts` for the reusable integration contract exercised against the same public API surface.

For a real Arbitrum Sepolia end-to-end integration run, start the API with the deployed Guard address configured in `CWF_GUARD_ADDRESS`, then run `npm run demo:agent-sdk`. The demo performs a real agent ToolRequest, live risk + exact target simulation, EIP-712 signing, Guardian preflight, real on-chain execution, and a second preflight with modified calldata that is blocked without submission.

### AgentExecutionGuard

`contracts/AgentExecutionGuard.sol` performs the final authorization checks before execution.

The Guard checks, among other things:

- agent registration and active status
- live policy-owner binding
- canonical wallet binding
- intent signature
- nonce
- deadline
- policy binding
- exact target and selector authorization
- transaction value limits
- daily spending limits
- owner approval thresholds
- pause/recovery state
- replay protection

The implementation supports EOA and ERC-1271 signatures.

### AgentSmartWallet

`AgentSmartWallet` provides wallet custody for executions that move native value.

For wallet-custody execution, the value is taken from the configured SmartWallet.

Each agent has one canonical wallet recorded by `AgentRegistry`. The wallet itself is immutably bound to that agent and Guard, and the Guard checks the live wallet owner and Guard binding before execution.

The SmartWallet also checks that execution comes through its configured Guard.

### AgentRegistry

`AgentRegistry` handles agent registration and lifecycle operations including activation, deactivation, ownership transfer, recovery controls and canonical wallet binding.

### PolicyRegistry

`PolicyRegistry` stores immutable execution policies.

Policies can restrict:

- target contracts
- function selectors
- maximum transaction value
- daily spending
- owner approval thresholds
- validity period
- native transfer targets

## Risk Intelligence

The runtime includes a fail-closed risk layer.

The current real provider uses Arbitrum Sepolia RPC data to inspect:

- deployed bytecode
- transaction history
- chain ID
- calldata selector/size
- known high-risk authorization calldata such as unlimited ERC-20 approvals and NFT operator approvals
- intent value

Provider failure produces `REVIEW` with degraded status, and the HTTP execution path refuses to execute. Deterministic Guardian enforcement remains the final on-chain authority.

This is deliberately not presented as an AI risk model. The provider interface can be extended with richer intelligence later without moving final authority away from the Guard.

## HTTP API

The repository contains a small HTTP API in `api/app.ts`.

- `GET /health`
- `POST /v1/intent/prepare`
- `POST /v1/intent/preflight`
- `POST /v1/intent/execute`
- `POST /v1/agent/demo/security-demo`

The normal execution path is fail-closed: risk clearance and real Guardian preflight must pass before the relayer sends a transaction.

The security-demo endpoint runs a real agent signature, real Guardian preflight, real Arbitrum Sepolia execution, calldata tampering and Guardian rejection.

## Security evidence

### 10,000 authorization checks

The deterministic local benchmark evaluates the real `AgentExecutionGuard` against 10,000 signed-intent cases:

- 1,000 expected ALLOW
- 9,000 expected BLOCK
- false authorization rate: 0
- false block rate: 0
- p50: ~2.11 ms
- p95: ~3.59 ms
- p99: ~9.37 ms

This is an authorization benchmark, not 10,000 mined blockchain transactions.

### 100 real Arbitrum Sepolia executions

The recorded real-chain benchmark contains:

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

The evidence is stored in `benchmark/real-100-latest.json`.

### Live signed-intent tamper demo

The one-click demo performs a real ALLOW execution, then modifies the calldata of a freshly signed intent without resigning it.

The Guard rejects the modified calldata with `InvalidSignature`.

The demo verifies:

- the original transaction was mined
- the modified intent was not executed
- no second transaction was sent
- the Guardian nonce remained unchanged after the blocked tampered attempt

## Automated security validation

The latest successful CI run verifies:

- 208 Solidity/Hardhat contract tests
- 28 runtime/API tests
- compile + test
- coverage
- Slither static analysis

Current CI coverage:

- statements: 97.65%
- branches: 87.07%
- functions: 92.41%
- lines: 95.35%

Slither passes with `fail-on: high`. The run reports 26 detector findings, primarily expected mock-contract findings and non-blocking code-quality/security heuristics; no high-severity finding blocks the build.

Seeded randomized Hardhat tests are included. Foundry/Echidna and an independent audit are future hardening work.

## Arbitrum Sepolia deployments

Network: Arbitrum Sepolia

Chain ID: 421614

Two current evidence deployments are recorded in `deployments.json`:

- `real100Benchmark`
- `agentDemo`

The target contract is shared between both.

## Security evidence dashboard

The repository includes a React/Vite evidence dashboard backed directly by benchmark artifacts. It exposes:

- the 10,000 authorization benchmark
- 100 real Arbitrum Sepolia executions
- 50 ALLOW / 50 BLOCK outcomes
- false-authorization and false-block rates
- real-chain latency and gas metrics
- recent mined transaction hashes with explorer links
- current deployment evidence

Build with `npm run build:dashboard`.

Run the combined API and dashboard server with `npm run start:api`.

## CWF submission material

Presentation video:
https://youtu.be/kl5gLOeRggw

Product demo:
https://youtu.be/yyGg0d7pzfc

The videos are final submission material. The product demo focuses on the technical execution path rather than repeating the presentation.

## CWF development disclosure

Agent Guardian CWF is based on an earlier Agent Guardian / Arbitrum codebase. Pre-existing foundation work is disclosed separately in docs/hackathon/CWF_DEVELOPMENT_LEDGER.md.

The ledger identifies the baseline before CWF and the material features implemented during the competition period.

## Local development

`npm install`

`npm run compile`

`npm test`

`npm run coverage`

`npx hardhat run scripts/cwf-api-demo.ts`

## Current scope

The current hackathon product is the transaction security boundary between an autonomous agent request and blockchain execution, plus a developer-facing runtime/API, integration SDK and evidence dashboard.

It does not claim:

- a mature published npm SDK or large external connector ecosystem
- production monitoring/alerting
- independent security audit
- multi-chain production rollout

The final execution authority is deterministic on-chain policy enforcement. Optional risk intelligence can only add a fail-closed pre-execution gate.

## Status

**Security core: implemented and validated.**

**CWF submission material: prepared.**

**Judge-facing demo: verified.**


