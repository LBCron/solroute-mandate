import { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AutonomousCapitalAgentKernel,
  createDefaultMandatePolicy,
} from "../src/agent/mandateKernel.js";
import {
  HttpMultiHopperClient,
  SandboxMultiHopperBackend,
} from "../src/protocol/multihopperClient.js";
import { MAINNET_USDC_MINT, NATIVE_SOL_MINT } from "../src/protocol/multihopperPdas.js";
import {
  MultiHopperWebhookRouter,
  signMultiHopperWebhookPayload,
  verifyMultiHopperWebhookSignature,
} from "../src/protocol/webhookVerifier.js";
import { createSolRouteServer } from "../src/server/appServer.js";
import { MultiHopperProtocolError } from "../src/types.js";

describe("Autonomous Capital Agent Kernel, Actor Mailbox & Mandate Guardrails", () => {
  it("serializes concurrent wallet executions via Actor Mailbox so daily spend limits cannot race", async () => {
    const signer = Keypair.generate();
    const recipient = Keypair.generate().publicKey.toBase58();
    const backend = new SandboxMultiHopperBackend();
    const policy = {
      ...createDefaultMandatePolicy(signer.publicKey.toBase58()),
      maxSingleTransferUsd: 100,
      maxDailySpendUsd: 150, // Two $90 transfers ($180) cannot both pass!
      requireHumanApprovalAboveUsd: 100,
    };

    const kernel = new AutonomousCapitalAgentKernel({ policy, backend });

    const buildReq = (extId: string) => ({
      tokenMint: MAINNET_USDC_MINT,
      amountRaw: "90000000", // $90 USDC
      amountTokens: "90",
      tokenDecimals: 6,
      tokenSymbol: "USDC",
      tokenPriceUsd: 1.0,
      sourceOwner: signer.publicKey.toBase58(),
      recipientWallet: recipient,
      hops: 3,
      arrivalSeconds: 180,
      externalId: extId,
    });

    // Fire concurrently in parallel
    const [r1, r2] = await Promise.all([
      kernel.executeGuardedRoute({
        request: buildReq("concurrent-1"),
        signer,
        walletSolBalanceLamports: 1_000_000_000,
      }),
      kernel.executeGuardedRoute({
        request: buildReq("concurrent-2"),
        signer,
        walletSolBalanceLamports: 1_000_000_000,
      }),
    ]);

    expect(r1.mandateVerdict.status).toBe("ALLOW_AUTONOMOUS");
    expect(r1.simulationPassed).toBe(true);
    expect(r1.transfer?.status).toBe("completed");

    expect(r2.mandateVerdict.status).toBe("DENY");
    expect(r2.simulationPassed).toBe(false);
    expect(r2.mandateVerdict.reasons[0]).toContain("exceeds maxDailySpendUsd");
    expect(kernel.getRolling24hSpendUsd()).toBe(90);
    expect(r1.provenanceHashSha256).not.toBe(r2.provenanceHashSha256);
  });

  it("enforces human co-signature threshold and emergency kill-switch cleanly", async () => {
    const signer = Keypair.generate();
    const recipient = Keypair.generate().publicKey.toBase58();
    const kernel = new AutonomousCapitalAgentKernel({
      policy: createDefaultMandatePolicy(signer.publicKey.toBase58()),
      backend: new SandboxMultiHopperBackend(),
    });

    const req150 = {
      tokenMint: MAINNET_USDC_MINT,
      amountRaw: "150000000", // $150 > $100 autonomous cap
      amountTokens: "150",
      tokenDecimals: 6,
      tokenPriceUsd: 1.0,
      sourceOwner: signer.publicKey.toBase58(),
      recipientWallet: recipient,
      hops: 4,
      arrivalSeconds: 300,
    };

    const gated = await kernel.executeGuardedRoute({
      request: req150,
      signer,
      walletSolBalanceLamports: 1_000_000_000,
      explicitHumanApproval: false,
    });
    expect(gated.mandateVerdict.status).toBe("REQUIRE_SIGNATURE_APPROVAL");
    expect(gated.transfer).toBeUndefined();

    const approved = await kernel.executeGuardedRoute({
      request: { ...req150, externalId: "approved-150" },
      signer,
      walletSolBalanceLamports: 1_000_000_000,
      explicitHumanApproval: true,
    });
    expect(approved.mandateVerdict.status).toBe("ALLOW_AUTONOMOUS");
    expect(approved.transfer?.status).toBe("completed");

    kernel.updatePolicy({ emergencyHalt: true });
    const halted = await kernel.executeGuardedRoute({
      request: { ...req150, amountRaw: "25000000", amountTokens: "25", externalId: "halted-25" },
      signer,
      walletSolBalanceLamports: 1_000_000_000,
    });
    expect(halted.mandateVerdict.status).toBe("DENY");
    expect(halted.mandateVerdict.reasons[0]).toContain("Emergency halt");
  });
});

