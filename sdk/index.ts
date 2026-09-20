import { ethers } from "ethers";

export type AgentGuardianClientOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
};

export type ToolRequest = {
  agent: string;
  wallet: string;
  tool: string;
  action: string;
  args: readonly unknown[];
  value?: string;
  nonce: string;
  deadline: string;
  policyHash: string;
};

export type PreparedIntent = {
  agent: string;
  wallet: string;
  target: string;
  value: bigint;
  data: string;
  nonce: bigint;
  deadline: bigint;
  policyHash: string;
};

export type PrepareResponse = {
  ok: true;
  intent: PreparedIntent;
  typedData: {
    domain: ethers.TypedDataDomain;
    primaryType: "ExecutionIntent";
    types: Record<string, ethers.TypedDataField[]>;
    message: Record<string, unknown>;
  };
  digest: string;
  risk?: unknown;
};

export type DecisionResponse = {
  ok: boolean;
  decision: "ALLOW" | "BLOCK";
  reason?: string;
  risk?: unknown;
  transactionHash?: string | null;
};

export class AgentGuardianClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AgentGuardianClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  async prepare(request: ToolRequest): Promise<PrepareResponse> {
    return this.post<PrepareResponse>("/v1/agent/prepare", request);
  }

  async preflight(
    intent: PreparedIntent,
    signature: string,
  ): Promise<DecisionResponse> {
    return this.post<DecisionResponse>("/v1/intent/preflight", {
      intent: this.serializeIntent(intent),
      signature,
    });
  }

  async execute(
    intent: PreparedIntent,
    signature: string,
  ): Promise<DecisionResponse> {
    return this.post<DecisionResponse>("/v1/agent/execute", {
      intent: this.serializeIntent(intent),
      signature,
    });
  }

  async prepareAndSign(
    request: ToolRequest,
    signer: ethers.Signer,
  ): Promise<{ prepared: PrepareResponse; signature: string }> {
    const prepared = await this.prepare(request);
    if (!prepared.ok) {
      throw new Error("Guardian prepare request was rejected");
    }

    const signature = await signer.signTypedData(
      prepared.typedData.domain,
      prepared.typedData.types,
      prepared.typedData.message,
    );

    return { prepared, signature };
  }

  async guardedExecute(
    request: ToolRequest,
    signer: ethers.Signer,
  ): Promise<{
    prepared: PrepareResponse;
    signature: string;
    preflight: DecisionResponse;
    execution: DecisionResponse;
  }> {
    const { prepared, signature } = await this.prepareAndSign(request, signer);
    const preflight = await this.preflight(prepared.intent, signature);

    if (preflight.decision !== "ALLOW") {
      return { prepared, signature, preflight, execution: preflight };
    }

    const execution = await this.execute(prepared.intent, signature);
    return { prepared, signature, preflight, execution };
  }

  private serializeIntent(intent: PreparedIntent) {
    return {
      agent: intent.agent,
      wallet: intent.wallet,
      target: intent.target,
      value: intent.value.toString(),
      data: intent.data,
      nonce: intent.nonce.toString(),
      deadline: intent.deadline.toString(),
      policyHash: intent.policyHash,
    };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(this.baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const payload = await response.json() as T & { error?: string };
    if (!response.ok) {
      throw new Error(
        payload.error ?? ("Guardian API request failed: " + response.status),
      );
    }

    return payload;
  }
}
