import { expect } from "chai";
import { createServer, Server } from "node:http";
import { ethers } from "hardhat";

import { createCwfApiHandler } from "../api/app";

const FAR_FUTURE = 4102444800n;

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

async function postJson(
  url: string,
  body: unknown,
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return {
    response,
    body: await response.json(),
  };
}

describe("CWF HTTP API -> real Guard", function () {
  it("blocks tampered calldata, then executes the original signed intent", async function () {
    const [owner, relayer] = await ethers.getSigners();

    const agent = ethers.Wallet.createRandom().connect(
      ethers.provider,
    );

    const registry = await (
      await ethers.getContractFactory("AgentRegistry")
    ).deploy();
    await registry.waitForDeployment();

    const policyRegistry = await (
      await ethers.getContractFactory("PolicyRegistry")
    ).deploy();
    await policyRegistry.waitForDeployment();

    const guard = await (
      await ethers.getContractFactory("AgentExecutionGuard")
    ).deploy(
      await registry.getAddress(),
      await policyRegistry.getAddress(),
    );
    await guard.waitForDeployment();

    const wallet = await (
      await ethers.getContractFactory("AgentSmartWallet")
    ).deploy(
      owner.address,
      await guard.getAddress(),
    );
    await wallet.waitForDeployment();

    const target = await (
      await ethers.getContractFactory("RecordingTarget")
    ).deploy();
    await target.waitForDeployment();

    const metadataHash = ethers.keccak256(
      ethers.toUtf8Bytes("cwf-api"),
    );

    const network = await ethers.provider.getNetwork();

    const registryDomain = {
      name: "AgentRegistry",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await registry.getAddress(),
    };

    const registrationSignature = await agent.signTypedData(
      registryDomain,
      {
        AgentRegistration: [
          { name: "agent", type: "address" },
          { name: "owner", type: "address" },
          { name: "metadataHash", type: "bytes32" },
        ],
      },
      {
        agent: agent.address,
        owner: owner.address,
        metadataHash,
      },
    );

    await (
      await registry.connect(relayer).register(
        agent.address,
        owner.address,
        metadataHash,
        registrationSignature,
      )
    ).wait();

    const recordSelector = ethers.id(
      "record(uint256)",
    ).slice(0, 10);

    const salt = ethers.keccak256(
      ethers.toUtf8Bytes("cwf-api-policy"),
    );

    await (
      await policyRegistry.connect(owner).createPolicy(
        salt,
        agent.address,
        0n,
        0n,
        ethers.parseEther("1"),
        0n,
        FAR_FUTURE,
        [
          {
            target: await target.getAddress(),
            selector: recordSelector,
          },
        ],
        [],
      )
    ).wait();

    const policyId = await policyRegistry.computePolicyId(
      owner.address,
      salt,
    );

    const policyHash = await policyRegistry.policyHashOf(
      policyId,
    );

    const tool = {
      tool: "recording-target",
      action: "record",
      target: await target.getAddress(),
      encode(args: readonly unknown[]) {
        const iface = new ethers.Interface([
          "function record(uint256 amount)",
        ]);

        return iface.encodeFunctionData(
          "record",
          [...args],
        );
      },
    };

    const guardExecutor = {
      async executeFromWallet(
        agentAddress: string,
        walletAddress: string,
        targetAddress: string,
        value: bigint,
        data: string,
        nonce: bigint,
        deadline: bigint,
        intentPolicyHash: string,
        signature: string,
      ) {
        return guard.connect(relayer).executeFromWallet(
          agentAddress,
          walletAddress,
          targetAddress,
          value,
          data,
          nonce,
          deadline,
          intentPolicyHash,
          signature,
        );
      },
    };

    const server = createServer(
      createCwfApiHandler({
        tools: new Map([
          ["recording-target:record", tool],
        ]),
        chainId: network.chainId,
        verifyingContract: await guard.getAddress(),
        executor: guardExecutor,
      }),
    );

    const port = await startServer(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const deadline =
        BigInt(
          Math.floor(Date.now() / 1000),
        ) + 3600n;

      const prepare = await postJson(
        `${baseUrl}/v1/intent/prepare`,
        {
          agent: agent.address,
          wallet: await wallet.getAddress(),
          tool: "recording-target",
          action: "record",
          args: [123],
          value: "0",
          nonce: "0",
          deadline: deadline.toString(),
          policyHash,
        },
      );

      expect(prepare.response.ok).to.equal(true);
      expect(prepare.body.ok).to.equal(true);

      const intent = prepare.body.intent;
      const typedData = prepare.body.typedData;

      const signature = await agent.signTypedData(
        typedData.domain,
        typedData.types,
        typedData.message,
      );

      const tamperedData =
        new ethers.Interface([
          "function record(uint256 amount)",
        ]).encodeFunctionData(
          "record",
          [999],
        );

      const tamperedIntent = {
        ...intent,
        data: tamperedData,
      };

      const tampered = await postJson(
        `${baseUrl}/v1/intent/execute`,
        {
          intent: tamperedIntent,
          signature,
        },
      );

      expect(tampered.response.ok).to.equal(false);
      expect(tampered.body.ok).to.equal(false);
      expect(tampered.body.error).to.contain(
        "InvalidSignature",
      );

      expect(
        await target.callCount(),
      ).to.equal(0n);

      expect(
        await guard.nextNonce(agent.address),
      ).to.equal(0n);

      const valid = await postJson(
        `${baseUrl}/v1/intent/execute`,
        {
          intent,
          signature,
        },
      );

      expect(valid.response.ok).to.equal(true);
      expect(valid.body.ok).to.equal(true);
      expect(valid.body.transactionHash).to.match(
        /^0x[0-9a-f]{64}$/i,
      );

      expect(
        await target.callCount(),
      ).to.equal(1n);


      expect(
        await guard.nextNonce(agent.address),
      ).to.equal(1n);
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

