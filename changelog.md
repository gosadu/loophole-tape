# Changelog

## 0.4.0 — 2026-09-10

- Added compact pump.fun observed-risk checks: $0.005 for one mint, $0.01 total for up to five caller-selected mints, through HTTP and MCP. Existing products and prices remain available.
- Added free coverage/pricing and watch-update availability tools. All requested mints must have full live coverage and feed lag <= 5 seconds at result generation. Invalid, unavailable and stale requests are rejected before payment, with eligibility checked again after verification. Delivery metadata includes settlement delay; the five-second rule is not a delivery-time guarantee.
- Added opaque, restart-safe, 24-hour watch cursors for documented first-observed flags and lifecycle transitions. Ordinary trades and changing counts do not trigger an update. An unchanged cursor passed to a paid check returns an unpaid `no_new_events` result. Poll free availability every 15 seconds or slower.
- Added ten-minute recovery of the original paid result using the exact signed payment, same transport and original arguments. Replays include the original receipt and explicit age/staleness metadata without another settlement. Altered payment metadata or arguments return a conflict. Expired settled-payment claims cannot be reused for fresh data during their 24-hour retention. Unknown settlement outcomes report `charged:null` and require reconciliation before another authorization.
- Added compact typed output schemas, evidence/timestamps, exact price metadata and full-card links. Discovery now exposes 17 MCP tools: seven free and ten paid. Updated OpenAPI, x402 manifest, catalog and agent guidance.
- Added Python and TypeScript buyers with HTTP/MCP support, recipient/network/asset/resource/price checks, cumulative budgets, persisted exact-payment retries and finite free watch polling. State files prevent concurrent spending of one budget. See README for crash recovery and authorization-accounting semantics.
- Added a compatible Python requirement set and pinned npm lockfile. Fresh Python imports and dependency checks pass. The TypeScript package uses Node 24+, x402 2.25.0, Solana Kit 5.5.1 and TypeScript 5.9.3 without peer overrides.

## 0.3.0 corrections — 2026-09-10

- Encoded paid URLs follow the same payment enforcement as canonical router paths.
- Robinhood Chain two-/six-second activity counts expire against request time when a curve is idle; trade age and feed timestamps use observed event time.
