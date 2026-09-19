import { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";
import {
  EXECUTION_INTENT_TYPES,
  buildIntentDomain,
  intentDigest,
  TransactionIntent,
} from "../runtime/intent";
import {
  resolveToolRequest,
  ToolDefinition,
  ToolRequest,
} from "../runtime/tool-request";
import {
  executeIntent,
  ExecutionRequest,
  GuardExecutor,
} from "../runtime/executor";
import { assessRisk, RiskProvider } from "../runtime/risk";

export type CwfApiContext = {
  tools: Map<string, ToolDefinition>;
  chainId: bigint;
  verifyingContract: string;
  executor?: GuardExecutor;
  preflight?: (request: ExecutionRequest) => Promise<void>;
  riskProviders?: readonly RiskProvider[];
};

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);

  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";

    req.setEncoding("utf8");

    req.on("data", (chunk) => {
      data += chunk;

      if (data.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function asToolRequest(value: unknown): ToolRequest {
  if (!value || typeof value !== "object") {
    throw new Error("request body must be an object");
  }

  const input = value as Record<string, unknown>;

  const requiredStrings = [
    "agent",
    "wallet",
    "tool",
    "action",
    "nonce",
    "deadline",
    "policyHash",
  ];

  for (const field of requiredStrings) {
    if (typeof input[field] !== "string") {
      throw new Error(`${field} must be a string`);
    }
  }

  if (!("args" in input)) {
    throw new Error("args is required");
  }

  if (!Array.isArray(input.args)) {
    throw new Error("args must be an array");
  }

  if (
    input.value !== undefined &&
    typeof input.value !== "string"
  ) {
    throw new Error("value must be a string");
  }

  return {
    agent: input.agent as string,
    wallet: input.wallet as string,
    tool: input.tool as string,
    action: input.action as string,
    args: input.args as readonly unknown[],
    value: BigInt((input.value as string | undefined) ?? "0"),
    nonce: BigInt(input.nonce as string),
    deadline: BigInt(input.deadline as string),
    policyHash: input.policyHash as string,
  };
}

function asExecutionIntent(
  value: unknown,
): TransactionIntent {
  if (!value || typeof value !== "object") {
    throw new Error("intent must be an object");
  }

  const input = value as Record<string, unknown>;

  const requiredStrings = [
    "agent",
    "wallet",
    "target",
    "value",
    "data",
    "nonce",
    "deadline",
    "policyHash",
  ];

  for (const field of requiredStrings) {
    if (typeof input[field] !== "string") {
      throw new Error(`intent.${field} must be a string`);
    }
  }

  return {
    agent: input.agent as string,
    wallet: input.wallet as string,
    target: input.target as string,
    value: BigInt(input.value as string),
    data: input.data as string,
    nonce: BigInt(input.nonce as string),
    deadline: BigInt(input.deadline as string),
    policyHash: input.policyHash as string,
  };
}

function serializeIntent(intent: TransactionIntent) {
  return {
    agent: intent.agent,
    wallet: intent.wallet,
    target: intent.target,
    value: intent.value.toString(),
    data: intent.data,
    calldataHash: ethers.keccak256(intent.data),
    nonce: intent.nonce.toString(),
    deadline: intent.deadline.toString(),
    policyHash: intent.policyHash,
  };
}

function validateSignature(value: unknown): string {
  if (typeof value !== "string" || !ethers.isHexString(value)) {
    throw new Error("signature must be hex");
  }

  return value;
}

export function createCwfApiHandler(context: CwfApiContext) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === "GET" && req.url === "/v1/benchmark") {
        const root = process.env.CWF_PROJECT_ROOT ?? process.cwd();
        const real100 = JSON.parse(readFileSync(join(root, "benchmark", "real-100-latest.json"), "utf8"));
        const benchmark10k = JSON.parse(readFileSync(join(root, "benchmark", "latest.json"), "utf8"));
        send(res, 200, { real100, benchmark10k });
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        send(res, 200, {
          ok: true,
          service: "agent-guardian-cwf",
        });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/risk/assess") {
        const body = await readJson(req);
        if (!body || typeof body !== "object") throw new Error("request body must be an object");
        const input = body as Record<string, unknown>;
        const intent = asExecutionIntent(input.intent);
        const result = await assessRisk(
          { intent, chainId: context.chainId },
          context.riskProviders ?? [],
          typeof input.deterministicBlockReason === "string" ? input.deterministicBlockReason : undefined,
        );
        send(res, 200, { ok: true, assessment: result });
        return;
      }

      if (req.method === "GET" && req.url === "/v1/risk/demo") {
        const root = process.env.CWF_PROJECT_ROOT ?? process.cwd();
        const benchmark = JSON.parse(
          readFileSync(join(root, "benchmark", "real-100-latest.json"), "utf8"),
        );
        const target = benchmark.deployments?.target;
        if (!target) throw new Error("real benchmark target is unavailable");
        const intent: TransactionIntent = {
          agent: ethers.ZeroAddress,
          wallet: ethers.ZeroAddress,
          target,
          value: 0n,
          data: "0x12345678",
          nonce: 0n,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
          policyHash: ethers.ZeroHash,
        };
        const assessment = await assessRisk(
          { intent, chainId: BigInt(benchmark.chainId) },
          context.riskProviders ?? [],
        );
        send(res, 200, {
          ok: true,
          source: "real-100-latest.json",
          chainId: benchmark.chainId,
          target,
          assessment,
        });
        return;
      }

      if (
        req.method === "POST" &&
        req.url === "/v1/intent/prepare"
      ) {
        const body = await readJson(req);
        const toolRequest = asToolRequest(body);

        const key = `${toolRequest.tool}:${toolRequest.action}`;
        const definition = context.tools.get(key);

        if (!definition) {
          send(res, 404, {
            ok: false,
            error: "tool_action_not_registered",
            tool: toolRequest.tool,
            action: toolRequest.action,
          });
          return;
        }

        const resolved = resolveToolRequest(
          definition,
          toolRequest,
        );

        const intent = resolved.intent;

        const domain = buildIntentDomain(
          context.chainId,
          context.verifyingContract,
        );

        const digest = intentDigest(
          intent,
          context.chainId,
          context.verifyingContract,
        );

        send(res, 200, {
          ok: true,
          intent: serializeIntent(intent),
          typedData: {
            domain: {
              name: domain.name,
              version: domain.version,
              chainId: domain.chainId.toString(),
              verifyingContract: domain.verifyingContract,
            },
            primaryType: "ExecutionIntent",
            types: EXECUTION_INTENT_TYPES,
            message: {
              agent: intent.agent,
              wallet: intent.wallet,
              target: intent.target,
              value: intent.value.toString(),
              calldataHash: ethers.keccak256(intent.data),
              nonce: intent.nonce.toString(),
              deadline: intent.deadline.toString(),
              policyHash: intent.policyHash,
            },
          },
          digest,
        });

        return;
      }

      if (
        req.method === "POST" &&
        req.url === "/v1/intent/preflight"
      ) {
        if (!context.preflight) {
          send(res, 503, {
            ok: false,
            error: "preflight_not_configured",
          });
          return;
        }

        const body = await readJson(req);

        if (!body || typeof body !== "object") {
          throw new Error("request body must be an object");
        }

        const input = body as Record<string, unknown>;

        const intent = asExecutionIntent(input.intent);
        const signature = validateSignature(input.signature);

        const request: ExecutionRequest = {
          intent,
          signature,
        };

        try {
          await context.preflight(request);

          send(res, 200, {
            ok: true,
            decision: "ALLOW",
          });
        } catch (error) {
          const reason =
            error instanceof Error
              ? error.message
              : "simulation_reverted";

          send(res, 200, {
            ok: false,
            decision: "BLOCK",
            reason,
          });
        }

        return;
      }

      if (
        req.method === "POST" &&
        req.url === "/v1/intent/execute"
      ) {
        // The HTTP API is intentionally fail-closed: an execution request
        // must pass the configured Guardian preflight before the relayer
        // submits it to the on-chain Guard. The on-chain Guard remains the
        // final authorization boundary and is still independently callable.
        if (!context.executor) {
          send(res, 503, {
            ok: false,
            error: "execution_not_configured",
          });
          return;
        }

        if (!context.preflight) {
          send(res, 503, {
            ok: false,
            error: "preflight_not_configured",
          });
          return;
        }

        const body = await readJson(req);

        if (!body || typeof body !== "object") {
          throw new Error("request body must be an object");
        }

        const input = body as Record<string, unknown>;

        const intent = asExecutionIntent(input.intent);
        const signature = validateSignature(input.signature);

        const request: ExecutionRequest = {
          intent,
          signature,
        };

        try {
          await context.preflight(request);
        } catch (error) {
          const reason =
            error instanceof Error
              ? error.message
              : "simulation_reverted";

          send(res, 200, {
            ok: false,
            decision: "BLOCK",
            reason,
          });
          return;
        }

        const result = await executeIntent(
          context.executor,
          request,
        );

        const receipt = result as { hash?: string; transactionHash?: string } | null | undefined;
        send(res, 200, {
          ok: true,
          transactionHash: receipt?.hash ?? receipt?.transactionHash ?? null,
        });

        return;
      }

      send(res, 404, {
        ok: false,
        error: "not_found",
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "unknown error";

      send(res, 400, {
        ok: false,
        error: message,
      });
    }
  };
}

