# Agent Guardian CWF — Threat Model
## 1. Purpose and security boundary

Agent Guardian is a policy-enforced execution protocol for AI-agent transactions. Its core security claim is not that an AI agent is trustworthy. The agent is treated as potentially compromised and every agent-authorized execution must cross a deterministic on-chain authorization boundary.

The authoritative execution chain is:

`ToolRequest → ToolDefinition → TransactionIntent → EIP-712 signature → preflight → AgentExecutionGuard → AgentSmartWallet → target`

The **AgentExecutionGuard is the final authorization boundary**. The off-chain Guardian/API preflight is defense-in-depth and must not be treated as the source of truth for custody.

This document defines:
- protected assets and trust boundaries;
- attacker capabilities and assumptions;
- STRIDE threats;
- attack trees;
- security invariants;
- mitigations and adversarial test coverage;
- residual and out-of-scope risks.

Security properties described here are claims about the current `main` implementation and should be revalidated after contract or deployment changes.

## 2. Assets

| Asset | Security property | Impact if compromised |
|---|---|---|
| SmartWallet funds | Confidentiality/integrity/authorization | Unauthorized transfer of native/ERC-20 assets |
| Agent signing authority | Authenticity | Attacker can propose signed intents |
| TransactionIntent | Integrity/authenticity | Field substitution or replay could authorize a different action |
| Policy mandate | Integrity | Unauthorized targets/selectors/value limits |
| Agent ownership | Authenticity/authorization | Unauthorized lifecycle and policy control |
| Recovery guardian | Authorization | Emergency disablement or recovery abuse |
| Nonce state | Integrity/freshness | Replay or stale execution |
| Canonical wallet binding | Integrity | Execution against an unintended wallet |
| EIP-712 domain | Domain separation | Cross-chain/cross-contract replay |
| Audit/event trail | Integrity | Loss of forensic evidence |

## 3. Trust boundaries

1. **AI agent → runtime**: agent output is untrusted input.
2. **Runtime → API/Guardian**: network/API components may fail or be compromised.
3. **Relayer → Guard**: relayer is untrusted; possession of a valid transaction must not confer authority.
4. **Agent → Guard**: signature proves the registered agent identity but does not override policy.
5. **Owner → registries**: owner controls lifecycle and policy creation, but ownership handoff has explicit invariants.
6. **Guard → SmartWallet**: only the immutable configured guard may invoke agent-authorized wallet execution.
7. **SmartWallet → target contract**: target code is untrusted and may revert or attempt reentrancy.
8. **Blockchain → protocol**: chain state, timestamps, gas behavior and target contracts are external dependencies.

## 4. Attacker model

We assume an attacker may:
- fully control an AI agent process;
- craft arbitrary ToolRequests/calldata;
- control or replace a relayer;
- observe signed intents and attempt replay/front-running;
- alter target, selector, value, nonce, deadline, wallet or policy fields after signing;
- deploy malicious target contracts;
- attempt reentrancy;
- create policies for another agent where the registry permits creation but not execution;
- possess an old owner's key after ownership transfer;
- rotate an ERC-1271 signer;
- call public/external contract functions directly;
- submit malformed calldata or boundary values;
- exploit deployment/configuration mistakes.

We do **not** assume the off-chain Guardian is honest. If it fails open, the on-chain Guard must still reject unauthorized execution.

We do not treat token reputation, market data, an LLM judgment, or an API response as authorization by itself.

## 5. Security objectives

O1. An agent can execute only through its canonical SmartWallet.
O2. Every agent-authorized execution is bound to a registered active agent.
O3. The signed intent exactly binds wallet, target, value, calldata, nonce, deadline and policy.
O4. The selected policy belongs to the current agent owner and is active.
O5. Policy authorization is exact for target + selector and separate for native transfers.
O6. maxTxValue and daily spend limits cannot be bypassed by owner approvals.
O7. Replayed, stale, future or cross-domain signatures fail closed.
O8. Ownership transfer invalidates stale authorization state.
O9. Pause, deactivation and policy revocation block execution.
O10. A compromised relayer cannot create authority.
O11. The SmartWallet has no owner-controlled alternate agent execution path.
O12. Failed target calls do not consume authorization state.

## 6. Non-goals

