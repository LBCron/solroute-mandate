import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { buildServerPresignedV0Tx } from "../src/protocol/multihopperClient.js";
import { MULTIHOPPER_CORE_PROGRAM_ID } from "../src/protocol/multihopperPdas.js";
import { validateCustomRoute } from "../src/protocol/routeValidator.js";
import {
  executeResumableDeployLoop,
  signVersionedPreservingPartialSigs,
} from "../src/protocol/txSignerBroadcaster.js";
import {
  ConfirmBroadcastRequest,
  MultiHopperProtocolError,
  PreparedTxsBundle,
} from "../src/types.js";

describe("Custom Route MH_018 & MH_019 Pre-Flight Validator", () => {
  it("accepts a valid custom route mixing hop-library bundles and explicit wallets", () => {
    const sender = Keypair.generate().publicKey.toBase58();
    const recipient = Keypair.generate().publicKey.toBase58();
    const middleHop = Keypair.generate().publicKey.toBase58();

    const res = validateCustomRoute({
      route: {
        hops: [
          { bundle: "cex", waitSeconds: 120 },
          { wallet: middleHop, waitSeconds: 300 },
          { bundle: "kol", waitSeconds: 600 },
        ],
      },
      cluster: "mainnet-beta",
      sourceOwner: sender,
      recipientWallet: recipient,
      isMultiDestination: false,
    });

    expect(res.onChainHopCount).toBe(4);
    expect(res.arrivalSeconds).toBe(1020);
  });

  it("aggregates multiple simultaneous rule violations into a single MH_018 error", () => {
    const sender = Keypair.generate().publicKey.toBase58();
    const recipient = Keypair.generate().publicKey.toBase58();

    let caught: MultiHopperProtocolError | undefined;
    try {
      validateCustomRoute({
        route: {
          hops: [
            { wallet: sender, waitSeconds: 60 },
            { wallet: recipient, waitSeconds: 60 },
            { wallet: MULTIHOPPER_CORE_PROGRAM_ID.toBase58(), waitSeconds: 60 },
          ],
        },
        cluster: "mainnet-beta",
        sourceOwner: sender,
        recipientWallet: recipient,
        isMultiDestination: false,
      });
    } catch (err) {
      caught = err as MultiHopperProtocolError;
    }

    expect(caught).toBeDefined();
    expect(caught!.code).toBe("MH_018");
    expect(caught!.problems.length).toBe(3);
    expect(caught!.message).toContain("route.hops[0]");
    expect(caught!.message).toContain("route.hops[1]");
    expect(caught!.message).toContain("route.hops[2]");
  });

  it("rejects hop-library bundle usage on devnet with MH_019", () => {
    expect(() =>
      validateCustomRoute({
        route: {
          hops: [
            { bundle: "cex", waitSeconds: 60 },
            { bundle: "dex", waitSeconds: 60 },
          ],
        },
        cluster: "devnet",
        isMultiDestination: false,
      })
    ).toThrowError(/hop library is not available on devnet/i);
  });
});

