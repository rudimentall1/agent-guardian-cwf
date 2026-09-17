import { createServer, Server } from "node:http";
import { ethers } from "hardhat";

import { createCwfApiHandler } from "../api/app";

const FAR_FUTURE = 4102444800n;

function line() {
  console.log("------------------------------------------------------------");
}

function section(title: string) {
  console.log("");
  line();
  console.log(title);
  line();
}

function allow(message: string) {
  console.log(`  [ALLOW] ${message}`);
}

function block(message: string) {
  console.log(`  [BLOCK] ${message}`);
}

async function startServer(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("could not determine API port");
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

function createRecordTool(
  tool: string,
  target: string,
) {
  const iface = new ethers.Interface([
    "function record(uint256 amount)",
  ]);

  return {
    tool,
    action: "record",
    target,

    encode(args: readonly unknown[]) {
      return iface.encodeFunctionData(
        "record",
        [...args],
      );
    },
  };
}

async function main() {
  const [owner, relayer] = await ethers.getSigners();

  section("CWF — API TO GUARDED EXECUTION");

  console.log(
    "This demo shows what happens between an AI agent request",
  );
  console.log(
    "and an on-chain execution decision.",
  );

  console.log("");
  console.log(
    "Agent request -> Intent -> Signature -> Preflight -> Guard -> Wallet -> Target",
  );

  // --------------------------------------------------------------
  // Deploy
  // --------------------------------------------------------------

  section("1. Deploy");

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
    agent.address,
  );
  await wallet.waitForDeployment();

  const target = await (
    await ethers.getContractFactory("RecordingTarget")
  ).deploy();
  await target.waitForDeployment();

  const forbiddenTarget = await (
    await ethers.getContractFactory("RecordingTarget")
  ).deploy();
  await forbiddenTarget.waitForDeployment();

  console.log(
    "Guard:          ",
    await guard.getAddress(),
  );
  console.log(
    "SmartWallet:    ",
    await wallet.getAddress(),
  );
  console.log(
    "Allowed target: ",
    await target.getAddress(),
  );
  console.log(
    "Other target:   ",
    await forbiddenTarget.getAddress(),
  );

  // --------------------------------------------------------------
  // Register agent
  // --------------------------------------------------------------

  section("2. Register agent");

  const network = await ethers.provider.getNetwork();

  const registryDomain = {
    name: "AgentRegistry",
    version: "1",
    chainId: network.chainId,
    verifyingContract: await registry.getAddress(),
  };

  const metadataHash = ethers.keccak256(
    ethers.toUtf8Bytes("cwf-api-demo"),
  );

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
    await registry.register(
      agent.address,
      owner.address,
      metadataHash,
      registrationSignature,
    )
  ).wait();

  await registry.bindWallet(agent.address, await wallet.getAddress());

  console.log(
    "Agent active:",
    await registry.isActiveAgent(agent.address),
  );

  // --------------------------------------------------------------
  // Policy
  // Only target is authorized.
  // --------------------------------------------------------------

  section("3. Create policy");

  const recordSelector = ethers.id(
    "record(uint256)",
  ).slice(0, 10);

  const salt = ethers.keccak256(
    ethers.toUtf8Bytes("cwf-api-demo-policy"),
  );

  await (
    await policyRegistry.connect(owner).createPolicy(
      salt,
      agent.address,
      ethers.parseEther("1"),
      ethers.parseEther("1"),
      0n,
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

  const policyId =
    await policyRegistry.computePolicyId(
      owner.address,
      salt,
    );

  const policyHash =
    await policyRegistry.policyHashOf(policyId);

  console.log(
    "Policy allows:  ",
    await target.getAddress(),
  );
  console.log(
    "Policy hash:    ",
    policyHash,
  );

  // --------------------------------------------------------------
  // API wiring
  // --------------------------------------------------------------

  const allowedTool = createRecordTool(
    "recording-target",
    await target.getAddress(),
  );

  const forbiddenTool = createRecordTool(
    "other-target",
    await forbiddenTarget.getAddress(),
  );

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

  const preflight = async (request: {
    intent: {
      agent: string;
      wallet: string;
      target: string;
      value: bigint;
      data: string;
      nonce: bigint;
      deadline: bigint;
      policyHash: string;
    };
    signature: string;
  }) => {
    try {
      await guard.connect(relayer).executeFromWallet.staticCall(
        request.intent.agent,
        request.intent.wallet,
        request.intent.target,
        request.intent.value,
        request.intent.data,
        request.intent.nonce,
        request.intent.deadline,
        request.intent.policyHash,
        request.signature,
      );
    } catch (error: any) {
      const data =
        error?.data ??
        error?.revert?.data ??
        error?.info?.error?.data;

      if (data) {
        try {
          const parsed =
            guard.interface.parseError(data);

          if (parsed) {
            throw new Error(parsed.name);
          }
        } catch (parseError) {
          if (
            parseError instanceof Error &&
            !parseError.message.startsWith(
              "Cannot read properties",
            )
          ) {
            throw parseError;
          }
        }
      }

      throw new Error(
        error?.shortMessage ??
        error?.message ??
        "simulation_reverted",
      );
    }
  };

  const server = createServer(
    createCwfApiHandler({
      tools: new Map([
        ["recording-target:record", allowedTool],
        ["other-target:record", forbiddenTool],
      ]),
      chainId: network.chainId,
      verifyingContract: await guard.getAddress(),
      executor: guardExecutor,
      preflight,
    }),
  );

  const port = await startServer(server);
  const baseUrl =
    `http://127.0.0.1:${port}`;

  console.log(
    "API:             ",
    baseUrl,
  );

  try {
    const deadline =
      BigInt(
        Math.floor(Date.now() / 1000),
      ) + 3600n;

    // ------------------------------------------------------------
    // Scenario 1
    // ------------------------------------------------------------

    section("4. Normal request");

    console.log(
      "AI request: record(123) on the allowed target",
    );

    const prepared = await postJson(
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

    if (!prepared.body.ok) {
      throw new Error(
        `prepare failed: ${JSON.stringify(prepared.body)}`,
      );
    }

    const signature =
      await agent.signTypedData(
        prepared.body.typedData.domain,
        prepared.body.typedData.types,
        prepared.body.typedData.message,
      );

    const preflight = await postJson(
      `${baseUrl}/v1/intent/preflight`,
      {
        intent: prepared.body.intent,
        signature,
      },
    );

    if (
      !preflight.body.ok ||
      preflight.body.decision !== "ALLOW"
    ) {
      throw new Error(
        `unexpected preflight result: ${JSON.stringify(preflight.body)}`,
      );
    }

    allow("preflight approved the signed intent");

    const execution = await postJson(
      `${baseUrl}/v1/intent/execute`,
      {
        intent: prepared.body.intent,
        signature,
      },
    );

    if (!execution.body.ok) {
      throw new Error(
        `execution failed: ${JSON.stringify(execution.body)}`,
      );
    }

    allow(
      `executed on-chain: ${execution.body.transactionHash}`,
    );

    // ------------------------------------------------------------
    // Scenario 2
    // ------------------------------------------------------------

    section("5. Calldata changed after signing");

    console.log(
      "Original request: record(123)",
    );
    console.log(
      "Attacker sends:   record(999)",
    );

    const tamperedPrepared = await postJson(
      `${baseUrl}/v1/intent/prepare`,
      {
        agent: agent.address,
        wallet: await wallet.getAddress(),
        tool: "recording-target",
        action: "record",
        args: [123],
        value: "0",
        nonce: "1",
        deadline: deadline.toString(),
        policyHash,
      },
    );

    if (!tamperedPrepared.body.ok) {
      throw new Error(
        `tampered prepare failed: ${JSON.stringify(
          tamperedPrepared.body,
        )}`,
      );
    }

    const tamperedSignature =
      await agent.signTypedData(
        tamperedPrepared.body.typedData.domain,
        tamperedPrepared.body.typedData.types,
        tamperedPrepared.body.typedData.message,
      );

    const tamperedIntent = {
      ...tamperedPrepared.body.intent,
      data: allowedTool.encode([999]),
    };

    const tamperedPreflight = await postJson(
      `${baseUrl}/v1/intent/preflight`,
      {
        intent: tamperedIntent,
        signature: tamperedSignature,
      },
    );

    if (
      tamperedPreflight.body.ok ||
      tamperedPreflight.body.decision !== "BLOCK"
    ) {
      throw new Error(
        "tampered intent unexpectedly passed preflight",
      );
    }

    block(
      `preflight blocked the modified intent: ${tamperedPreflight.body.reason}`,
    );

    const tamperedExecution = await postJson(
      `${baseUrl}/v1/intent/execute`,
      {
        intent: tamperedIntent,
        signature: tamperedSignature,
      },
    );

    if (tamperedExecution.body.ok) {
      throw new Error(
        "tampered execution unexpectedly succeeded",
      );
    }

    block("execution blocked as well");

    // ------------------------------------------------------------
    // Scenario 3
    // ------------------------------------------------------------

    section("6. Agent signs an action outside policy");

    console.log(
      "AI request: record(123) on a different target",
    );
    console.log(
      "Signature: valid",
    );
    console.log(
      "Policy:    does not authorize that target",
    );

    const forbiddenPrepared = await postJson(
      `${baseUrl}/v1/intent/prepare`,
      {
        agent: agent.address,
        wallet: await wallet.getAddress(),
        tool: "other-target",
        action: "record",
        args: [123],
        value: "0",
        nonce: "1",
        deadline: deadline.toString(),
        policyHash,
      },
    );

    if (!forbiddenPrepared.body.ok) {
      throw new Error(
        `forbidden prepare failed: ${JSON.stringify(
          forbiddenPrepared.body,
        )}`,
      );
    }

    const forbiddenSignature =
      await agent.signTypedData(
        forbiddenPrepared.body.typedData.domain,
        forbiddenPrepared.body.typedData.types,
        forbiddenPrepared.body.typedData.message,
      );

    const forbiddenPreflight = await postJson(
      `${baseUrl}/v1/intent/preflight`,
      {
        intent: forbiddenPrepared.body.intent,
        signature: forbiddenSignature,
      },
    );

    if (
      forbiddenPreflight.body.ok ||
      forbiddenPreflight.body.decision !== "BLOCK"
    ) {
      throw new Error(
        "policy-violating intent unexpectedly passed preflight",
      );
    }

    block(
      `preflight blocked the policy violation: ${forbiddenPreflight.body.reason}`,
    );

    const forbiddenExecution = await postJson(
      `${baseUrl}/v1/intent/execute`,
      {
        intent: forbiddenPrepared.body.intent,
        signature: forbiddenSignature,
      },
    );

    if (forbiddenExecution.body.ok) {
      throw new Error(
        "policy-violating execution unexpectedly succeeded",
      );
    }

    block("execution blocked by the Guard");

    // ------------------------------------------------------------
    // Final state
    // ------------------------------------------------------------

    section("7. Final state");

    console.log(
      "Allowed target calls:",
      (
        await target.callCount()
      ).toString(),
    );

    console.log(
      "Forbidden target calls:",
      (
        await forbiddenTarget.callCount()
      ).toString(),
    );

    console.log(
      "Agent next nonce:",
      (
        await guard.nextNonce(agent.address)
      ).toString(),
    );

    console.log("");
    console.log(
      "RESULT: API + SIGNATURE + POLICY + GUARD VERIFIED",
    );
    console.log("");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

