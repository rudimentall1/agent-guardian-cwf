# Agent Guardian CWF

## Security boundary for autonomous AI agent transactions

Agent Guardian CWF is a transaction security layer for AI agents interacting with blockchain contracts.

The current implementation combines deterministic on-chain authorization with a small off-chain request layer.

## Execution flow

1. An agent creates a ToolRequest.
2. The registered ToolDefinition determines the target and calldata encoding.
3. The request is converted into a TransactionIntent.
4. The intent is signed with EIP-712.
5. The signed intent can be checked through the API preflight endpoint.
6. AgentExecutionGuard performs the final authorization checks.
7. AgentSmartWallet provides wallet custody when native value is moved.
8. The authorized call reaches the target contract.

The agent request does not provide an arbitrary target address. The target comes from the registered tool definition.

## Implemented components

### ToolRequest and TransactionIntent

`runtime/tool-request.ts` converts a tool request into a `TransactionIntent`.

A ToolDefinition contains:

- tool name
- action name
- target contract
- ABI fragment used to encode calldata

The resulting intent contains:

- agent
- wallet
- target
- value
- calldata
- nonce
- deadline
- policy hash

The intent is signed with EIP-712.

### AgentExecutionGuard

`contracts/AgentExecutionGuard.sol` performs the final authorization checks before execution.

The Guard checks, among other things:

- agent registration and active status
- wallet binding
- intent signature
- nonce
- deadline
- policy binding
- target and selector authorization
- transaction value limits
- daily spending limits
- owner approval thresholds
- pause state
- replay protection

The implementation supports EOA and ERC-1271 signatures.

### AgentSmartWallet

`AgentSmartWallet` provides wallet custody for executions that move native value.

For wallet-custody execution, the value is taken from the configured SmartWallet.

Each agent has one canonical wallet recorded by `AgentRegistry`. The wallet itself is immutably bound to that agent, and the Guard checks the live wallet owner and Guard binding before custody execution.

The SmartWallet also checks that execution comes through its configured Guard.

### AgentRegistry

`AgentRegistry` handles agent registration and lifecycle operations including activation, deactivation, ownership transfer and recovery controls.

### PolicyRegistry

`PolicyRegistry` stores the execution policies used by the Guard.

Policies can restrict:

- target contracts
- function selectors
- maximum transaction value
- daily spending
- owner approval thresholds
- validity period
- native transfer targets

## HTTP API

The repository contains a small HTTP API in `api/app.ts`.

### GET /health

Returns a basic health response.

### POST /v1/intent/prepare

Accepts a ToolRequest, resolves the registered tool definition and returns:

- the transaction intent
- EIP-712 typed data
- the intent digest

The target is taken from the registered tool definition.

### POST /v1/intent/preflight

Accepts an intent and its signature.

The API calls the configured preflight function. In the integration demo this is a static call to the real AgentExecutionGuard.

A successful check returns an ALLOW decision.

A Guard revert is returned as a BLOCK decision with the error reason.

### POST /v1/intent/execute

Accepts the signed intent and sends it through the configured Guard executor.

A successful execution returns the transaction hash.

## API demo

`scripts/cwf-api-demo.ts` runs the API flow against freshly deployed local contracts.

It demonstrates three cases.

### 1. Allowed execution

The agent requests `record(123)`.

The request is prepared, signed, preflighted and executed.

### 2. Calldata changed after signing

The signed request contains `record(123)`.

The submitted calldata is changed to `record(999)`.

The Guard rejects the modified intent because the calldata no longer matches the signed data.

### 3. Target outside the policy

The agent creates a valid signature for another target.

The policy does not authorize that target, so the Guard rejects the execution.

These cases are demonstrated by the API and Guard integration test.

Run the demo with:

`npx hardhat run scripts/cwf-api-demo.ts`

## Security tests

The Solidity and Hardhat suite currently reports:

**196 passing**

The tests cover adversarial cases including:

- nonce replay
- stale and future nonces
- target substitution
- calldata modification
- value modification
- deadline modification
- policy substitution
- cross-chain replay
- cross-contract replay
- reentrancy
- inactive agents
- policy-owner mismatch
- selector and target authorization
- maximum transaction value
- daily spending limits
- owner approval thresholds
- SmartWallet custody
- ERC-1271 signatures
- recovery controls

CWF runtime and API tests are located in:

- `runtime-test/`
- `api-test/`

Run the complete test suite with:

`npm test`

Run only the contract tests:

`npm run test:contracts`

Run only the CWF runtime and API tests:

`npm run test:cwf`

## Arbitrum Sepolia

The repository contains a recorded Arbitrum Sepolia deployment from an earlier contract version. It must be redeployed after the canonical wallet-binding security fix before being presented as the current deployment.

Network: Arbitrum Sepolia

Chain ID: 421614

Deployment addresses are stored in:

`deployments.json`

## Local development

Install dependencies:

`npm install`

Compile:

`npm run compile`

Run all tests:

`npm test`

Run coverage:

`npm run coverage`

Run the API demo:

`npx hardhat run scripts/cwf-api-demo.ts`

## Current scope

The current repository implements the transaction security boundary between an autonomous agent request and blockchain execution.

It does not currently include:

- an off-chain AI risk-scoring engine
- a monitoring dashboard
- a production SDK
- a large external connector ecosystem

The authorization decision that reaches the blockchain is enforced by the deterministic Guard and its configured policy.

## Status

Active hackathon codebase.

The current focus is the security boundary between an agent request and the final blockchain transaction.
