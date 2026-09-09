# loophole tape — real-time labelled pump.fun and Robinhood Chain launch intelligence, paid per request (x402, USDC on Solana)

**Base URL:** `https://api.loopholetape.com`
**Payment:** [x402](https://github.com/x402-foundation/x402) v2, scheme `exact`, network `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, asset USDC, facilitator `https://facilitator.payai.network`. The facilitator pays the Solana network fee; a caller needs only USDC. No accounts, no API keys, no humans.
**Version:** 0.3.0 (schema 2.0)

## What it is

Live pump.fun / PumpSwap analytics derived from public on-chain data. Pay per request in USDC on Solana through x402. See the documented routes for coverage and freshness.

Since v0.3.0 the same service also covers **Robinhood Chain (Pons V2 launchpad)**: launch feed and per-curve structure cards derived from public on-chain activity (raised/progress/price multiple, snipe-tax activity, holder concentration, same-block direct-buy cluster share, direct vs terminal route mix, new-buyer flow, lifecycle).

## Routes

| Route | Price (USDC) | What you get |
|---|---|---|
| `GET /v1/mint/{mint}` | $0.025 | Risk card for one pump.fun mint (live microstructure or thin on-chain card) |
| `GET /v1/launches/recent` | $0.01 | Recent pump.fun launches with compact risk labels |
| `GET /v1/rugs/recent` | $0.02 | Recent rug / close flags with mechanism labels |
| `GET /v1/graduations/recent` | $0.02 | Recent migrations labelled true graduation vs below-threshold close |
| `GET /v1/creator/{address}` | $0.02 | Creator reputation over our full launch history |
| `GET /v1/wallet/{address}` | $0.02 | Wallet class from our rolling PnL leaderboard + live holdings |
| `GET /v1/rhc/launches/recent` | $0.01 | Robinhood Chain (Pons V2) recent launches with holder / route / cluster structure |
| `GET /v1/rhc/curve/{address}` | $0.02 | Robinhood Chain (Pons V2) curve structure card for one curve or token address |
| `/`, `/health`, `/v1/market/regime`, `/v1/sample/launches`, `/v1/sample/rugs`, `/v1/sample/mint`, `/v1/x402/resources`, `/v1/labels`, `/v1/rhc/regime`, `/.well-known/x402`, `/openapi.json`, `/llms.txt`, `/mcp`, `/terms` | free | index, health, regime meters, delayed samples, discovery documents, labels, MCP, terms |

Every paid response is self-describing: `schema_version`, `generated_at`, `coverage` (`full` = computed from our live window, `thin` = history record + live on-chain state + base rates, with `*_reason` fields where a value is unknowable), `source`, `is_stale`, and `next` hints to related resources. A valid mint always returns 200; only a malformed pubkey returns 404. Label semantics: `/v1/labels`. Base rates (7-day, from our full launch history) ride along on every card.

## Discovery for agents

`/` (index), `/openapi.json` (x402scan-conformant, mirrored here), `/llms.txt` and `/llms-full.txt`, `/.well-known/x402` (manifest with accepts, input and output schemas per resource, mirrored here), `/v1/x402/resources` (per-resource accepts, examples, latency, freshness). Listed in the PayAI x402 catalog, on agent402.tools, and in the official MCP registry as `io.github.gosadu/loophole-tape`.

## Pay from Python (reference client)

```bash
pip install "x402[httpx,svm]==2.22.0" "solana==0.36.7"
TAPE_PAYER_KEYPAIR=~/.config/solana/payer.json python pay_client.py https://api.loopholetape.com "/v1/launches/recent?limit=5"
```

Any x402 v2 client works the same way: call the route, read the `PAYMENT-REQUIRED` header (the 402 body repeats it as JSON with a `how` field), sign the USDC transfer, retry with `PAYMENT-SIGNATURE`; the `PAYMENT-RESPONSE` header carries the settlement signature. TypeScript: `@x402/fetch` + `@x402/svm`. AgentKit's `discover_x402_services` finds the routes.

## MCP (for agents that call tools)

MCP server over streamable HTTP at `https://api.loopholetape.com/mcp` (no trailing slash needed; CORS preflight and plain JSON accepted). Tools: `catalog` (free), `health` (free), `market_regime` (free), `sample_mint` (free), `mint_risk_card` ($0.025), `recent_launches` ($0.01), `recent_rugs` ($0.02), `recent_graduations` ($0.02), `creator_reputation` ($0.02), `wallet_profile` ($0.02), `rhc_regime` (free), `rhc_recent_launches` ($0.01), `rhc_curve_card` ($0.02). Paid tools use x402 over MCP: the first call returns a payment-required result, the client pays in `_meta["x402/payment"]`, the settlement comes back in `_meta["x402/payment-response"]`; invalid arguments return a structured `isError` result with the schema before any payment. Reference client: `mcp_client.py` (`pip install "x402[httpx,svm]==2.22.0" "solana==0.36.7" "mcp<2"`).

## Terms, in one line

Statistics derived from public on-chain data; labels are heuristics, not guarantees; nothing here is financial advice; sold as-is per request; no refunds for empty results; do not resell raw responses. Full text at `/terms`.
