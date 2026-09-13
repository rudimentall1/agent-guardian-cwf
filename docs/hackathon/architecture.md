# Agent Guardian Architecture

## Overview

Agent Guardian is an on-chain security layer for autonomous agents that need to interact with blockchain contracts and move assets.

The main idea is simple. The agent can decide what it wants to do, but it does not get unlimited authority over the wallet. Every action passes through the same checks before it reaches the target contract.

The current system is built from four main pieces:

```text
Agent
  |
  | EIP-712 signed intent
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

The important security boundary is the Guard. The agent signs an intent, but the contract decides whether that intent is valid and allowed.

## AgentRegistry

`AgentRegistry` stores the agent identity and its owner.

It handles:

- agent registration
- activation and deactivation
- ownership transfer
- recovery guardian assignment
- emergency recovery

The registry supports normal EOA agents and ERC-1271 contract based identities.

An agent can also be disabled without changing the agent signing key. This matters when the owner suspects that the key or the automation around it has been compromised.

## PolicyRegistry

`PolicyRegistry` stores the rules that define what an agent is allowed to do.

A policy can define:

- exact `(target, selector)` call permissions
- native transfer targets
- maximum value for one transaction
- daily spending limit
- owner approval threshold
- validity period

Target and selector permissions are checked as pairs. Authorizing a selector on one contract does not authorize the same selector on another contract.

Policies are not edited in place to widen their permissions. A new policy can be created when the owner needs different limits.

## AgentExecutionGuard

`AgentExecutionGuard` is the execution firewall.

Before an action is forwarded, it checks the signed intent against the current state.

The checks include:

- registered agent identity
- active agent status
- policy ownership and policy validity
- exact target and selector authorization
- transaction value
- daily spending limit
- nonce
- deadline
- agent signature
- fresh owner approval when the policy requires it

The signed intent contains the important execution fields, including the agent, wallet, target, value, calldata hash, nonce, deadline and policy hash. Changing any of these fields invalidates the signature.

The Guard itself is not a wallet. It does not keep user funds.

## AgentSmartWallet

`AgentSmartWallet` is the custody layer for native assets used by agent execution.

The wallet is bound to one specific `AgentExecutionGuard`. It rejects execution requests coming from another Guard.

For wallet custody, the execution value is taken from the SmartWallet balance. The caller does not have to fund the transaction with the value being transferred.

The Guard also rejects direct ETH transfers to itself. This keeps custody in one place and makes the funding model easier to reason about.

## Execution flow

A normal wallet-custody execution looks like this:

1. The owner registers an agent.
2. The owner creates a policy for that agent.
3. The agent signs an execution intent.
4. A relayer submits the signed intent to the Guard.
5. The Guard checks the signature, nonce, deadline, policy and spending rules.
6. If the value is above the approval threshold, the Guard also checks a fresh owner approval.
7. The Guard asks the bound SmartWallet to fund the transaction.
8. The target contract receives the call.
9. The nonce and spending state are updated only when execution succeeds.

## Emergency controls

There are two different emergency controls.

The owner can pause the agent at the Guard level.

A recovery guardian can deactivate the agent at the registry level. This provides a second emergency path if the agent key or the normal owner workflow is compromised.

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
- ERC-1271 agent signatures
- emergency recovery

The current implementation is an on-chain enforcement layer. There is no off-chain AI risk engine making the final execution decision.
