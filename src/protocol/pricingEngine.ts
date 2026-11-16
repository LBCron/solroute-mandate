import {
  ClusterEnvironment,
  DestinationShareInput,
  EstimateTransferRequest,
  EstimateTransferResponse,
  MultiHopperProtocolError,
} from "../types.js";
import {
  DEFAULT_INTEGRATOR_REWARDS_WALLET,
  NATIVE_SOL_MINT,
} from "./multihopperPdas.js";

/**
 * Live MultiHopper on-chain 10-tier fee schedule (active since 2026-09-28 on Mainnet & Devnet).
 * Source: https://dev-docs.multihopper.com/concepts/pricing.md
 */
export interface FeeTierSpec {
  tierIndex: number;
  tier: string;
  maxUsdMicros: bigint | null; // null = unbounded (Tier 9 > $500)
  flatFeeLamportsPerHop: number;
  flatFeeLamportsPerRoute: number;
}

export const ONCHAIN_FEE_SCHEDULE: readonly FeeTierSpec[] = [
  { tierIndex: 0, tier: "tier_0", maxUsdMicros: 50_000_000n, flatFeeLamportsPerHop: 0, flatFeeLamportsPerRoute: 0 },
  { tierIndex: 1, tier: "tier_1", maxUsdMicros: 106_250_000n, flatFeeLamportsPerHop: 125_000, flatFeeLamportsPerRoute: 0 },
  { tierIndex: 2, tier: "tier_2", maxUsdMicros: 162_500_000n, flatFeeLamportsPerHop: 375_000, flatFeeLamportsPerRoute: 0 },
  { tierIndex: 3, tier: "tier_3", maxUsdMicros: 218_750_000n, flatFeeLamportsPerHop: 625_000, flatFeeLamportsPerRoute: 0 },
  { tierIndex: 4, tier: "tier_4", maxUsdMicros: 275_000_000n, flatFeeLamportsPerHop: 875_000, flatFeeLamportsPerRoute: 0 },
  { tierIndex: 5, tier: "tier_5", maxUsdMicros: 331_250_000n, flatFeeLamportsPerHop: 1_125_000, flatFeeLamportsPerRoute: 0 },
  { tierIndex: 6, tier: "tier_6", maxUsdMicros: 387_500_000n, flatFeeLamportsPerHop: 1_375_000, flatFeeLamportsPerRoute: 0 },
  { tierIndex: 7, tier: "tier_7", maxUsdMicros: 443_750_000n, flatFeeLamportsPerHop: 1_625_000, flatFeeLamportsPerRoute: 0 },
  { tierIndex: 8, tier: "tier_8", maxUsdMicros: 500_000_000n, flatFeeLamportsPerHop: 1_875_000, flatFeeLamportsPerRoute: 0 },
  { tierIndex: 9, tier: "tier_9", maxUsdMicros: null, flatFeeLamportsPerHop: 2_000_000, flatFeeLamportsPerRoute: 0 },
];

export const PERCENT_FEE_BPS = 50n; // 0.50%
export const BPS_DENOMINATOR = 10_000n;
export const SOL_RENT_EXEMPT_MINIMUM_LAMPORTS = 890_880n;
export const MIN_SOL_TRANSFER_LAMPORTS = 2_039_280;
export const MAINNET_SCREENING_FEE_PER_WALLET_LAMPORTS = 2_000_000; // 0.002 SOL

export interface PricingContextOptions {
  cluster?: ClusterEnvironment;
  isTestMode?: boolean;
  integratorRewardsWallet?: string;
  priceSource?: "onchain_pool" | "override" | "oracle";
}

function parsePositiveBigInt(raw: string, fieldName: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new MultiHopperProtocolError(
      "BAD_REQUEST",
      `${fieldName} must be an unsigned integer string`
    );
  }
  const value = BigInt(raw);
  if (value <= 0n) {
    throw new MultiHopperProtocolError("MH_012", `${fieldName} must be greater than zero`);
  }
  return value;
}

function computeUsdMicros(
  amountRaw: bigint,
  decimals: number,
  priceUsd: number
): bigint {
  const priceMicros = BigInt(Math.round(priceUsd * 1_000_000));
  const scale = 10n ** BigInt(decimals);
  return (amountRaw * priceMicros) / scale;
}

