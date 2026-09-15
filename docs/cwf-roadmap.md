# Agent Guardian CWF Roadmap

## Goal

Build a demonstrable security boundary for autonomous AI agents that can interact with real blockchain assets.

## Milestone 1: Baseline

- Existing Agent Guardian contracts preserved
- Existing tests preserved
- Existing security assumptions documented
- CWF work isolated from the previous hackathon repository

## Milestone 2: Agent Runtime

- Add a minimal real agent
- Add tool execution path
- Add enforced guardrail
- Convert tool actions into canonical transaction intents

## Milestone 3: Transaction Security

- Add simulation before execution
- Compare declared intent with actual calldata
- Enforce policy against target, selector and value
- Add adversarial scenarios

## Milestone 4: Evidence

- Record policy decision
- Record simulation result
- Hash security-relevant evidence
- Produce a verifiable decision record

## Milestone 5: Demo

Required scenarios:

1. Allowed transaction
2. Spending-limit violation
3. Unauthorized contract/function
4. Malicious or modified calldata

## Milestone 6: Network

- Arbitrum Sepolia end-to-end validation
- Static analysis
- Fuzzing
- Coverage review
- Security review
- Arbitrum One deployment

## Out of scope for the first CWF release

- Token
- DAO
- Multi-chain deployment
- Bittensor subnet
- Full enterprise dashboard
- Complex autonomous trading strategy
- AI-generated security verdicts without deterministic enforcement
