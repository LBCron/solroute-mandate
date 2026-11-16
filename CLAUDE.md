# SolRouteMandate — Agent Context (`CLAUDE.md`)

Use this context when operating `SolRouteMandate` inside **Steve Capital MCP Workspace**, **Claude Code**, or **Cursor**.

## Non-Custodial Security Rule

1. Hosted MultiHopper endpoints (`https://multihopper.com/api/v1` and `https://multihopper.com/api/mcp`) **never** receive private keys.
2. Every financial action must pass through `SolRouteMandate`'s per-wallet **Actor Mailbox** and **Capital Mandate Gate** (`execute_mandate_routed_transfer`) before client-side partial signing.
3. `VersionedTransaction (v0)` bundles returned by `/prepare` carry server ephemeral signatures; always preserve existing signature slots via `signVersionedPreservingPartialSigs`.
4. Broadcast strictly in order:
   `keeperFundingTx` -> `confirm-broadcast` (keeper lock) -> `routeInitTxs` -> `orchestratorInitTx` -> `sessionInitTxs` -> `dispersionInitTxs` -> `confirm-broadcast` (final).

## Local MCP Tools (`solroute-mandate-mcp`)

- `quote_multihopper_route` — Exact 10-tier fee quote, net delivery, SOL reserve requirement, and 50% integrator split.
- `validate_custom_route` — Pre-flight `MH_018` / `MH_019` dry-run check for custom `route.hops`.
- `derive_multihopper_pdas` — Deterministic Solana PDAs for `3jLoS2wbNgtKzieUUxwg6Xhdv6gbZkHDtPWA9ZAgspFh` & `4TPCmR2uN3hDM1FbTsf7ZtFXwXGSz4u1Kxv5YHj6eruX`.
- `execute_mandate_routed_transfer` — Full guarded single or multi-destination execution + SHA-256 provenance receipt.
- `verify_mainnet_programs` — Live Solana Mainnet RPC verification of MultiHopper programs.
- `get_provenance_ledger` — Inspect active policy, 24h spend usage, and hash-chained receipts.
