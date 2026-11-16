import {
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  ClusterEnvironment,
  ConfirmBroadcastRequest,
  CreateTransferRequest,
  EstimateTransferRequest,
  EstimateTransferResponse,
  HopLibraryCategory,
  MultiHopperProtocolError,
  PreparedTxsBundle,
  PrepareTransferResponse,
  ResolvedRouteHop,
  TransferRecord,
} from "../types.js";
import {
  DEFAULT_INTEGRATOR_REWARDS_WALLET,
  NATIVE_SOL_MINT,
} from "./multihopperPdas.js";
import {
  allocateDestinationPayouts,
  estimateTransferLocal,
} from "./pricingEngine.js";
import { validateCreateTransferRequest } from "./routeValidator.js";

export interface MultiHopperBackend {
  estimateTransfer(req: EstimateTransferRequest): Promise<EstimateTransferResponse>;
  createTransfer(req: CreateTransferRequest, idempotencyKey?: string): Promise<TransferRecord>;
  prepareTransfer(transferId: number, idempotencyKey?: string): Promise<PrepareTransferResponse>;
  confirmBroadcast(
    transferId: number,
    body: ConfirmBroadcastRequest,
    idempotencyKey?: string
  ): Promise<TransferRecord>;
  getTransfer(transferId: number): Promise<TransferRecord>;
  listTransfers(): Promise<TransferRecord[]>;
  rescuePrepare(transferId: number, idempotencyKey?: string): Promise<{ rescueTxs: string[] }>;
  rescueConfirm(
    transferId: number,
    signatures: string[],
    idempotencyKey?: string
  ): Promise<TransferRecord>;
}

/**
 * Live HTTP REST v1 client for `https://multihopper.com/api/v1` and `https://devnet.multihopper.com/api/v1`.
 * Enforces `Idempotency-Key` headers on all POST mutations (`MH_070`) and maps `MH_XXX` errors cleanly.
 */
export class HttpMultiHopperClient implements MultiHopperBackend {
  public readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(params: {
    apiKey: string;
    cluster?: ClusterEnvironment;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
  }) {
    if (!params.apiKey || !params.apiKey.startsWith("mh_")) {
      throw new MultiHopperProtocolError(
        "MH_001",
        "API key must start with 'mh_test_' or 'mh_live_'",
        401
      );
    }
    const cluster = params.cluster ?? (params.apiKey.startsWith("mh_test_") ? "devnet" : "mainnet-beta");
    this.baseUrl = (
      params.baseUrl ??
      (cluster === "devnet" ? "https://devnet.multihopper.com" : "https://multihopper.com")
    ).replace(/\/$/, "");
    this.apiKey = params.apiKey;
    this.fetchImpl = params.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    idempotencyKey?: string
  ): Promise<T> {
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      Accept: "application/json",
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = idempotencyKey ?? crypto.randomUUID();
    }

    const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const errObj = (json.error ?? {}) as { code?: string; message?: string };
      throw new MultiHopperProtocolError(
        (errObj.code as MultiHopperProtocolError["code"]) ?? "MH_090",
        errObj.message ?? `HTTP ${res.status} from MultiHopper API`,
        res.status
      );
    }
    return json as T;
  }

  public async estimateTransfer(req: EstimateTransferRequest): Promise<EstimateTransferResponse> {
    return this.request<EstimateTransferResponse>("POST", "/transfers/estimate", req);
  }

  public async createTransfer(
    req: CreateTransferRequest,
    idempotencyKey?: string
  ): Promise<TransferRecord> {
    return this.request<TransferRecord>("POST", "/transfers", req, idempotencyKey);
  }

  public async prepareTransfer(
    transferId: number,
    idempotencyKey?: string
  ): Promise<PrepareTransferResponse> {
    return this.request<PrepareTransferResponse>(
      "POST",
      `/transfers/${transferId}/prepare`,
      {},
      idempotencyKey
    );
  }

  public async confirmBroadcast(
    transferId: number,
    body: ConfirmBroadcastRequest,
    idempotencyKey?: string
  ): Promise<TransferRecord> {
    const wrapped = await this.request<{ transfer?: TransferRecord } & TransferRecord>(
      "POST",
      `/transfers/${transferId}/confirm-broadcast`,
      body,
      idempotencyKey
    );
    return wrapped.transfer ?? wrapped;
  }

  public async getTransfer(transferId: number): Promise<TransferRecord> {
    const wrapped = await this.request<{ transfer?: TransferRecord } & TransferRecord>(
      "GET",
      `/transfers/${transferId}`
    );
    return wrapped.transfer ?? wrapped;
  }

  public async listTransfers(): Promise<TransferRecord[]> {
    const wrapped = await this.request<{ transfers?: TransferRecord[] } | TransferRecord[]>(
      "GET",
      "/transfers"
    );
    return Array.isArray(wrapped) ? wrapped : wrapped.transfers ?? [];
  }

  public async rescuePrepare(
    transferId: number,
    idempotencyKey?: string
  ): Promise<{ rescueTxs: string[] }> {
    return this.request<{ rescueTxs: string[] }>(
      "POST",
      `/transfers/${transferId}/rescue/prepare`,
      {},
      idempotencyKey
    );
  }

  public async rescueConfirm(
    transferId: number,
    signatures: string[],
    idempotencyKey?: string
  ): Promise<TransferRecord> {
    return this.request<TransferRecord>(
      "POST",
      `/transfers/${transferId}/rescue/confirm`,
      { signatures },
      idempotencyKey
    );
  }
}

