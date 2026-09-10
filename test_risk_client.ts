import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { BASE, Buyer, Journal, NETWORK, PAY_TO, USDC, micro, selectOffer } from "./risk_client.ts";

const mints = ["1".repeat(32), "2".repeat(32)];
function required(url: string): PaymentRequired { return { x402Version: 2, resource: { url }, accepts: [{
  scheme: "exact", payTo: PAY_TO, network: NETWORK, asset: USDC, amount: "10000", maxTimeoutSeconds: 60, extra: {},
}] }; }
function state(transport: "http" | "mcp" = "http") {
  const path = mkdtempSync(join(tmpdir(), "tape-buyer-"));
  return { path, journal: new Journal(join(path, "buyer-state.json"), mints, transport) };
}
const proof: PaymentPayload = { x402Version: 2, accepted: required(BASE).accepts[0]!, payload: { transaction: "offline-proof" } };

test("recipient, network, asset, scheme, amount and resource policy", () => {
  const url = BASE + "/v1/check/watchlist";
  assert.equal(selectOffer(required(url), url, 10000, 10000).amount, "10000");
  for (const [key, value] of [["payTo", "elsewhere"], ["network", "eip155:8453"], ["asset", "SOL"],
                            ["scheme", "upto"], ["amount", "10001"], ["amount", "-1"], ["amount", "nan"]]) {
    const bad = required(url);
    Object.assign(bad.accepts[0]!, { [key!]: value });
    assert.throws(() => selectOffer(bad, url, 10000, 10000));
  }
  assert.throws(() => selectOffer(required(url), url + "/other", 10000, 10000));
  assert.throws(() => selectOffer(required(url), url, 10000, 9999));
  assert.equal(micro("0.005"), 5000);
  for (const value of ["NaN", "Infinity", "-1", "0.0000001"]) assert.throws(() => micro(value));
});

test("unavailable and unchanged requests never invoke signer", async () => {
  const { path, journal } = state();
  try {
    for (const body of [{ ok: false, charged: false, error: "feed_stale" }, { ok: true, data: { charged: false, status: "no_new_events" } }]) {
      const http = (async () => Response.json(body)) as typeof fetch;
      const buyer = new Buyer(http, journal, async () => { throw new Error("must not sign"); });
      assert.deepEqual(await buyer.check(), body);
    }
    assert.equal(journal.data.authorized_micro, 0);
  } finally { journal.close(); rmSync(path, { recursive: true }); }
});

test("lost response retries exact signed proof with one authorization", async () => {
  const { path, journal } = state();
  try {
    let signs = 0;
    const signed: string[] = [];
    const http = (async (url: string, options: RequestInit) => {
      assert.equal(options.redirect, "error");
      const header = (options.headers as Record<string, string>)["PAYMENT-SIGNATURE"];
      if (!header) return Response.json(required(url), { status: 402 });
      signed.push(header);
      if (signed.length === 1) throw new Error("offline response lost");
      return Response.json({ ok: true, data: { result_id: "original", cursor: "cursor" } }, { headers: { "payment-response": "offline-receipt" } });
    }) as typeof fetch;
    const buyer = new Buyer(http, journal, async () => { signs++; return proof; });
    assert.equal((await buyer.check()).data.result_id, "original");
    assert.equal(signs, 1);
    assert.equal(signed[0], signed[1]);
    assert.equal(journal.data.authorized_micro, 10000);
    assert.equal(journal.data.pending, null);
    assert.equal(statSync(journal.path).mode & 0o777, 0o600);
  } finally { journal.close(); rmSync(path, { recursive: true }); }
});

test("persisted pending attempt resumes without a new signature", async () => {
  const { path, journal: initial } = state();
  let journal = initial;
  try {
    const first = new Buyer(fetch, initial, async () => proof);
    initial.data.pending = { operation: first.operation("check"), proof, created: Date.now() / 1000 };
    initial.data.authorized_micro = 10000;
    initial.save(); initial.close();
    journal = new Journal(initial.path, mints, "http");
    const http = (async (_url: string, options: RequestInit) => {
      assert.deepEqual(JSON.parse(Buffer.from((options.headers as Record<string, string>)["PAYMENT-SIGNATURE"]!, "base64").toString()), proof);
      return Response.json({ ok: true, data: { cursor: "new" } }, { headers: { "payment-response": "offline-receipt" } });
    }) as typeof fetch;
    await new Buyer(http, journal, async () => { throw new Error("must not sign"); }, 10000).check();
    assert.equal(journal.data.authorized_micro, 10000);
  } finally { journal.close(); rmSync(path, { recursive: true }); }
});

test("unknown/expired outcomes stop and retain the request", async () => {
  const { path, journal } = state();
  try {
    let calls = 0;
    const http = (async () => { calls++; return Response.json({ ok: false, charged: null, error: "payment_outcome_unknown" }, { status: 409 }); }) as typeof fetch;
    const buyer = new Buyer(http, journal, async () => { throw new Error("must not sign"); });
    journal.data.pending = { operation: buyer.operation("check"), proof, created: Date.now() / 1000 };
    await assert.rejects(buyer.check());
    assert.notEqual(journal.data.pending, null);
    journal.data.pending.created -= 601;
    await assert.rejects(buyer.check());
    assert.equal(calls, 1);
  } finally { journal.close(); rmSync(path, { recursive: true }); }
});

test("MCP payment uses tool resource and enforces cumulative cap", async () => {
  const { path, journal } = state("mcp");
  try {
    let signs = 0;
    const http = (async (_url: string, options: RequestInit) => {
      const req = JSON.parse(options.body as string);
      const paid = req.params._meta?.["x402/payment"];
      return Response.json({ jsonrpc: "2.0", id: 1, result: {
        structuredContent: paid ? { ok: true, data: { cursor: "cursor" } } : required(BASE + "/mcp#check_watchlist_risk"),
        _meta: paid ? { "x402/payment-response": { success: true } } : {},
      } });
    }) as typeof fetch;
    const buyer = new Buyer(http, journal, async () => { signs++; return proof; }, 10000);
    assert.equal((await buyer.check()).ok, true);
    await assert.rejects(buyer.check());
    assert.equal(signs, 1);
  } finally { journal.close(); rmSync(path, { recursive: true }); }
});

test("journal prevents concurrent spenders", () => {
  const { path, journal } = state();
  try { assert.throws(() => new Journal(journal.path, mints, "http")); }
  finally { journal.close(); rmSync(path, { recursive: true }); }
});
