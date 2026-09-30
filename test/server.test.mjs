// Offline tests: a fake API on a local port stands in for api.loopholetape.com. Nothing here touches a chain.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { BASE_CHAIN, PAY_TO, PAY_TO_BASE, Refusal, SOLANA, Spend, Tape, USDC, USDC_BASE, buildUrl, config, evmSecret, parseRpc, pinned, routeFromResource, secretBytes, usd } from "../src/server.mjs";

const LIVE = "LiveMint1111111111111111111111111111111pump";
const OLD = "OldMint11111111111111111111111111111111pump";
const OTHER = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const OTHER_ADDRESS = "11111111111111111111111111111111";
const FEE_PAYER = "BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP";

const seen = { paymentHeaders: 0, keys: [], paths: [], payloads: [] };
let api;
let base;

/** A real Ed25519 keypair in solana-keygen's 64-byte form (seed + public key), generated for the test and thrown away. */
async function throwawayKeypair() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return new Uint8Array([...pkcs8.slice(-32), ...pub]);
}

const x402 = (price) => ({ x402: { price_usd: price } });
const TOOLS = [
  { name: "token_check", title: "Free check", description: "Free.", inputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] } },
  { name: "catalog", description: "Free.", inputSchema: { type: "object", properties: {} } },
  { name: "radar", title: "Live radar (free)", description: "Free. ".padEnd(2000, "x"), inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "verdict", title: "Verdict ($0.01)", description: "$0.01 per call.", inputSchema: { type: "object", properties: { mint: { type: "string" } }, required: ["mint"] }, _meta: x402(0.01), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: "mint_risk_card", description: "Per call.", inputSchema: { type: "object", properties: { mint: { type: "string" } }, required: ["mint"] }, _meta: x402(0.025) },
  { name: "check_batch_risk", description: "$0.10 here.", inputSchema: { type: "object", properties: { mints: { type: "string" } }, required: ["mints"] }, _meta: x402(0.1) },
  { name: "buy_dataset", description: "$5.", inputSchema: { type: "object", properties: { day: { type: "string" } } }, _meta: x402(5) },
  { name: "orphan_paid", description: "paid, no route in the manifest", inputSchema: { type: "object", properties: {} }, _meta: x402(0.01) },
  { name: "nan_tool", description: "paid, no price in the manifest", inputSchema: { type: "object", properties: { mint: { type: "string" } } }, _meta: x402(0.01) },
  { name: "token_safety", description: "a remote tool with a local name", inputSchema: { type: "object", properties: {} } },
];
const RESOURCES = [
  { resource: "https://api.loopholetape.com/v1/verdict/{mint}", method: "GET", price_usd: 0.01, mcp_tool: "verdict", input: { path_params: { mint: { type: "string" } }, query: null }, query_form: "https://api.loopholetape.com/v1/verdict?mint={mint}" },
  { resource: "https://api.loopholetape.com/v1/mint/{mint}", method: "GET", price_usd: 0.025, mcp_tool: "mint_risk_card", input: { path_params: { mint: { type: "string" } }, query: null } },
  { resource: "https://api.loopholetape.com/v1/check/batch", method: "GET", price_usd: 0.1, mcp_tool: "check_batch_risk", input: { path_params: null, query: { type: "object", properties: { mints: { type: "string" } }, required: ["mints"] } } },
  { resource: "https://api.loopholetape.com/v1/datasets/pumpfun_launches/{day}", method: "GET", price_usd: 5, mcp_tool: "buy_dataset", input: { path_params: { day: { type: "string" } }, query: null } },
  { resource: "https://api.loopholetape.com/v1/nan/{mint}", method: "GET", mcp_tool: "nan_tool", input: { path_params: { mint: { type: "string" } }, query: null } },
  { resource: "@evil.example/v1/x/{mint}", method: "GET", price_usd: 0.01, mcp_tool: "host_tool", input: { path_params: { mint: { type: "string" } }, query: null } },
];