This protocol does not guarantee:
- that a target contract is economically safe;
- that an authorized target behaves honestly;
- that an owner who intentionally transfers/recover assets is acting safely;
- protection against compromise of the blockchain or consensus;
- protection against private-key theft outside protocol controls;
- protection against every off-chain API or infrastructure outage;
- that CMC/token intelligence or any other reputation source is authoritative security policy;
- that an LLM can correctly understand arbitrary contract semantics.

## 7. STRIDE analysis

### Spoofing

**S1 — Agent impersonation.**
An attacker submits an intent claiming another agent identity.
Mitigation: EIP-712 agent-bound signature; AgentRegistry registration; active-agent check; ERC-1271 verification where applicable.
Coverage: adversarial cross-agent and invalid-signer tests.

**S2 — Owner/guardian impersonation.**
An attacker attempts lifecycle operations as another owner or guardian.
Mitigation: explicit access control; guardian identity checks; ownership transfer clears the previous guardian.
Coverage: AgentRegistry lifecycle and recovery tests.

**S3 — Wallet impersonation.**
An attacker substitutes another wallet controlled by the same owner.
Mitigation: immutable agent identity in SmartWallet plus canonical wallet binding in AgentRegistry and Guard.
Coverage: WalletNotCanonical and immutable-agent tests.

### Tampering

**T1 — Signed field substitution.**
Change target, selector/calldata, value, nonce, deadline, wallet or policy after signing.
Mitigation: complete TransactionIntent EIP-712 digest.
Coverage: attack-8 field substitution suite.

**T2 — Policy widening.**
Modify an existing policy after an approval is signed.
Mitigation: mandate values and authorization entries are immutable; revoke/reactivate does not mutate them.
Coverage: PolicyRegistry immutability tests.

**T3 — Ownership lifecycle tampering.**
Reuse old-owner authorization after A→B or A→B→A.
Mitigation: ownership epoch encoded into nonce space; ownership transfer forces inactive state and clears recovery guardian.
Coverage: hostile ownership round-trip tests.

**T4 — Runtime target substitution.**
Caller attempts to choose a target different from the registered ToolDefinition.
Mitigation: ToolRequest resolves through canonical tool definitions; intent target is signed and Guard verifies it.
Coverage: runtime/API target substitution tests.

### Repudiation

**R1 — Ambiguous execution provenance.**
A relayer submits an intent and attempts to claim authority.
Mitigation: authorization belongs to the signed agent intent, not the relayer; execution events identify target/value.
Residual: external log indexing and chain reorg handling remain infrastructure concerns.

### Information disclosure

**I1 — Sensitive intent data in off-chain logs.**
Runtime/API logs may expose transaction metadata.
Mitigation: do not treat public logs as a confidentiality boundary; minimize secrets and never log private keys/signatures beyond operational need.
Residual: transaction calldata and on-chain events are public by blockchain design.

### Denial of service

**D1 — Agent deactivation/pause.**
Mitigation: owner-controlled deactivation and emergency pause; execution fails closed.

**D2 — Policy revocation.**
Mitigation: revoked policies are rejected immediately; explicit reactivation restores the same policy semantics.

**D3 — Malicious target revert.**
Mitigation: target failure reverts the entire Guard transaction and leaves nonce/spend state unchanged.
Coverage: failed external call tests.

**D4 — Reentrancy.**
Mitigation: ReentrancyGuard around execution paths; state changes are protected.
Coverage: same-agent, next-nonce and cross-agent reentrancy tests.

**D5 — Boundary/overflow values.**
Mitigation: explicit uint256 nonce boundary checks and exact maxTxValue/daily-limit validation.
Coverage: nonce max and limit boundary tests.

### Elevation of privilege

**E1 — Direct SmartWallet execution.**
Mitigation: `execute` is restricted to immutable executionGuard.

**E2 — Owner installs a bypass guard.**
Mitigation: executionGuard is immutable; there is no setter.
Coverage: SmartWallet immutability test.

**E3 — Arbitrary policy owner creates execution authority.**
Mitigation: Guard requires policy owner == current AgentRegistry owner.
Coverage: policy-owner hostile review.

**E4 — Agent self-grants lifecycle authority.**
Mitigation: agent address has no special owner/registry privilege.
Coverage: AgentRegistry access-control tests.

**E5 — Old guardian survives ownership transfer.**
Mitigation: guardian cleared on transfer; new owner must establish a new guardian.
Coverage: guardian lifecycle tests.

