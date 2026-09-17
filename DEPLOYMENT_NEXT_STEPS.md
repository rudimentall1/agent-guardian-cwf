# Agent Guardian CWF - deployment notes

Current architecture:
- `AgentRegistry` stores agent identity, owner and one canonical SmartWallet.
- `PolicyRegistry` stores immutable execution policies.
- `AgentExecutionGuard` is the authorization boundary.
- `AgentSmartWallet` is immutably bound to one agent and one Guard.

## Fresh end-to-end deployment

1. Configure the deployer key in `.env` as `PRIVATE_KEY`.
2. Configure the agent signing key as `CWF_AGENT_PRIVATE_KEY`.
3. Optionally set `CWF_AGENT_METADATA_HASH` to a 32-byte metadata commitment.
4. Deploy:

`npx hardhat run scripts/deploy.ts --network arbitrumSepolia`

When `CWF_AGENT_PRIVATE_KEY` is present, the script registers that agent to the deployer, deploys an `AgentSmartWallet` bound to the agent and Guard, binds it as the agent's canonical wallet, and records the resulting addresses in `deployments.json`.

If the agent key is omitted, the script deliberately deploys only the core registry/Guard stack and does not create a misleading unbound example wallet.

## Demo

For a fully local end-to-end security demonstration:

`npx hardhat run scripts/cwf-demo.ts`

For the HTTP API flow:

`npx hardhat run scripts/cwf-api-demo.ts`

## Security invariant

Do not treat a SmartWallet address as sufficient configuration. The agent must have exactly one canonical wallet recorded in `AgentRegistry`, and the wallet must have been constructed with the same agent identity and configured Guard. The Guard verifies these bindings at execution time.
