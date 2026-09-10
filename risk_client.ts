/** Budgeted HTTP/MCP buyer. The state file contains a signed payment: keep it private. */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";

export const BASE = "https://api.loopholetape.com";
export const PAY_TO = "9HkwyUhDMyjbpSpnyu5xuZ9vRaFQeajnJsavhie7XcsT";
export const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
type Json = Record<string, any>;
type Operation = { url: string; resource: string; body: Json | null };
type State = {
  mints: string[]; transport: "http" | "mcp"; authorized_micro: number; cursor: string | null;
  pending: { operation: Operation; proof: PaymentPayload; created: number } | null;
};

export function micro(value: string): number {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error("Use a nonnegative USD amount with at most six decimals.");
  const [whole, fraction = ""] = value.split(".");
  const amount = Number(BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0")));
  if (!Number.isSafeInteger(amount)) throw new Error("Budget is too large.");
  return amount;
}

export function selectOffer(required: Json, resource: string, cap: number, remaining: number): PaymentRequirements {
  if (required.x402Version !== 2 || required.resource?.url !== resource) throw new Error("Refusing an unexpected payment version or resource.");
  for (const offer of required.accepts ?? []) {
    if (offer.scheme === "exact" && offer.payTo === PAY_TO && offer.network === NETWORK && offer.asset === USDC
        && typeof offer.amount === "string" && /^\d+$/.test(offer.amount)
        && BigInt(offer.amount) > 0n && BigInt(offer.amount) <= BigInt(Math.max(0, Math.min(cap, remaining)))) return offer;
  }
  throw new Error("Payment refused: wrong recipient/network/asset, or per-call/run budget exceeded.");
}

export class Journal {
  path: string;
  lockPath: string;
  data: State;
  constructor(path: string, mints: string[], transport: "http" | "mcp") {
    this.path = resolve(path);
    this.lockPath = this.path + ".lock";
    mkdirSync(dirname(this.path), { recursive: true });
    // An atomic lock prevents concurrent processes spending one journal's budget.
    // A stale lock after a crash can be removed after confirming that PID exited.
    const fd = openSync(this.lockPath, "wx", 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    try {
      this.data = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {
        mints, transport, authorized_micro: 0, pending: null, cursor: null,
      };
      if (JSON.stringify(this.data.mints) !== JSON.stringify(mints) || this.data.transport !== transport)
        throw new Error("State belongs to another mint set/transport. Use a separate --state file.");
    } catch (error) { this.close(); throw error; }
  }
  save() {
    const temp = dirname(this.path) + "/.buyer-state-" + randomUUID();
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(this.data)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, this.path);
  }
  close() { unlinkSync(this.lockPath); }
}

export class Buyer {
  http: typeof fetch;
  journal: Pick<Journal, "data" | "save">;
  sign: (required: PaymentRequired) => Promise<PaymentPayload>;
  budget: number;
  cap: number;
  constructor(http: typeof fetch, journal: Pick<Journal, "data" | "save">,
              sign: (required: PaymentRequired) => Promise<PaymentPayload>, budget = 50_000, cap = 10_000) {
    this.http = http; this.journal = journal; this.sign = sign; this.budget = budget; this.cap = cap;
  }
  operation(kind: "coverage" | "watch" | "check", cursor: string | null = null): Operation {
    const { mints, transport } = this.journal.data;
    const single = mints.length === 1;
    const args: Json = kind === "check" && single ? { mint: mints[0] } : { mints };
    if (cursor !== null) args.cursor = cursor;
    const tool = { coverage: "check_coverage", watch: "watchlist_updates",
      check: single ? "check_pumpfun_risk" : "check_watchlist_risk" }[kind];
    if (transport === "mcp") return { url: BASE + "/mcp", resource: BASE + "/mcp#" + tool,
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } } };
    const path = kind === "check" && single ? "/v1/check/mint/" + mints[0] : "/v1/check/" + (kind === "check" ? "watchlist" : kind);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) if (key !== "mint") query.set(key, Array.isArray(value) ? value.join(",") : value);
    const url = BASE + path + (query.size ? "?" + query : "");
    return { url, resource: url, body: null };
  }
  async send(operation: Operation, proof?: PaymentPayload): Promise<{ status: number; body: Json; receipt: unknown }> {
    if (new URL(operation.url).origin !== BASE || (!operation.url.startsWith(BASE + "/v1/check/") && operation.url !== BASE + "/mcp"))
      throw new Error("Refusing an unexpected API origin/path.");
    const headers: Record<string, string> = { Accept: "application/json, text/event-stream" };
    const requestBody = operation.body ? structuredClone(operation.body) : null;
    if (requestBody) {
      headers["Content-Type"] = "application/json";
      if (proof) requestBody.params._meta = { "x402/payment": proof };
    } else if (proof) headers["PAYMENT-SIGNATURE"] = Buffer.from(JSON.stringify(proof)).toString("base64");
    const response = await this.http(operation.url, { method: requestBody ? "POST" : "GET", headers,
      body: requestBody ? JSON.stringify(requestBody) : undefined, redirect: "error", signal: AbortSignal.timeout(60_000) });
    let body: Json = await response.json();
    let receipt: unknown = response.headers.get("payment-response");
    if (requestBody && body.result) {
      receipt = body.result._meta?.["x402/payment-response"];
      body = body.result.structuredContent ?? JSON.parse(body.result.content[0].text);
    }
    return { status: response.status, body, receipt };
  }
  async recover(): Promise<Json> {
    const pending = this.journal.data.pending!;
    if (Date.now() / 1000 - pending.created >= 600)
      throw new Error("Pending payment is beyond the replay window. Reconcile before authorizing another; state retained.");
    for (let attempt = 0; attempt < 3; attempt++) {
      let result;
      try { result = await this.send(pending.operation, pending.proof); }
      catch {
        if (attempt === 2) throw new Error("Response unavailable. Re-run with this state file to retry the original payment.");
        await delay(1000 * (attempt + 1)); continue;
      }
      const { status, body, receipt } = result;
      if (status < 300 && body.ok === true && (receipt || body.data?.charged === false)) {
        this.journal.data.pending = null;
        this.journal.data.cursor = body.data?.cursor ?? null;
        this.journal.save(); return body;
      }
      if (body.charged === false) {
        this.journal.data.pending = null;
        this.journal.save(); return body;
      }
      throw new Error("Payment outcome needs reconciliation; exact request retained. No new payment was authorized.");
    }
    throw new Error("Response unavailable; state retained.");
  }
  async check(): Promise<Json> {
    if (this.journal.data.pending) return this.recover();
    const operation = this.operation("check", this.journal.data.cursor);
    const { body } = await this.send(operation);
    if (body.x402Version !== 2) return body;
    const offer = selectOffer(body, operation.resource, Math.min(this.cap, this.journal.data.mints.length === 1 ? 5000 : 10000),
      this.budget - this.journal.data.authorized_micro);
    const proof = await this.sign({ ...body, accepts: [offer] } as PaymentRequired);
    this.journal.data.authorized_micro += Number(offer.amount);
    this.journal.data.pending = { operation, proof, created: Date.now() / 1000 };
    this.journal.save(); // Durable before sending; retries never create another signature.
    return this.recover();
  }
}