function maxRawForUsdMicros(
  maxUsdMicros: bigint,
  decimals: number,
  priceUsd: number
): bigint {
  const priceMicros = BigInt(Math.round(priceUsd * 1_000_000));
  if (priceMicros <= 0n) return 0n;
  const scale = 10n ** BigInt(decimals);
  return (maxUsdMicros * scale) / priceMicros;
}

function pickTierForUsdMicros(usdMicros: bigint): FeeTierSpec {
  for (const spec of ONCHAIN_FEE_SCHEDULE) {
    if (spec.maxUsdMicros === null || usdMicros <= spec.maxUsdMicros) {
      return spec;
    }
  }
  return ONCHAIN_FEE_SCHEDULE[ONCHAIN_FEE_SCHEDULE.length - 1]!;
}

/**
 * Reproduces MultiHopper's exact on-chain integer pricing, tier selection,
 * tier-boundary capping, upfront SOL rent/screening budget, and 50/50 atomic integrator split.
 */
export function estimateTransferLocal(
  req: EstimateTransferRequest,
  opts: PricingContextOptions = {}
): EstimateTransferResponse {
  const isSol = req.tokenMint === NATIVE_SOL_MINT;
  const decimals = req.tokenDecimals ?? (isSol ? 9 : 6);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new MultiHopperProtocolError("BAD_REQUEST", "tokenDecimals must be an integer 0..18");
  }

  const amountRaw = parsePositiveBigInt(req.amountRaw, "amountRaw");
  if (isSol && amountRaw < BigInt(MIN_SOL_TRANSFER_LAMPORTS)) {
    throw new MultiHopperProtocolError(
      "MH_012",
      `SOL amountRaw (${amountRaw.toString()}) is below minimum ${MIN_SOL_TRANSFER_LAMPORTS} lamports`
    );
  }

  if (req.route && (req.hops !== undefined || req.arrivalSeconds !== undefined)) {
    throw new MultiHopperProtocolError(
      "MH_018",
      "Invalid custom route — route replaces hops and arrivalSeconds; do not combine them"
    );
  }

  const destinationCount = req.destinationCount ?? null;
  if (destinationCount !== null && (!Number.isInteger(destinationCount) || destinationCount < 1 || destinationCount > 20)) {
    throw new MultiHopperProtocolError("BAD_REQUEST", "destinationCount must be an integer 1..20");
  }

  let effectiveHops: number;
  let routeMeta: { hopCount: number; arrivalSeconds: number } | undefined;

  if (req.route) {
    const customLen = req.route.hops.length;
    effectiveHops = destinationCount !== null ? customLen : customLen + 1;
    const totalWait = req.route.hops.reduce((acc, h) => acc + h.waitSeconds, 0);
    routeMeta = { hopCount: effectiveHops, arrivalSeconds: totalWait };
  } else {
    effectiveHops = req.hops ?? 7;
  }

  if (!Number.isInteger(effectiveHops) || effectiveHops < 3 || effectiveHops > 10) {
    throw new MultiHopperProtocolError(
      "MH_013",
      `Hops out of range (${effectiveHops}): must be 3..10`
    );
  }

  const priceUsd = req.tokenPriceUsd ?? (isSol ? 150 : 1.0);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new MultiHopperProtocolError("MH_010", "Missing or non-positive tokenPriceUsd context");
  }

  const cluster = opts.cluster ?? "mainnet-beta";
  const isTestMode = opts.isTestMode ?? false;
  const rewardsWallet = opts.integratorRewardsWallet ?? DEFAULT_INTEGRATOR_REWARDS_WALLET;

  // Solve tier fixed-point on post-fee hopAmount (handling tier boundary discontinuities cleanly)
  let chosenTier: FeeTierSpec = ONCHAIN_FEE_SCHEDULE[0]!;
  let hopAmountRaw = 0n;
  let cappedAtTierBoundary = false;

  for (let i = 0; i < ONCHAIN_FEE_SCHEDULE.length; i++) {
    const candidate = ONCHAIN_FEE_SCHEDULE[i]!;
    const totalFlat = BigInt(
      candidate.flatFeeLamportsPerRoute + candidate.flatFeeLamportsPerHop * effectiveHops
    );
    const netPool = isSol ? amountRaw - totalFlat : amountRaw;
    if (netPool <= 0n) {
      continue;
    }
    const candidateHop = (netPool * BPS_DENOMINATOR) / (BPS_DENOMINATOR + PERCENT_FEE_BPS);
    const hopUsdMicros = computeUsdMicros(candidateHop, decimals, priceUsd);
    const impliedTier = pickTierForUsdMicros(hopUsdMicros);

    if (impliedTier.tierIndex === candidate.tierIndex) {
      chosenTier = candidate;
      hopAmountRaw = candidateHop;
      cappedAtTierBoundary = false;
      break;
    }

    // Discontinuity right above tier boundary: higher tier's flat fee pushes hopAmount into lower tier
    if (impliedTier.tierIndex < candidate.tierIndex && i > 0) {
      const lowerTier = ONCHAIN_FEE_SCHEDULE[i - 1]!;
      if (lowerTier.maxUsdMicros !== null) {
        chosenTier = lowerTier;
        hopAmountRaw = maxRawForUsdMicros(lowerTier.maxUsdMicros, decimals, priceUsd);
        cappedAtTierBoundary = true;
        break;
      }
    }
  }

  if (hopAmountRaw <= 0n) {
    throw new MultiHopperProtocolError(
      "MH_016",
      "Transfer amount does not cover protocol fees (post-fee hop amount <= 0)"
    );
  }

  const percentFeeRaw = (hopAmountRaw * PERCENT_FEE_BPS) / BPS_DENOMINATOR;
  const integratorPercentShare = percentFeeRaw / 2n;
  const totalFlatFeeLamports =
    chosenTier.flatFeeLamportsPerRoute + chosenTier.flatFeeLamportsPerHop * effectiveHops;

  const usdValueMicros = computeUsdMicros(hopAmountRaw, decimals, priceUsd);
  const grossUsdMicros = computeUsdMicros(amountRaw, decimals, priceUsd);
  const usdEquivalent = Number(grossUsdMicros) / 1_000_000;

  // SOL upfront network + screening + rent model matching /api/v1/transfers/estimate
  const routeInitRentLamports = 15_407_640;
  const orchestratorRentLamports = 4_551_680 * effectiveHops;
  const ataRentLamports = 809_413 * effectiveHops + 2;
  const transactionFeesLamports = 15_000 * effectiveHops;
  const dispersionRentLamports =
    destinationCount !== null ? destinationCount * 2_250_000 : 0;

  const lateArrivalExtraScreens =
    (req.arrivalSeconds ?? routeMeta?.arrivalSeconds ?? 300) > 21_600
      ? destinationCount ?? 1
      : 0;
  const screenedWallets =
    cluster === "mainnet-beta"
      ? effectiveHops + (destinationCount ?? 1) + lateArrivalExtraScreens
      : 0;
  const screeningFeeLamports =
    screenedWallets * MAINNET_SCREENING_FEE_PER_WALLET_LAMPORTS;

  const nonPrincipalUpfront =
    routeInitRentLamports +
    orchestratorRentLamports +
    ataRentLamports +
    transactionFeesLamports +
    totalFlatFeeLamports +
    screeningFeeLamports +
    dispersionRentLamports;

  // For SOL transfers, totalFlatFeeLamports is already inside amountRaw
  const requiredSolUpFrontLamports = isSol
    ? Number(amountRaw) + (nonPrincipalUpfront - totalFlatFeeLamports) + 16_602_391
    : nonPrincipalUpfront;

  const refundableLamports =
    orchestratorRentLamports + dispersionRentLamports + 2_428_240;
  const netCostLamports = requiredSolUpFrontLamports - refundableLamports;

  const res: EstimateTransferResponse = {
    tier: chosenTier.tier,
    tierIndex: chosenTier.tierIndex,
    percentFeeBps: Number(PERCENT_FEE_BPS),
    percentFeeRaw: percentFeeRaw.toString(),
    flatFeeLamportsPerHop: chosenTier.flatFeeLamportsPerHop,
    flatFeeLamportsPerRoute: chosenTier.flatFeeLamportsPerRoute,
    totalFlatFeeLamports,
    integratorPercentShare: integratorPercentShare.toString(),
    integratorFlatShare: 0,
    integratorRewardsWallet: rewardsWallet,
    usdEquivalent: Math.round(usdEquivalent * 100) / 100,
    usdValueMicros: usdValueMicros.toString(),
    priceSource: opts.priceSource ?? "onchain_pool",
    hopAmountRaw: hopAmountRaw.toString(),
    cappedAtTierBoundary,
    destinationCount,
    isTestMode,
    tokens: {
      amountRaw: amountRaw.toString(),
      feeRaw: percentFeeRaw.toString(),
      netDeliveredRaw: hopAmountRaw.toString(),
      decimals,
    },
    sol: {
      requiredSolUpFrontLamports,
      minTransferAmountLamports: MIN_SOL_TRANSFER_LAMPORTS,
      breakdown: {
        routeInitRentLamports,
        orchestratorRentLamports,
        ataRentLamports,
        transactionFeesLamports,
        priorityFeesLamports: 0,
        protocolFlatFeeLamports: totalFlatFeeLamports,
        screeningFeeLamports,
        dispersionRentLamports,
      },
      refundableLamports,
      netCostLamports,
    },
  };

  if (routeMeta) {
    res.route = routeMeta;
  }

  return res;
}

