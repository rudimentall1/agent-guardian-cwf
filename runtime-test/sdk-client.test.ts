import { expect } from "chai";
import { ethers } from "ethers";
import { AgentGuardianClient } from "../sdk";

describe("CWF Agent Guardian SDK", () => {
  const agent = ethers.Wallet.createRandom();
  const wallet = ethers.Wallet.createRandom();
  const target = ethers.Wallet.createRandom().address;
  const policyHash = ethers.ZeroHash;

  function mockFetch(body: unknown, status = 200): typeof fetch {
    return (async () => ({
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return body;
      },
    })) as Response;
  }

  it("prepares through the public agent API and signs returned EIP-712 data", async () => {
    const intent = {
      agent: agent.address,
      wallet: wallet.address,
      target,
      value: 0n,
      data: "0x1234",
      nonce: 7n,
      deadline: 9999999999n,
      policyHash,
    };
    const domain = {
      name: "AgentExecutionGuard",
      version: "1",
      chainId: 421614n,
      verifyingContract: target,
    };
    const body = {
      ok: true,
      intent: {
        agent: intent.agent,
        wallet: intent.wallet,
        target: intent.target,
        value: "0",
        data: intent.data,
        nonce: "7",
        deadline: "9999999999",
        policyHash,
      },
      typedData: {
        domain,
        primaryType: "ExecutionIntent",
        types: {
          ExecutionIntent: [
            { name: "agent", type: "address" },
            { name: "wallet", type: "address" },
            { name: "target", type: "address" },
            { name: "value", type: "uint256" },
            { name: "calldataHash", type: "bytes32" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
            { name: "policyHash", type: "bytes32" },
          ],
        },
        message: {
          ...intent,
          value: "0",
          calldataHash: ethers.keccak256(intent.data),
          nonce: "7",
          deadline: "9999999999",
        },
      },
      digest: ethers.TypedDataEncoder.hash(
        domain,
        {
          ExecutionIntent: [
            { name: "agent", type: "address" },
            { name: "wallet", type: "address" },
            { name: "target", type: "address" },
            { name: "value", type: "uint256" },
            { name: "calldataHash", type: "bytes32" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
            { name: "policyHash", type: "bytes32" },
          ],
        },
        {
          ...intent,
          value: 0n,
          calldataHash: ethers.keccak256(intent.data),
        },
      ),
    };

    const client = new AgentGuardianClient({
      baseUrl: "http://guardian.test",
      fetchImpl: mockFetch(body),
    });
    const prepared = await client.prepare({
      agent: agent.address,
      wallet: wallet.address,
      tool: "demo",
      action: "ping",
      args: [123],
      nonce: "7",
      deadline: "9999999999",
      policyHash,
    });

    expect(prepared.intent.data).to.equal("0x1234");
    const signature = await agent.signTypedData(
      prepared.typedData.domain,
      prepared.typedData.types,
      prepared.typedData.message,
    );
    expect(ethers.verifyTypedData(
      prepared.typedData.domain,
      prepared.typedData.types,
      prepared.typedData.message,
      signature,
    )).to.equal(agent.address);
  });
  it("sends signed intents to preflight and execution endpoints", async () => {
    const calls: string[] = [];
    const client = new AgentGuardianClient({
      baseUrl: "http://guardian.test/",
      fetchImpl: (async (url) => {
        calls.push(String(url));
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              decision: "ALLOW",
              transactionHash: "0xabc",
            };
          },
        };
      }) as typeof fetch,
    });

    const intent = {
      agent: agent.address,
      wallet: wallet.address,
      target,
      value: 0n,
      data: "0x",
      nonce: 0n,
      deadline: 9999999999n,
      policyHash,
    };

    const preflight = await client.preflight(intent, "0x1234");
    const execution = await client.execute(intent, "0x1234");

    expect(preflight.decision).to.equal("ALLOW");
    expect(execution.transactionHash).to.equal("0xabc");
    expect(calls).to.deep.equal([
      "http://guardian.test/v1/intent/preflight",
      "http://guardian.test/v1/agent/execute",
    ]);
  });
});
