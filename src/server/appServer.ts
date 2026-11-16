import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair } from "@solana/web3.js";
import {
  AutonomousCapitalAgentKernel,
  createDefaultMandatePolicy,
} from "../agent/mandateKernel.js";
import {
  discoverHostedMultiHopperMcpTools,
  JsonRpcRequest,
  SolRouteMcpServer,
} from "../mcp/mcpServer.js";
import {
  HttpMultiHopperClient,
  MultiHopperBackend,
  SandboxMultiHopperBackend,
} from "../protocol/multihopperClient.js";
import {
  DEFAULT_INTEGRATOR_REWARDS_WALLET,
  deriveCompleteRouteAccountBundle,
  verifyMainnetPrograms,
} from "../protocol/multihopperPdas.js";
import { estimateTransferLocal } from "../protocol/pricingEngine.js";
import { validateCustomRoute } from "../protocol/routeValidator.js";
import { loadKeypairFromBase58OrJson } from "../protocol/txSignerBroadcaster.js";
import {
  MultiHopperWebhookRouter,
  signMultiHopperWebhookPayload,
} from "../protocol/webhookVerifier.js";
import {
  CapitalMandatePolicy,
  CreateTransferRequest,
  CustomRouteInput,
  EstimateTransferRequest,
  MultiHopperProtocolError,
  MultiHopperWebhookEvent,
} from "../types.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function readRawBody(req: IncomingMessage, maxBytes = 256_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error("Payload too large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export interface AppServerInstance {
  server: Server;
  kernel: AutonomousCapitalAgentKernel;
  agentSigner: Keypair;
  webhookEvents: MultiHopperWebhookEvent[];
  webhookSecret: string;
}

