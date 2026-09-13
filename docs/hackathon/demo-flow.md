# Agent Guardian Demo Flow

## Live demo

Network: Arbitrum Sepolia

Chain ID: 421614

The current demo follows the same security path used by the contracts. It shows both successful execution and actions that are rejected by the policy.

## Step 1: Deploy the stack

The demo deploys:

- `AgentRegistry`
- `PolicyRegistry`
- `AgentExecutionGuard`
- `AgentSmartWallet`
- a simple target contract used as the transaction destination

The SmartWallet is deployed with the Guard address, so the wallet only accepts execution through that Guard.

## Step 2: Register the agent

The owner registers the agent with an EIP-712 signature.

The registry records the agent as active and binds it to the owner.

## Step 3: Create the policy

The owner creates a policy with these values:

- maximum transaction value: 0.5 ETH
- daily limit: 0.6 ETH
- approval threshold: 0.3 ETH
- authorized native-transfer target: the demo target contract

## Step 4: Fund the SmartWallet

The owner sends 2 ETH to the `AgentSmartWallet`.

The Guard remains unfunded. The agent execution path uses the SmartWallet balance instead.

## Step 5: Small transfer succeeds

The agent signs a 0.1 ETH execution intent.

The relayer submits it.

The amount is below the owner approval threshold, so the Guard accepts the intent and the SmartWallet funds the transfer.

## Step 6: Larger transfer is rejected

The agent signs a 0.4 ETH intent.

The amount is below the 0.5 ETH transaction limit but above the 0.3 ETH approval threshold.

Without an owner approval, the Guard rejects the execution.

## Step 7: Owner approval allows the transfer

The owner signs a fresh approval for the same execution intent.

The relayer submits the intent together with the approval.

The Guard verifies both signatures and the 0.4 ETH transfer succeeds.

The total spend for the day is now 0.5 ETH.

## Step 8: Daily limit blocks the next transfer

The agent tries another 0.2 ETH transfer.

The transaction itself is within the per-transaction limit, but 0.5 + 0.2 would exceed the 0.6 ETH daily limit.

The Guard rejects the transaction.

## Step 9: Owner pauses the agent

The owner pauses the agent.

Even a small execution that would otherwise satisfy the policy is rejected while the agent is paused.

## Step 10: Recovery guardian disables the agent

A recovery guardian is assigned to the agent.

The guardian can deactivate the agent through the registry. After recovery, the agent is no longer active and protected execution is blocked.

## What the demo proves

The demo is not just a successful transaction.

It shows that the same execution path can allow normal agent activity, require human approval for larger transfers, enforce a daily budget and stop the agent through an emergency control.
