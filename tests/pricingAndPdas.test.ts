import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTEGRATOR_REWARDS_WALLET,
  deriveCompleteRouteAccountBundle,
  deriveFeeSchedulePda,
  deriveOrchestratorConfigPda,
  deriveOrchestratorStepPda,
  derivePermanentDelegatePda,
  deriveProviderPda,
  deriveRouteConfigPda,
  deriveRouteStatePda,
  deriveSolVaultPda,
  deriveSplVaultPda,
  deriveTokenConfigGlobalPda,
  deriveWrapperMintPda,
  MAINNET_USDC_MINT,
  MULTIHOPPER_CORE_PROGRAM_ID,
  MULTIHOPPER_ORCHESTRATOR_PROGRAM_ID,
  NATIVE_SOL_MINT,
} from "../src/protocol/multihopperPdas.js";
import {
  allocateDestinationPayouts,
  estimateTransferLocal,
} from "../src/protocol/pricingEngine.js";
import { MultiHopperProtocolError } from "../src/types.js";

describe("MultiHopper On-Chain 10-Tier Pricing & Revenue Share Engine", () => {
  it("reproduces the official MultiHopper 1 SOL @ $120 (3 hops) worked example to the exact lamport", () => {
    const quote = estimateTransferLocal(
      {
        tokenMint: NATIVE_SOL_MINT,
        amountRaw: "1000000000",
        tokenDecimals: 9,
        tokenPriceUsd: 120,
        hops: 3,
      },
      { cluster: "devnet" }
    );

    expect(quote.tier).toBe("tier_2");
    expect(quote.tierIndex).toBe(2);
    expect(quote.flatFeeLamportsPerHop).toBe(375_000);
    expect(quote.totalFlatFeeLamports).toBe(1_125_000);
    expect(quote.hopAmountRaw).toBe("993905472");
    expect(quote.percentFeeRaw).toBe("4969527");
    expect(quote.integratorPercentShare).toBe("2484763");
    expect(quote.integratorFlatShare).toBe(0);
    expect(quote.integratorRewardsWallet).toBe(DEFAULT_INTEGRATOR_REWARDS_WALLET);
    expect(quote.cappedAtTierBoundary).toBe(false);
  });

  it("reproduces the official MultiHopper multi-destination 60/40 split to the exact lamport", () => {
    const destA = "7pBqizvE8vQZ29F49NWSu9cho3s7M9SqJyNN1UoQyQ2u";
    const destB = "3UdgSTpcUbiBSmgdPBiVHRMbcDS731kMT6bAQQZgE3c4";

    const allocs = allocateDestinationPayouts({
      totalAmountRaw: "1000000000",
      recipientReceivesRaw: "993905472",
      destinations: [
        { wallet: destA, amountRaw: "600000000" },
        { wallet: destB, amountRaw: "400000000" },
      ],
      isNativeSol: true,
    });

    expect(allocs).toEqual([
      { wallet: destA, postFeeAmountRaw: "596343283" },
      { wallet: destB, postFeeAmountRaw: "397562189" },
    ]);
    expect(BigInt(allocs[0]!.postFeeAmountRaw) + BigInt(allocs[1]!.postFeeAmountRaw)).toBe(
      993_905_472n
    );
  });

  it("charges 0 per-hop flat SOL fee in Tier 0 (<= $50) and splits 0.50% SPL fee 50/50", () => {
    const quote = estimateTransferLocal({
      tokenMint: MAINNET_USDC_MINT,
      amountRaw: "40000000", // 40 USDC
      tokenDecimals: 6,
      tokenPriceUsd: 1.0,
      hops: 5,
    });

    expect(quote.tier).toBe("tier_0");
    expect(quote.totalFlatFeeLamports).toBe(0);
    // 40_000_000 * 10000 / 10050 = 39_800_995
    expect(quote.hopAmountRaw).toBe("39800995");
    expect(quote.percentFeeRaw).toBe("199004");
    expect(quote.integratorPercentShare).toBe("99502");
    // Mainnet compliance screening fee included (5 hops + 1 recipient = 6 * 2,000,000 = 12,000,000)
    expect(quote.sol.breakdown.screeningFeeLamports).toBe(12_000_000);
  });

  it("handles tier boundary discontinuity via cappedAtTierBoundary=true", () => {
    // 0.5026 SOL @ $100 = $50.26 gross; post-0.5% is $50.009 (Tier 1),
    // but subtracting Tier 1's 3 * 125,000 = 375,000 lamports ($0.0375) drops hopAmount below $50.00 (Tier 0)!
    const quote = estimateTransferLocal({
      tokenMint: NATIVE_SOL_MINT,
      amountRaw: "502600000",
      tokenDecimals: 9,
      tokenPriceUsd: 100,
      hops: 3,
    });

    expect(quote.cappedAtTierBoundary).toBe(true);
    expect(quote.tier).toBe("tier_0");
    expect(quote.hopAmountRaw).toBe("500000000"); // capped cleanly at $50.00 top of Tier 0
  });

  it("rejects SOL multi-destination payouts below the 890,880-lamport rent-exempt floor with MH_017", () => {
    const destA = Keypair.generate().publicKey.toBase58();
    const destB = Keypair.generate().publicKey.toBase58();

    expect(() =>
      allocateDestinationPayouts({
        totalAmountRaw: "10000000",
        recipientReceivesRaw: "9950248",
        destinations: [
          { wallet: destA, amountRaw: "9500000" },
          { wallet: destB, amountRaw: "500000" }, // < 890,880 lamports
        ],
        isNativeSol: true,
      })
    ).toThrowError(MultiHopperProtocolError);

    try {
      allocateDestinationPayouts({
        totalAmountRaw: "10000000",
        recipientReceivesRaw: "9950248",
        destinations: [
          { wallet: destA, amountRaw: "9500000" },
          { wallet: destB, amountRaw: "500000" },
        ],
        isNativeSol: true,
      });
    } catch (err) {
      expect((err as MultiHopperProtocolError).code).toBe("MH_017");
    }
  });
});