function freeCheck(token) {
  const paid = (tool, price, path) => ({ tool, price_usd: price, url: `https://api.loopholetape.com${path}`, adds: "depth" });
  if (token === LIVE) return { ok: true, coverage: "full", data: { token, venue: "pump.fun", verdict: "avoid", next: { verdict: paid("verdict", 0.01, `/v1/verdict/${token}`), card: paid("mint_risk_card", 0.025, `/v1/mint/${token}`) } } };
  if (token === "EVIL") return { ok: true, coverage: "full", data: { token: "Abc", venue: "pump.fun", verdict: "avoid", next: { verdict: paid("check_batch_risk", 0.01, "/v1/check/batch?mints=Abc"), card: paid("nan_tool", 0.01, "/v1/nan/Abc") } } };
  if (token === "TRAVERSE") return { ok: true, coverage: "full", data: { token: "..", venue: "pump.fun", verdict: "avoid", next: { verdict: paid("verdict", 0.01, "x:/v1/..\\..\\admin") } } };
  if (token === OLD) return { ok: true, coverage: "thin", data: { token, venue: "pump.fun", verdict: "no_flags_observed_on_chain", next: { card: paid("mint_risk_card", 0.025, `/v1/mint/${token}`) } } };
  return { ok: true, coverage: "thin", data: { token, venue: "unknown", verdict: "no_flags_observed_on_chain", next: { card: paid("mint_risk_card", 0.025, `/v1/mint/${token}`) } } };
}

const BASE_ACCEPT = { scheme: "exact", network: BASE_CHAIN, amount: "10000", asset: USDC_BASE, payTo: PAY_TO_BASE, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };

function required(payTo, feePayer = FEE_PAYER, baseOnly = false) {
  const doc = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: `${base}/v1/verdict/x`, description: "test", mimeType: "application/json" },
    accepts: baseOnly ? [BASE_ACCEPT] : [{ scheme: "exact", network: SOLANA, amount: "10000", asset: USDC, payTo, maxTimeoutSeconds: 60, extra: { feePayer } }, BASE_ACCEPT],
  };
  return Buffer.from(JSON.stringify(doc)).toString("base64");
}

