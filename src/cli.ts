#!/usr/bin/env node
import { Connection, Keypair } from "@solana/web3.js";
import {
  AutonomousCapitalAgentKernel,
  createDefaultMandatePolicy,
} from "./agent/mandateKernel.js";
import { SandboxMultiHopperBackend } from "./protocol/multihopperClient.js";
import {
  DEFAULT_INTEGRATOR_REWARDS_WALLET,
  deriveCompleteRouteAccountBundle,
  NATIVE_SOL_MINT,
  verifyMainnetPrograms,
} from "./protocol/multihopperPdas.js";
import { createSolRouteServer } from "./server/appServer.js";

async function runDemo(): Promise<void> {
  const agentSigner = Keypair.generate();
  const recipientA = Keypair.generate().publicKey.toBase58();
  const recipientB = Keypair.generate().publicKey.toBase58();

  const backend = new SandboxMultiHopperBackend();
  const kernel = new AutonomousCapitalAgentKernel({
    policy: createDefaultMandatePolicy(agentSigner.publicKey.toBase58()),
    backend,
  });

  console.log("=== SolRouteMandate Autonomous Execution Demo ===");
  console.log(`Agent Treasury Wallet     : ${agentSigner.publicKey.toBase58()}`);
  console.log(`Integrator Rewards Wallet : ${DEFAULT_INTEGRATOR_REWARDS_WALLET}`);

  const pdaBundle = deriveCompleteRouteAccountBundle({
    routeId: 42n,
    tokenMint: NATIVE_SOL_MINT,
    providerId: "lbcron-router",
  });
  console.log(`Derived RouteConfig PDA   : ${pdaBundle.routeConfig.address} (bump ${pdaBundle.routeConfig.bump})`);
  console.log(`Derived WrapperMint PDA   : ${pdaBundle.wrapperMint.address} (bump ${pdaBundle.wrapperMint.bump})`);

  const payrollReceipt = await kernel.executeGuardedRoute({
    request: {
      tokenMint: NATIVE_SOL_MINT,
      amountRaw: "500000000", // 0.5 SOL ($75 @ $150/SOL -> autonomous tier!)
      amountTokens: "0.5",
      tokenDecimals: 9,
      tokenSymbol: "SOL",
      tokenPriceUsd: 150,
      sourceOwner: agentSigner.publicKey.toBase58(),
      hops: 4,
      arrivalSeconds: 300,
      destinations: [
        { wallet: recipientA, amountRaw: "300000000" },
        { wallet: recipientB, amountRaw: "200000000" },
      ],
      externalId: "demo-payroll-001",
    },
    signer: agentSigner,
    walletSolBalanceLamports: 2_000_000_000,
  });

  console.log(`Mandate Verdict           : ${payrollReceipt.mandateVerdict.status}`);
  console.log(`Recipient Net Delivery    : ${payrollReceipt.estimate.hopAmountRaw} lamports`);
  console.log(`Atomic 50% Revenue Share  : ${payrollReceipt.estimate.integratorPercentShare} lamports`);
  console.log(`Provenance Receipt SHA256 : ${payrollReceipt.provenanceHashSha256}`);
}

async function runVerifyMainnet(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpcUrl, "confirmed");
  const statuses = await verifyMainnetPrograms(conn);
  console.log(JSON.stringify({ rpcUrl, programs: statuses }, null, 2));
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "serve";
  if (cmd === "demo") {
    await runDemo();
    return;
  }
  if (cmd === "verify-mainnet") {
    await runVerifyMainnet();
    return;
  }

  const port = Number(process.env.PORT ?? 4173);
  const { server, agentSigner } = createSolRouteServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`SolRouteMandate Cockpit listening on http://127.0.0.1:${port}`);
    console.log(`Active Agent Wallet: ${agentSigner.publicKey.toBase58()}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
