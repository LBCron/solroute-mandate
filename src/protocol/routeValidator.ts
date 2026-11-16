import { PublicKey } from "@solana/web3.js";
import {
  ClusterEnvironment,
  CreateTransferRequest,
  CustomRouteInput,
  HopLibraryBundle,
  MultiHopperProtocolError,
} from "../types.js";
import { SYSTEM_AND_PROTOCOL_ADDRESSES } from "./multihopperPdas.js";

const VALID_BUNDLES = new Set<HopLibraryBundle>([
  "cex",
  "dex",
  "exchanges",
  "kol",
  "contracts",
  "mix",
]);

const MIN_WAIT_SECONDS = 20;
const MAX_WAIT_SECONDS = 2_592_000; // 30 days
const EXTERNAL_ID_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;

export function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

export function isOnCurveWallet(address: string): boolean {
  try {
    const pk = new PublicKey(address);
    return PublicKey.isOnCurve(pk.toBytes());
  } catch {
    return false;
  }
}

/**
 * Minimum arrivalSeconds required by hop count for standard non-custom routes.
 */
export function minArrivalSecondsForHops(hops: number): number {
  return Math.max(60, hops * 20);
}

/**
 * Validates a custom route against every MultiHopper protocol rule (`guides/custom-routes.md`),
 * collecting all rule violations simultaneously in a single `MH_018` error just like the live API.
 */
export function validateCustomRoute(params: {
  route: CustomRouteInput;
  cluster?: ClusterEnvironment;
  sourceOwner?: string;
  recipientWallet?: string;
  destinationWallets?: string[];
  isMultiDestination: boolean;
}): { onChainHopCount: number; arrivalSeconds: number } {
  const { route, isMultiDestination } = params;
  const cluster = params.cluster ?? "mainnet-beta";

  if (!route || !Array.isArray(route.hops)) {
    throw new MultiHopperProtocolError("BAD_REQUEST", "route.hops must be an array");
  }

  if (route.hops.length > 10) {
    throw new MultiHopperProtocolError(
      "BAD_REQUEST",
      "route.hops cannot exceed 10 entries"
    );
  }

  // First check structural/malformed fields (BAD_REQUEST / MH_019)
  for (let i = 0; i < route.hops.length; i++) {
    const hop = route.hops[i]!;
    const hasWallet = "wallet" in hop && typeof hop.wallet === "string";
    const hasBundle = "bundle" in hop && typeof hop.bundle === "string";

    if ((hasWallet && hasBundle) || (!hasWallet && !hasBundle)) {
      throw new MultiHopperProtocolError(
        "BAD_REQUEST",
        `route.hops[${i}] must specify exactly one of 'wallet' or 'bundle'`
      );
    }

    if (
      !Number.isInteger(hop.waitSeconds) ||
      hop.waitSeconds < MIN_WAIT_SECONDS ||
      hop.waitSeconds > MAX_WAIT_SECONDS
    ) {
      throw new MultiHopperProtocolError(
        "BAD_REQUEST",
        `route.hops[${i}].waitSeconds must be an integer between ${MIN_WAIT_SECONDS} and ${MAX_WAIT_SECONDS}`
      );
    }

    if (hasWallet) {
      const w = (hop as { wallet: string }).wallet;
      if (!isValidSolanaAddress(w)) {
        throw new MultiHopperProtocolError(
          "BAD_REQUEST",
          `route.hops[${i}].wallet is not a valid Solana public key`
        );
      }
    }

    if (hasBundle) {
      const b = (hop as { bundle: HopLibraryBundle }).bundle;
      if (!VALID_BUNDLES.has(b)) {
        throw new MultiHopperProtocolError(
          "BAD_REQUEST",
          `route.hops[${i}].bundle '${String(b)}' is not a valid hop library bundle`
        );
      }
      if (cluster === "devnet") {
        throw new MultiHopperProtocolError(
          "MH_019",
          `The hop library is not available on devnet (route.hops[${i}].bundle='${b}'): use explicit wallets`
        );
      }
    }
  }

  // Next check semantic route constraints — report ALL violations at once via MH_018
  const problems: string[] = [];
  const minHops = isMultiDestination ? 3 : 2;
  const maxHops = isMultiDestination ? 10 : 9;

  if (route.hops.length < minHops || route.hops.length > maxHops) {
    problems.push(
      `route.hops: length ${route.hops.length} out of allowed range ${minHops}..${maxHops} (${
        isMultiDestination ? "multi-destination" : "single-recipient"
      })`
    );
  }

  let totalWait = 0;
  const seenWallets = new Set<string>();
  const destinationSet = new Set(params.destinationWallets ?? []);

  for (let i = 0; i < route.hops.length; i++) {
    const hop = route.hops[i]!;
    totalWait += hop.waitSeconds;
    const isLast = i === route.hops.length - 1;

    if ("wallet" in hop) {
      const w = hop.wallet;
      if (params.sourceOwner && w === params.sourceOwner) {
        problems.push(
          `route.hops[${i}]: ${w} is the sender (sourceOwner); it cannot also be a hop`
        );
      }
      if (params.recipientWallet && w === params.recipientWallet) {
        problems.push(
          `route.hops[${i}]: ${w} is the recipient; the route already ends on it`
        );
      }
      if (destinationSet.has(w)) {
        problems.push(
          `route.hops[${i}]: ${w} is a payout destination; destinations cannot appear in route.hops`
        );
      }
      if (SYSTEM_AND_PROTOCOL_ADDRESSES.has(w)) {
        problems.push(
          `route.hops[${i}]: ${w} is a reserved system or MultiHopper protocol account`
        );
      }
      if (seenWallets.has(w)) {
        problems.push(
          `route.hops[${i}]: ${w} is already used earlier on this route`
        );
      }
      seenWallets.add(w);

      if (isMultiDestination && isLast && !isOnCurveWallet(w)) {
        problems.push(
          `route.hops[${i}]: last hop of a multi-destination route must be a regular on-curve wallet, not a PDA`
        );
      }
    } else if ("bundle" in hop) {
      if (isMultiDestination && isLast && hop.bundle === "contracts") {
        problems.push(
          `route.hops[${i}]: 'contracts' bundle cannot be the last hop of a multi-destination route`
        );
      }
    }
  }

  if (totalWait > MAX_WAIT_SECONDS) {
    problems.push(
      `route.hops: cumulative waitSeconds (${totalWait}) exceeds 30-day maximum (${MAX_WAIT_SECONDS})`
    );
  }

  if (problems.length > 0) {
    throw new MultiHopperProtocolError(
      "MH_018",
      `Invalid custom route — ${problems.join("; ")}`,
      400,
      problems
    );
  }

  return {
    onChainHopCount: isMultiDestination ? route.hops.length : route.hops.length + 1,
    arrivalSeconds: totalWait,
  };
}

