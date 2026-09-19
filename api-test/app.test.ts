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

  it("fails closed when execute is configured without Guardian preflight", async function () {
    const target = ethers.Wallet.createRandom().address;
    const agent = ethers.Wallet.createRandom().address;
    const wallet = ethers.Wallet.createRandom().address;
    let executorCalled = false;

    const server = createServer(
      createCwfApiHandler({
        tools: new Map(),
        chainId: 31337n,
        verifyingContract: ethers.Wallet.createRandom().address,
        executor: {
          async executeFromWallet() {
            executorCalled = true;
            return { wait: async () => ({ hash: "0x" }) };
          },
        },
      }),
    );

    const port = await startServer(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/intent/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intent: {
            agent,
            wallet,
            target,
            value: "0",
            data: "0x",
            nonce: "0",
            deadline: "4102444800",
            policyHash: ethers.ZeroHash,
          },
          signature: "0x1234",
        }),
      });

      expect(response.status).to.equal(503);
      expect(await response.json()).to.deep.equal({
        ok: false,
        error: "preflight_not_configured",
      });
      expect(executorCalled).to.equal(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("surfaces risk intelligence in agent prepare", async function () {
    const target = ethers.Wallet.createRandom().address;
    const agent = ethers.Wallet.createRandom().address;
    const wallet = ethers.Wallet.createRandom().address;
    const riskProviders = [{
      name: "test-review",
      async assess() {
        return {
          status: "REVIEW" as const,
          score: 50,
          confidence: 0.4,
          degraded: true,
          signals: [],
        };
      },
    }];
    const tool = defineContractTool("demo", "record", target, "function record(uint256 id)");
    const server = createServer(createCwfApiHandler({
      tools: new Map([["demo:record", tool]]),
      chainId: 31337n,
      verifyingContract: ethers.Wallet.createRandom().address,
      riskProviders,
    }));
    const port = await startServer(server);
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/v1/agent/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent, wallet, tool: "demo", action: "record", args: [1],
          value: "0", nonce: "0", deadline: "4102444800", policyHash: ethers.ZeroHash,
        }),
      });
      const result = await response.json();
      expect(result.ok).to.equal(true);
      expect(result.risk.status).to.equal("REVIEW");
      expect(result.risk.degraded).to.equal(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve()),
      );
    }
  });

  it("blocks execute when Guardian preflight rejects and never calls the executor", async function () {
    const target = ethers.Wallet.createRandom().address;
    const agent = ethers.Wallet.createRandom().address;
    const wallet = ethers.Wallet.createRandom().address;
    let executorCalled = false;
    let preflightCalled = false;

    const server = createServer(
      createCwfApiHandler({
        tools: new Map(),
        chainId: 31337n,
        verifyingContract: ethers.Wallet.createRandom().address,
        executor: {
          async executeFromWallet() {
            executorCalled = true;
            return { wait: async () => ({ hash: "0x" }) };
          },
        },
        preflight: async () => {
          preflightCalled = true;
          throw new Error("PolicyBlocked");
        },
      }),
    );

    const port = await startServer(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/intent/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intent: {
            agent,
            wallet,
            target,
            value: "0",
            data: "0x",
            nonce: "0",
            deadline: "4102444800",
            policyHash: ethers.ZeroHash,
          },
          signature: "0x1234",
        }),
      });

      expect(response.status).to.equal(200);
      expect(await response.json()).to.deep.equal({
        ok: false,
        decision: "BLOCK",
        reason: "PolicyBlocked",
      });
      expect(preflightCalled).to.equal(true);
      expect(executorCalled).to.equal(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
