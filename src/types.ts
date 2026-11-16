/**
 * Core protocol types for SolRouteMandate:
 * MultiHopper REST v1 + MCP + On-Chain Solana PDAs + OOBE/Steve Capital SAP Mandate Kernel.
 */

export type ClusterEnvironment = "mainnet-beta" | "devnet";

export type HopLibraryBundle = "cex" | "dex" | "exchanges" | "kol" | "contracts" | "mix";
export type HopLibraryCategory = "cex" | "dex" | "famous" | "kol" | "contracts" | "other";

export type CustomRouteHopInput =
  | { wallet: string; waitSeconds: number }
  | { bundle: HopLibraryBundle; waitSeconds: number };

export interface CustomRouteInput {
  hops: CustomRouteHopInput[];
}

export interface DestinationShareInput {
  wallet: string;
  amountRaw: string;
}

export interface EstimateTransferRequest {
  tokenMint: string;
  amountRaw: string;
  tokenDecimals?: number;
  tokenPriceUsd?: number;
  hops?: number;
  destinationCount?: number;
  arrivalSeconds?: number;
  route?: CustomRouteInput;
  routeTemplateId?: number;
}

export interface SolUpfrontBreakdown {
  routeInitRentLamports: number;
  orchestratorRentLamports: number;
  ataRentLamports: number;
  transactionFeesLamports: number;
  priorityFeesLamports: number;
  protocolFlatFeeLamports: number;
  screeningFeeLamports: number;
  dispersionRentLamports: number;
}

export interface EstimateTransferResponse {
  tier: string;
  tierIndex: number;
  percentFeeBps: number;
  percentFeeRaw: string;
  flatFeeLamportsPerHop: number;
  flatFeeLamportsPerRoute: number;
  totalFlatFeeLamports: number;
  integratorPercentShare: string;
  integratorFlatShare: number;
  integratorRewardsWallet: string;
  usdEquivalent: number;
  usdValueMicros: string;
  priceSource: "onchain_pool" | "override" | "oracle";
  hopAmountRaw: string;
  cappedAtTierBoundary: boolean;
  destinationCount: number | null;
  isTestMode: boolean;
  tokens: {
    amountRaw: string;
    feeRaw: string;
    netDeliveredRaw: string;
    decimals: number;
  };
  sol: {
    requiredSolUpFrontLamports: number;
    minTransferAmountLamports: number;
    breakdown: SolUpfrontBreakdown;
    refundableLamports: number;
    netCostLamports: number;
  };
  route?: {
    hopCount: number;
    arrivalSeconds: number;
  };
}

export interface CreateTransferRequest {
  tokenMint: string;
  amountRaw: string;
  amountTokens: string;
  sourceOwner: string;
  recipientWallet?: string;
  destinations?: DestinationShareInput[];
  tokenDecimals?: number;
  tokenSymbol?: string;
  hops?: number;
  arrivalSeconds?: number;
  route?: CustomRouteInput;
  routeTemplateId?: number;
  externalId?: string;
  tokenPriceUsd?: number;
}

export type TransferStatus =
  | "quote"
  | "awaiting_signature"
  | "processing"
  | "active"
  | "completed"
  | "failed"
  | "expired"
  | "refunded";

export type TransferPhase =
  | "quoted"
  | "deploying"
  | "executing"
  | "settled"
  | "failed"
  | "recoverable"
  | "rescued"
  | "reclaimed"
  | "expired";

export interface ResolvedRouteHop {
  index: number;
  address: string;
  label: string | null;
  category: HopLibraryCategory | null;
  scheduledAt: string;
  executedAt: string | null;
  txSignature: string | null;
}

export interface DestinationPayoutStatus {
  wallet: string;
  amountRaw: string;
  status: "pending" | "paid";
  payoutSignature: string | null;
  paidAt: string | null;
}

export interface TransferRecord {
  id: number;
  externalId: string | null;
  supportBundleId: string;
  tokenMint: string;
  tokenSymbol?: string;
  tokenDecimals: number;
  amountRaw: string;
  amountTokens: string;
  sourceOwner: string;
  recipientWallet: string | null;
  destinationCount: number | null;
  destinations: DestinationPayoutStatus[] | null;
  recipientReceivesRaw: string;
  fundingStrategy: string;
  hops: number;
  arrivalSeconds: number;
  pricingTier: string;
  percentFeeBps: number;
  percentFeeRaw: string;
  flatFeeLamportsPerHop: number;
  totalFlatFeeLamports: number;
  integratorShareRaw: string;
  status: TransferStatus;
  phase: TransferPhase;
  progress: {
    hopsCompleted: number;
    hopsTotal: number;
  };
  isTest: boolean;
  quotedAt: string;
  expiresAt: string;
  createdAt: string;
  route?: {
    hops: ResolvedRouteHop[];
  };
}