## 8. Attack trees

### A. Steal assets from an AgentSmartWallet

**Goal: unauthorized asset transfer**

- A1. Bypass SmartWallet execution boundary
  - call execute directly
  - replace executionGuard
  - substitute another wallet
- A2. Obtain an apparently valid Guard execution
  - replay signed intent
  - alter signed fields
  - use wrong policy
  - use stale owner policy
  - bypass nonce
  - bypass target/selector/value limits
- A3. Abuse authorized target
  - malicious target behavior
  - reentrancy into Guard/wallet
  - exploit target contract itself

Controls:
- immutable executionGuard;
- canonical wallet + immutable agent;
- EIP-712 intent binding;
- nonce and ownership epoch;
- PolicyRegistry owner binding;
- exact target/selector authorization;
- maxTxValue/daily limits;
- reentrancy protection.

### B. Reuse an old authorization after ownership changes

**Goal: old owner authorization executes under a new owner**

1. Owner A signs intent.
2. Transfer A→B.
3. Agent becomes inactive.
4. B reactivates.
5. Attempt old intent.
6. Attempt B→A round trip.
7. Attempt old nonce/policy/guardian.

Controls:
- inactive-on-transfer;
- ownership-bound policy;
- ownership epoch nonce;
- guardian reset;
- current-owner checks.

Expected result: stale authorization remains unusable even after reactivation or A→B→A.

### C. Turn an AI/tool compromise into arbitrary blockchain execution

**Goal: compromised agent drains wallet**

1. Compromise agent.
2. Request arbitrary target/calldata.
3. Try to bypass ToolDefinition.
4. Try to produce a signature.
5. Try to execute through API.
6. Try to bypass off-chain preflight.
7. Reach on-chain Guard.
8. Guard must reject unless every signed and policy condition matches.

The key assumption is deliberate: **the agent may be malicious; the protocol must still enforce policy.**

### D. Abuse an ERC-1271 controller rotation

**Goal: reuse an old contract-owner or contract-agent authorization**

1. Sign approval with signer A.
2. Rotate controller to signer B.
3. Submit old approval.
4. Attempt fresh approval from unauthorized signer.
5. Attempt A→B→A ownership round trip.

Controls:
- live ERC-1271 `isValidSignature`;
- current controller validation;
- ownership epoch nonce;
- fail-closed invalid signature handling.

## 9. Security invariants

The following are protocol invariants, not merely test names:

I1. `AgentRegistry.walletOf(agent)` is either zero or the one canonical SmartWallet.
I2. SmartWallet immutable `agent` equals the registry agent it is bound to.
I3. SmartWallet immutable `executionGuard` is the intended AgentExecutionGuard.
I4. Agent execution requires the agent to be registered and active.
I5. The Guard rejects a non-canonical wallet.
I6. The Guard rejects a policy whose owner is not the current agent owner.
I7. A policy cannot authorize an unlisted target/selector pair.
I8. Native transfer authorization cannot be substituted for function-call authorization.
I9. Intent nonce must equal the current nonce for that agent.
I10. Consumed nonces cannot be replayed.
I11. Ownership epochs monotonically invalidate prior authorization domains.
I12. Revoked policy and paused/deactivated agent cannot execute.
I13. Failed external calls leave nonce and spend accounting unchanged.
I14. Owner approval cannot bypass policy, nonce, value or daily limits.
I15. No owner-only function can install an alternate agent execution path.
I16. Relayer identity does not confer execution authority.
I17. Off-chain preflight failure must not cause API execution.
I18. ERC-1271 authorization follows the current contract-controlled signer.

## 10. Control-to-code mapping