/**
 * Full pre-flight validation of a `CreateTransferRequest` prior to API submission.
 */
export function validateCreateTransferRequest(
  req: CreateTransferRequest,
  cluster: ClusterEnvironment = "mainnet-beta"
): void {
  if (!isValidSolanaAddress(req.tokenMint)) {
    throw new MultiHopperProtocolError("MH_010", "Invalid tokenMint Solana address");
  }
  if (!isValidSolanaAddress(req.sourceOwner)) {
    throw new MultiHopperProtocolError("MH_011", "Invalid sourceOwner wallet address");
  }

  const hasRecipient = Boolean(req.recipientWallet);
  const hasDestinations = Array.isArray(req.destinations) && req.destinations.length > 0;

  if ((hasRecipient && hasDestinations) || (!hasRecipient && !hasDestinations)) {
    throw new MultiHopperProtocolError(
      "BAD_REQUEST",
      "Provide exactly one of recipientWallet or destinations"
    );
  }

  if (req.recipientWallet) {
    if (!isValidSolanaAddress(req.recipientWallet) || !isOnCurveWallet(req.recipientWallet)) {
      throw new MultiHopperProtocolError(
        "MH_011",
        "recipientWallet must be a valid on-curve Solana wallet address"
      );
    }
    if (req.recipientWallet === req.sourceOwner) {
      throw new MultiHopperProtocolError(
        "MH_011",
        "Circular self-transfer rejected: recipientWallet cannot equal sourceOwner"
      );
    }
  }

  if (req.destinations) {
    if (req.destinations.length < 1 || req.destinations.length > 20) {
      throw new MultiHopperProtocolError(
        "BAD_REQUEST",
        "destinations must contain 1..20 entries"
      );
    }
    for (const d of req.destinations) {
      if (!isValidSolanaAddress(d.wallet)) {
        throw new MultiHopperProtocolError(
          "MH_011",
          `Invalid destination wallet address: ${d.wallet}`
        );
      }
      if (d.wallet === req.sourceOwner) {
        throw new MultiHopperProtocolError(
          "MH_011",
          `Circular self-transfer rejected: destination ${d.wallet} equals sourceOwner`
        );
      }
    }
  }

  if (req.externalId !== undefined && !EXTERNAL_ID_REGEX.test(req.externalId)) {
    throw new MultiHopperProtocolError(
      "MH_015",
      "Invalid externalId format (allowed: alphanumeric, '.', '_', '-', max 128 chars)"
    );
  }

  if (req.route && req.routeTemplateId !== undefined) {
    throw new MultiHopperProtocolError(
      "MH_018",
      "Cannot combine route and routeTemplateId in the same request"
    );
  }

  if (req.route) {
    if (req.hops !== undefined || req.arrivalSeconds !== undefined) {
      throw new MultiHopperProtocolError(
        "MH_018",
        "Invalid custom route — do not combine route with hops or arrivalSeconds"
      );
    }
    validateCustomRoute({
      route: req.route,
      cluster,
      sourceOwner: req.sourceOwner,
      recipientWallet: req.recipientWallet,
      destinationWallets: req.destinations?.map((d) => d.wallet),
      isMultiDestination: hasDestinations,
    });
  } else if (req.routeTemplateId === undefined) {
    const hops = req.hops ?? 7;
    if (!Number.isInteger(hops) || hops < 3 || hops > 10) {
      throw new MultiHopperProtocolError(
        "MH_013",
        `Hops out of range (${hops}): must be 3..10`
      );
    }
    if (req.arrivalSeconds !== undefined) {
      const minArr = minArrivalSecondsForHops(hops);
      if (
        !Number.isInteger(req.arrivalSeconds) ||
        req.arrivalSeconds < minArr ||
        req.arrivalSeconds > MAX_WAIT_SECONDS
      ) {
        throw new MultiHopperProtocolError(
          "MH_014",
          `arrivalSeconds (${req.arrivalSeconds}) out of range ${minArr}..${MAX_WAIT_SECONDS} for ${hops} hops`
        );
      }
    }
  }
}
