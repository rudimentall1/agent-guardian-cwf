# Agent Guardian

## Autonomous AI Agent Security Layer for Web3

**Demo:** https://youtu.be/z7_GXu9Phwc

Agent Guardian is an on-chain security layer for autonomous agents that need to execute blockchain transactions.

The problem is straightforward. Giving an AI agent a private key with unlimited wallet access gives the agent too much authority. If the key is compromised or the agent makes a bad decision, the wallet has very few boundaries left.

Agent Guardian puts those boundaries in the contracts.

## The security boundary

```text
AI Agent
   |
   v
Signed Intent
   |
   v
AgentExecutionGuard
   |
   +-- Agent identity
   +-- Policy
   +-- Per-transaction limit
   +-- Daily limit
   +-- Owner approval
   +-- Nonce / deadline
   +-- Recovery state
   |
   v
AgentSmartWallet
   |
   v
Arbitrum
```

The agent decides what it wants to do. The contracts decide whether that action is allowed.

## What is implemented

### AgentRegistry

Stores the agent identity and owner, handles activation and deactivation, ownership transfer and recovery controls.

The registry supports EOA agents and ERC-1271 contract based identities.

### PolicyRegistry

Defines what the agent can do. Policies support exact target and function selector pairs, native transfer targets, per-transaction limits, daily limits, owner approval thresholds and validity windows.

### AgentExecutionGuard

Checks the signed execution intent before forwarding it.

The Guard validates the agent, signature, nonce, deadline, policy, exact target and selector, spending limits and owner approval when required.

### AgentSmartWallet

Holds funds used by wallet-custody execution. The wallet is tied to its Guard and rejects execution requests from another Guard.

The Guard itself does not hold the user's funds.

## Wallet custody

Native value for the wallet-custody path comes from `AgentSmartWallet`.

The regular `execute` and `executeWithApproval` entry points do not accept a nonzero value. Native transfers use `executeFromWallet` and `executeWithApprovalFromWallet` instead.

This keeps the custody model explicit. The Guard enforces the policy, while the SmartWallet holds the funds.

## Example flow

The current demo uses a policy with these limits:

- 0.5 ETH maximum per transaction
- 0.6 ETH daily limit
- 0.3 ETH owner approval threshold

A 0.1 ETH transfer succeeds without owner approval.

A 0.4 ETH transfer is rejected without the required owner approval and succeeds after the owner signs the approval.

A later 0.2 ETH transfer is rejected because the daily limit would be exceeded.

The demo then shows the owner pause path and the separate recovery guardian path.

## Testing

The current suite has **178 passing tests**.

Coverage from the current local run:

- Statements: **95.48%**
- Lines: **93.63%**
- Functions: **92.42%**
- Branches: **77.55%**

The tests include replay protection, calldata and field mutation, exact target and selector authorization, spending limits, owner approvals, reentrancy, ERC-1271 identities, wallet custody and recovery scenarios.

GitHub Actions also runs compile and tests, coverage and Slither. The latest successful CI run passed all three jobs.

## Deployment

The current deployment is on **Arbitrum Sepolia**, chain ID `421614`.

Contract addresses are stored in [`deployments.json`](../../deployments.json).

## Current scope

This repository focuses on the on-chain enforcement layer.

It does not include an off-chain AI risk-scoring service, SDK, monitoring dashboard, Robinhood Chain deployment or an independent security audit.

Real Foundry/Echidna property-based fuzzing has also not been run yet. The current fuzz test file uses seeded randomized test cases in Hardhat.

These are known limitations, not features being presented as finished.

## Why this matters

Autonomous agents need a different security model from a normal user signing occasional transactions.

The useful part of Agent Guardian is the boundary between the agent's decision and actual execution. The agent can operate within defined limits, while the owner keeps control over permissions, approvals and emergency recovery.

## Why Arbitrum

Arbitrum gives the project a practical environment for low-cost execution while staying close to the Ethereum security model.

The current prototype is intentionally focused. The goal is to make the execution boundary reliable before adding off-chain services and developer tooling.