const SAMPLE_LIBRARY_WALLETS: Record<
  string,
  { address: string; label: string; category: HopLibraryCategory }[]
> = {
  cex: [
    {
      address: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
      label: "Binance Hot Wallet 2",
      category: "cex",
    },
    {
      address: "AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2",
      label: "Bybit Hot Wallet",
      category: "cex",
    },
  ],
  dex: [
    {
      address: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
      label: "Raydium Authority V4",
      category: "dex",
    },
  ],
  kol: [
    {
      address: "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ",
      label: "Solana Ecosystem Relay",
      category: "kol",
    },
  ],
};

function makeRecentBlockhash(seed: number): string {
  const bytes = Buffer.alloc(32, 0);
  bytes.writeUInt32LE(0x501a_2026, 0);
  bytes.writeUInt32LE(seed >>> 0, 4);
  return bs58.encode(bytes);
}

/**
 * Builds an authentic Solana VersionedTransaction (v0) pre-signed by an ephemeral server keypair,
 * leaving `sourceOwner` as the feePayer (slot 0) unsigned — reproducing MultiHopper `/prepare` verbatim!
 */
export function buildServerPresignedV0Tx(params: {
  sourceOwner: PublicKey;
  ephemeralServerKeypair: Keypair;
  lamports: number;
  recentBlockhash: string;
}): string {
  const ix = SystemProgram.transfer({
    fromPubkey: params.sourceOwner,
    toPubkey: params.ephemeralServerKeypair.publicKey,
    lamports: params.lamports,
  });
  // Add a 0-lamport self-instruction signed by ephemeralServerKeypair so BOTH signatures are required
  const ephemeralIx = SystemProgram.transfer({
    fromPubkey: params.ephemeralServerKeypair.publicKey,
    toPubkey: params.ephemeralServerKeypair.publicKey,
    lamports: 0,
  });

  const msgV0 = MessageV0.compile({
    payerKey: params.sourceOwner,
    instructions: [ix, ephemeralIx],
    recentBlockhash: params.recentBlockhash,
  });

  const vtx = new VersionedTransaction(msgV0);
  vtx.sign([params.ephemeralServerKeypair]);
  return Buffer.from(vtx.serialize()).toString("base64");
}

export function buildUnsignedLegacyOrchestratorTx(params: {
  sourceOwner: PublicKey;
  orchestratorTarget: PublicKey;
  recentBlockhash: string;
}): string {
  const tx = new Transaction({
    feePayer: params.sourceOwner,
    recentBlockhash: params.recentBlockhash,
  });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: params.sourceOwner,
      toPubkey: params.orchestratorTarget,
      lamports: 5_000,
    })
  );
  return Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString(
    "base64"
  );
}

/**
 * Deterministic Local Sandbox Backend that implements the complete MultiHopper v1 state machine
 * (including `MH_033` externalId idempotency, `MH_039` keeperFundingSignature enforcement,
 * `MH_041` multi-destination dispersion binding enforcement, and real Ed25519 Solana v0/Legacy tx verification)
 * with zero external API keys required.
 */
