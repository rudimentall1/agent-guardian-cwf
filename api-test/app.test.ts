import { expect } from "chai";
import { createServer, Server } from "node:http";
import { ethers } from "ethers";
import { createCwfApiHandler } from "../api/app";
import { defineContractTool } from "../runtime/tool-request";

async function startServer(
  server: Server,
): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("failed to resolve test server address");
  }

  return address.port;
}

describe("CWF HTTP API", function () {
  it("prepares a canonical transaction intent", async function () {
    const guard = ethers.Wallet.createRandom().address;
    const target = ethers.Wallet.createRandom().address;
    const agent = ethers.Wallet.createRandom().address;
    const wallet = ethers.Wallet.createRandom().address;

    const recordTool = defineContractTool(
      "demo",
      "record",
      target,
      "function record(uint256 id)",
    );

    const server = createServer(
      createCwfApiHandler({
        tools: new Map([["demo:record", recordTool]]),
        chainId: 31337n,
        verifyingContract: guard,
      }),
    );

    const port = await startServer(server);

    try {
      const health = await fetch(
        `http://127.0.0.1:${port}/health`,
      );

      expect(health.ok).to.equal(true);

      const now = BigInt(
        Math.floor(Date.now() / 1000),
      );

      const response = await fetch(
        `http://127.0.0.1:${port}/v1/intent/prepare`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            agent,
            wallet,
            tool: "demo",
            action: "record",
            args: [42],
            value: "0",
            nonce: "7",
            deadline: (now + 3600n).toString(),
            policyHash: ethers.ZeroHash,
          }),
        },
      );

      expect(response.ok).to.equal(true);

      const result = await response.json();

      expect(result.ok).to.equal(true);
      expect(result.intent.agent).to.equal(agent);
      expect(result.intent.wallet).to.equal(wallet);
      expect(result.intent.target).to.equal(target);
      expect(result.intent.nonce).to.equal("7");

      expect(result.intent.data).to.match(/^0x[0-9a-f]+$/i);

      expect(result.intent.calldataHash).to.equal(
        ethers.keccak256(result.intent.data),
      );

      expect(result.typedData.domain.chainId).to.equal(
        "31337",
      );

      expect(result.typedData.message.calldataHash).to.equal(
        result.intent.calldataHash,
      );

      expect(result.digest).to.match(/^0x[0-9a-f]{64}$/i);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});
