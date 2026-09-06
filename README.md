# loophole tape — real-time labelled pump.fun intelligence, paid per request (x402, USDC on Solana)

**Base URL:** `https://api.loopholetape.com`
**Payment:** [x402](https://github.com/x402-foundation/x402) v2, scheme `exact`, network `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, asset USDC. The facilitator pays the Solana network fee; a caller needs only USDC. No accounts, no API keys, no humans.

## What it is

Public on-chain activity for each observed pump.fun launch, curve trade and migration, turned into labels that are
not sold anywhere else per request:

- **creator reputation as knowable at launch time** (look-ahead-safe: launches, curve-true graduations, rugs, median time to the dev's first sell) over 385k launches / 90k creators
- **create-slot bundle, insider and dev shares** (who bought in the launch slot and how much they hold)
- **rug / close flags within seconds**: `creator_sold`, `bundle_dumped`, `curve_drained`, `pool_drained`, `curve_closed_low`, `migrate_below_grad`
- **graduation truth**: a graduation is the curve witnessed at >= 84 SOL; everything else (mayhem closes, operator-seeded pools, ~31% of "migrations") is labelled a close
- **funding-linked (warm) launches**: the creator was funded by a watched insider wallet within 30 minutes of launching
- **demand and holder microstructure**: unique buyers, buy/sell flow, inflow stall, top-5 share, HHI
- a free **market regime meter** and free delayed samples of every paid route

## Routes

| Route | Price (USDC) | What you get |
|---|---|---|
| `GET /v1/mint/{mint}` | $0.025 | live risk card for one mint (curve truth, demand, holders, create-slot shares, creator prior, flags, exit signals); historical record for older mints |
| `GET /v1/launches/recent` | $0.01 | recent launches with compact labels (`limit`, `max_age_s`, `exclude_mayhem`, `min_rs`, `only_alive`) |
| `GET /v1/rugs/recent` | $0.02 | recent rug / close flags with mechanism labels (`limit`, `window_s`) |
| `GET /v1/graduations/recent` | $0.02 | recent migrations labelled true-graduation vs below-threshold close |
| `GET /v1/creator/{address}` | $0.02 | creator reputation, last 25 launches, live mints, recent insider funding |
| `GET /v1/wallet/{address}` | $0.02 | wallet class from our PnL leaderboard, holdings among recent mints |
| `GET /v1/market/regime` | free | launches/min, mayhem share, buy/sell flow, fail share, migrations vs true graduations, rug flags |
| `GET /v1/sample/launches`, `/v1/sample/rugs`, `/v1/sample/mint` | free | 3-item samples delayed >= 300 s |
| `GET /`, `/health`, `/openapi.json`, `/docs`, `/.well-known/x402`, `/v1/x402/resources`, `/terms` | free | index, health, schema, discovery manifest, terms |

Every response is `{"ok": true, "t": <unix>, "data": {...}, "meta": {"feed_lag_s": ..., "last_slot": ..., "disclaimer": ...}}`.

## Pay from Python (reference client)

```bash
pip install "x402[httpx,svm]==2.22.0" "solana==0.36.7"
TAPE_PAYER_KEYPAIR=~/.config/solana/payer.json python pay_client.py https://api.loopholetape.com "/v1/launches/recent?limit=5"
```

Any x402 v2 client works the same way: call the route, read the `PAYMENT-REQUIRED` header, sign the USDC transfer, retry with
`PAYMENT-SIGNATURE`; the `PAYMENT-RESPONSE` header carries the settlement signature. TypeScript: `@x402/fetch` + `@x402/svm`.
Agents: the routes are listed in the PayAI x402 catalog and on agent402.tools; AgentKit's `discover_x402_services` finds them.

## MCP (for agents that call tools)

The same intelligence is an MCP server over streamable HTTP at `https://api.loopholetape.com/mcp`,
listed in the official MCP registry as `io.github.gosadu/loophole-tape`. Tools: `market_regime` and `sample_mint` (free),
`mint_risk_card` ($0.025), `recent_launches` ($0.01), `recent_rugs`, `recent_graduations`, `creator_reputation`,
`wallet_profile` ($0.02 each). Paid tools use x402 over MCP: the first call returns a payment-required result, the client pays
in `_meta["x402/payment"]`, the settlement comes back in `_meta["x402/payment-response"]`. Reference client: `mcp_client.py`
(`pip install "x402[httpx,svm]==2.22.0" "solana==0.36.7" "mcp<2"`).

## Terms, in one line

Statistics derived from public on-chain data; labels are heuristics, not guarantees; nothing here is financial advice; sold as-is per request; no refunds for empty results; do not resell raw responses. Full text at `/terms`.
