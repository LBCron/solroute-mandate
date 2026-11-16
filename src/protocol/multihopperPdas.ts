import { Connection, PublicKey } from "@solana/web3.js";

/**
 * Verified MultiHopper Solana Mainnet / Devnet Anchor Program IDs
 * Source: https://dev-docs.multihopper.com/protocol/architecture.md
 * Verified executable on Solana Mainnet-Beta via BPFLoaderUpgradeab1e11111111111111111111111.
 */
export const MULTIHOPPER_CORE_PROGRAM_ID = new PublicKey(
  "3jLoS2wbNgtKzieUUxwg6Xhdv6gbZkHDtPWA9ZAgspFh"
);

export const MULTIHOPPER_ORCHESTRATOR_PROGRAM_ID = new PublicKey(
  "4TPCmR2uN3hDM1FbTsf7ZtFXwXGSz4u1Kxv5YHj6eruX"
);

export const MULTIHOPPER_HOOK_GUARD_PROGRAM_ID = new PublicKey(
  "2JEv3pD6nczEvn1xDXaEzehkJofPPjoQQpnW5nGY3r52"
);

export const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const MAINNET_USDG_MINT = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH";
export const DEFAULT_INTEGRATOR_REWARDS_WALLET =
  "32647Bri8KhJQE11x26iF7fpae9nouCJSZ8Y2VPpq5yM";

export const SYSTEM_AND_PROTOCOL_ADDRESSES = new Set<string>([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  MULTIHOPPER_CORE_PROGRAM_ID.toBase58(),
  MULTIHOPPER_ORCHESTRATOR_PROGRAM_ID.toBase58(),
  MULTIHOPPER_HOOK_GUARD_PROGRAM_ID.toBase58(),
]);

export interface DerivedPda {
  name: string;
  address: string;
  bump: number;
  programId: string;
  seedsHex: string[];
}