describe("MultiHopper Solana Anchor PDA Derivation Suite", () => {
  it("derives all 11 protocol PDAs deterministically against verified Mainnet program IDs", () => {
    const creator = Keypair.generate().publicKey;
    const route1 = deriveRouteConfigPda(1n);
    const route2 = deriveRouteConfigPda(2n);
    expect(route1.address).not.toBe(route2.address);
    expect(route1.programId).toBe(MULTIHOPPER_CORE_PROGRAM_ID.toBase58());

    const statePda = deriveRouteStatePda(1n);
    const delegatePda = derivePermanentDelegatePda(1n);
    const wrapperPda = deriveWrapperMintPda(1n);
    const splVault = deriveSplVaultPda(MAINNET_USDC_MINT);
    const solVault = deriveSolVaultPda(creator);
    const tokenCfg = deriveTokenConfigGlobalPda();
    const provider = deriveProviderPda("lbcron-router");
    const feeSched = deriveFeeSchedulePda("lbcron-router");
    const orchCfg = deriveOrchestratorConfigPda();
    const orchStep = deriveOrchestratorStepPda(orchCfg.address, 0);

    expect(orchCfg.programId).toBe(MULTIHOPPER_ORCHESTRATOR_PROGRAM_ID.toBase58());
    expect(orchStep.programId).toBe(MULTIHOPPER_ORCHESTRATOR_PROGRAM_ID.toBase58());

    const allAddresses = new Set([
      route1.address,
      statePda.address,
      delegatePda.address,
      wrapperPda.address,
      splVault.address,
      solVault.address,
      tokenCfg.address,
      provider.address,
      feeSched.address,
      orchCfg.address,
      orchStep.address,
    ]);
    expect(allAddresses.size).toBe(11);

    const bundle = deriveCompleteRouteAccountBundle({
      routeId: 1n,
      tokenMint: MAINNET_USDC_MINT,
      providerId: "lbcron-router",
    });
    expect(bundle.routeConfig.address).toBe(route1.address);
    expect(bundle.provider?.address).toBe(provider.address);
  });
});