| Threat/control | Enforcement location | Adversarial coverage |
|---|---|---|
| Agent registration/lifecycle | `AgentRegistry.sol` | registration + lifecycle suites |
| Canonical wallet | `AgentRegistry.sol`, `AgentExecutionGuard.sol` | canonical wallet tests |
| Immutable wallet identity | `AgentSmartWallet.sol` | SmartWallet boundary tests |
| Immutable execution guard | `AgentSmartWallet.sol` | guard immutability test |
| Intent authenticity | `AgentExecutionGuard.sol` + EIP-712 runtime | signature/domain tests |
| Exact target/selector | `PolicyRegistry.sol` | Cartesian-product regression |
| Native transfer separation | `PolicyRegistry.sol` | native/call separation tests |
| Policy ownership | `AgentExecutionGuard.sol` | hostile policy-owner review |
| Policy immutability | `PolicyRegistry.sol` | revoke/reactivate tests |
| Nonce/replay protection | `AgentExecutionGuard.sol` | replay/property tests |
| Ownership epoch | `AgentRegistry.sol` + Guard | A→B→A tests |
| Daily limits | `AgentExecutionGuard.sol` | boundary/accounting tests |
| Owner approvals | `AgentExecutionGuard.sol` | approval adversarial suite |
| Pause/deactivation | Registry + Guard | lifecycle/pause tests |
| Recovery guardian | `AgentRegistry.sol` | guardian lifecycle tests |
| ERC-1271 | Guard + ERC-1271 interface | signer rotation tests |
| Reentrancy | Guard/SmartWallet | reentrancy suite |
| API preflight | `api/app.ts` | fail-closed API tests |
| Tool target integrity | `runtime/tool-request.ts` | ToolRequest tests |
| Runtime signing | `runtime/intent.ts` | digest equivalence tests |

## 11. Failure-mode requirements

Security-sensitive failures must be fail-closed:

- missing registration → reject;
- inactive agent → reject;
- wrong wallet → reject;
- wrong owner/policy → reject;
- invalid signature → reject;
- wrong nonce → reject;
- expired intent → reject;
- revoked policy → reject;
- paused agent → reject;
- malformed calldata → reject;
- unauthorized target/selector → reject;
- value above policy/daily limit → reject;
- target call failure → revert without consuming authorization state;
- missing Guardian preflight in API execution path → reject before executor submission.

A successful HTTP response is not itself evidence of authorization. The on-chain Guard remains authoritative.

## 12. Residual risks

1. **Authorized malicious target:** If a policy legitimately authorizes a dangerous contract/function, the protocol can enforce the policy but cannot prove the target's economic correctness.
2. **Owner compromise:** The owner is a privileged custody/lifecycle authority. Guardian and pause mechanisms reduce response time but do not turn the owner into a trustless actor.
3. **Agent key compromise:** A compromised agent can produce valid signatures, but only for actions allowed by current policy and lifecycle state.
4. **Off-chain Guardian compromise:** An attacker may manipulate warnings or preflight availability, but cannot create on-chain authority outside the Guard.
5. **ERC-1271 implementation quality:** A contract wallet controls what it considers a valid signature. The protocol can enforce the current ERC-1271 result but cannot audit arbitrary external signer logic.
6. **Target-contract vulnerabilities:** Downstream contracts remain separate security domains.
7. **Deployment misconfiguration:** Incorrect registry/guard/wallet addresses or incomplete canonical binding can invalidate the intended security model. Deployment must be verified on-chain before public claims.
8. **Chain-specific assumptions:** Final security properties depend on the deployed chain's consensus and EVM behavior.

## 13. Out of scope

- blockchain consensus attacks;
- validator/miner censorship;
- compromised RPC infrastructure changing finalized chain state;
- vulnerabilities in arbitrary third-party target contracts;
- phishing or social engineering of the owner;
- theft of owner private keys outside the protocol;
- malicious behavior by a user who intentionally authorizes a transaction;
- economic attacks that remain within the exact policy mandate;
- LLM alignment or model-quality research beyond treating model output as untrusted.

## 14. Validation status

Current repository validation before deployment freeze:
- 199 Solidity/Hardhat tests passing;
- 15 runtime/API tests passing;
- 214 total tests;
- compile succeeds for 34 Solidity files;
- CI must remain green on the current commit before deployment;
- this repository uses seeded/property-style randomized tests; it does **not** claim Foundry/Echidna fuzzing.

The next benchmark should derive its transaction classes directly from this threat model rather than inventing unrelated traffic.

## 15. Change control

Any change to:
- authorization flow;
- EIP-712 fields/domain;
- nonce semantics;
- policy representation;
- ownership lifecycle;
- SmartWallet execution;
- ERC-1271 handling;
- Guardian/API execution path

requires a threat-model review and corresponding adversarial regression coverage before deployment.

**Security boundary summary:** the AI agent proposes, the runtime canonicalizes, the Guardian can preflight, but the on-chain AgentExecutionGuard authorizes execution. The SmartWallet executes only through its immutable guard.
