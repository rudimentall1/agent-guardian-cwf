# Agent Guardian Security Model

## Security goal

Agent Guardian is designed to limit what an autonomous agent can do with blockchain assets.

The main assumption is that an agent key can be compromised, make a bad decision or be controlled by faulty automation. The system should still have deterministic limits around the key.

## Threat 1: Compromised agent key

### Risk

An attacker gains control of the agent signing key and tries to send transactions.

### Protection

The attacker still has to pass the Guard checks:

- active agent status
- valid policy
- exact target and selector authorization
- transaction value limit
- daily limit
- nonce
- deadline
- signature checks
- owner approval when required

The owner can also pause the agent, and a recovery guardian can deactivate it entirely.

## Threat 2: Unlimited permissions

### Risk

The agent is allowed to call arbitrary contracts or move arbitrary amounts.

### Protection

`PolicyRegistry` defines the allowed actions and spending limits.

Call permissions use exact `(target, selector)` pairs. A permission for one contract does not automatically apply to another contract.

## Threat 3: Spending-limit bypass

### Risk

The agent tries to split transactions or use another execution path to get around the limits.

### Protection

The Guard tracks both per-transaction value and daily spending for the policy.

Owner approval can also be required above a configured threshold.

## Threat 4: Replay

### Risk

A valid signed intent is submitted again or modified before being resubmitted.

### Protection

The execution intent is bound to the agent, wallet, target, value, calldata hash, nonce, deadline and policy hash.

The EIP-712 domain also binds the signature to the chain and Guard contract. A consumed nonce cannot be reused.

## Threat 5: Policy substitution

### Risk

An attacker creates or selects another policy and tries to use it for an existing agent execution.

### Protection

The policy is part of the signed intent and the Guard checks the policy owner and agent binding before execution.

A policy created by another owner cannot silently gain execution authority over someone else's agent.

## Threat 6: Reentrancy

### Risk

A target contract or attacker callback tries to enter the Guard again during execution.

### Protection

The execution paths use reentrancy protection, and the test suite contains explicit reentrancy scenarios.

## Threat 7: Wrong wallet or Guard

### Risk

An execution is pointed at a different wallet, a wallet bound to another agent, or a wallet controlled by a different Guard.

### Protection

`AgentRegistry` records exactly one canonical wallet for each agent. `AgentSmartWallet` permanently records its agent identity, while the Guard verifies the canonical wallet, wallet agent, current owner and configured Guard before execution. A second wallet cannot be substituted by merely signing its address.

## Threat 8: Owner access is compromised

### Risk

The normal owner account is also unavailable or compromised during an incident.

### Protection

A separate recovery guardian can deactivate the agent at the registry level.

This is a separate control path from normal agent execution.

## Custody model

The Guard does not act as a user wallet.

The native asset custody path is:

```text
Owner
  |
  v
AgentSmartWallet
  |
  v
AgentExecutionGuard
  |
  v
Target
```

The regular execution entry points reject nonzero attached value. Native value transfers use the wallet-custody functions, which draw funds from the bound SmartWallet.

## What is intentionally not part of the security model

There is no off-chain AI risk engine making the final allow or deny decision.

The current enforcement boundary is deterministic and on-chain. An AI service, SDK, monitoring system and other higher-level tooling can be added later without changing the core security boundary described here.