export interface PreparedTxsBundle {
  routeInitTxs?: { base64: string }[] | null;
  orchestratorInitTx?: string | null;
  sessionInitTxs?: string[] | null;
  keeperFundingTx?: string | null;
  dispersionInitTxs?: string[] | null;
  recentBlockhash?: string;
  lastValidBlockHeight?: number;
  resume?: {
    nothingToDo?: boolean;
    routeAlreadyDeployed?: boolean;
    dispersion?: {
      boundSteps: number;
      totalSteps: number;
    };
  };
}

export interface PrepareTransferResponse {
  transfer: TransferRecord;
  preparedTxs: PreparedTxsBundle;
}

export interface ConfirmBroadcastRequest {
  keeperFundingSignature?: string;
  routeInitSignatures: string[];
  orchestratorInitSignature?: string;
  sessionInitSignatures?: string[];
  dispersionInitSignatures?: string[];
}

export type MultiHopperErrorCode =
  | "BAD_REQUEST"
  | "MH_001"
  | "MH_002"
  | "MH_003"
  | "MH_004"
  | "MH_010"
  | "MH_011"
  | "MH_012"
  | "MH_013"
  | "MH_014"
  | "MH_015"
  | "MH_016"
  | "MH_017"
  | "MH_018"
  | "MH_019"
  | "MH_020"
  | "MH_021"
  | "MH_022"
  | "MH_023"
  | "MH_030"
  | "MH_032"
  | "MH_033"
  | "MH_034"
  | "MH_035"
  | "MH_039"
  | "MH_040"
  | "MH_041"
  | "MH_070"
  | "MH_071"
  | "MH_080"
  | "MH_090"
  | "MH_091";

export class MultiHopperProtocolError extends Error {
  public readonly code: MultiHopperErrorCode;
  public readonly httpStatus: number;
  public readonly problems: string[];

  constructor(
    code: MultiHopperErrorCode,
    message: string,
    httpStatus = 400,
    problems: string[] = []
  ) {
    super(message);
    this.name = "MultiHopperProtocolError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.problems = problems;
  }
}

export type MultiHopperWebhookEventType =
  | "transfer.quote_created"
  | "transfer.deposit_confirmed"
  | "transfer.processing"
  | "transfer.phase_changed"
  | "transfer.hop_complete"
  | "transfer.completed"
  | "transfer.failed"
  | "transfer.expired"
  | "transfer.refunded"
  | "transfer.recoverable"
  | "transfer.rescued"
  | "transfer.rent_reclaimed"
  | "payout.completed";

export interface MultiHopperWebhookEvent<TData = Record<string, unknown>> {
  id: string;
  type: MultiHopperWebhookEventType;
  createdAt: string;
  transferId?: number;
  data: TData;
}

export interface CapitalMandatePolicy {
  mandateId: string;
  ownerWallet: string;
  integratorRewardsWallet: string;
  maxSingleTransferUsd: number;
  maxDailySpendUsd: number;
  requireHumanApprovalAboveUsd: number;
  minSolReserveLamports: number;
  allowedMints: string[];
  allowedRecipients?: string[];
  blockedRecipients: string[];
  maxHops: number;
  minHops: number;
  emergencyHalt: boolean;
}

export type PolicyVerdictStatus =
  | "ALLOW_AUTONOMOUS"
  | "REQUIRE_SIGNATURE_APPROVAL"
  | "DENY";

export interface PolicyEvaluationResult {
  status: PolicyVerdictStatus;
  reasons: string[];
  projectedUsdSpend: number;
  remainingDailyBudgetUsd: number;
  requiredSolUpFrontLamports: number;
}

export interface ProvenanceReceipt {
  receiptId: string;
  wallet: string;
  commandType: "SINGLE_ROUTE" | "MULTI_DESTINATION_PAYROLL" | "TREASURY_REBALANCE";
  timestamp: string;
  mandateVerdict: PolicyEvaluationResult;
  simulationPassed: boolean;
  simulationLogs: string[];
  estimate: EstimateTransferResponse;
  transfer?: TransferRecord;
  signatures: {
    keeperFundingSignature?: string;
    routeInitSignatures: string[];
    orchestratorInitSignature?: string;
    sessionInitSignatures?: string[];
    dispersionInitSignatures?: string[];
  };
  provenanceHashSha256: string;
}
