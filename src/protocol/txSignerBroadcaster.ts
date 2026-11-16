import {
  Keypair,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  ConfirmBroadcastRequest,
  MultiHopperProtocolError,
  PreparedTxsBundle,
} from "../types.js";

export function loadKeypairFromBase58OrJson(secret: string): Keypair {
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

/**
 * Signs a MultiHopper VersionedTransaction (v0) with `sourceOwner` WITHOUT clobbering
 * server-applied ephemeral keypair partial signatures (`guides/agentic-integration.md`).
 */
export function signVersionedPreservingPartialSigs(
  base64Tx: string,
  signer: Keypair
): string {
  const raw = Buffer.from(base64Tx, "base64");
  const tx = VersionedTransaction.deserialize(raw);
  const staticKeys = tx.message.staticAccountKeys;
  const signerIndex = staticKeys.findIndex((k) => k.equals(signer.publicKey));
  if (signerIndex === -1 || signerIndex >= tx.message.header.numRequiredSignatures) {
    throw new Error(
      `Signer ${signer.publicKey.toBase58()} is not a required signer on VersionedTransaction`
    );
  }
  // VersionedTransaction.sign([signer]) signs message.serialize() and writes ONLY signerIndex slot,
  // preserving all other non-zero signatures already attached by MultiHopper's server.
  tx.sign([signer]);
  return Buffer.from(tx.serialize()).toString("base64");
}

/**
 * Partially signs a Legacy Solana Transaction (`orchestratorInitTx`) with `sourceOwner`.
 */
export function signLegacyPartial(base64Tx: string, signer: Keypair): string {
  const raw = Buffer.from(base64Tx, "base64");
  const tx = Transaction.from(raw);
  tx.partialSign(signer);
  return Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64");
}

export interface SignedPreparedBundle {
  keeperFundingTx?: string;
  routeInitTxs?: { base64: string }[];
  orchestratorInitTx?: string;
  sessionInitTxs?: string[];
  dispersionInitTxs?: string[];
}

/**
 * Signs all non-null transaction groups in `preparedTxs`.
 * Groups returned as `null` by `/prepare` on resume are already confirmed on-chain and skipped.
 */
export function signPreparedBundle(
  prepared: PreparedTxsBundle,
  signer: Keypair
): SignedPreparedBundle {
  const signed: SignedPreparedBundle = {};

  if (prepared.keeperFundingTx) {
    signed.keeperFundingTx = signVersionedPreservingPartialSigs(
      prepared.keeperFundingTx,
      signer
    );
  }
  if (prepared.routeInitTxs && prepared.routeInitTxs.length > 0) {
    signed.routeInitTxs = prepared.routeInitTxs.map((entry) => ({
      base64: signVersionedPreservingPartialSigs(entry.base64, signer),
    }));
  }
  if (prepared.orchestratorInitTx) {
    signed.orchestratorInitTx = signLegacyPartial(
      prepared.orchestratorInitTx,
      signer
    );
  }
  if (prepared.sessionInitTxs && prepared.sessionInitTxs.length > 0) {
    signed.sessionInitTxs = prepared.sessionInitTxs.map((b64) =>
      signVersionedPreservingPartialSigs(b64, signer)
    );
  }
  if (prepared.dispersionInitTxs && prepared.dispersionInitTxs.length > 0) {
    signed.dispersionInitTxs = prepared.dispersionInitTxs.map((b64) =>
      signVersionedPreservingPartialSigs(b64, signer)
    );
  }

  return signed;
}

export interface RpcBroadcasterTransport {
  sendAndConfirmBase64Tx(base64Tx: string, label: string): Promise<string>;
}

export interface MultiHopperConfirmTransport {
  prepareTransfer(transferId: number, idempotencyKey: string): Promise<PreparedTxsBundle>;
  confirmBroadcast(
    transferId: number,
    body: ConfirmBroadcastRequest,
    idempotencyKey: string
  ): Promise<void>;
}

export interface BroadcastExecutionOptions {
  propagationDelayMs?: number;
  maxPrepareAttempts?: number;
  sleepFn?: (ms: number) => Promise<void>;
  idempotencyKeyFactory?: () => string;
}

const defaultSleep = (ms: number) =>
  ms <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Executes the strict 5-stage MultiHopper broadcast order with two-phase `confirm-broadcast`
 * anti-double-funding protection and automatic blockhash-expiry resume (`maxPrepareAttempts`).
 *
 * Strict Order:
 * 1. keeperFundingTx -> IMMEDIATE confirmBroadcast({ routeInitSignatures: [], keeperFundingSignature })
 * 2. routeInitTxs[0..N] (sequential + propagation delay)
 * 3. orchestratorInitTx (+ propagation delay)
 * 4. sessionInitTxs[0..N]
 * 5. dispersionInitTxs[0..N] (multi-destination payout binding)
 * 6. Final confirmBroadcast(allCollectedSignatures)
 */
export async function executeResumableDeployLoop(params: {
  transferId: number;
  signer: Keypair;
  rpc: RpcBroadcasterTransport;
  api: MultiHopperConfirmTransport;
  options?: BroadcastExecutionOptions;
}): Promise<ConfirmBroadcastRequest> {
  const propagationDelayMs = params.options?.propagationDelayMs ?? 3_000;
  const maxPrepareAttempts = params.options?.maxPrepareAttempts ?? 3;
  const sleep = params.options?.sleepFn ?? defaultSleep;
  const makeIdemKey = params.options?.idempotencyKeyFactory ?? (() => crypto.randomUUID());

  const collected: ConfirmBroadcastRequest = {
    routeInitSignatures: [],
  };

  let attempts = 0;

  while (true) {
    attempts += 1;
    if (attempts > maxPrepareAttempts) {
      throw new MultiHopperProtocolError(
        "MH_032",
        `Exceeded maximum prepare/resume attempts (${maxPrepareAttempts}) for transfer ${params.transferId}`,
        408
      );
    }

    const prepared = await params.api.prepareTransfer(params.transferId, makeIdemKey());
    if (prepared.resume?.nothingToDo) {
      break;
    }

    const signed = signPreparedBundle(prepared, params.signer);

    try {
      // Stage 1: keeperFundingTx FIRST + immediate confirm-broadcast lock
      if (signed.keeperFundingTx) {
        const sig = await params.rpc.sendAndConfirmBase64Tx(
          signed.keeperFundingTx,
          "keeperFundingTx"
        );
        collected.keeperFundingSignature = sig;
        await params.api.confirmBroadcast(
          params.transferId,
          { routeInitSignatures: [], keeperFundingSignature: sig },
          makeIdemKey()
        );
      }

      // Stage 2: routeInitTxs sequentially with propagation wait
      if (signed.routeInitTxs && signed.routeInitTxs.length > 0) {
        for (let i = 0; i < signed.routeInitTxs.length; i++) {
          const sig = await params.rpc.sendAndConfirmBase64Tx(
            signed.routeInitTxs[i]!.base64,
            `routeInitTxs[${i}]`
          );
          collected.routeInitSignatures.push(sig);
          if (i < signed.routeInitTxs.length - 1) {
            await sleep(propagationDelayMs);
          }
        }
        await sleep(propagationDelayMs);
      }

      // Stage 3: orchestratorInitTx
      if (signed.orchestratorInitTx) {
        const sig = await params.rpc.sendAndConfirmBase64Tx(
          signed.orchestratorInitTx,
          "orchestratorInitTx"
        );
        collected.orchestratorInitSignature = sig;
        await sleep(propagationDelayMs);
      }

      // Stage 4: sessionInitTxs
      if (signed.sessionInitTxs && signed.sessionInitTxs.length > 0) {
        collected.sessionInitSignatures = collected.sessionInitSignatures ?? [];
        for (let i = 0; i < signed.sessionInitTxs.length; i++) {
          const sig = await params.rpc.sendAndConfirmBase64Tx(
            signed.sessionInitTxs[i]!,
            `sessionInitTxs[${i}]`
          );
          collected.sessionInitSignatures.push(sig);
        }
      }

      // Stage 5: dispersionInitTxs (multi-destination exit commitment)
      if (signed.dispersionInitTxs && signed.dispersionInitTxs.length > 0) {
        collected.dispersionInitSignatures = collected.dispersionInitSignatures ?? [];
        for (let i = 0; i < signed.dispersionInitTxs.length; i++) {
          const sig = await params.rpc.sendAndConfirmBase64Tx(
            signed.dispersionInitTxs[i]!,
            `dispersionInitTxs[${i}]`
          );
          collected.dispersionInitSignatures.push(sig);
        }
      }

      if (!prepared.resume?.routeAlreadyDeployed) {
        break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isBlockhashExpired =
        msg.toLowerCase().includes("blockhash") ||
        msg.toLowerCase().includes("expired");
      if (!isBlockhashExpired || attempts >= maxPrepareAttempts) {
        throw err;
      }
      // Loop around and call /prepare with a fresh Idempotency-Key; server omits landed groups
    }
  }

  // Stage 6: Final confirm-broadcast with all remaining signatures
  await params.api.confirmBroadcast(params.transferId, collected, makeIdemKey());
  return collected;
}
