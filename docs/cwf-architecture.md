# Agent Guardian CWF Architecture

## Product

Agent Guardian is a security layer for autonomous AI agents that can call tools and execute blockchain transactions.

The system separates:

1. what the agent wants to do;
2. what the policy allows;
3. what the final transaction actually does;
4. whether the transaction is allowed to execute.

The agent can propose an action, but it does not receive unrestricted authority over funds.

## Core flow

AI Agent
    |
    v
Tool / MCP Request
    |
    v
Agent Guardrail
    |
    | policy / limits / confirmation
    v
Transaction Intent
    |
    v
Risk + Simulation
    |
    | policy + calldata + simulation
    v
AgentExecutionGuard
    |
    v
AgentSmartWallet
    |
    v
Arbitrum

## Security boundary

The CWF version is built around two independent enforcement layers.

### Tool-level enforcement

The off-chain guardrail protects actions before execution.

It can enforce:

- allowed tools
- numeric limits
- aggregate spending limits
- rate limits
- domain restrictions
- confirmation requirements
- audit logging

The important property is that enforcement must happen at the executor boundary, not only as an advisory MCP tool.

### Transaction-level enforcement

The on-chain Guardian protects blockchain execution.

It enforces:

- agent identity
- policy ownership
- target authorization
- function selector authorization
- transaction value limits
- daily spending limits
- nonce
- deadline
- owner approval thresholds
- emergency recovery
- wallet custody

The blockchain guard validates the actual execution path and is therefore independent of the model's interpretation of its own intent.

## Trust model

The AI model is not trusted with final authorization.

The system treats:

- AI output as an untrusted proposal;
- off-chain intelligence as advisory evidence;
- policy evaluation as deterministic;
- transaction authorization as an enforcement decision;
- the smart contract as the final on-chain authority.

## CWF implementation priorities

### Phase 1

- preserve the existing Agent Guardian security baseline;
- add a real agent/tool execution path;
- connect tool requests to transaction intents;
- add transaction simulation;
- add adversarial demo scenarios.

### Phase 2

- integrate reusable intelligence components from Agentic Wallet Guardian v3;
- integrate enforced MCP/tool execution from Agent Guardrail;
- add signed decision evidence;
- add a minimal demo UI.

### Phase 3

- Arbitrum Sepolia end-to-end deployment;
- adversarial testing;
- fuzzing and static analysis;
- production hardening;
- Arbitrum One deployment.

## Design rule

Do not move security-critical authorization into the AI layer.

AI may recommend.

Policy may evaluate.

The execution boundary decides.
