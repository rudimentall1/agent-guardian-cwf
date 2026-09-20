# Agent Guardian Architecture

## Overview

Agent Guardian is an execution security layer for autonomous agents that need to interact with blockchain contracts and move assets.

The agent can decide what it wants to do, but it does not get unlimited authority over the wallet. Every action passes through deterministic checks before it reaches the target contract.

Optional off-chain risk intelligence can add external context before execution. It is fail-closed and cannot override a deterministic Guardian block.

The current system is built from these layers:

```text
AI Agent
  |
  | ToolRequest
  v
Canonical TransactionIntent
  |
  | EIP-712 signature
  v
Risk Intelligence (optional, fail-closed)
  |
  v
AgentExecutionGuard
  |
  +---- AgentRegistry
  |
  +---- PolicyRegistry
  |
  +---- spending limits
  |
  +---- owner approval
  |
  +---- nonce / deadline
  |
  v
AgentSmartWallet
  |
  v
Target contract / recipient
```

The important security boundary is the Guard. Risk intelligence may block/review an intent before submission, but it does not become the authority that controls the wallet.

## AgentRegistry

`AgentRegistry` stores the agent identity and its owner.

It handles:

- agent registration
- activation and deactivation
- ownership transfer
- recovery guardian assignment
- emergency recovery
- canonical wallet binding

The registry supports EOA agents and ERC-1271 contract-based identities.

An agent can be disabled without changing its signing key. Ownership transfer increments an authority epoch and forces the agent inactive until the new owner explicitly reactivates it.

## PolicyRegistry

`PolicyRegistry` stores immutable execution mandates.

A policy can define:

- exact (target, selector) call permissions
- native transfer targets
- maximum value for one transaction
- daily spending limit
- owner approval threshold
- validity period
- immutable agent binding

Target and selector permissions are checked as pairs. Authorizing a selector on one contract does not authorize the same selector on another contract.

Policies cannot be edited in place to widen permissions. A new policy is created when the owner needs different limits.

## AgentExecutionGuard

`AgentExecutionGuard` is the execution firewall.

Before an action is forwarded, it checks:

- registered and active agent
- live policy-owner relationship
- policy validity and time window
- exact target and selector authorization
- transaction value
- daily spending limit
- nonce
- deadline
- agent signature
- owner approval when required
- canonical wallet binding
- wallet owner/agent/Guard bindings
- pause state
- replay protection

The signed intent contains the important execution fields, including the agent, wallet, target, value, calldata hash, nonce, deadline and policy hash. Changing any of these fields invalidates the signature.

The Guard itself is not a wallet. It does not keep user funds.

## AgentSmartWallet

`AgentSmartWallet` is the custody layer for native assets used by agent execution.

The wallet is immutably bound to one agent and one configured `AgentExecutionGuard`. `AgentRegistry` records one canonical wallet per agent, and the Guard verifies the canonical wallet, wallet agent identity, current owner, and Guard binding before custody execution.

For wallet custody, the execution value is taken from the SmartWallet balance.

The Guard rejects direct ETH transfers to itself. This keeps custody in one place and prevents the relayer from smuggling value through the Guard.

## Risk Intelligence

The runtime risk layer is provider-based and fail-closed.

The current real provider uses Arbitrum Sepolia RPC data to inspect target bytecode, transaction history, chain identity, calldata shape and intent value.

Provider failure becomes REVIEW with degraded status. The HTTP execution path refuses REVIEW and BLOCK assessments.

A deterministic Guardian block always dominates external risk intelligence. Risk intelligence is therefore an additional safety signal, not a replacement for on-chain authorization.

## Execution flow

A normal wallet-custody execution looks like this:

1. The owner registers an agent.
2. The owner deploys a SmartWallet bound to that agent and binds it as the agent's canonical wallet.
3. The owner creates an immutable policy for that agent.
4. The agent creates a canonical ToolRequest.
5. The runtime resolves the request into a TransactionIntent.
6. Optional risk intelligence evaluates the intent and fails closed on provider failure.
7. The agent signs the exact intent with EIP-712.
8. A relayer submits the signed intent to the Guard.
9. The Guard checks the signature, nonce, deadline, policy and spending rules.
10. If the value is above the approval threshold, the Guard also checks a fresh owner approval.
11. The Guard verifies the canonical wallet and its live owner/agent/Guard bindings.
12. The Guard asks the bound SmartWallet to execute the call.
13. The target contract receives the call.
14. Nonce and spending state are committed only if execution succeeds.

## Emergency controls

There are two different emergency controls.

The owner can pause the agent at the Guard level.

A recovery guardian can deactivate the agent at the registry level. Ownership transfer also invalidates the previous ownership epoch and requires explicit reactivation by the new owner.

## Security properties

The current test suite covers the main failure cases around this architecture, including:

- replayed intents
- stale and future nonces
- cross-chain replay
- cross-contract replay
- modified target, value and calldata
- unauthorized policy use
- daily limit bypass attempts
- owner approval bypass attempts
- reentrancy
- disabled agents
- wrong-Guard wallet substitution
- canonical wallet substitution
- ERC-1271 agent and owner signatures
- signer rotation
- ownership handoff
- emergency recovery

The current implementation is intentionally focused on deterministic on-chain enforcement with optional fail-closed risk intelligence.
