import { Connection, Keypair } from "@solana/web3.js";
import { AutonomousCapitalAgentKernel } from "../agent/mandateKernel.js";
import {
  deriveCompleteRouteAccountBundle,
  verifyMainnetPrograms,
} from "../protocol/multihopperPdas.js";
import { estimateTransferLocal } from "../protocol/pricingEngine.js";
import { validateCustomRoute } from "../protocol/routeValidator.js";
import {
  CreateTransferRequest,
  CustomRouteInput,
  EstimateTransferRequest,
} from "../types.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const SOLROUTE_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "quote_multihopper_route",
    description:
      "Calculate exact on-chain 10-tier MultiHopper transfer fees, post-fee recipient delivery, required upfront SOL (including TRM screening & rent), and 50/50 atomic integrator revenue share.",
    inputSchema: {
      type: "object",
      properties: {
        tokenMint: { type: "string" },
        amountRaw: { type: "string" },
        tokenDecimals: { type: "integer" },
        tokenPriceUsd: { type: "number" },
        hops: { type: "integer" },
        destinationCount: { type: "integer" },
        arrivalSeconds: { type: "integer" },
      },
      required: ["tokenMint", "amountRaw"],
    },
  },
  {
    name: "validate_custom_route",
    description:
      "Dry-run validate a MultiHopper custom route (bundles cex/dex/exchanges/kol/contracts/mix or named wallets) and report all MH_018 rule violations before spending rate limits.",
    inputSchema: {
      type: "object",
      properties: {
        route: { type: "object" },
        sourceOwner: { type: "string" },
        recipientWallet: { type: "string" },
        isMultiDestination: { type: "boolean" },
      },
      required: ["route"],
    },
  },
  {
    name: "derive_multihopper_pdas",
    description:
      "Derive deterministic Solana Program Derived Addresses (RouteConfig, RouteState, PermanentDelegate, WrapperMint, Vault, Provider, FeeSchedule, OrchestratorConfig) for MultiHopper Core & Orchestrator.",
    inputSchema: {
      type: "object",
      properties: {
        routeId: { type: "string" },
        tokenMint: { type: "string" },
        providerId: { type: "string" },
      },
      required: ["routeId", "tokenMint"],
    },
  },
  {
    name: "execute_mandate_routed_transfer",
    description:
      "Execute a policy-checked, simulation-gated MultiHopper single or multi-destination transfer via the Autonomous Capital Agent Kernel and emit a SHA-256 provenance receipt.",
    inputSchema: {
      type: "object",
      properties: {
        tokenMint: { type: "string" },
        amountRaw: { type: "string" },
        amountTokens: { type: "string" },
        recipientWallet: { type: "string" },
        destinations: { type: "array" },
        hops: { type: "integer" },
        arrivalSeconds: { type: "integer" },
        tokenPriceUsd: { type: "number" },
        walletSolBalanceLamports: { type: "integer" },
        explicitHumanApproval: { type: "boolean" },
      },
      required: ["tokenMint", "amountRaw", "amountTokens"],
    },
  },
  {
    name: "verify_mainnet_programs",
    description:
      "Verify live Solana Mainnet executable status of MultiHopper Core, Orchestrator, and Token2022 Transfer Hook Guard programs.",
    inputSchema: {
      type: "object",
      properties: {
        rpcUrl: { type: "string" },
      },
    },
  },
  {
    name: "get_provenance_ledger",
    description:
      "Return the hash-chained SHA-256 provenance receipts of all autonomous agent evaluations and executions.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

/**
 * Discovers live hosted tools directly from MultiHopper's production MCP server
 * (`https://multihopper.com/api/mcp`) using unauthenticated `tools/list`.
 */
export async function discoverHostedMultiHopperMcpTools(
  mcpEndpoint = "https://multihopper.com/api/mcp",
  fetchImpl: typeof fetch = fetch
): Promise<McpToolDefinition[]> {
  const res = await fetchImpl(mcpEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
  if (!res.ok) {
    throw new Error(`MultiHopper MCP tools/list returned HTTP ${res.status}`);
  }
  const payload = (await res.json()) as {
    result?: { tools?: McpToolDefinition[] };
  };
  return payload.result?.tools ?? [];
}

/**
 * Standards-compliant JSON-RPC 2.0 MCP Server compatible with Steve Capital MCP Workspace,
 * Claude Code, and Cursor (`protocolVersion: "2025-06-18"`).
 */
export class SolRouteMcpServer {
  private readonly kernel: AutonomousCapitalAgentKernel;
  private readonly agentSigner: Keypair;

  constructor(params: { kernel: AutonomousCapitalAgentKernel; agentSigner: Keypair }) {
    this.kernel = params.kernel;
    this.agentSigner = params.agentSigner;
  }

  public async handleJsonRpc(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (req.id === undefined) {
      // JSON-RPC notification (e.g. notifications/initialized)
      return null;
    }

    try {
      switch (req.method) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              protocolVersion: "2025-06-18",
              serverInfo: {
                name: "solroute-mandate-mcp",
                version: "1.0.0",
              },
              capabilities: {
                tools: {},
              },
            },
          };

        case "tools/list":
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              tools: SOLROUTE_MCP_TOOLS,
            },
          };

        case "tools/call": {
          const name = String(req.params?.name ?? "");
          const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
          const toolOutput = await this.invokeTool(name, args);
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(toolOutput, null, 2),
                },
              ],
              isError: false,
            },
          };
        }

        default:
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: {
              code: -32601,
              message: `Method not found: ${req.method}`,
            },
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
          isError: true,
        },
      };
    }
  }

  private async invokeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "quote_multihopper_route": {
        const estReq: EstimateTransferRequest = {
          tokenMint: String(args.tokenMint),
          amountRaw: String(args.amountRaw),
          tokenDecimals:
            typeof args.tokenDecimals === "number" ? args.tokenDecimals : undefined,
          tokenPriceUsd:
            typeof args.tokenPriceUsd === "number" ? args.tokenPriceUsd : undefined,
          hops: typeof args.hops === "number" ? args.hops : undefined,
          destinationCount:
            typeof args.destinationCount === "number" ? args.destinationCount : undefined,
          arrivalSeconds:
            typeof args.arrivalSeconds === "number" ? args.arrivalSeconds : undefined,
        };
        return estimateTransferLocal(estReq);
      }

      case "validate_custom_route": {
        return validateCustomRoute({
          route: args.route as CustomRouteInput,
          sourceOwner: typeof args.sourceOwner === "string" ? args.sourceOwner : undefined,
          recipientWallet:
            typeof args.recipientWallet === "string" ? args.recipientWallet : undefined,
          isMultiDestination: Boolean(args.isMultiDestination),
        });
      }

      case "derive_multihopper_pdas": {
        return deriveCompleteRouteAccountBundle({
          routeId: BigInt(String(args.routeId)),
          tokenMint: String(args.tokenMint),
          providerId: typeof args.providerId === "string" ? args.providerId : undefined,
        });
      }

      case "execute_mandate_routed_transfer": {
        const transferReq: CreateTransferRequest = {
          tokenMint: String(args.tokenMint),
          amountRaw: String(args.amountRaw),
          amountTokens: String(args.amountTokens),
          sourceOwner: this.agentSigner.publicKey.toBase58(),
          recipientWallet:
            typeof args.recipientWallet === "string" ? args.recipientWallet : undefined,
          destinations: Array.isArray(args.destinations)
            ? (args.destinations as CreateTransferRequest["destinations"])
            : undefined,
          hops: typeof args.hops === "number" ? args.hops : undefined,
          arrivalSeconds:
            typeof args.arrivalSeconds === "number" ? args.arrivalSeconds : undefined,
          tokenPriceUsd:
            typeof args.tokenPriceUsd === "number" ? args.tokenPriceUsd : undefined,
        };
        return this.kernel.executeGuardedRoute({
          request: transferReq,
          signer: this.agentSigner,
          walletSolBalanceLamports:
            typeof args.walletSolBalanceLamports === "number"
              ? args.walletSolBalanceLamports
              : 2_500_000_000,
          explicitHumanApproval: Boolean(args.explicitHumanApproval),
        });
      }

      case "verify_mainnet_programs": {
        const rpcUrl =
          typeof args.rpcUrl === "string"
            ? args.rpcUrl
            : process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
        const conn = new Connection(rpcUrl, "confirmed");
        return verifyMainnetPrograms(conn);
      }

      case "get_provenance_ledger":
        return {
          policy: this.kernel.getPolicy(),
          rolling24hSpendUsd: this.kernel.getRolling24hSpendUsd(),
          receipts: this.kernel.getProvenanceLedger(),
        };

      default:
        throw new Error(`Unknown MCP tool: ${name}`);
    }
  }
}