describe("HMAC-SHA256 Webhook Engine & Full HTTP + MCP Server Integration", () => {
  let baseUrl = "";
  const secret = "whsec_unit_test_secret_key_2026";
  const instance = createSolRouteServer({ webhookSecret: secret });

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      instance.server.listen(0, "127.0.0.1", () => {
        const addr = instance.server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => instance.server.close(() => resolve()));
  });

  it("verifies timing-safe HMAC-SHA256 signatures and deduplicates webhook retries", async () => {
    const router = new MultiHopperWebhookRouter(secret);
    let handledCount = 0;
    router.on("transfer.completed", () => {
      handledCount += 1;
    });

    const body = JSON.stringify({
      id: "evt_retry_01",
      type: "transfer.completed",
      createdAt: "2026-11-16T15:00:00.000Z",
      transferId: 42,
      data: { status: "completed" },
    });

    const validSig = signMultiHopperWebhookPayload(body, secret);
    expect(verifyMultiHopperWebhookSignature(body, validSig, secret)).toBe(true);
    expect(verifyMultiHopperWebhookSignature(body, "deadbeef", secret)).toBe(false);
    expect(verifyMultiHopperWebhookSignature(`${body} `, validSig, secret)).toBe(false);

    const first = await router.processRawWebhook(body, validSig);
    const retry = await router.processRawWebhook(body, validSig);
    expect(first).toEqual({ accepted: true, duplicate: false, event: JSON.parse(body) });
    expect(retry).toEqual({ accepted: true, duplicate: true, event: JSON.parse(body) });
    expect(handledCount).toBe(1);
  });

  it("serves Cockpit UI, REST endpoints, HMAC webhooks, and JSON-RPC 2.0 MCP tools end-to-end", async () => {
    const htmlRes = await fetch(`${baseUrl}/`);
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html).toContain("SolRouteMandate");

    // MCP initialize + tools/list + tools/call
    const initRes = await fetch(`${baseUrl}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    }).then((r) => r.json());
    expect(initRes.result.protocolVersion).toBe("2025-06-18");

    const listRes = await fetch(`${baseUrl}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }).then((r) => r.json());
    expect(listRes.result.tools.length).toBe(6);

    const recipientA = Keypair.generate().publicKey.toBase58();
    const recipientB = Keypair.generate().publicKey.toBase58();
    const execMcpRes = await fetch(`${baseUrl}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "execute_mandate_routed_transfer",
          arguments: {
            tokenMint: NATIVE_SOL_MINT,
            amountRaw: "500000000",
            amountTokens: "0.5",
            tokenPriceUsd: 150,
            hops: 4,
            arrivalSeconds: 300,
            destinations: [
              { wallet: recipientA, amountRaw: "300000000" },
              { wallet: recipientB, amountRaw: "200000000" },
            ],
            walletSolBalanceLamports: 2_500_000_000,
          },
        },
      }),
    }).then((r) => r.json());

    expect(execMcpRes.result.isError).toBe(false);
    const parsedReceipt = JSON.parse(execMcpRes.result.content[0].text);
    expect(parsedReceipt.mandateVerdict.status).toBe("ALLOW_AUTONOMOUS");
    expect(parsedReceipt.transfer.destinations.length).toBe(2);
    expect(parsedReceipt.transfer.destinations[0].status).toBe("paid");

    // Reject unauthenticated webhook, accept signed webhook
    const badWh = await fetch(`${baseUrl}/api/webhooks/multihopper`, {
      method: "POST",
      headers: { "x-multihopper-signature": "00".repeat(32) },
      body: JSON.stringify({
        id: "evt_http_1",
        type: "payout.completed",
        createdAt: new Date().toISOString(),
        data: {},
      }),
    });
    expect(badWh.status).toBe(401);

    const simWh = await fetch(`${baseUrl}/api/webhooks/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "transfer.completed", transferId: parsedReceipt.transfer.id }),
    });
    expect(simWh.status).toBe(200);
  });

  it("enforces Idempotency-Key headers and maps MH_XXX errors in HttpMultiHopperClient", async () => {
    expect(() => new HttpMultiHopperClient({ apiKey: "invalid_key" })).toThrowError(
      MultiHopperProtocolError
    );

    let capturedHeaders: Record<string, string> = {};
    const mockFetch: typeof fetch = async (_input, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          error: { code: "MH_040", message: "Quote stale: tier shifted" },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    };

    const client = new HttpMultiHopperClient({
      apiKey: "mh_test_demo123456",
      fetchImpl: mockFetch,
    });

    await expect(client.prepareTransfer(42, "idem-fixed-key-001")).rejects.toMatchObject({
      code: "MH_040",
      httpStatus: 409,
    });
    expect(capturedHeaders["x-api-key"]).toBe("mh_test_demo123456");
    expect(capturedHeaders["Idempotency-Key"]).toBe("idem-fixed-key-001");
  });

  it("enforces MH_033 externalId idempotency, MH_039 keeper lock, MH_041 dispersion binding, and MH_080 rescue guards", async () => {
    const sandbox = new SandboxMultiHopperBackend();
    const sender = Keypair.generate().publicKey.toBase58();
    const destA = Keypair.generate().publicKey.toBase58();
    const destB = Keypair.generate().publicKey.toBase58();

    const created1 = await sandbox.createTransfer({
      tokenMint: MAINNET_USDC_MINT,
      amountRaw: "50000000",
      amountTokens: "50",
      sourceOwner: sender,
      destinations: [
        { wallet: destA, amountRaw: "30000000" },
        { wallet: destB, amountRaw: "20000000" },
      ],
      hops: 3,
      arrivalSeconds: 180,
      externalId: "order-idem-1",
    });

    // Exact replay returns same transfer idempotently
    const replay = await sandbox.createTransfer({
      tokenMint: MAINNET_USDC_MINT,
      amountRaw: "50000000",
      amountTokens: "50",
      sourceOwner: sender,
      destinations: [
        { wallet: destA, amountRaw: "30000000" },
        { wallet: destB, amountRaw: "20000000" },
      ],
      hops: 3,
      arrivalSeconds: 180,
      externalId: "order-idem-1",
    });
    expect(replay.id).toBe(created1.id);

    // Mutated amount with same externalId throws MH_033
    await expect(
      sandbox.createTransfer({
        tokenMint: MAINNET_USDC_MINT,
        amountRaw: "60000000",
        amountTokens: "60",
        sourceOwner: sender,
        destinations: [
          { wallet: destA, amountRaw: "30000000" },
          { wallet: destB, amountRaw: "30000000" },
        ],
        hops: 3,
        arrivalSeconds: 180,
        externalId: "order-idem-1",
      })
    ).rejects.toMatchObject({ code: "MH_033" });

    // Confirm without keeperFundingSignature throws MH_039
    await expect(
      sandbox.confirmBroadcast(created1.id, { routeInitSignatures: ["sig_r0"] })
    ).rejects.toMatchObject({ code: "MH_039" });

    // Lock keeperFundingSignature, then omit dispersionInitSignatures -> throws MH_041
    await sandbox.confirmBroadcast(created1.id, {
      routeInitSignatures: [],
      keeperFundingSignature: "sig_keeper",
    });
    await expect(
      sandbox.confirmBroadcast(created1.id, { routeInitSignatures: ["sig_r0"] })
    ).rejects.toMatchObject({ code: "MH_041" });

    // Rescue in non-recoverable phase throws MH_080
    await expect(sandbox.rescuePrepare(created1.id)).rejects.toMatchObject({
      code: "MH_080",
    });
  });
});
