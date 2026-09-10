# loophole tape — pump.fun risk checks from $0.005

**Base URL:** `https://api.loopholetape.com`
**Payment:** [x402](https://github.com/x402-foundation/x402) v2, scheme `exact`, network `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, asset USDC, facilitator `https://facilitator.payai.network`. The facilitator pays the Solana network fee; a caller needs only USDC. No account or API key required.
**Version:** 0.4.0 (schema 2.0)

Check one mint for **$0.005**, or up to five caller-selected mints for **$0.01 total**. Get observed creator exits, early-wallet selling, drains, migration state, concentration and buyer flow in a compact JSON result. Use it before a swap or to monitor a position. Findings carry first-observed times and evidence; `no_flags_observed` means no documented flags were observed, not that a token is safe.

**Free coverage, free watch availability, no charge for unchanged watched events.** New paid checks require full live coverage for every mint and feed lag no greater than five seconds. Invalid, unavailable and stale checks are rejected before payment, with eligibility checked again after verification. The existing full card remains $0.025 and the existing free routes remain free.

## Start here

1. Choose one to five pump.fun mints from your own workflow. Call `GET /v1/check/coverage?mints=MINT1,MINT2` for free to see availability and exact prices. Coverage is also checked automatically by the paid route, so a separate preflight call is optional.
2. Call `GET /v1/check/mint/MINT` ($0.005) or `GET /v1/check/watchlist?mints=MINT1,MINT2` ($0.01 total). A payable request returns the standard x402 402 challenge. Pay once to receive the compact check and a watch cursor.
3. Poll `GET /v1/check/watch?mints=MINT1,MINT2&cursor=CURSOR` every 15 seconds or slower for free. When `data.has_new_events` is true, pass the same cursor to the paid check for details and an updated cursor. Passing an unchanged cursor directly to the paid check also returns an unpaid `no_new_events` result.

Only these events advance a watch cursor: `creator_sold`, `bundle_dumped`, `curve_drained`, `pool_drained`, `curve_closed_low`, `migrate_below_grad`, and curve completion/migration/graduation transitions. Ordinary trades, ages and changing totals do not. Cursors bind to the exact mint set and expire after 24 hours. Calling the free watch without a cursor initializes a baseline; omit the cursor from a paid check when you want the current measurements regardless of new events.

The five-second eligibility limit is measured at result generation, before settlement. Settlement and network transit can add delay. `meta.freshness_checked_at` and `feed_lag_at_generation_s` record the eligibility check; `result_age_s`, `feed_lag_s` and `is_stale` are aged when the result is sent, including time spent settling. Compare `t` with your own clock after receipt; this is not a guarantee of delivery within five seconds.

## Budgeted buyers: Python and TypeScript

The new reference buyers work with **HTTP and MCP**. They check the recipient, Solana mainnet, USDC, exact scheme, resource, advertised product price and your budget before signing. A state file retains the original signed payment before transmission; timeouts reuse that payment. Neither client loads a wallet for unavailable or unchanged results.

Python 3.12+ (Linux/macOS):

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-client.txt
.venv/bin/python risk_client.py "$MINTS" --coverage
# The next command authorizes real payments from YOUR funded wallet, within $0.05 total.
TAPE_PAYER_KEYPAIR=/absolute/path/to/payer.json .venv/bin/python risk_client.py "$MINTS" --budget 0.05 --polls 20
```

TypeScript, Node.js 24+:

```bash
npm ci --ignore-scripts
node risk_client.ts "$MINTS" --coverage --state buyer-state-ts.json
TAPE_PAYER_KEYPAIR=/absolute/path/to/payer.json node risk_client.ts "$MINTS" --budget 0.05 --polls 20 --state buyer-state-ts.json
```

Set `MINTS` to one mint or a comma-separated list of at most five. Add `--transport mcp` and use a separate `--state` file to use the same workflow through MCP. `--polls 20` checks once, then makes up to 20 free availability polls at 15-second intervals; it buys an update only when a watched event changes. Omit `--polls` for a single check. `--max-per-call` defaults to $0.01 and the single-mint route is capped at $0.005.

Keep each `buyer-state*.json` file private and use one active process per file. The cumulative budget belongs to that file and counts authorized attempts conservatively, including attempts that did not settle; rerunning does not reset it. A mint-set or transport change requires a separate state file. Both clients stop on an uncertain outcome rather than signing again. TypeScript uses an exclusive `.lock` file; after an abrupt crash, confirm that its recorded PID has exited before removing only that lock and resuming with the original JSON state. Python releases its process lock automatically.

Exact retries on the **same transport and original arguments** recover the original result and receipt for ten minutes. Replays carry `meta.replayed`, `meta.result_age_s` and aged freshness metadata; they do not contain newly measured data. The optional x402 payment identifier is supported, but an identifier alone cannot retrieve a result. Altering metadata or arguments on an already-used transaction returns a conflict. If you receive `payment_outcome_unknown` with `charged: null`, or the retry window has elapsed, reconcile the original transaction before authorizing another payment.

The pinned Python installation avoids the SVM extra's conflicting Solana/solders constraints. The TypeScript lockfile pins compatible x402, Solana Kit and TypeScript versions. Offline checks: `.venv/bin/python -m unittest -q test_risk_client` and `npm run check && npm test`.

## What it is

Live pump.fun / PumpSwap analytics derived from public on-chain data. Pay per request in USDC on Solana through x402. See the documented routes for coverage and freshness.

Since v0.3.0 the same service also covers **Robinhood Chain (Pons V2 launchpad)**: launch feed and per-curve structure cards derived from public on-chain activity (raised/progress/price multiple, snipe-tax activity, holder concentration, same-block direct-buy cluster share, direct vs terminal route mix, new-buyer flow, lifecycle).

Robinhood Chain two- and six-second flow counts expire against the response timestamp, even when no new trade arrives. Check `meta.is_stale` before interpreting zero activity; [field definitions](https://api.loopholetape.com/v1/labels) explain timestamp and coverage semantics.

## Routes

| Route | Price (USDC) | What you get |
|---|---|---|
| `GET /v1/check/mint/{mint}` | $0.005 | Compact observed-risk check for one fully covered pump.fun mint |
| `GET /v1/check/watchlist?mints=...` | $0.01 total | Compact checks for up to five fully covered caller-selected mints |
| `GET /v1/check/coverage?mints=...`, `GET /v1/check/watch?mints=...&cursor=...` | free | Coverage/prices and availability of new documented watch events |
| `GET /v1/mint/{mint}` | $0.025 | Risk card for one pump.fun mint (live microstructure or thin on-chain card) |
| `GET /v1/launches/recent` | $0.01 | Recent pump.fun launches with compact risk labels |
| `GET /v1/rugs/recent` | $0.02 | Recent rug / close flags with mechanism labels |
| `GET /v1/graduations/recent` | $0.02 | Recent migrations labelled true graduation vs below-threshold close |
| `GET /v1/creator/{address}` | $0.02 | Creator reputation over our full launch history |
| `GET /v1/wallet/{address}` | $0.02 | Wallet class from our rolling PnL leaderboard + live holdings |
| `GET /v1/rhc/launches/recent` | $0.01 | Robinhood Chain (Pons V2) recent launches with holder / route / cluster structure |
| `GET /v1/rhc/curve/{address}` | $0.02 | Robinhood Chain (Pons V2) curve structure card for one curve or token address |
| `/`, `/health`, `/v1/market/regime`, `/v1/sample/launches`, `/v1/sample/rugs`, `/v1/sample/mint`, `/v1/x402/resources`, `/v1/labels`, `/v1/rhc/regime`, `/.well-known/x402`, `/openapi.json`, `/llms.txt`, `/mcp`, `/terms` | free | index, health, regime meters, delayed samples, discovery documents, labels, MCP, terms |

Every paid response is self-describing: `schema_version`, `generated_at`, `coverage`, and `meta` with freshness, source and related resources. The full `/v1/mint/{mint}` card supports both full live coverage and thin history/on-chain coverage. New compact checks require full coverage; an unavailable mint makes the entire requested batch unpaid. Label semantics: `/v1/labels`. Seven-day base rates are included in the existing full card.

## Discovery for agents

`/` (index), `/openapi.json` (x402scan-conformant, mirrored here), `/llms.txt` and `/llms-full.txt`, `/.well-known/x402` (manifest with accepts, input and output schemas per resource, mirrored here), `/v1/x402/resources` (per-resource accepts, examples, latency, freshness). Listed in the PayAI x402 catalog, on agent402.tools, and in the official MCP registry as `io.github.gosadu/loophole-tape`.

## Pay from Python (reference client)

```bash
pip install -r requirements-client.txt
TAPE_PAYER_KEYPAIR=~/.config/solana/payer.json python pay_client.py https://api.loopholetape.com "/v1/launches/recent?limit=5"
```

The reference clients register a payment guard: they sign only for this API's recipient, Solana mainnet and USDC, at or under the route's price (cap `TAPE_MAX_USD_PER_CALL`, default $0.03); anything else is refused. Any x402 v2 client works the same way: call the route, read the `PAYMENT-REQUIRED` header (the 402 body repeats it as JSON with a `how` field), sign the USDC transfer, retry with `PAYMENT-SIGNATURE`; the `PAYMENT-RESPONSE` header carries the settlement signature. TypeScript: `@x402/fetch` + `@x402/svm`. AgentKit's `discover_x402_services` finds the routes.

## MCP (for agents that call tools)

MCP server over streamable HTTP at `https://api.loopholetape.com/mcp` (no trailing slash needed; CORS preflight and plain JSON accepted). **17 tools: seven free, ten paid.** New tools are `check_coverage` and `watchlist_updates` (free), `check_pumpfun_risk` ($0.005) and `check_watchlist_risk` ($0.01 total). MCP mint lists are JSON arrays; a single check takes `mint`. The new paid tools publish typed `outputSchema` and return the same data as HTTP.

Existing tools: `catalog`, `health`, `market_regime`, `sample_mint`, `rhc_regime` (free); `mint_risk_card` ($0.025), `recent_launches` ($0.01), `recent_rugs`, `recent_graduations`, `creator_reputation`, `wallet_profile`, `rhc_curve_card` ($0.02), and `rhc_recent_launches` ($0.01).

Paid tools first return an `isError` payment-required result. Retry with the signed payload in `_meta["x402/payment"]`; settlement returns in `_meta["x402/payment-response"]`. Invalid inputs and unavailable compact checks return structured errors without requesting payment. Use the new budgeted buyers with `--transport mcp`. The older generic `mcp_client.py` also works after `pip install -r requirements-client.txt "mcp<2"`.

## Terms, in one line

Statistics derived from public on-chain data; labels are heuristics, not guarantees; nothing here is financial advice; sold as-is per request; no refunds for empty results; do not resell raw responses. Full text at `/terms`.