before(async () => {
  api = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const key = req.headers["x-api-key"] || null;
    seen.paths.push(url.pathname);
    if (req.headers["payment-signature"] || req.headers["x-payment"]) seen.paymentHeaders += 1;
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && url.pathname === "/mcp") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const message = JSON.parse(raw);
        if (message.method === "tools/list") return send(200, { jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
        const { name, arguments: args } = message.params;
        if (name === "token_check") return send(200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(freeCheck(args.token)) }], structuredContent: {} } });
        if (name === "radar") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          return res.end(`: ping\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "radar answer" }] } })}\n\n`);
        }
        return send(200, { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "unknown tool" } });
      });
      return undefined;
    }
    if (url.pathname === "/v1/x402/resources") return send(200, { ok: true, data: { resources: RESOURCES } });
    if (url.pathname === "/v1/redirect") return send(302, {}, { location: "http://127.0.0.1:9/elsewhere" });
    if (url.pathname.startsWith("/v1/verdict") || url.pathname.startsWith("/v1/mint")) {
      seen.keys.push(key);
      const raw = url.searchParams.get("mint") || decodeURIComponent(url.pathname.split("/").pop());
      const [id, idQuery] = raw.split("?"); // the SELFPAY case smuggles the wallet address inside the id
      if (id === "REFUSED") return send(409, { ok: false, error: "quote_not_modelled", hint: "the curve is quoted in another asset" });
      if (key === "lt_trial" || key === "lt_paid") return send(200, { ok: true, data: { id, path: url.pathname } });
      const payTo = id === "WRONGPAYTO" ? OTHER_ADDRESS : PAY_TO;
      const feePayer = id === "SELFPAY" ? new URLSearchParams(idQuery || "").get("wallet") || FEE_PAYER : FEE_PAYER;
      if (req.headers["payment-signature"]) {   // a signed payment arrived: settle it offline when it is a Base authorization to our address
        let payload = null;
        try {
          payload = JSON.parse(Buffer.from(req.headers["payment-signature"], "base64").toString("utf8"));
        } catch {
          payload = null;
        }
        seen.payloads.push(payload);
        const accepted = payload?.accepted || {};
        if (payload?.payload?.signature && accepted.network === BASE_CHAIN && accepted.payTo === PAY_TO_BASE && accepted.amount === "10000") {
          const receipt = Buffer.from(JSON.stringify({ success: true, transaction: `0x${"ab".repeat(32)}`, network: BASE_CHAIN, payer: payload.payload.authorization?.from })).toString("base64");
          return send(200, { ok: true, data: { id, path: url.pathname, paid_on: "base" } }, { "PAYMENT-RESPONSE": receipt });
        }
        return send(402, { error: "Payment required", reason: "invalid_payment" }, { "PAYMENT-REQUIRED": required(payTo, feePayer, id === "BASEPAY") });
      }
      return send(402, { error: "Payment required", reason: "no_payment", no_x402_client: { public_trial_key: { header: "X-API-Key: lt_trial", note: "shared" } } }, { "PAYMENT-REQUIRED": required(payTo, feePayer, id === "BASEPAY") });
    }
    return send(404, { ok: false, error: "not_found" });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${api.address().port}`;
});

after(() => api.close());

const dir = () => mkdtempSync(join(tmpdir(), "ltmcp-"));
const tape = (env = {}) => new Tape(config({ LOOPHOLETAPE_BASE_URL: base, LOOPHOLETAPE_STATE_DIR: dir(), ...env }));
const texts = (result) => result.content.map((item) => item.text);
const good = { scheme: "exact", network: SOLANA, payTo: PAY_TO, asset: USDC, amount: "10000", extra: { feePayer: FEE_PAYER } };

test("pinned terms: our address, USDC, Solana mainnet, at most the listed price, a fee payer that is not the wallet", () => {
  assert.equal(pinned([good], 10000, OTHER_ADDRESS).length, 1);
  assert.equal(pinned([{ ...good, amount: "5000" }], 10000, OTHER_ADDRESS).length, 1);
  for (const bad of [
    { ...good, payTo: OTHER_ADDRESS },
    { ...good, asset: "So11111111111111111111111111111111111111112" },
    { ...good, network: "eip155:8453" },
    { ...good, scheme: "upto" },
    { ...good, amount: "10001" },
    { ...good, amount: "0" },
    { ...good, amount: "-5" },
    { ...good, amount: "1e3" },
    { ...good, amount: undefined },
    { ...good, extra: {} },
    { ...good, extra: { feePayer: OTHER_ADDRESS } }, // the wallet itself as fee payer: it would pay the network fee
    { ...good, extra: { feePayer: "not base58 0OIl" } },
  ]) {
    assert.equal(pinned([bad], 10000, OTHER_ADDRESS).length, 0, JSON.stringify(bad));
  }
  assert.deepEqual(pinned(undefined, 10000, OTHER_ADDRESS), []);
  assert.deepEqual(pinned([good], NaN, OTHER_ADDRESS), [], "no price, no payment");
  assert.deepEqual(pinned([good], 0, OTHER_ADDRESS), []);
  // the Base rail: only with an EVM wallet, only our Base address and native USDC on chain 8453
  const evm = "0x1111111111111111111111111111111111111111";
  assert.equal(pinned([BASE_ACCEPT], 10000, { solana: null, evm }).length, 1);
  assert.equal(pinned([{ ...BASE_ACCEPT, payTo: PAY_TO_BASE.toLowerCase() }], 10000, { solana: null, evm }).length, 1, "addresses compare without case");
  assert.equal(pinned([BASE_ACCEPT], 10000, { solana: OTHER_ADDRESS, evm: null }).length, 0, "no EVM wallet, no Base payment");
  assert.equal(pinned([good], 10000, { solana: null, evm }).length, 0, "no Solana wallet, no Solana payment");
  assert.equal(pinned([good, BASE_ACCEPT], 10000, { solana: OTHER_ADDRESS, evm }).length, 2, "both wallets: both kept, the API's order decides");
  for (const bad of [{ ...BASE_ACCEPT, payTo: evm }, { ...BASE_ACCEPT, asset: "0x0000000000000000000000000000000000000000" }, { ...BASE_ACCEPT, network: "eip155:1" }, { ...BASE_ACCEPT, amount: "10001" }]) {
    assert.equal(pinned([bad], 10000, { solana: null, evm }).length, 0, JSON.stringify(bad));
  }
});

test("the EVM key must be a 32-byte private key; an address is refused and never quoted", () => {
  const key = `0x${"7".repeat(64)}`;
  assert.equal(evmSecret({ evmSecret: key }), key);
  assert.equal(evmSecret({}), null);
  assert.equal(evmSecret({ evmSecret: "7".repeat(64) }), key, "a key exported without its 0x prefix");
  assert.throws(() => evmSecret({ evmSecret: `0x${"7".repeat(40)}` }), /public address/);
  assert.throws(() => evmSecret({ evmSecret: "not-a-key-zzzz" }), (error) => !error.message.includes("zzzz"));
});

test("routes from the manifest: a price that is not a positive whole number of micro-USDC, or a path off /v1/, is dropped", () => {
  assert.equal(routeFromResource(RESOURCES[0]).micro, 10000);
  assert.equal(routeFromResource(RESOURCES[4]), null, "no price");
  assert.equal(routeFromResource({ ...RESOURCES[0], price_usd: "$0.01" }), null);
  assert.equal(routeFromResource({ ...RESOURCES[0], price_usd: -0.01 }), null);
  assert.equal(routeFromResource(RESOURCES[5]), null, "a host in the path");
  for (const resource of [".evil.example/v1/x/{mint}", ":8443/v1/x/{mint}", "https://api.loopholetape.com/v2/x/{mint}", "https://api.loopholetape.com/v1/../x/{mint}", "https://api.loopholetape.com/v1/x?y={mint}"]) {
    assert.equal(routeFromResource({ ...RESOURCES[0], resource }), null, resource);
  }
  assert.equal(routeFromResource({ ...RESOURCES[0], query_form: "https://api.loopholetape.com/v2/verdict?mint={mint}" }), null);
});

test("arguments to a URL: path id, query, arrays, a pasted link through the query form, never off the API", () => {
  const verdict = routeFromResource(RESOURCES[0]);
  assert.equal(buildUrl("https://h", verdict, { mint: "Abc" }), "https://h/v1/verdict/Abc");
  assert.equal(buildUrl("https://h", verdict, { mint: "https://pump.fun/coin/Abc" }), "https://h/v1/verdict?mint=https%3A%2F%2Fpump.fun%2Fcoin%2FAbc");
  const batch = routeFromResource(RESOURCES[2]);
  assert.equal(buildUrl("https://h", batch, { mints: ["A", "B"], stray: 1 }), "https://h/v1/check/batch?mints=A%2CB");
  const card = routeFromResource(RESOURCES[1]);
  assert.equal(buildUrl("https://h", card, { mint: "%2e%2e" }), "https://h/v1/mint/%252e%252e");
  assert.throws(() => buildUrl("https://h", verdict, {}), Refusal);
  assert.throws(() => buildUrl("https://h", verdict, { mint: "  " }), Refusal);
  assert.throws(() => buildUrl("https://h", verdict, { mint: ".." }), Refusal);
  assert.throws(() => buildUrl("https://h", verdict, { mint: "." }), Refusal);
  assert.throws(() => buildUrl("https://h", card, { mint: "x/y" }), Refusal, "a link on a route without a query form");
  assert.throws(() => buildUrl("https://h", card, { mint: "a\\b" }), Refusal);
});

test("daily spend: counted in the file before signing, refunded after, shared by every process on the directory", () => {
  const d = dir();
  let now = Date.parse("2026-09-30T23:59:00Z");
  const a = new Spend(30000, d, () => now);
  const b = new Spend(30000, d, () => now);
  assert.equal(a.reserve(10000), null);
  assert.equal(b.reserve(10000), null, "a second process shares the file");
  assert.match(b.reserve(10001), /daily cap/, "two reservations leave 10,000");
  assert.equal(a.settle(10000, 10000, true).micro, 20000, "signed and settled: stays counted");
  assert.deepEqual([b.settle(10000, 0, false).micro, b.read().settled, b.read().payments], [10000, 10000, 1], "nothing signed: refunded");
  assert.equal(a.reserve(20000), null);
  assert.equal(a.settle(20000, 20000, false).micro, 30000, "signed without a receipt: counted like a settled one");
  assert.match(new Spend(30000, d, () => now).reserve(1), /daily cap/, "a restart reads the file");
  now = Date.parse("2026-10-01T00:00:30Z");
  assert.equal(a.read().micro, 0, "a new UTC day starts at zero");
  assert.equal(a.reserve(30000), null);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(d, "spend.json"), "utf8"))).sort(), ["day", "micro", "payments", "settled"]);
  assert.match(a.reserve(NaN), /whole number/);
  assert.match(a.reserve(-5), /whole number/);
  assert.match(a.reserve(0.5), /whole number/);
  assert.equal(usd(25000), "$0.025");
  assert.equal(usd(1000000), "$1");
});

test("daily spend: a file that cannot be read or written refuses payments instead of forgetting them", () => {
  const d = dir();
  const spend = new Spend(30000, d);
  assert.equal(spend.reserve(10000), null);
  writeFileSync(join(d, "spend.json"), "{not json", { mode: 0o600 });
  assert.match(spend.reserve(10000), /cannot be read/);
  writeFileSync(join(d, "spend.json"), JSON.stringify({ day: spend.day(), micro: 20000, settled: 0, payments: 0 }), { mode: 0o400 });
  chmodSync(d, 0o500);
  try {
    if (process.getuid?.() !== 0) assert.match(spend.reserve(5000), /cannot be written|locked/);
  } finally {
    chmodSync(d, 0o700);
  }
  chmodSync(join(d, "spend.json"), 0o600);
  assert.equal(spend.reserve(5000), null, "writable again");
  const stale = new Spend(30000, d, () => Date.now() + 40_000);
  writeFileSync(join(d, "spend.lock"), "", { mode: 0o600 }); // a dead process's lock
  assert.equal(stale.reserve(1), null, "a lock older than 30 s is taken over");
});

test("JSON-RPC answers: plain JSON and an event stream", () => {
  assert.deepEqual(parseRpc('{"result":{"a":1}}').result, { a: 1 });
  assert.deepEqual(parseRpc(': ping\n\ndata: {"jsonrpc":"2.0","method":"notifications/x"}\n\ndata: {"id":1,"result":{"a":2}}\n\n', "text/event-stream").result, { a: 2 });
  assert.equal(parseRpc("<html>", "text/html"), null);
});

test("the key is read from base58, a byte array or a file; 32 bytes and a public address are refused; an error never quotes it", async () => {
  const bytes = await throwawayKeypair();
  const { getBase58Decoder } = await import("@solana/kit");
  const b58 = getBase58Decoder().decode(bytes);
  assert.deepEqual([...(await secretBytes({ secret: b58 }))], [...bytes]);
  assert.deepEqual([...(await secretBytes({ secret: JSON.stringify([...bytes]) }))], [...bytes]);
  const file = join(dir(), "id.json");
  writeFileSync(file, JSON.stringify([...bytes]), { mode: 0o600 });
  assert.deepEqual([...(await secretBytes({ keypairPath: file }))], [...bytes]);
  assert.deepEqual([...(await secretBytes({ secret: file }))], [...bytes]);
  assert.equal(await secretBytes({}), null);
  const address = getBase58Decoder().decode(bytes.slice(32));
  await assert.rejects(secretBytes({ secret: address }), /32 bytes.*public address/);
  await assert.rejects(secretBytes({ secret: JSON.stringify([...bytes.slice(0, 32)]) }), /32 bytes/);
  for (const bad of ["not-base58-0OIl-secret-value", "[1,2,secretish", b58.slice(0, 40)]) {
    await assert.rejects(secretBytes({ secret: bad }), (error) => !error.message.includes(bad.slice(0, 12)));
  }
});

test("tool list: token_safety first, wallet_status last, hidden, unpriced, unaffordable and name-clashing tools left out, paid tools not read-only", async () => {
  const tools = await tape().tools();
  assert.deepEqual(tools.map((tool) => tool.name), ["token_safety", "radar", "verdict", "mint_risk_card", "wallet_status"]);
  const radar = tools.find((tool) => tool.name === "radar");
  assert.ok(radar.description.length < 1000);
  assert.equal(radar.outputSchema, undefined);
  assert.equal(radar.annotations.readOnlyHint, true);
  const verdict = tools.find((tool) => tool.name === "verdict");
  assert.deepEqual([verdict.annotations.readOnlyHint, verdict.annotations.idempotentHint], [false, false], "it spends money");
  assert.match(tools.find((tool) => tool.name === "mint_risk_card").description, /\$0\.025 per call/, "the price rides when the description lacks it");
  assert.equal(tools[0].annotations.readOnlyHint, false);
  assert.match(tools[0].description, /\(\$0\.01\)/);
  assert.ok((await tape({ LOOPHOLETAPE_MAX_USD_PER_CALL: "0.2" }).tools()).some((tool) => tool.name === "check_batch_risk"));
  assert.ok((await tape({ LOOPHOLETAPE_API_KEY: "lt_paid" }).tools()).some((tool) => tool.name === "check_batch_risk"));
  assert.deepEqual((await tape({ LOOPHOLETAPE_BASE_URL: "http://127.0.0.1:9" }).tools()).map((tool) => tool.name), ["token_safety", "wallet_status"]);
});

test("a free tool is forwarded; unknown and unpriced tools are refused", async () => {
  const t = tape();
  assert.deepEqual(texts(await t.call("radar", {})), ["radar answer"]);
  assert.equal((await t.call("nope", {})).isError, true);
  assert.equal((await t.call("nan_tool", { mint: "Abc" })).isError, true, "no route without a price");
  assert.equal((await t.call("host_tool", { mint: "Abc" })).isError, true);
});

test("no wallet, no key: the shared trial key answers, and says so", async () => {
  const result = await tape().call("verdict", { mint: "Abc" });
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(texts(result)[0]).data.id, "Abc");
  assert.match(texts(result)[1], /trial key/);
  const off = await tape({ LOOPHOLETAPE_TRIAL: "0" }).call("verdict", { mint: "Abc" });
  assert.equal(off.isError, true);
  assert.match(texts(off)[0], /SOLANA_PRIVATE_KEY/);
  assert.match(texts(off)[0], /\$0\.01/);
});

test("a prepaid key pays; an empty one explains with the API's own words", async () => {
  const paid = await tape({ LOOPHOLETAPE_API_KEY: "lt_paid" }).call("verdict", { mint: "https://pump.fun/coin/Abc" });
  assert.equal(JSON.parse(texts(paid)[0]).data.path, "/v1/verdict");
  assert.match(texts(paid)[1], /prepaid key/);
  const empty = await tape({ LOOPHOLETAPE_API_KEY: "lt_empty" }).call("verdict", { mint: "Abc" });
  assert.equal(empty.isError, true);
  assert.match(texts(empty)[0], /did not cover/);
  assert.match(texts(empty)[0], /The API said: Payment required; no_payment/);
});

test("a refusal by the API is reported as not charged", async () => {
  const result = await tape({ LOOPHOLETAPE_API_KEY: "lt_paid" }).call("verdict", { mint: "REFUSED" });
  assert.equal(result.isError, true);
  assert.match(texts(result)[0], /HTTP 409; nothing was charged/);
  assert.match(texts(result)[0], /quote_not_modelled/);
});

test("a redirect is never followed with credentials", async () => {
  const t = tape({ LOOPHOLETAPE_API_KEY: "lt_paid" });
  const catalog = await t.loadCatalog();
  catalog.routes.set("redirecting", { tool: "redirecting", micro: 10000, path: "/v1/redirect", pathParams: [], queryParams: [], queryForm: null });
  const result = await t.call("redirecting", {});
  assert.equal(result.isError, true);
  assert.match(texts(result)[0], /failed|redirect/i);
  assert.ok(!texts(result)[0].includes("elsewhere"), "the redirect target was never fetched");
});

test("token_safety: free for everything, paid depth only where it exists, only the documented tool, on a URL it builds itself", async () => {
  const t = tape();
  const auto = texts(await t.call("token_safety", { token: LIVE }));
  assert.equal(JSON.parse(auto[0]).coverage, "full");
  assert.match(auto[1], /--- verdict \(\$0\.01\) ---/);
  assert.equal(JSON.parse(auto[2]).data.path, `/v1/verdict/${LIVE}`);
  const free = texts(await t.call("token_safety", { token: LIVE, depth: "free" }));
  assert.equal(free.length, 1);
  const old = texts(await t.call("token_safety", { token: OLD }));
  assert.match(old[1], /nothing was bought/);
  const oldFull = texts(await t.call("token_safety", { token: OLD, depth: "full" }));
  assert.match(oldFull[1], /--- mint_risk_card \(\$0\.025\) ---/);
  const other = texts(await t.call("token_safety", { token: OTHER, depth: "full" }));
  assert.match(other[1], /nothing was bought/);
  const before = seen.paths.length;
  const evil = texts(await t.call("token_safety", { token: "EVIL" }));
  assert.match(evil[1], /nothing was bought/, "the free answer named another tool as the verdict");
  const evilFull = texts(await t.call("token_safety", { token: "EVIL", depth: "full" }));
  assert.match(evilFull[1], /nothing was bought/, "the free answer named an unpriced tool as the card");
  const traverse = texts(await t.call("token_safety", { token: "TRAVERSE" }));
  assert.match(traverse[1], /not bought|nothing was bought/);
  assert.deepEqual(seen.paths.slice(before).filter((p) => p !== "/mcp"), [], "no paid request left for any of them");
  assert.equal((await t.call("token_safety", {})).isError, true);
});

test("a wallet: caps refuse before anything is sent; a quote naming another address, or the wallet as fee payer, is never signed", async () => {
  const key = JSON.stringify([...(await throwawayKeypair())]);
  const capped = tape({ SOLANA_PRIVATE_KEY: key, LOOPHOLETAPE_MAX_USD_PER_CALL: "0.005" });
  assert.equal(await capped.mode(), "wallet");
  const before = seen.keys.length;
  const tooDear = await capped.call("verdict", { mint: "Abc" });
  assert.equal(tooDear.isError, true);
  assert.match(texts(tooDear)[0], /per-call cap/);
  const day = tape({ SOLANA_PRIVATE_KEY: key, LOOPHOLETAPE_MAX_USD_PER_DAY: "0.005" });
  const overDay = await day.call("verdict", { mint: "Abc" });
  assert.match(texts(overDay)[0], /daily cap/);
  assert.equal(seen.keys.length, before, "neither refusal reached the API");

  const wrong = tape({ SOLANA_PRIVATE_KEY: key });
  const result = await wrong.call("verdict", { mint: "WRONGPAYTO" });
  assert.equal(result.isError, true);
  assert.match(texts(result)[0], /nothing was paid: the API's quote did not match/);
  const self = await wrong.call("verdict", { mint: `SELFPAY?wallet=${(await wrong.wallet()).solana.address}` });
  assert.equal(self.isError, true, "the wallet itself as fee payer");
  assert.equal(seen.paymentHeaders, 0, "no payment header ever left this process");
  assert.equal(wrong.spend.read().micro, 0, "the reservations were refunded");

  const status = JSON.parse(texts(await tape({ SOLANA_PRIVATE_KEY: key, SOLANA_RPC_URL: "http://127.0.0.1:9" }).call("wallet_status", {}))[0]);
  assert.equal(status.mode, "wallet");
  assert.deepEqual(status.pays_only.map((p) => p.to), [PAY_TO, PAY_TO_BASE]);
  assert.equal(status.wallet.usdc, null);
  assert.equal(status.wallet_base, null);
  assert.equal(status.prices_usd.verdict, 0.01);
  assert.equal(status.signed_today_usd, 0);
  assert.ok(!JSON.stringify(status).includes(key.slice(1, 20)));
});

test("an EVM key pays on Base: the authorization is signed here, the fake settles it, the cap and the note say Base", async () => {
  const key = `0x${"5".repeat(64)}`;
  const t = tape({ EVM_PRIVATE_KEY: key, EVM_RPC_URL: "http://127.0.0.1:9" });
  assert.equal(await t.mode(), "wallet");
  const status = JSON.parse(texts(await t.call("wallet_status", {}))[0]);
  assert.equal(status.wallet, null);
  assert.match(status.wallet_base.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(status.wallet_base.usdc, null);
  const solanaOnly = await t.call("verdict", { mint: "Abc" });
  assert.equal(solanaOnly.isError, undefined, "the fake quotes Base as well, so the EVM wallet pays");
  const before = seen.payloads.length;
  const result = await t.call("verdict", { mint: "BASEPAY" });
  assert.equal(result.isError, undefined, texts(result)[0]);
  assert.equal(JSON.parse(texts(result)[0]).data.paid_on, "base");
  assert.match(texts(result)[1], /paid \$0\.01 USDC on Base, tx 0xabab/);
  const payload = seen.payloads[seen.payloads.length - 1];
  assert.ok(seen.payloads.length > before);
  assert.equal(payload.accepted.payTo, PAY_TO_BASE);
  assert.equal(payload.payload.authorization.to, PAY_TO_BASE);
  assert.equal(payload.payload.authorization.value, "10000");
  assert.equal(payload.payload.authorization.from.toLowerCase(), status.wallet_base.address.toLowerCase());
  assert.deepEqual([t.spend.read().micro, t.spend.read().settled, t.spend.read().payments], [20000, 20000, 2]);
  const cheap = tape({ EVM_PRIVATE_KEY: key, LOOPHOLETAPE_MAX_USD_PER_CALL: "0.005" });
  assert.match(texts(await cheap.call("verdict", { mint: "BASEPAY" }))[0], /per-call cap/);
  assert.equal(seen.payloads.length, before + 1, "the capped call signed nothing");
});

test("a malformed key leaves the free tools working and is named without its value; the wallet loads once", async () => {
  const t = tape({ SOLANA_PRIVATE_KEY: "zzzz-not-a-key-zzzz" });
  assert.equal(await t.mode(), "trial");
  assert.match(t.walletError, /^the key/);
  assert.ok(!t.walletError.includes("zzzz"));
  assert.deepEqual(texts(await t.call("radar", {})), ["radar answer"]);
  const w = tape({ SOLANA_PRIVATE_KEY: JSON.stringify([...(await throwawayKeypair())]) });
  const [m1, m2] = await Promise.all([w.mode(), w.mode()]);
  assert.deepEqual([m1, m2], ["wallet", "wallet"], "a concurrent first call never sees the wallet as missing");
});

test("configuration: empty values and a host's unfilled placeholders are unset; caps fall back", () => {
  const cfg = config({ SOLANA_PRIVATE_KEY: "${user_config.solana_private_key}", LOOPHOLETAPE_API_KEY: "  ", LOOPHOLETAPE_MAX_USD_PER_CALL: "${user_config.max_usd_per_call}", LOOPHOLETAPE_MAX_USD_PER_DAY: "-3", LOOPHOLETAPE_TRIAL: "false" });
  assert.equal(cfg.secret, null);
  assert.equal(cfg.apiKey, null);
  assert.equal(cfg.capCall, 50000);
  assert.equal(cfg.capDay, 1000000);
  assert.equal(cfg.trial, false);
  assert.equal(cfg.base, "https://api.loopholetape.com");
  assert.equal(config({ LOOPHOLETAPE_MAX_USD_PER_CALL: "0.2", LOOPHOLETAPE_BASE_URL: "http://h:1//" }).capCall, 200000);
  assert.equal(config({ LOOPHOLETAPE_BASE_URL: "http://h:1//" }).base, "http://h:1");
});
