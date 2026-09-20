# Agent Guardian Demo Flow

## Protocol walkthrough

Network: Arbitrum Sepolia

Chain ID: 421614

The repository contains two different demonstrations:

1. a protocol walkthrough covering wallet custody, limits, approvals, pause and recovery;
2. a dedicated one-click judge demo covering a real signed agent intent, live risk intelligence, real-chain execution and calldata tampering.

They are intentionally separate so the judge demo stays short and focused on the core security boundary.

## Protocol walkthrough

The full-stack contract tests exercise:

- AgentRegistry registration and lifecycle
- PolicyRegistry immutable mandates
- AgentSmartWallet custody
- per-transaction limits
- daily spending limits
- owner approval thresholds
- pause and recovery controls
- ownership handoff and epoch invalidation

A representative policy uses:

- maximum transaction value: 0.5 ETH
- daily limit: 0.6 ETH
- approval threshold: 0.3 ETH

A 0.1 ETH transfer can execute without owner approval.

A 0.4 ETH transfer requires a fresh owner approval.

A later 0.2 ETH transfer is blocked because it would exceed the daily limit.

Pause and recovery then disable protected execution.

## One-click judge security demo

The current dedicated deployment is recorded as `agentDemo` in `deployments.json`.

The explicit button runs this sequence:

1. **AGENT_REQUEST**  a demo agent requests `ping(123)`.
2. **CANONICAL_INTENT**  the runtime resolves the exact target, calldata, nonce and policy.
3. **RISK_INTELLIGENCE**  the live Arbitrum Sepolia provider inspects the target and returns a fail-closed assessment.
4. **AGENT_SIGNATURE**  the dedicated agent signer produces an EIP-712 signature.
5. **GUARDIAN_PREFLIGHT**  the real Guard accepts the exact signed intent in a static call.
6. **REAL_TX**  the relayer sends the real transaction through `AgentExecutionGuard`.
7. **ATTACK**  a fresh signed `ping(123)` intent is modified to `ping(999)` without resigning.
8. **GUARDIAN_BLOCK**  the Guard rejects the modified calldata with `InvalidSignature`.

The endpoint verifies that:

- the original transaction was mined;
- the tampered intent was not executed;
- no second transaction was sent;
- the Guardian nonce did not advance because of the blocked tampered attempt.

The demo is explicit-click because it creates a real Arbitrum Sepolia transaction.

## Security evidence

The repository also contains:

- a 10,000-case deterministic authorization benchmark against the real Guard;
- a 100-execution Arbitrum Sepolia benchmark with 50 ALLOW and 50 BLOCK outcomes;
- adversarial contract tests;
- runtime/API integration tests;
- coverage and Slither CI.

These are evidence artifacts, not claims of production-scale security or an independent audit.
