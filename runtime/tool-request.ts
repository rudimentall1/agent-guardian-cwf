import { ethers } from "ethers";
import {
  TransactionIntent,
  canonicalizeIntent,
} from "./intent";

export type ToolRequest = {
  agent: string;
  wallet: string;
  tool: string;
  action: string;
  args: readonly unknown[];
  value: bigint;
  nonce: bigint;
  deadline: bigint;
  policyHash: string;
};

export type ToolDefinition = {
  tool: string;
  action: string;
  target: string;
  encode: (args: readonly unknown[]) => string;
};

export type ResolvedToolRequest = {
  request: ToolRequest;
  intent: TransactionIntent;
};

export function defineContractTool(
  tool: string,
  action: string,
  target: string,
  fragment: string,
): ToolDefinition {
  if (!tool.trim()) {
    throw new Error("Tool name cannot be empty");
  }

  if (!action.trim()) {
    throw new Error("Tool action cannot be empty");
  }

  if (!ethers.isAddress(target)) {
    throw new Error("Invalid tool target");
  }

  const iface = new ethers.Interface([fragment]);

  return {
    tool,
    action,
    target: ethers.getAddress(target),
    encode(args) {
      return iface.encodeFunctionData(action, [...args]);
    },
  };
}

export function resolveToolRequest(
  definition: ToolDefinition,
  request: ToolRequest,
): ResolvedToolRequest {
  if (request.tool !== definition.tool) {
    throw new Error(
      `Tool mismatch: request=${request.tool}, definition=${definition.tool}`,
    );
  }

  if (request.action !== definition.action) {
    throw new Error(
      `Action mismatch: request=${request.action}, definition=${definition.action}`,
    );
  }

  if (request.value < 0n) {
    throw new Error("value cannot be negative");
  }

  if (request.nonce < 0n) {
    throw new Error("nonce cannot be negative");
  }

  if (request.deadline < 0n) {
    throw new Error("deadline cannot be negative");
  }

  const data = definition.encode(request.args);

  const intent: TransactionIntent = {
    agent: request.agent,
    wallet: request.wallet,
    target: definition.target,
    value: request.value,
    data,
    nonce: request.nonce,
    deadline: request.deadline,
    policyHash: request.policyHash,
  };

  canonicalizeIntent(intent);

  return {
    request,
    intent,
  };
}