describe("Non-Custodial Partial Signing & 5-Stage Resumable Broadcaster", () => {
  it("preserves server-side ephemeral keypair partial signatures on VersionedTransaction (v0)", () => {
    const sourceOwner = Keypair.generate();
    const ephemeralServerKey = Keypair.generate();
    const blockhash = bs58.encode(Buffer.alloc(32, 7));

    const presignedBase64 = buildServerPresignedV0Tx({
      sourceOwner: sourceOwner.publicKey,
      ephemeralServerKeypair: ephemeralServerKey,
      lamports: 250_000,
      recentBlockhash: blockhash,
    });

    // Before client signing: slot 0 (sourceOwner) is all zeros, slot 1 (ephemeralServerKey) is signed
    const beforeTx = VersionedTransaction.deserialize(Buffer.from(presignedBase64, "base64"));
    expect(beforeTx.signatures[0]!.every((b) => b === 0)).toBe(true);
    const serverSigBefore = Buffer.from(beforeTx.signatures[1]!).toString("hex");
    expect(beforeTx.signatures[1]!.some((b) => b !== 0)).toBe(true);

    // Client signs slot 0 without clobbering slot 1
    const fullySignedBase64 = signVersionedPreservingPartialSigs(presignedBase64, sourceOwner);
    const afterTx = VersionedTransaction.deserialize(Buffer.from(fullySignedBase64, "base64"));

    expect(afterTx.signatures[0]!.some((b) => b !== 0)).toBe(true);
    expect(Buffer.from(afterTx.signatures[1]!).toString("hex")).toBe(serverSigBefore);
  });

  it("enforces strict 5-stage broadcast order, two-phase confirm-broadcast, and blockhash-expiry resume", async () => {
    const sourceOwner = Keypair.generate();
    const blockhash1 = bs58.encode(Buffer.alloc(32, 11));
    const blockhash2 = bs58.encode(Buffer.alloc(32, 22));

    const makeV0 = (bh: string) =>
      buildServerPresignedV0Tx({
        sourceOwner: sourceOwner.publicKey,
        ephemeralServerKeypair: Keypair.generate(),
        lamports: 100_000,
        recentBlockhash: bh,
      });

    const events: string[] = [];
    const confirmCalls: ConfirmBroadcastRequest[] = [];
    let prepareCount = 0;
    let injectedExpiry = false;

    const sigs = await executeResumableDeployLoop({
      transferId: 77,
      signer: sourceOwner,
      rpc: {
        sendAndConfirmBase64Tx: async (_b64, label) => {
          if (label === "routeInitTxs[0]" && !injectedExpiry) {
            injectedExpiry = true;
            events.push(`FAIL:${label}:Blockhash not found`);
            throw new Error("Transaction simulation failed: Blockhash not found");
          }
          events.push(`RPC:${label}`);
          return `sig_${label}_p${prepareCount}`;
        },
      },
      api: {
        prepareTransfer: async (_id, _idemKey): Promise<PreparedTxsBundle> => {
          prepareCount += 1;
          events.push(`PREPARE:#${prepareCount}`);
          if (prepareCount === 1) {
            return {
              keeperFundingTx: makeV0(blockhash1),
              routeInitTxs: [{ base64: makeV0(blockhash1) }],
              sessionInitTxs: [makeV0(blockhash1)],
              dispersionInitTxs: [makeV0(blockhash1)],
            };
          }
          // On resume (#2), keeperFundingTx is null because confirmBroadcast #1 already locked it!
          return {
            keeperFundingTx: null,
            routeInitTxs: [{ base64: makeV0(blockhash2) }],
            sessionInitTxs: [makeV0(blockhash2)],
            dispersionInitTxs: [makeV0(blockhash2)],
          };
        },
        confirmBroadcast: async (_id, body) => {
          confirmCalls.push(JSON.parse(JSON.stringify(body)) as ConfirmBroadcastRequest);
          events.push(
            body.routeInitSignatures.length === 0 ? "CONFIRM:KEEPER_LOCK" : "CONFIRM:FINAL"
          );
        },
      },
      options: {
        propagationDelayMs: 0,
      },
    });

    expect(events).toEqual([
      "PREPARE:#1",
      "RPC:keeperFundingTx",
      "CONFIRM:KEEPER_LOCK",
      "FAIL:routeInitTxs[0]:Blockhash not found",
      "PREPARE:#2",
      "RPC:routeInitTxs[0]",
      "RPC:sessionInitTxs[0]",
      "RPC:dispersionInitTxs[0]",
      "CONFIRM:FINAL",
    ]);

    expect(confirmCalls.length).toBe(2);
    expect(confirmCalls[0]).toEqual({
      routeInitSignatures: [],
      keeperFundingSignature: "sig_keeperFundingTx_p1",
    });
    expect(sigs.keeperFundingSignature).toBe("sig_keeperFundingTx_p1");
    expect(sigs.routeInitSignatures).toEqual(["sig_routeInitTxs[0]_p2"]);
    expect(sigs.dispersionInitSignatures).toEqual(["sig_dispersionInitTxs[0]_p2"]);
  });
});
