import { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";
import {
  EXECUTION_INTENT_TYPES,
  buildIntentDomain,
  intentDigest,
  TransactionIntent,
  signIntent,
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
  demoGuardContract?: any;
  demoAgentSigner?: ethers.Signer;
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



function typedIntentMessage(intent: TransactionIntent) {
  return { agent: intent.agent, wallet: intent.wallet, target: intent.target, value: intent.value.toString(), calldataHash: ethers.keccak256(intent.data), nonce: intent.nonce.toString(), deadline: intent.deadline.toString(), policyHash: intent.policyHash };
}

function guardianErrorReason(error: any) {
  const data = error?.data ?? error?.revert?.data ?? error?.info?.error?.data;
  if (data) {
    try {
      const parsed = new ethers.Interface(["error CallNotAuthorized(address target,bytes4 selector,bool isNativeTransfer)","error InvalidSignature()","error PolicyNotActive(bytes32 policyHash)","error WalletNotCanonical(address wallet,address expectedWallet,address agent)"]).parseError(data);
      if (parsed) return parsed.name;
    } catch {}
  }
  return error?.shortMessage ?? error?.reason ?? error?.message ?? "guardian_rejected";
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

      if (req.method === "GET" && req.url === "/v1/agent/demo") {
        const demoState=JSON.parse(readFileSync(join(process.env.CWF_PROJECT_ROOT ?? process.cwd(),"benchmark","agent-demo.json"),"utf8"));
        if(!context.demoGuardContract) throw new Error("agent demo relayer is not configured");
        const nonce=BigInt((await context.demoGuardContract.nextNonce(demoState.agent)).toString());
        const definition=context.tools.get("demo:ping");
        if(!definition) throw new Error("demo:ping tool is not registered");
        const toolRequest:ToolRequest={agent:demoState.agent,wallet:demoState.wallet,tool:"demo",action:"ping",args:[123],value:0n,nonce,deadline:BigInt(Math.floor(Date.now()/1000)+900),policyHash:demoState.policyHash};
        const resolved=resolveToolRequest(definition,toolRequest);
        const intent=resolved.intent;
        const risk=await assessRisk({intent,chainId:context.chainId},context.riskProviders??[]);
        const domain=buildIntentDomain(context.chainId,demoState.guard);
        const digest=intentDigest(intent,context.chainId,demoState.guard);
        send(res,200,{ok:true,stage:"AGENT_REQUEST → CANONICAL_INTENT → RISK_INTELLIGENCE → AGENT_SIGNATURE_READY",toolRequest:{tool:toolRequest.tool,action:toolRequest.action,args:toolRequest.args,agent:toolRequest.agent,wallet:toolRequest.wallet},intent:serializeIntent(intent),digest,typedData:{domain:{name:domain.name,version:domain.version,chainId:domain.chainId.toString(),verifyingContract:domain.verifyingContract},primaryType:"ExecutionIntent",types:EXECUTION_INTENT_TYPES,message:typedIntentMessage(intent)},risk,next:risk.status==="CLEAR"?"AGENT_SIGNATURE_READY":"EXECUTION_BLOCKED",demoDeployment:{guard:demoState.guard,registry:demoState.registry,policyRegistry:demoState.policyRegistry,wallet:demoState.wallet,agent:demoState.agent,target:demoState.target},signerConfigured:Boolean(context.demoAgentSigner)});
        return;
      }

      if(req.method==="POST" && req.url==="/v1/agent/demo/execute"){
        const root=process.env.CWF_PROJECT_ROOT ?? process.cwd();
        const demoState=JSON.parse(readFileSync(join(root,"benchmark","agent-demo.json"),"utf8"));
        if(!context.demoGuardContract || !context.demoAgentSigner) throw new Error("agent demo signer/relayer is not configured");
        const nonce=BigInt((await context.demoGuardContract.nextNonce(demoState.agent)).toString());
        const iface=new ethers.Interface(["function ping(uint256 id)"]);
        const intent:TransactionIntent={agent:demoState.agent,wallet:demoState.wallet,target:demoState.target,value:0n,data:iface.encodeFunctionData("ping",[Number(nonce%100000n)]),nonce,deadline:BigInt(Math.floor(Date.now()/1000)+900),policyHash:demoState.policyHash};
        const risk=await assessRisk({intent,chainId:context.chainId},context.riskProviders??[]);
        if(risk.status!=="CLEAR"){send(res,200,{ok:false,decision:"BLOCK",risk,reason:"Risk intelligence requires review"});return;}
        const signature=await signIntent(context.demoAgentSigner,intent,context.chainId,demoState.guard);
        const recovered=ethers.verifyTypedData(buildIntentDomain(context.chainId,demoState.guard),EXECUTION_INTENT_TYPES,typedIntentMessage(intent),signature);
        if(ethers.getAddress(recovered)!==ethers.getAddress(demoState.agent)) throw new Error("agent signature recovery mismatch");
        try{
          await context.demoGuardContract.executeFromWallet.staticCall(intent.agent,intent.wallet,intent.target,intent.value,intent.data,intent.nonce,intent.deadline,intent.policyHash,signature);
          const tx=await context.demoGuardContract.executeFromWallet(intent.agent,intent.wallet,intent.target,intent.value,intent.data,intent.nonce,intent.deadline,intent.policyHash,signature,{gasLimit:500000n});
          const receipt=await tx.wait();
          send(res,200,{ok:true,decision:"ALLOW",signatureVerified:true,agent:demoState.agent,intent:serializeIntent(intent),digest:intentDigest(intent,context.chainId,demoState.guard),risk,transactionHash:receipt?.hash??tx.hash,blockNumber:receipt?.blockNumber??null,gasUsed:receipt?.gasUsed?.toString()??null,explorer:"https://sepolia.arbiscan.io/tx/"+tx.hash});
        }catch(error){send(res,200,{ok:false,decision:"BLOCK",signatureVerified:true,risk,reason:guardianErrorReason(error)});}
        return;
      }

      if(req.method==="POST" && req.url==="/v1/agent/demo/security-demo"){
        const root=process.env.CWF_PROJECT_ROOT ?? process.cwd();
        const demoState=JSON.parse(readFileSync(join(root,"benchmark","agent-demo.json"),"utf8"));
        if(!context.demoGuardContract || !context.demoAgentSigner) throw new Error("agent demo signer/relayer is not configured");
        const timeline:any[]=[]; const startedAt=Date.now();
        const push=(stage:string,status:string,details:any={})=>timeline.push({stage,status,elapsedMs:Date.now()-startedAt,...details});
        push("AGENT_REQUEST","complete",{tool:"demo:ping",action:"ping",args:[123]});
        const nonce=BigInt((await context.demoGuardContract.nextNonce(demoState.agent)).toString());
        const iface=new ethers.Interface(["function ping(uint256 id)"]);
        const intent:TransactionIntent={agent:demoState.agent,wallet:demoState.wallet,target:demoState.target,value:0n,data:iface.encodeFunctionData("ping",[Number(nonce%100000n)]),nonce,deadline:BigInt(Math.floor(Date.now()/1000)+900),policyHash:demoState.policyHash};
        const risk=await assessRisk({intent,chainId:context.chainId},context.riskProviders??[]);
        push("CANONICAL_INTENT","complete",{intent:serializeIntent(intent),digest:intentDigest(intent,context.chainId,demoState.guard)});
        push("RISK_INTELLIGENCE",risk.status==="CLEAR"?"clear":"blocked",{status:risk.status,score:risk.score,confidence:risk.confidence,signals:risk.signals});
        if(risk.status!=="CLEAR"){send(res,200,{ok:true,decision:"BLOCK",timeline,summary:{realTransactionSent:false,secondTransactionSent:false}});return;}
        const signature=await signIntent(context.demoAgentSigner,intent,context.chainId,demoState.guard);
        const recovered=ethers.verifyTypedData(buildIntentDomain(context.chainId,demoState.guard),EXECUTION_INTENT_TYPES,typedIntentMessage(intent),signature);
        const signatureVerified=ethers.getAddress(recovered)===ethers.getAddress(demoState.agent);
        push("AGENT_SIGNATURE","verified",{signatureVerified,agent:demoState.agent});
        if(!signatureVerified) throw new Error("agent signature recovery mismatch");
        await context.demoGuardContract.executeFromWallet.staticCall(intent.agent,intent.wallet,intent.target,intent.value,intent.data,intent.nonce,intent.deadline,intent.policyHash,signature);
        push("GUARDIAN_PREFLIGHT","allow",{preflightPassed:true});
        const tx=await context.demoGuardContract.executeFromWallet(intent.agent,intent.wallet,intent.target,intent.value,intent.data,intent.nonce,intent.deadline,intent.policyHash,signature,{gasLimit:500000n});
        const receipt=await tx.wait(); const txHash=receipt?.hash??tx.hash;
        push("REAL_TX","mined",{transactionHash:txHash,blockNumber:receipt?.blockNumber??null,gasUsed:receipt?.gasUsed?.toString()??null,explorer:"https://sepolia.arbiscan.io/tx/"+txHash});
        const attackNonce=BigInt((await context.demoGuardContract.nextNonce(demoState.agent)).toString());
        const signedAttack:TransactionIntent={...intent,nonce:attackNonce,data:iface.encodeFunctionData("ping",[123])};
        const attackSignature=await signIntent(context.demoAgentSigner,signedAttack,context.chainId,demoState.guard);
        const tamperedIntent={...signedAttack,data:iface.encodeFunctionData("ping",[999])};
        const signedHash=ethers.keccak256(signedAttack.data), submittedHash=ethers.keccak256(tamperedIntent.data);
        push("ATTACK","calldata_modified",{signedCalldataHash:signedHash,submittedCalldataHash:submittedHash,hashChanged:signedHash!==submittedHash});
        const attackRecovered=ethers.verifyTypedData(buildIntentDomain(context.chainId,demoState.guard),EXECUTION_INTENT_TYPES,typedIntentMessage(signedAttack),attackSignature);
        try{ await context.demoGuardContract.executeFromWallet.staticCall(tamperedIntent.agent,tamperedIntent.wallet,tamperedIntent.target,tamperedIntent.value,tamperedIntent.data,tamperedIntent.nonce,tamperedIntent.deadline,tamperedIntent.policyHash,attackSignature); send(res,500,{ok:false,error:"tamper_unexpectedly_allowed",timeline}); }
        catch(error){
          const finalNonce=BigInt((await context.demoGuardContract.nextNonce(demoState.agent)).toString());
          push("GUARDIAN_BLOCK","blocked",{signatureVerified:ethers.getAddress(attackRecovered)===ethers.getAddress(demoState.agent),reason:guardianErrorReason(error),transactionSent:false});
          send(res,200,{ok:true,decision:"ALLOW_THEN_BLOCK",timeline,allow:{transactionHash:txHash,blockNumber:receipt?.blockNumber??null,gasUsed:receipt?.gasUsed?.toString()??null,explorer:"https://sepolia.arbiscan.io/tx/"+txHash,signatureVerified,nonce:intent.nonce.toString()},tamper:{signatureVerified:ethers.getAddress(attackRecovered)===ethers.getAddress(demoState.agent),signedCalldataHash:signedHash,submittedCalldataHash:submittedHash,reason:guardianErrorReason(error),transactionSent:false,nonceBeforeAttack:attackNonce.toString(),nonceAfterAttack:finalNonce.toString(),nonceUnchanged:finalNonce===attackNonce},summary:{realTransactionSent:true,secondTransactionSent:false,finalNonce:finalNonce.toString()}});
        }
        return;
      }

      if(req.method==="POST" && req.url==="/v1/agent/demo/tamper-test"){
        const root=process.env.CWF_PROJECT_ROOT ?? process.cwd();
        const demoState=JSON.parse(readFileSync(join(root,"benchmark","agent-demo.json"),"utf8"));
        if(!context.demoGuardContract || !context.demoAgentSigner) throw new Error("agent demo signer/relayer is not configured");
        const nonce=BigInt((await context.demoGuardContract.nextNonce(demoState.agent)).toString());
        const iface=new ethers.Interface(["function ping(uint256 id)"]);
        const signedIntent:TransactionIntent={agent:demoState.agent,wallet:demoState.wallet,target:demoState.target,value:0n,data:iface.encodeFunctionData("ping",[123]),nonce,deadline:BigInt(Math.floor(Date.now()/1000)+900),policyHash:demoState.policyHash};
        const signature=await signIntent(context.demoAgentSigner,signedIntent,context.chainId,demoState.guard);
        const tamperedIntent={...signedIntent,data:iface.encodeFunctionData("ping",[999])};
        const recovered=ethers.verifyTypedData(buildIntentDomain(context.chainId,demoState.guard),EXECUTION_INTENT_TYPES,typedIntentMessage(signedIntent),signature);
        try{
          await context.demoGuardContract.executeFromWallet.staticCall(tamperedIntent.agent,tamperedIntent.wallet,tamperedIntent.target,tamperedIntent.value,tamperedIntent.data,tamperedIntent.nonce,tamperedIntent.deadline,tamperedIntent.policyHash,signature);
          send(res,500,{ok:false,decision:"UNEXPECTED_ALLOW",signatureVerified:ethers.getAddress(recovered)===ethers.getAddress(demoState.agent)});
        }catch(error){
          send(res,200,{ok:true,decision:"BLOCK",signatureVerified:ethers.getAddress(recovered)===ethers.getAddress(demoState.agent),transactionSent:false,attack:"SIGNED_INTENT_CALldata_TAMPER",signedCalldataHash:ethers.keccak256(signedIntent.data),submittedCalldataHash:ethers.keccak256(tamperedIntent.data),reason:guardianErrorReason(error)});
        }
        return;
      }

      if(req.method==="POST" && req.url==="/v1/agent/demo/block-test"){
        const root=process.env.CWF_PROJECT_ROOT ?? process.cwd();
        const demoState=JSON.parse(readFileSync(join(root,"benchmark","agent-demo.json"),"utf8"));
        if(!context.demoGuardContract || !context.demoAgentSigner) throw new Error("agent demo signer/relayer is not configured");
        const nonce=BigInt((await context.demoGuardContract.nextNonce(demoState.agent)).toString());
        const iface=new ethers.Interface(["function blocked(uint256 id)"]);
        const intent:TransactionIntent={agent:demoState.agent,wallet:demoState.wallet,target:demoState.target,value:0n,data:iface.encodeFunctionData("blocked",[999]),nonce,deadline:BigInt(Math.floor(Date.now()/1000)+900),policyHash:demoState.policyHash};
        const signature=await signIntent(context.demoAgentSigner,intent,context.chainId,demoState.guard);
        const recovered=ethers.verifyTypedData(buildIntentDomain(context.chainId,demoState.guard),EXECUTION_INTENT_TYPES,typedIntentMessage(intent),signature);
        if(ethers.getAddress(recovered)!==ethers.getAddress(demoState.agent)) throw new Error("agent signature recovery mismatch");
        try{
          await context.demoGuardContract.executeFromWallet.staticCall(intent.agent,intent.wallet,intent.target,intent.value,intent.data,intent.nonce,intent.deadline,intent.policyHash,signature);
          send(res,500,{ok:false,decision:"UNEXPECTED_ALLOW",signatureVerified:true,intent:serializeIntent(intent)});
        }catch(error){
          const risk=await assessRisk({intent,chainId:context.chainId},context.riskProviders??[]);
          send(res,200,{ok:true,decision:"BLOCK",signatureVerified:true,transactionSent:false,intent:serializeIntent(intent),reason:guardianErrorReason(error),risk});
        }
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
        (req.url === "/v1/intent/prepare" ||
          req.url === "/v1/agent/prepare")
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
        const risk = context.riskProviders
          ? await assessRisk(
              { intent, chainId: context.chainId },
              context.riskProviders,
            )
          : undefined;

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
          risk,
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

        const risk = context.riskProviders
          ? await assessRisk(
              { intent, chainId: context.chainId },
              context.riskProviders,
            )
          : undefined;

        if (risk && risk.status !== "CLEAR") {
          send(res, 200, {
            ok: false,
            decision: "BLOCK",
            reason: risk.status === "BLOCK"
              ? "Risk intelligence blocked the intent"
              : "Risk intelligence requires review; execution is fail-closed",
            risk,
          });
          return;
        }

        try {
          await context.preflight(request);

          send(res, 200, {
            ok: true,
            decision: "ALLOW",
            risk,
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
        (req.url === "/v1/intent/execute" ||
          req.url === "/v1/agent/execute")
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

        const risk = context.riskProviders
          ? await assessRisk(
              { intent, chainId: context.chainId },
              context.riskProviders,
            )
          : undefined;

        if (risk && risk.status !== "CLEAR") {
          send(res, 200, {
            ok: false,
            decision: "BLOCK",
            reason: risk.status === "BLOCK"
              ? "Risk intelligence blocked the intent"
              : "Risk intelligence requires review; execution is fail-closed",
            risk,
          });
          return;
        }

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
            risk,
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
          decision: "ALLOW",
          risk,
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

