import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { createCwfApiHandler } from "./app";
import { defineContractTool } from "../runtime/tool-request";

const port=Number(process.env.CWF_API_PORT??"8787");
const chainId=BigInt(process.env.CWF_CHAIN_ID??"31337");
const verifyingContract=process.env.CWF_GUARD_ADDRESS;
const target=process.env.CWF_TOOL_TARGET;
const projectRoot=process.env.CWF_PROJECT_ROOT??process.cwd();
const dashboardRoot=join(projectRoot,"dist","dashboard");
if(!verifyingContract)throw new Error("CWF_GUARD_ADDRESS is required");
if(!target)throw new Error("CWF_TOOL_TARGET is required");
const recordTool=defineContractTool("demo","record",target,"function record(uint256 id)");
const tools=new Map([["demo:record",recordTool]]);
const apiHandler=createCwfApiHandler({tools,chainId,verifyingContract});
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