/**
 * Computes exact proportional post-fee destination payouts (summing to recipientReceivesRaw)
 * and enforces MH_017 SOL rent-exemption minimum per destination.
 */
export function allocateDestinationPayouts(params: {
  totalAmountRaw: string;
  recipientReceivesRaw: string;
  destinations: DestinationShareInput[];
  isNativeSol: boolean;
}): { wallet: string; postFeeAmountRaw: string }[] {
  const totalGross = BigInt(params.totalAmountRaw);
  const netHop = BigInt(params.recipientReceivesRaw);

  if (params.destinations.length < 1 || params.destinations.length > 20) {
    throw new MultiHopperProtocolError(
      "BAD_REQUEST",
      "destinations must contain 1..20 entries"
    );
  }

  const seen = new Set<string>();
  let shareSum = 0n;
  for (const d of params.destinations) {
    if (seen.has(d.wallet)) {
      throw new MultiHopperProtocolError(
        "BAD_REQUEST",
        `Duplicate destination wallet: ${d.wallet}`
      );
    }
    seen.add(d.wallet);
    const share = parsePositiveBigInt(d.amountRaw, `destinations[${d.wallet}].amountRaw`);
    shareSum += share;
  }

  if (shareSum !== totalGross) {
    throw new MultiHopperProtocolError(
      "BAD_REQUEST",
      `Destination shares (${shareSum.toString()}) must sum exactly to amountRaw (${totalGross.toString()})`
    );
  }

  const allocations: { wallet: string; postFeeAmountRaw: bigint }[] = [];
  let allocatedSum = 0n;

  for (let i = 0; i < params.destinations.length; i++) {
    const dest = params.destinations[i]!;
    const share = BigInt(dest.amountRaw);
    const isLast = i === params.destinations.length - 1;
    const postFee = isLast
      ? netHop - allocatedSum
      : (netHop * share) / totalGross;
    allocatedSum += postFee;
    allocations.push({ wallet: dest.wallet, postFeeAmountRaw: postFee });
  }

  const underfunded = allocations.filter((a) =>
    params.isNativeSol ? a.postFeeAmountRaw < SOL_RENT_EXEMPT_MINIMUM_LAMPORTS : a.postFeeAmountRaw <= 0n
  );

  if (underfunded.length > 0) {
    const list = underfunded
      .map((u) => `${u.wallet.slice(0, 6)}… (${u.postFeeAmountRaw.toString()})`)
      .join(", ");
    throw new MultiHopperProtocolError(
      "MH_017",
      params.isNativeSol
        ? `SOL destination(s) ${list} would receive less than the ${SOL_RENT_EXEMPT_MINIMUM_LAMPORTS.toString()}-lamport rent-exempt minimum after fees. Increase their share.`
        : `SPL destination(s) ${list} would receive 0 base units after fees.`
    );
  }

  return allocations.map((a) => ({
    wallet: a.wallet,
    postFeeAmountRaw: a.postFeeAmountRaw.toString(),
  }));
}
