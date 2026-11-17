# Security Policy & Mandate Threat Model

## Non-Custodial Execution Invariants
`SolRouteMandate` enforces deterministic pre-signing policy checks before any Solana transaction is signed or broadcast:

1. **Per-Epoch Notional Cap**: Rejects any swap whose input exceeds `maxPerSwapLamports` or remaining epoch allowance.
2. **Program & Mint Allowlist**: Every instruction `programId` and token mint in the route must match the explicit mandate allowlist.
3. **Slippage & Price-Impact Ceiling**: Routes exceeding `maxSlippageBps` or `maxPriceImpactPct` are rejected prior to signing.
4. **Zero Plaintext Secret Persistence**: Keypairs are loaded ephemerally from environment/keystore memory only when signing a validated mandate route.

## Reporting a Vulnerability
Please report security issues via GitHub Private Vulnerability Reporting on this repository.
