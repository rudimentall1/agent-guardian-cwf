import { expect } from "chai";
import { ethers } from "hardhat";
import {
  canonicalizeIntent,
  intentDigest,
  signIntent,
  EXECUTION_INTENT_TYPES,
} from "../runtime/intent";

describe("CWF runtime intent layer", function () {
  it("canonicalizes an intent deterministically", async function () {
    const [owner] = await ethers.getSigners();

    const data = "0x12345678";
    const policyHash = ethers.keccak256(
      ethers.toUtf8Bytes("policy-1"),
    );

    const intent = {
      agent: owner.address,
      wallet: owner.address,
      target: owner.address,
      value: 100n,
      data,
      nonce: 0n,
      deadline: 9999999999n,
      policyHash,
    };

    const canonical = canonicalizeIntent(intent);

    expect(canonical.agent).to.equal(owner.address);
    expect(canonical.calldataHash).to.equal(
      ethers.keccak256(data),
    );
    expect(canonical.nonce).to.equal(0n);
  });

  it("produces the same EIP-712 digest as the Solidity guard", async function () {
    const [owner] = await ethers.getSigners();

    const Guard = await ethers.getContractFactory("AgentExecutionGuard");
    const registry = await (
      await ethers.getContractFactory("AgentRegistry")
    ).deploy();
    await registry.waitForDeployment();

    const policies = await (
      await ethers.getContractFactory("PolicyRegistry")
    ).deploy();
    await policies.waitForDeployment();

    const guard = await Guard.deploy(
      await registry.getAddress(),
      await policies.getAddress(),
    );
    await guard.waitForDeployment();

    const chainId = (await ethers.provider.getNetwork()).chainId;

    const intent = {
      agent: owner.address,
      wallet: owner.address,
      target: owner.address,
      value: 100n,
      data: "0x12345678",
      nonce: 0n,
      deadline: 9999999999n,
      policyHash: ethers.keccak256(
        ethers.toUtf8Bytes("policy-1"),
      ),
    };

    const offchainDigest = intentDigest(
      intent,
      chainId,
      await guard.getAddress(),
    );

    const onchainDigest = await guard.hashIntent(
      intent.agent,
      intent.wallet,
      intent.target,
      intent.value,
      ethers.keccak256(intent.data),
      intent.nonce,
      intent.deadline,
      intent.policyHash,
    );

    expect(offchainDigest).to.equal(onchainDigest);
  });

  it("creates an EIP-712 signature recoverable to the agent", async function () {
    const [owner] = await ethers.getSigners();

    const Guard = await ethers.getContractFactory("AgentExecutionGuard");
    const registry = await (
      await ethers.getContractFactory("AgentRegistry")
    ).deploy();
    await registry.waitForDeployment();

    const policies = await (
      await ethers.getContractFactory("PolicyRegistry")
    ).deploy();
    await policies.waitForDeployment();

    const guard = await Guard.deploy(
      await registry.getAddress(),
      await policies.getAddress(),
    );
    await guard.waitForDeployment();

    const chainId = (await ethers.provider.getNetwork()).chainId;

    const intent = {
      agent: owner.address,
      wallet: owner.address,
      target: owner.address,
      value: 0n,
      data: "0x",
      nonce: 0n,
      deadline: 9999999999n,
      policyHash: ethers.keccak256(
        ethers.toUtf8Bytes("policy-1"),
      ),
    };

    const signature = await signIntent(
      owner,
      intent,
      chainId,
      await guard.getAddress(),
    );

    const domain = {
      name: "AgentExecutionGuard",
      version: "1",
      chainId,
      verifyingContract: await guard.getAddress(),
    };

    const canonical = canonicalizeIntent(intent);

    const recovered = ethers.verifyTypedData(
      domain,
      EXECUTION_INTENT_TYPES,
      canonical,
      signature,
    );

    expect(recovered).to.equal(owner.address);
  });
});
