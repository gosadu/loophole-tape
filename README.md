# loophole tape — pump.fun risk checks from $0.005

**Base URL:** `https://api.loopholetape.com`
**Payment:** [x402](https://github.com/x402-foundation/x402) v2, scheme `exact`, USDC on **Solana mainnet** (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) **or Base** (`eip155:8453`). Solana payments are settled by `https://facilitator.payai.network`, Base payments by Coinbase's facilitator `https://api.cdp.coinbase.com/platform/v2/x402`. Every 402 lists both networks in `accepts[]`; pay whichever your wallet supports. The facilitator pays the network fee on either chain; a caller needs only USDC. No account or API key required.
**Version:** 0.5.0 (schema 2.0)

Check one mint for **$0.005**, or up to five caller-selected mints for **$0.01 total**. Every result carries **calibrated probabilities**, P(rug within 5 minutes) for checks younger than 30 seconds and P(true graduation) at any age, fitted on our own capture and validated out of time; the validation tables are public at `/v1/calibration`. Get observed creator exits, early-wallet selling, drains, migration state, concentration and buyer flow in a compact JSON result. Use it before a swap or to monitor a position. Findings carry first-observed times and evidence; `no_flags_observed` means no documented flags were observed, not that a token is safe.

**Free coverage, free watch availability, no charge for unchanged watched events.** New paid checks require full live coverage for every mint and feed lag no greater than five seconds. Invalid, unavailable and stale checks are rejected before payment, with eligibility checked again after verification. The existing full card remains $0.025 and the existing free routes remain free.

## Start here

1. Choose one to five pump.fun mints from your own workflow. Call `GET /v1/check/coverage?mints=MINT1,MINT2` for free to see availability and exact prices. Coverage is also checked automatically by the paid route, so a separate preflight call is optional.
2. Call `GET /v1/check/mint/MINT` ($0.005) or `GET /v1/check/watchlist?mints=MINT1,MINT2` ($0.01 total). A payable request returns the standard x402 402 challenge. Pay once to receive the compact check and a watch cursor.
3. Poll `GET /v1/check/watch?mints=MINT1,MINT2&cursor=CURSOR` every 15 seconds or slower for free. When `data.has_new_events` is true, pass the same cursor to the paid check for details and an updated cursor. Passing an unchanged cursor directly to the paid check also returns an unpaid `no_new_events` result.

Only these events advance a watch cursor: `creator_sold`, `bundle_dumped`, `curve_drained`, `pool_drained`, `curve_closed_low`, `migrate_below_grad`, and curve completion/migration/graduation transitions. Ordinary trades, ages and changing totals do not. Cursors bind to the exact mint set and expire after 24 hours. Calling the free watch without a cursor initializes a baseline; omit the cursor from a paid check when you want the current measurements regardless of new events.

The five-second eligibility limit is measured at result generation, before settlement. Settlement and network transit can add delay. `meta.freshness_checked_at` and `feed_lag_at_generation_s` record the eligibility check; `result_age_s`, `feed_lag_s` and `is_stale` are aged when the result is sent, including time spent settling. Compare `t` with your own clock after receipt; this is not a guarantee of delivery within five seconds.

## Pay on Solana or Base

**In a browser, no client needed:** open any paid URL (for example a mint from the free [radar](https://api.loopholetape.com/radar)) in a browser with a Solana wallet such as Phantom or Solflare; the page asks the wallet to pay the exact amount and then shows the result. Agents get the JSON 402 with the `PAYMENT-REQUIRED` header instead.

The bundled example buyers pay with USDC on Solana. Any generic x402 v2 client with an EVM signer pays the same prices with USDC on Base: for example `@x402/fetch` with `@x402/evm` (viem account) or Python `x402[httpx,evm]`. Check `accepts[]` for the `eip155:8453` entry; its `payTo` and `asset` (native USDC) are fixed and published in `/.well-known/x402`.

## Budgeted buyers: Python and TypeScript

The reference buyers work with **HTTP and MCP**. They check the recipient, Solana mainnet, USDC, exact scheme, resource, advertised product price and your budget before signing. A state file retains the original signed payment before transmission; timeouts reuse that payment. Neither client loads a wallet for unavailable or unchanged results. Choose a language below and run its setup from the repository root.

Python 3.12+ (Linux/macOS):

```bash
cd examples/python
python3 -m venv .venv
.venv/bin/pip install -r requirements-client.txt
.venv/bin/python risk_client.py "$MINTS" --coverage
# The next command authorizes real payments from YOUR funded wallet, within $0.05 total.
TAPE_PAYER_KEYPAIR=/absolute/path/to/payer.json .venv/bin/python risk_client.py "$MINTS" --budget 0.05 --polls 20
```

TypeScript, Node.js 24+:

```bash
cd examples/typescript
npm ci --ignore-scripts
node risk_client.ts "$MINTS" --coverage --state buyer-state-ts.json
TAPE_PAYER_KEYPAIR=/absolute/path/to/payer.json node risk_client.ts "$MINTS" --budget 0.05 --polls 20 --state buyer-state-ts.json
```

Set `MINTS` to one mint or a comma-separated list of at most five. Add `--transport mcp` and use a separate `--state` file to use the same workflow through MCP. `--polls 20` checks once, then makes up to 20 free availability polls at 15-second intervals; it buys an update only when a watched event changes. Omit `--polls` for a single check. `--max-per-call` defaults to $0.01 and the single-mint route is capped at $0.005.

Keep each `buyer-state*.json` file private and use one active process per file. The cumulative budget belongs to that file and counts authorized attempts conservatively, including attempts that did not settle; rerunning does not reset it. A mint-set or transport change requires a separate state file. Both clients stop on an uncertain outcome rather than signing again. TypeScript uses an exclusive `.lock` file; after an abrupt crash, confirm that its recorded PID has exited before removing only that lock and resuming with the original JSON state. Python releases its process lock automatically.

Exact retries on the **same transport and original arguments** recover the original result and receipt for ten minutes. Replays carry `meta.replayed`, `meta.result_age_s` and aged freshness metadata; they do not contain newly measured data. The optional x402 payment identifier is supported, but an identifier alone cannot retrieve a result. Altering metadata or arguments on an already-used transaction returns a conflict. If you receive `payment_outcome_unknown` with `charged: null`, or the retry window has elapsed, reconcile the original transaction before authorizing another payment.

Both examples include pinned dependency files for installation.

## What it is

Live pump.fun / PumpSwap analytics derived from public on-chain data. Pay per request in USDC on Solana through x402. See the documented routes for coverage and freshness.

Since v0.3.0 the same service also covers **Robinhood Chain (Pons V2 launchpad)**: launch feed and per-curve structure cards derived from public on-chain activity (exact reserves, raised/progress/price multiple, the launch's trade fee and creator tax in basis points, snipe-tax activity, holder concentration, same-block direct-buy cluster share, direct vs terminal route mix, new-buyer flow, lifecycle).

Robinhood Chain two- and six-second flow counts expire against the response timestamp, even when no new trade arrives. Check `meta.is_stale` before interpreting zero activity; [field definitions](https://api.loopholetape.com/v1/labels) explain timestamp and coverage semantics.

## Routes

| Route | Price (USDC) | What you get |
|---|---|---|
| `GET /v1/check/mint/{mint}` | $0.005 | Compact observed-risk check for one fully covered pump.fun mint |
| `GET /v1/check/watchlist?mints=...` | $0.01 total | Compact checks for up to five fully covered caller-selected mints |
| `GET /v1/calibration` | free | Validation tables (Brier, calibration error, by-age) behind the probabilities |
| `GET /v1/radar`, page `/radar` | free | Live radar: the ten covered mints under 30 s with the highest calibrated rug-within-300s probability and the ten under 15 min with the highest true-graduation probability, each with the paid check URL; refreshed every 5 s |
| `GET /v1/rhc/sample/launches`, page `/rhc` | free | Robinhood Chain (Pons V2): five launch cards delayed 5 minutes in the exact paid shape, and a page with the live regime meter (launches/h, graduation rate, creator-tax split) |
| `GET /v1/check/coverage?mints=...`, `GET /v1/check/watch?mints=...&cursor=...` | free | Coverage/prices and availability of new documented watch events |
| `GET /v1/mint/{mint}` | $0.025 | Risk card for one pump.fun mint (live microstructure or thin on-chain card) |
| `GET /v1/launches/recent` | $0.01 | Recent pump.fun launches with compact risk labels |
| `GET /v1/rugs/recent` | $0.02 | Recent rug / close flags with mechanism labels |
| `GET /v1/graduations/recent` | $0.02 | Recent migrations labelled true graduation vs below-threshold close |
| `GET /v1/creator/{address}` | $0.02 | Creator reputation over our full launch history |
| `GET /v1/wallet/{address}` | $0.02 | Wallet class from our rolling PnL leaderboard + live holdings |
| `GET /v1/rhc/launches/recent` | $0.01 | Robinhood Chain (Pons V2) recent launches with holder / route / cluster structure |
| `GET /v1/rhc/curve/{address}` | $0.02 | Robinhood Chain (Pons V2) curve structure card for one curve or token address |
| `/`, `/health`, `/v1/market/regime`, `/v1/sample/launches`, `/v1/sample/rugs`, `/v1/sample/mint`, `/v1/x402/resources`, `/v1/labels`, `/v1/rhc/regime`, `/.well-known/x402`, `/openapi.json`, `/llms.txt`, `/mcp`, `/terms`, `/.well-known/agent-card.json`, `/a2a`, `/.well-known/mcp-server-card`, `/.well-known/agents.json`, `/agents.txt`, `/.well-known/api-catalog` | free | index, health, regime meters, delayed samples, discovery documents, labels, MCP, terms |

Every paid response is self-describing: `schema_version`, `generated_at`, `coverage`, and `meta` with freshness, source and related resources. The full `/v1/mint/{mint}` card supports both full live coverage and thin history/on-chain coverage. New compact checks require full coverage; an unavailable mint makes the entire requested batch unpaid. Label semantics: `/v1/labels`. Seven-day base rates are included in the existing full card.

## Discovery for agents

An agent skill describing the whole paid workflow is served at `/skills/pumpfun-risk-check/SKILL.md` and published on Smithery as `loopholetape/pumpfun-risk-check`; the MCP server is listed as `loopholetape/loophole-tape`. Agent directories can read the A2A agent card at `/.well-known/agent-card.json` (the `/a2a` JSON-RPC endpoint answers `message/send` with the catalog, payment terms and the exact call for a named skill or mint), the MCP server card at `/.well-known/mcp-server-card`, `agents.json` flows at `/.well-known/agents.json`, `agents.txt`, and the RFC 9727 catalog at `/.well-known/api-catalog`.

Use the live documents for current capabilities, schemas and prices:

- [API reference](https://api.loopholetape.com/docs) and [OpenAPI schema](https://api.loopholetape.com/openapi.json)
- [Agent guide](https://api.loopholetape.com/llms.txt)
- [x402 manifest](https://api.loopholetape.com/.well-known/x402) and [resource catalog](https://api.loopholetape.com/v1/x402/resources)

MCP registry name: `io.github.gosadu/loophole-tape`. Connect to `https://api.loopholetape.com/mcp`.

## Pay from Python (reference client)

For other routes, use the [generic HTTP buyer](examples/python/pay_client.py) from `examples/python` after the Python setup above:

```bash
TAPE_PAYER_KEYPAIR=~/.config/solana/payer.json .venv/bin/python pay_client.py https://api.loopholetape.com "/v1/launches/recent?limit=5"
```

The reference clients register a payment guard: they sign only for this API's recipient, Solana mainnet and USDC, at or under the route's price (cap `TAPE_MAX_USD_PER_CALL`, default $0.03); anything else is refused. Any x402 v2 client works the same way: call the route, read the `PAYMENT-REQUIRED` header (the 402 body repeats it as JSON with a `how` field), sign the USDC transfer, retry with `PAYMENT-SIGNATURE`; the `PAYMENT-RESPONSE` header carries the settlement signature. TypeScript: `@x402/fetch` + `@x402/svm`. AgentKit's `discover_x402_services` finds the routes.

## MCP (for agents that call tools)

MCP server over streamable HTTP at `https://api.loopholetape.com/mcp` (no trailing slash needed; CORS preflight and plain JSON accepted). **17 tools: seven free, ten paid.** New tools are `check_coverage` and `watchlist_updates` (free), `check_pumpfun_risk` ($0.005) and `check_watchlist_risk` ($0.01 total). MCP mint lists are JSON arrays; a single check takes `mint`. The new paid tools publish typed `outputSchema` and return the same data as HTTP.

Existing tools: `catalog`, `health`, `market_regime`, `sample_mint`, `radar`, `rhc_regime` (free); `mint_risk_card` ($0.025), `recent_launches` ($0.01), `recent_rugs`, `recent_graduations`, `creator_reputation`, `wallet_profile`, `rhc_curve_card` ($0.02), and `rhc_recent_launches` ($0.01).

Paid tools first return an `isError` payment-required result. Retry with the signed payload in `_meta["x402/payment"]`; settlement returns in `_meta["x402/payment-response"]`. Invalid inputs and unavailable compact checks return structured errors without requesting payment. Use the budgeted buyers with `--transport mcp`. For other tools, use the [generic MCP buyer](examples/python/mcp_client.py); from `examples/python`, install its extra dependency with `.venv/bin/pip install "mcp<2"`.

## Terms, in one line

Statistics derived from public on-chain data; labels are heuristics, not guarantees; nothing here is financial advice; sold as-is per request; no refunds for empty results; do not resell raw responses. Full text at `/terms`.
