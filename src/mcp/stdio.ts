#!/usr/bin/env node
import { createInterface } from "node:readline";
import { Keypair } from "@solana/web3.js";
import {
  AutonomousCapitalAgentKernel,
  createDefaultMandatePolicy,
} from "../agent/mandateKernel.js";
import {
  HttpMultiHopperClient,
  SandboxMultiHopperBackend,
} from "../protocol/multihopperClient.js";
import { loadKeypairFromBase58OrJson } from "../protocol/txSignerBroadcaster.js";
import { JsonRpcRequest, SolRouteMcpServer } from "./mcpServer.js";

const signer = process.env.SOLANA_PRIVATE_KEY
  ? loadKeypairFromBase58OrJson(process.env.SOLANA_PRIVATE_KEY)
  : Keypair.generate();

const backend = process.env.MH_API_KEY
  ? new HttpMultiHopperClient({ apiKey: process.env.MH_API_KEY })
  : new SandboxMultiHopperBackend();

const kernel = new AutonomousCapitalAgentKernel({
  policy: createDefaultMandatePolicy(signer.publicKey.toBase58()),
  backend,
});

const server = new SolRouteMcpServer({ kernel, agentSigner: signer });

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const req = JSON.parse(trimmed) as JsonRpcRequest;
    const res = await server.handleJsonRpc(req);
    if (res !== null) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
    }
  } catch (err) {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: err instanceof Error ? err.message : "Parse error" },
      })}\n`
    );
  }
});
