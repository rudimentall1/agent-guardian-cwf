import { createServer } from "node:http";
import { ethers } from "ethers";
import { createCwfApiHandler } from "./app";
import { defineContractTool } from "../runtime/tool-request";

const port = Number(process.env.CWF_API_PORT ?? "8787");
const chainId = BigInt(process.env.CWF_CHAIN_ID ?? "31337");
const verifyingContract = process.env.CWF_GUARD_ADDRESS;

const target = process.env.CWF_TOOL_TARGET;

if (!verifyingContract) {
  throw new Error("CWF_GUARD_ADDRESS is required");
}

if (!target) {
  throw new Error("CWF_TOOL_TARGET is required");
}

const recordTool = defineContractTool(
  "demo",
  "record",
  target,
  "function record(uint256 id)"
);

const tools = new Map([
  ["demo:record", recordTool],
]);

const server = createServer(
  createCwfApiHandler({
    tools,
    chainId,
    verifyingContract,
  })
);

server.listen(port, () => {
  console.log(`CWF API listening on http://127.0.0.1:${port}`);
});