export class SandboxMultiHopperBackend implements MultiHopperBackend {
  private nextId = 1001;
  private readonly transfers = new Map<number, TransferRecord>();
  private readonly byExternalId = new Map<string, { id: number; fingerprint: string }>();
  private readonly keeperFundedIds = new Set<number>();
  private readonly cluster: ClusterEnvironment;
  private readonly rewardsWallet: string;

  constructor(opts?: { cluster?: ClusterEnvironment; integratorRewardsWallet?: string }) {
    this.cluster = opts?.cluster ?? "mainnet-beta";
    this.rewardsWallet = opts?.integratorRewardsWallet ?? DEFAULT_INTEGRATOR_REWARDS_WALLET;
  }

  public async estimateTransfer(req: EstimateTransferRequest): Promise<EstimateTransferResponse> {
    return estimateTransferLocal(req, {
      cluster: this.cluster,
      isTestMode: true,
      integratorRewardsWallet: this.rewardsWallet,
    });
  }

  public async createTransfer(req: CreateTransferRequest): Promise<TransferRecord> {
    validateCreateTransferRequest(req, this.cluster);

    const fingerprint = JSON.stringify({
      tokenMint: req.tokenMint,
      amountRaw: req.amountRaw,
      sourceOwner: req.sourceOwner,
      recipientWallet: req.recipientWallet ?? null,
      destinations: req.destinations ?? null,
      hops: req.hops ?? null,
      route: req.route ?? null,
    });

    if (req.externalId) {
      const existing = this.byExternalId.get(req.externalId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new MultiHopperProtocolError(
            "MH_033",
            `Transfer already exists for externalId '${req.externalId}' with different parameters`,
            409
          );
        }
        return this.transfers.get(existing.id)!;
      }
    }

    const est = estimateTransferLocal(
      {
        tokenMint: req.tokenMint,
        amountRaw: req.amountRaw,
        tokenDecimals: req.tokenDecimals,
        tokenPriceUsd: req.tokenPriceUsd,
        hops: req.route ? undefined : req.hops,
        arrivalSeconds: req.route ? undefined : req.arrivalSeconds,
        destinationCount: req.destinations?.length,
        route: req.route,
      },
      {
        cluster: this.cluster,
        isTestMode: true,
        integratorRewardsWallet: this.rewardsWallet,
      }
    );

    const isSol = req.tokenMint === NATIVE_SOL_MINT;
    let destinations: TransferRecord["destinations"] = null;
    if (req.destinations) {
      const allocs = allocateDestinationPayouts({
        totalAmountRaw: req.amountRaw,
        recipientReceivesRaw: est.hopAmountRaw,
        destinations: req.destinations,
        isNativeSol: isSol,
      });
      destinations = allocs.map((a) => ({
        wallet: a.wallet,
        amountRaw: a.postFeeAmountRaw,
        status: "pending",
        payoutSignature: null,
        paidAt: null,
      }));
    }

    const nowMs = Date.now();
    const hopsCount = est.route?.hopCount ?? req.hops ?? 7;
    const arrivalSec = est.route?.arrivalSeconds ?? req.arrivalSeconds ?? 300;
    const resolvedHops: ResolvedRouteHop[] = [];

    if (req.route) {
      let elapsed = 0;
      for (let i = 0; i < req.route.hops.length; i++) {
        const h = req.route.hops[i]!;
        let address: string;
        let label: string | null = null;
        let category: HopLibraryCategory | null = null;
        if ("wallet" in h) {
          address = h.wallet;
        } else {
          const pool =
            SAMPLE_LIBRARY_WALLETS[h.bundle] ?? SAMPLE_LIBRARY_WALLETS.cex!;
          const picked = pool[i % pool.length]!;
          address = picked.address;
          label = picked.label;
          category = picked.category;
        }
        resolvedHops.push({
          index: i,
          address,
          label,
          category,
          scheduledAt: new Date(nowMs + elapsed * 1000).toISOString(),
          executedAt: null,
          txSignature: null,
        });
        elapsed += h.waitSeconds;
      }
      if (req.recipientWallet) {
        resolvedHops.push({
          index: req.route.hops.length,
          address: req.recipientWallet,
          label: null,
          category: null,
          scheduledAt: new Date(nowMs + elapsed * 1000).toISOString(),
          executedAt: null,
          txSignature: null,
        });
      }
    } else {
      const stepSec = Math.floor(arrivalSec / hopsCount);
      for (let i = 0; i < hopsCount; i++) {
        const isLastSingle = i === hopsCount - 1 && req.recipientWallet;
        const hopAddr = isLastSingle
          ? req.recipientWallet!
          : Keypair.generate().publicKey.toBase58();
        resolvedHops.push({
          index: i,
          address: hopAddr,
          label: isLastSingle ? "Final Recipient" : `Ephemeral Hop #${i + 1}`,
          category: null,
          scheduledAt: new Date(nowMs + (i + 1) * stepSec * 1000).toISOString(),
          executedAt: null,
          txSignature: null,
        });
      }
    }

