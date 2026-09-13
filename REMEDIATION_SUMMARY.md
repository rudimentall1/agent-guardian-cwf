# Agent Guardian - remediation summary

This document records the remediation work that led to the current version of Agent Guardian.

## What was fixed

### Wallet custody

`AgentExecutionGuard` now has explicit wallet-custody execution paths.

Funds can be taken from the owner's `AgentSmartWallet` instead of relying on the transaction sender to provide the value.

The wallet is bound to its Guard and fails closed when another Guard attempts to use it.

### ERC-1271 agent identities

Agent registration and execution signature checks support ERC-1271 identities through `SignatureChecker`.

This allows contract based accounts and other smart-account style identities to act as agents.

### Policy validation

Invalid native-transfer policies are rejected when they could never actually execute because their value limit is zero.

### Documentation and deployment hygiene

Deployment is handled by `scripts/deploy.ts`, which writes the network-specific deployment record to `deployments.json`.

The hackathon documentation was also cleaned up so that it describes the current contract set rather than older versions of the project.

## Current verification

The current main branch has:

- **178 passing tests**
- **95.48% statement coverage**
- **93.63% line coverage**
- **92.42% function coverage**
- **77.55% branch coverage**
- Slither passing in CI

The current deployment target is Arbitrum Sepolia.

Demo:

https://youtu.be/z7_GXu9Phwc

## What is still missing

The project has not had an independent security audit or a real Foundry/Echidna fuzzing campaign.

There is also no off-chain AI risk engine, SDK or monitoring dashboard yet.

Those are known limitations and future work. They are not part of the current security boundary implemented by the contracts.

## Bottom line

The remediation work addressed the custody, identity and policy issues found during review.

The current project is a working on-chain security layer for autonomous agents, not a complete agent platform.

That distinction is intentional and should stay clear in the hackathon submission.