export function createSolRouteServer(opts?: {
  agentSigner?: Keypair;
  backend?: MultiHopperBackend;
  webhookSecret?: string;
  publicDir?: string;
  solanaRpcUrl?: string;
}): AppServerInstance {
  const agentSigner =
    opts?.agentSigner ??
    (process.env.SOLANA_PRIVATE_KEY
      ? loadKeypairFromBase58OrJson(process.env.SOLANA_PRIVATE_KEY)
      : Keypair.generate());

  const backend =
    opts?.backend ??
    (process.env.MH_API_KEY
      ? new HttpMultiHopperClient({ apiKey: process.env.MH_API_KEY })
      : new SandboxMultiHopperBackend());

  const kernel = new AutonomousCapitalAgentKernel({
    policy: createDefaultMandatePolicy(agentSigner.publicKey.toBase58()),
    backend,
  });

  const mcpServer = new SolRouteMcpServer({ kernel, agentSigner });

  const webhookSecret =
    opts?.webhookSecret ?? process.env.MH_WEBHOOK_SECRET ?? "whsec_solroute_mandate_dev_secret";
  const webhookRouter = new MultiHopperWebhookRouter(webhookSecret);
  const webhookEvents: MultiHopperWebhookEvent[] = [];
  webhookRouter.on("*", (ev) => {
    webhookEvents.unshift(ev);
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const publicDir = opts?.publicDir ?? resolve(here, "../../public");
  const solanaRpcUrl =
    opts?.solanaRpcUrl ?? process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const { pathname } = url;

      if (req.method === "GET" && pathname === "/api/health") {
        return sendJson(res, 200, {
          ok: true,
          mode: process.env.MH_API_KEY ? "live_multihopper_api" : "deterministic_sandbox",
          agentWallet: agentSigner.publicKey.toBase58(),
          integratorRewardsWallet: DEFAULT_INTEGRATOR_REWARDS_WALLET,
          rolling24hSpendUsd: kernel.getRolling24hSpendUsd(),
          provenanceCount: kernel.getProvenanceLedger().length,
        });
      }

      if (req.method === "GET" && pathname === "/api/agent/mandate") {
        return sendJson(res, 200, {
          policy: kernel.getPolicy(),
          rolling24hSpendUsd: kernel.getRolling24hSpendUsd(),
          receipts: kernel.getProvenanceLedger(),
          webhookEvents,
        });
      }

      if (req.method === "POST" && pathname === "/api/agent/mandate") {
        const raw = await readRawBody(req);
        const patch = JSON.parse(raw.toString("utf8")) as Partial<CapitalMandatePolicy>;
        const updated = kernel.updatePolicy(patch);
        return sendJson(res, 200, { policy: updated });
      }

      if (req.method === "POST" && pathname === "/api/pricing/estimate") {
        const raw = await readRawBody(req);
        const body = JSON.parse(raw.toString("utf8")) as EstimateTransferRequest;
        const estimate = estimateTransferLocal(body);
        return sendJson(res, 200, estimate);
      }

      if (req.method === "POST" && pathname === "/api/routes/validate") {
        const raw = await readRawBody(req);
        const body = JSON.parse(raw.toString("utf8")) as {
          route: CustomRouteInput;
          sourceOwner?: string;
          recipientWallet?: string;
          destinationWallets?: string[];
          isMultiDestination?: boolean;
        };
        const result = validateCustomRoute({
          route: body.route,
          sourceOwner: body.sourceOwner ?? agentSigner.publicKey.toBase58(),
          recipientWallet: body.recipientWallet,
          destinationWallets: body.destinationWallets,
          isMultiDestination: Boolean(body.isMultiDestination),
        });
        return sendJson(res, 200, { valid: true, ...result });
      }

      if (req.method === "POST" && pathname === "/api/pdas/derive") {
        const raw = await readRawBody(req);
        const body = JSON.parse(raw.toString("utf8")) as {
          routeId: string | number;
          tokenMint: string;
          providerId?: string;
        };
        const bundle = deriveCompleteRouteAccountBundle({
          routeId: BigInt(String(body.routeId)),
          tokenMint: body.tokenMint,
          providerId: body.providerId,
        });
        return sendJson(res, 200, bundle);
      }

      if (req.method === "GET" && pathname === "/api/mainnet/programs") {
        const conn = new Connection(solanaRpcUrl, "confirmed");
        const programs = await verifyMainnetPrograms(conn);
        return sendJson(res, 200, { rpcUrl: solanaRpcUrl, programs });
      }

      if (req.method === "GET" && pathname === "/api/mcp/discover") {
        const hostedTools = await discoverHostedMultiHopperMcpTools();
        return sendJson(res, 200, {
          endpoint: "https://multihopper.com/api/mcp",
          hostedCount: hostedTools.length,
          hostedTools: hostedTools.map((t) => ({
            name: t.name,
            description: t.description,
          })),
        });
      }

      if (req.method === "POST" && pathname === "/api/agent/execute") {
        const raw = await readRawBody(req);
        const body = JSON.parse(raw.toString("utf8")) as {
          request: Omit<CreateTransferRequest, "sourceOwner"> & { sourceOwner?: string };
          walletSolBalanceLamports?: number;
          explicitHumanApproval?: boolean;
        };
        const fullReq: CreateTransferRequest = {
          ...body.request,
          sourceOwner: body.request.sourceOwner ?? agentSigner.publicKey.toBase58(),
        };
        const receipt = await kernel.executeGuardedRoute({
          request: fullReq,
          signer: agentSigner,
          walletSolBalanceLamports: body.walletSolBalanceLamports ?? 3_000_000_000,
          explicitHumanApproval: Boolean(body.explicitHumanApproval),
        });
        return sendJson(res, 200, receipt);
      }

      if (req.method === "POST" && pathname === "/api/webhooks/multihopper") {
        const raw = await readRawBody(req);
        const sig = req.headers["x-multihopper-signature"];
        const sigStr = Array.isArray(sig) ? sig[0] : sig;
        const result = await webhookRouter.processRawWebhook(raw, sigStr);
        if (!result.accepted) {
          return sendJson(res, 401, { error: "Invalid x-multihopper-signature" });
        }
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && pathname === "/api/webhooks/simulate") {
        const raw = await readRawBody(req);
        const parsed = JSON.parse(raw.toString("utf8")) as Partial<MultiHopperWebhookEvent>;
        const eventPayload: MultiHopperWebhookEvent = {
          id: parsed.id ?? `evt_${crypto.randomUUID().slice(0, 10)}`,
          type: parsed.type ?? "transfer.completed",
          createdAt: new Date().toISOString(),
          transferId: parsed.transferId ?? 1001,
          data: parsed.data ?? { status: "completed", hopsCompleted: 4 },
        };
        const serialized = JSON.stringify(eventPayload);
        const hmac = signMultiHopperWebhookPayload(serialized, webhookSecret);
        const result = await webhookRouter.processRawWebhook(serialized, hmac);
        return sendJson(res, 200, { signatureHeader: hmac, ...result });
      }

      if (req.method === "POST" && pathname === "/api/mcp") {
        const raw = await readRawBody(req);
        const rpcReq = JSON.parse(raw.toString("utf8")) as JsonRpcRequest;
        const rpcRes = await mcpServer.handleJsonRpc(rpcReq);
        return sendJson(res, 200, rpcRes ?? { ok: true });
      }

      // Static asset serving from public/
      if (req.method === "GET") {
        const relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
        const candidate = resolve(join(publicDir, relPath));
        if (!candidate.startsWith(publicDir)) {
          return sendJson(res, 403, { error: "Forbidden" });
        }
        try {
          const content = await readFile(candidate);
          const mime = MIME_TYPES[extname(candidate)] ?? "application/octet-stream";
          res.writeHead(200, { "Content-Type": mime });
          res.end(content);
          return;
        } catch {
          return sendJson(res, 404, { error: "Not found" });
        }
      }

      return sendJson(res, 404, { error: "Route not found" });
    } catch (err) {
      if (err instanceof MultiHopperProtocolError) {
        return sendJson(res, err.httpStatus, {
          error: {
            code: err.code,
            message: err.message,
            problems: err.problems,
          },
        });
      }
      const message = err instanceof Error ? err.message : "Internal server error";
      return sendJson(res, 500, { error: { code: "INTERNAL_ERROR", message } });
    }
  });

  return { server, kernel, agentSigner, webhookEvents, webhookSecret };
}