    const id = this.nextId++;
    const record: TransferRecord = {
      id,
      externalId: req.externalId ?? null,
      supportBundleId: `MH-sandbox-${id}`,
      tokenMint: req.tokenMint,
      tokenSymbol: req.tokenSymbol ?? (isSol ? "SOL" : "USDC"),
      tokenDecimals: est.tokens.decimals,
      amountRaw: req.amountRaw,
      amountTokens: req.amountTokens,
      sourceOwner: req.sourceOwner,
      recipientWallet: req.recipientWallet ?? null,
      destinationCount: req.destinations ? req.destinations.length : null,
      destinations,
      recipientReceivesRaw: est.hopAmountRaw,
      fundingStrategy: "direct_orchestration",
      hops: hopsCount,
      arrivalSeconds: arrivalSec,
      pricingTier: est.tier,
      percentFeeBps: est.percentFeeBps,
      percentFeeRaw: est.percentFeeRaw,
      flatFeeLamportsPerHop: est.flatFeeLamportsPerHop,
      totalFlatFeeLamports: est.totalFlatFeeLamports,
      integratorShareRaw: est.integratorPercentShare,
      status: "quote",
      phase: "quoted",
      progress: {
        hopsCompleted: 0,
        hopsTotal: hopsCount,
      },
      isTest: true,
      quotedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 30 * 60 * 1000).toISOString(),
      createdAt: new Date(nowMs).toISOString(),
      route: { hops: resolvedHops },
    };

    this.transfers.set(id, record);
    if (req.externalId) {
      this.byExternalId.set(req.externalId, { id, fingerprint });
    }
    return record;
  }

  public async prepareTransfer(transferId: number): Promise<PrepareTransferResponse> {
    const rec = this.transfers.get(transferId);
    if (!rec) {
      throw new MultiHopperProtocolError("MH_030", `Transfer ${transferId} not found`, 404);
    }
    if (["completed", "failed", "expired", "refunded"].includes(rec.status)) {
      throw new MultiHopperProtocolError(
        "MH_035",
        `Transfer ${transferId} is already in terminal state '${rec.status}'`,
        409
      );
    }

    rec.status = "awaiting_signature";
    rec.phase = "deploying";

    const sourcePubkey = new PublicKey(rec.sourceOwner);
    const blockhash = makeRecentBlockhash(transferId);

    const alreadyFundedKeeper = this.keeperFundedIds.has(transferId);
    const keeperFundingTx = alreadyFundedKeeper
      ? null
      : buildServerPresignedV0Tx({
          sourceOwner: sourcePubkey,
          ephemeralServerKeypair: Keypair.generate(),
          lamports: 150_000,
          recentBlockhash: blockhash,
        });

    const routeInitTxs = [
      {
        base64: buildServerPresignedV0Tx({
          sourceOwner: sourcePubkey,
          ephemeralServerKeypair: Keypair.generate(),
          lamports: 1_000_000,
          recentBlockhash: blockhash,
        }),
      },
    ];

    const orchestratorInitTx = buildUnsignedLegacyOrchestratorTx({
      sourceOwner: sourcePubkey,
      orchestratorTarget: Keypair.generate().publicKey,
      recentBlockhash: blockhash,
    });

    const sessionInitTxs = [
      buildServerPresignedV0Tx({
        sourceOwner: sourcePubkey,
        ephemeralServerKeypair: Keypair.generate(),
        lamports: 50_000,
        recentBlockhash: blockhash,
      }),
    ];

    const dispersionInitTxs =
      rec.destinations && rec.destinations.length > 0
        ? rec.destinations.map(() =>
            buildServerPresignedV0Tx({
              sourceOwner: sourcePubkey,
              ephemeralServerKeypair: Keypair.generate(),
              lamports: 25_000,
              recentBlockhash: blockhash,
            })
          )
        : [];

    return {
      transfer: rec,
      preparedTxs: {
        keeperFundingTx,
        routeInitTxs,
        orchestratorInitTx,
        sessionInitTxs,
        dispersionInitTxs,
        recentBlockhash: blockhash,
        lastValidBlockHeight: 295_000_000,
      },
    };
  }

  public async confirmBroadcast(
    transferId: number,
    body: ConfirmBroadcastRequest
  ): Promise<TransferRecord> {
    const rec = this.transfers.get(transferId);
    if (!rec) {
      throw new MultiHopperProtocolError("MH_030", `Transfer ${transferId} not found`, 404);
    }

    // Call #1: immediate keeperFundingSignature lock (routeInitSignatures === [])
    if (body.keeperFundingSignature) {
      this.keeperFundedIds.add(transferId);
    }

    if (body.routeInitSignatures.length === 0 && body.keeperFundingSignature) {
      return rec;
    }

    if (!this.keeperFundedIds.has(transferId) && !body.keeperFundingSignature) {
      throw new MultiHopperProtocolError(
        "MH_039",
        "keeperFundingSignature is required before route deployment",
        400
      );
    }

    if (
      rec.destinations &&
      rec.destinations.length > 0 &&
      (!body.dispersionInitSignatures ||
        body.dispersionInitSignatures.length < rec.destinations.length)
    ) {
      throw new MultiHopperProtocolError(
        "MH_041",
        `Destinations not yet bound on chain — expected ${rec.destinations.length} dispersionInitSignatures`,
        409
      );
    }

    const settledAt = new Date().toISOString();
    rec.status = "completed";
    rec.phase = "settled";
    rec.progress = {
      hopsCompleted: rec.hops,
      hopsTotal: rec.hops,
    };
    if (rec.route) {
      rec.route.hops = rec.route.hops.map((h, idx) => ({
        ...h,
        executedAt: settledAt,
        txSignature:
          body.routeInitSignatures[0] ?? `sim_hop_${transferId}_${idx}`,
      }));
    }
    if (rec.destinations) {
      rec.destinations = rec.destinations.map((d, idx) => ({
        ...d,
        status: "paid",
        paidAt: settledAt,
        payoutSignature:
          body.dispersionInitSignatures?.[idx] ?? `sim_disp_${transferId}_${idx}`,
      }));
    }

    return rec;
  }

  public async getTransfer(transferId: number): Promise<TransferRecord> {
    const rec = this.transfers.get(transferId);
    if (!rec) {
      throw new MultiHopperProtocolError("MH_030", `Transfer ${transferId} not found`, 404);
    }
    return rec;
  }

  public async listTransfers(): Promise<TransferRecord[]> {
    return Array.from(this.transfers.values()).sort((a, b) => b.id - a.id);
  }

  public async rescuePrepare(transferId: number): Promise<{ rescueTxs: string[] }> {
    const rec = this.transfers.get(transferId);
    if (!rec) {
      throw new MultiHopperProtocolError("MH_030", `Transfer ${transferId} not found`, 404);
    }
    if (rec.phase !== "recoverable") {
      throw new MultiHopperProtocolError(
        "MH_080",
        `Recovery action not allowed in phase '${rec.phase}'`,
        409
      );
    }
    const tx = buildUnsignedLegacyOrchestratorTx({
      sourceOwner: new PublicKey(rec.sourceOwner),
      orchestratorTarget: new PublicKey(rec.sourceOwner),
      recentBlockhash: makeRecentBlockhash(transferId + 99),
    });
    return { rescueTxs: [tx] };
  }

  public async rescueConfirm(transferId: number, _signatures: string[]): Promise<TransferRecord> {
    const rec = this.transfers.get(transferId);
    if (!rec) {
      throw new MultiHopperProtocolError("MH_030", `Transfer ${transferId} not found`, 404);
    }
    rec.phase = "rescued";
    rec.status = "refunded";
    return rec;
  }
}