function u64LeBytes(value: bigint): Buffer {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`routeId out of u64 range: ${value.toString()}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

function u16LeBytes(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`stepIndex out of u16 range: ${value}`);
  }
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  return buf;
}

function encodeSeedId(id: string | Uint8Array): Buffer {
  if (typeof id === "string") {
    const trimmed = id.trim();
    if (!trimmed || Buffer.byteLength(trimmed, "utf8") > 32) {
      throw new RangeError("providerId string seed must be 1..32 UTF-8 bytes");
    }
    return Buffer.from(trimmed, "utf8");
  }
  if (id.length === 0 || id.length > 32) {
    throw new RangeError("seed byte array must be 1..32 bytes");
  }
  return Buffer.from(id);
}

function deriveWithMeta(
  name: string,
  seeds: Buffer[],
  programId: PublicKey
): DerivedPda {
  const [pubkey, bump] = PublicKey.findProgramAddressSync(seeds, programId);
  return {
    name,
    address: pubkey.toBase58(),
    bump,
    programId: programId.toBase58(),
    seedsHex: seeds.map((s) => s.toString("hex")),
  };
}

export function deriveRouteConfigPda(
  routeId: bigint,
  coreProgramId: PublicKey = MULTIHOPPER_CORE_PROGRAM_ID
): DerivedPda {
  return deriveWithMeta(
    "RouteConfig",
    [Buffer.from("route", "utf8"), u64LeBytes(routeId)],
    coreProgramId
  );
}

export function deriveRouteStatePda(
  routeId: bigint,
  coreProgramId: PublicKey = MULTIHOPPER_CORE_PROGRAM_ID
): DerivedPda {
  return deriveWithMeta(
    "RouteState",
    [Buffer.from("state", "utf8"), u64LeBytes(routeId)],
    coreProgramId
  );
}

export function derivePermanentDelegatePda(
  routeId: bigint,
  coreProgramId: PublicKey = MULTIHOPPER_CORE_PROGRAM_ID
): DerivedPda {
  return deriveWithMeta(
    "PermanentDelegate",
    [Buffer.from("delegate", "utf8"), u64LeBytes(routeId)],
    coreProgramId
  );
}

export function deriveWrapperMintPda(
  routeId: bigint,
  coreProgramId: PublicKey = MULTIHOPPER_CORE_PROGRAM_ID
): DerivedPda {
  return deriveWithMeta(
    "WrapperMint",
    [Buffer.from("mint_authority", "utf8"), u64LeBytes(routeId)],
    coreProgramId
  );
}

export function deriveSplVaultPda(
  originalMint: PublicKey | string,
  coreProgramId: PublicKey = MULTIHOPPER_CORE_PROGRAM_ID
): DerivedPda {
  const mintKey =
    typeof originalMint === "string" ? new PublicKey(originalMint) : originalMint;
  return deriveWithMeta(
    "Vault",
    [Buffer.from("vault_authority", "utf8"), mintKey.toBuffer()],
    coreProgramId
  );
}

export function deriveSolVaultPda(
  tokenConfigCreator: PublicKey | string,
  coreProgramId: PublicKey = MULTIHOPPER_CORE_PROGRAM_ID
): DerivedPda {
  const creatorKey =
    typeof tokenConfigCreator === "string"
      ? new PublicKey(tokenConfigCreator)
      : tokenConfigCreator;
  return deriveWithMeta(
    "SolVault",
    [Buffer.from("sol_vault", "utf8"), creatorKey.toBuffer()],
    coreProgramId
  );
}

export function deriveTokenConfigGlobalPda(
  coreProgramId: PublicKey = MULTIHOPPER_CORE_PROGRAM_ID
): DerivedPda {
  return deriveWithMeta(
    "TokenConfig",
    [Buffer.from("token_config_global_v2", "utf8")],
    coreProgramId
  );
}

export function deriveProviderPda(
  providerId: string | Uint8Array,
  coreProgramId: PublicKey = MULTIHOPPER_CORE_PROGRAM_ID
): DerivedPda {
  return deriveWithMeta(
    "Provider",
    [Buffer.from("provider", "utf8"), encodeSeedId(providerId)],
    coreProgramId
  );
}

export function deriveFeeSchedulePda(
  providerId: string | Uint8Array,
  coreProgramId: PublicKey = MULTIHOPPER_CORE_PROGRAM_ID
): DerivedPda {
  return deriveWithMeta(
    "FeeSchedule",
    [Buffer.from("fee_schedule", "utf8"), encodeSeedId(providerId)],
    coreProgramId
  );
}

export function deriveOrchestratorConfigPda(
  orchestratorProgramId: PublicKey = MULTIHOPPER_ORCHESTRATOR_PROGRAM_ID
): DerivedPda {
  return deriveWithMeta(
    "OrchestratorConfig",
    [Buffer.from("orchestrator", "utf8")],
    orchestratorProgramId
  );
}

export function deriveOrchestratorStepPda(
  orchestratorKey: PublicKey | string,
  stepIndex: number,
  orchestratorProgramId: PublicKey = MULTIHOPPER_ORCHESTRATOR_PROGRAM_ID
): DerivedPda {
  const orch =
    typeof orchestratorKey === "string"
      ? new PublicKey(orchestratorKey)
      : orchestratorKey;
  return deriveWithMeta(
    "OrchestratorStep",
    [Buffer.from("step", "utf8"), orch.toBuffer(), u16LeBytes(stepIndex)],
    orchestratorProgramId
  );
}

export interface RouteAccountBundle {
  routeId: string;
  routeConfig: DerivedPda;
  routeState: DerivedPda;
  permanentDelegate: DerivedPda;
  wrapperMint: DerivedPda;
  tokenConfigGlobal: DerivedPda;
  vault: DerivedPda;
  provider?: DerivedPda;
  feeSchedule?: DerivedPda;
  orchestratorConfig: DerivedPda;
}

export function deriveCompleteRouteAccountBundle(params: {
  routeId: bigint;
  tokenMint: string;
  providerId?: string;
}): RouteAccountBundle {
  const bundle: RouteAccountBundle = {
    routeId: params.routeId.toString(),
    routeConfig: deriveRouteConfigPda(params.routeId),
    routeState: deriveRouteStatePda(params.routeId),
    permanentDelegate: derivePermanentDelegatePda(params.routeId),
    wrapperMint: deriveWrapperMintPda(params.routeId),
    tokenConfigGlobal: deriveTokenConfigGlobalPda(),
    vault: deriveSplVaultPda(params.tokenMint),
    orchestratorConfig: deriveOrchestratorConfigPda(),
  };
  if (params.providerId) {
    bundle.provider = deriveProviderPda(params.providerId);
    bundle.feeSchedule = deriveFeeSchedulePda(params.providerId);
  }
  return bundle;
}

export interface VerifiedProgramStatus {
  label: string;
  programId: string;
  exists: boolean;
  executable: boolean;
  owner: string | null;
  lamports: number;
}

export async function verifyMainnetPrograms(
  connection: Connection
): Promise<VerifiedProgramStatus[]> {
  const targets = [
    { label: "MultiHopper Core", pubkey: MULTIHOPPER_CORE_PROGRAM_ID },
    { label: "MultiHopper Orchestrator", pubkey: MULTIHOPPER_ORCHESTRATOR_PROGRAM_ID },
    { label: "Transfer Hook Guard (Token2022)", pubkey: MULTIHOPPER_HOOK_GUARD_PROGRAM_ID },
  ];
  const infos = await connection.getMultipleAccountsInfo(
    targets.map((t) => t.pubkey),
    "confirmed"
  );
  return targets.map((t, idx) => {
    const info = infos[idx] ?? null;
    return {
      label: t.label,
      programId: t.pubkey.toBase58(),
      exists: info !== null,
      executable: Boolean(info?.executable),
      owner: info ? info.owner.toBase58() : null,
      lamports: info?.lamports ?? 0,
    };
  });
}