async function signPayment(required: PaymentRequired): Promise<PaymentPayload> {
  const keyPath = process.env.TAPE_PAYER_KEYPAIR;
  if (!keyPath) throw new Error("Set TAPE_PAYER_KEYPAIR to your funded Solana keypair JSON to authorize payment.");
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");
  const { x402Client } = await import("@x402/core/client");
  const { ExactSvmScheme } = await import("@x402/svm/exact/client");
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
  const client = new x402Client().register(NETWORK, new ExactSvmScheme(signer));
  const declaration = required.extensions?.["payment-identifier"] as Json | undefined;
  if (declaration) declaration.info = { ...declaration.info, id: "pay_" + randomUUID().replaceAll("-", "") };
  return client.createPaymentPayload(required);
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    transport: { type: "string", default: "http" }, coverage: { type: "boolean", default: false },
    budget: { type: "string", default: "0.05" }, "max-per-call": { type: "string", default: "0.01" },
    polls: { type: "string", default: "0" }, state: { type: "string", default: "buyer-state.json" },
  } });
  const mints = (positionals[0] ?? "").split(",").sort();
  if (mints.length < 1 || mints.length > 5 || new Set(mints).size !== mints.length || mints.some(m => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)))
    throw new Error("Usage: node risk_client.ts MINT1[,MINT2] [--coverage] [--transport http|mcp] [--budget 0.05] [--polls 20]");
  if (values.transport !== "http" && values.transport !== "mcp") throw new Error("Transport must be http or mcp.");
  const journal = new Journal(values.state, mints, values.transport);
  try {
    const buyer = new Buyer(fetch, journal, signPayment, micro(values.budget), micro(values["max-per-call"]));
    if (values.coverage) { console.log(JSON.stringify((await buyer.send(buyer.operation("coverage"))).body, null, 2)); return; }
    console.log(JSON.stringify(await buyer.check(), null, 2));
    for (let i = 0; i < Number(values.polls); i++) {
      if (!journal.data.cursor) break;
      await delay(15_000);
      const { body } = await buyer.send(buyer.operation("watch", journal.data.cursor));
      if (body.data?.has_new_events) console.log(JSON.stringify(await buyer.check(), null, 2));
    }
  } finally { journal.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
