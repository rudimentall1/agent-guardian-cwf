import "dotenv/config";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { ethers } from "ethers";
import { createCwfApiHandler } from "./app";
import { defineContractTool } from "../runtime/tool-request";
import { OnChainRiskProvider } from "../runtime/risk";

const port=Number(process.env.CWF_API_PORT??"8787");
const projectRoot=process.env.CWF_PROJECT_ROOT??process.cwd();
const benchmark=JSON.parse(readFileSync(join(projectRoot,"benchmark","real-100-latest.json"),"utf8"));
const chainId=BigInt(process.env.CWF_CHAIN_ID??String(benchmark.chainId));
const verifyingContract=process.env.CWF_GUARD_ADDRESS??benchmark.deployments?.guard;
const target=process.env.CWF_TOOL_TARGET??benchmark.deployments?.target;
const dashboardRoot=join(projectRoot,"dist","dashboard");
if(!verifyingContract)throw new Error("CWF_GUARD_ADDRESS is required");
if(!target)throw new Error("CWF_TOOL_TARGET is required");
const agentTool=defineContractTool("demo","ping",target,"function ping(uint256 id)");
const tools=new Map([["demo:ping",agentTool]]);
const riskRpc=process.env.CWF_RISK_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc";
const riskProviders=[new OnChainRiskProvider({rpcUrl:riskRpc})];
const rpcProvider=new ethers.JsonRpcProvider(riskRpc);
const relayerKey=process.env.PRIVATE_KEY;
const guardAbi=["function executeFromWallet(address agent,address wallet,address target,uint256 value,bytes data,uint256 nonce,uint256 deadline,bytes32 policyHash,bytes signature) returns (bytes)","function nextNonce(address agent) view returns (uint256)"];
const guardContract=relayerKey && verifyingContract
  ? new ethers.Contract(verifyingContract,guardAbi,new ethers.Wallet(relayerKey,rpcProvider))
  : undefined;
const guardExecutor=guardContract ? {
  async executeFromWallet(agent:string,wallet:string,target:string,value:bigint,data:string,nonce:bigint,deadline:bigint,policyHash:string,signature:string){
    return guardContract.executeFromWallet(agent,wallet,target,value,data,nonce,deadline,policyHash,signature);
  },
} : undefined;
const demoStatePath=join(projectRoot,"benchmark","agent-demo.json");
const demoState=JSON.parse(readFileSync(demoStatePath,"utf8"));
const demoAgentSigner=process.env.AGENT_DEMO_PRIVATE_KEY ? new ethers.Wallet(process.env.AGENT_DEMO_PRIVATE_KEY,rpcProvider) : undefined;
if(demoAgentSigner && ethers.getAddress(demoAgentSigner.address)!==ethers.getAddress(demoState.agent)) throw new Error("AGENT_DEMO_PRIVATE_KEY does not match benchmark/agent-demo.json agent");
const demoGuardContract=relayerKey ? new ethers.Contract(demoState.guard,guardAbi,new ethers.Wallet(relayerKey,rpcProvider)) : undefined;
const preflight=guardContract ? async (request:{intent:{agent:string;wallet:string;target:string;value:bigint;data:string;nonce:bigint;deadline:bigint;policyHash:string};signature:string}) => {
  try {
    await guardContract.executeFromWallet.staticCall(request.intent.agent,request.intent.wallet,request.intent.target,request.intent.value,request.intent.data,request.intent.nonce,request.intent.deadline,request.intent.policyHash,request.signature);
  } catch (error:any) {
    const data=error?.data ?? error?.revert?.data ?? error?.info?.error?.data;
    if(data){try{const parsed=new ethers.Interface(guardAbi).parseError(data);if(parsed)throw new Error(parsed.name);}catch(parseError){if(parseError instanceof Error && !parseError.message.startsWith("Cannot read properties"))throw parseError;}}
    throw new Error(error?.shortMessage ?? error?.message ?? "simulation_reverted");
  }
} : undefined;
const apiHandler=createCwfApiHandler({tools,chainId,verifyingContract,riskProviders,executor:guardExecutor,preflight,demoGuardContract,demoAgentSigner});
const mime:Record<string,string>={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml",".json":"application/json"};
const server=createServer(async(req:IncomingMessage,res:ServerResponse)=>{
 if(req.url?.startsWith("/v1/")||req.url==="/health")return apiHandler(req,res);
 const requested=req.url==="/"?"/index.html":(req.url??"/index.html").split("?")[0];
 const file=join(dashboardRoot,requested.replace(/^\/+?/,""));
 const fallback=join(dashboardRoot,"index.html");
 try{const targetFile=existsSync(file)?file:fallback;res.statusCode=200;res.setHeader("content-type",mime[extname(targetFile)]??"text/plain; charset=utf-8");res.end(readFileSync(targetFile));}
 catch{res.statusCode=503;res.end("Dashboard not built. Run npm run build:dashboard.");}
});
server.listen(port,()=>console.log("CWF API + dashboard listening on http://127.0.0.1:"+port));
