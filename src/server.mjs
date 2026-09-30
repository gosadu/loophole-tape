// loophole tape: local MCP server (stdio).
//
// It lists loophole tape's tools to a local MCP client and answers them from https://api.loopholetape.com.
// Free tools are forwarded as they are. Paid tools are paid per call in USDC on Solana over x402, signed on
// this machine with the wallet you configure, or charged to a prepaid key.
//
// What the code below enforces, whatever the API answers:
//   - a payment goes to PAY_TO in USDC on Solana mainnet with a fee payer that is not you, or it is not signed;
//   - one call never signs more than the tool's listed price or LOOPHOLETAPE_MAX_USD_PER_CALL;
//   - one UTC day never signs more than LOOPHOLETAPE_MAX_USD_PER_DAY, counted in a locked file BEFORE signing, so the
//     cap holds across restarts and across several copies of this server sharing one state directory;
//   - the private key is read once, handed to the signer and never written, logged or sent.
//
// Reviewed adversarially before its first release (2026-09-30): the review's findings are the reasons behind the guards.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VERSION = "0.2.0";
export const PAY_TO = "9HkwyUhDMyjbpSpnyu5xuZ9vRaFQeajnJsavhie7XcsT"; // loophole tape's Solana address
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC on Solana mainnet
export const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // Solana mainnet, CAIP-2
export const PAY_TO_BASE = "0x25d408eF54e60F3006bD13d5A040d525E2F359c2"; // loophole tape's Base address
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // native USDC on Base
export const BASE_CHAIN = "eip155:8453"; // Base mainnet, CAIP-2
const DEFAULT_BASE = "https://api.loopholetape.com";
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const DEFAULT_EVM_RPC = "https://mainnet.base.org";
const EVM_KEY = /^0x[0-9a-fA-F]{64}$/;
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const CATALOG_TTL_MS = 15 * 60_000;
const CATALOG_RETRY_MS = 60_000;
const DESCRIPTION_MAX = 700;
const SIGNING_TIMEOUT_MS = 25_000; // the scheme's own RPC reads (mint account, blockhash) carry no signal of their own
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const TX_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

// One-off purchases (a key shown once, a dataset file, a 30-day subscription) are not per-call data tools.
const NOT_TOOLS = new Set(["buy_api_key", "buy_trial_key", "buy_dataset", "subscribe_alerts"]);
// token_check is served here as token_safety; the tool list itself is the catalog; the feed's health and the sample card are
// for integrators, not for an agent deciding on a token.
const HIDDEN_FREE = new Set(["token_check", "catalog", "health", "sample_mint"]);
// What token_safety may buy, by depth: the tool named by the free answer must be one of these, or nothing is bought.
const DEPTH_TOOLS = { auto: ["verdict"], full: ["mint_risk_card", "rhc_curve_card"] };
const PAID_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }; // it spends money
const FREE_LOCAL_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const INSTRUCTIONS =
  "Pre-trade safety checks and launch data for Solana tokens: pump.fun launches in depth (calibrated rug and graduation " +
  "odds, holders, creator record, trade flow), any other Solana mint from its on-chain state, and Robinhood Chain (pons) " +
  "launches. Start with token_safety: it is free for every token. Tools that cost money say the price in their description; " +
  "this local server pays them in USDC from the wallet its owner configured, inside the owner's per-call and per-day caps. " +
  "wallet_status shows the payment mode, the caps, today's spend and every price.";

export const toMicro = (usd) => Math.round(Number(usd) * 1e6);
export const usd = (micro) => `$${(micro / 1e6).toFixed(6).replace(/\.?0+$/, "")}`;
const isPrice = (micro) => Number.isSafeInteger(micro) && micro > 0;

function tokenSafetyDef(routes) {
  const price = (tool, fallback) => usd(routes?.get(tool)?.micro ?? toMicro(fallback));
  return {
    name: "token_safety",
    title: "Token safety check for any Solana token (free, optional paid depth)",
    description:
      "Pre-trade safety check for one token. Free for every Solana mint: mint and freeze authority, Token-2022 holder risks, " +
      "the ten largest token accounts with pool and curve vaults named, the launch venue, and a verdict word with its reason. " +
      `For a pump.fun launch inside the live window (its first hours) depth=auto also buys the verdict with calibrated ` +
      `P(rug within 5 min), P(graduation) and up to three observed flags (${price("verdict", 0.01)}). depth=full buys the full ` +
      `risk card instead (${price("mint_risk_card", 0.025)}: holders, creator record, bundle and sniper cohorts, market) for a ` +
      `live launch or any pump.fun token, or the curve card of a pons token (${price("rhc_curve_card", 0.02)}). depth=free never ` +
      "pays. Nothing is bought when the paid answer would add nothing. Input: a mint address, a pons (Robinhood Chain) 0x address, " +
      "or a link to the token on pump.fun, gmgn, solscan, birdeye or dexscreener.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Mint address, pons 0x token address, or a link to the token on a terminal or explorer." },
        depth: { type: "string", enum: ["auto", "free", "full"], default: "auto", description: "auto: the free answer plus the verdict when the launch is live. free: never pays. full: the risk card when we hold depth on the token." },
      },
      required: ["token"],
      additionalProperties: false,
    },
    annotations: PAID_ANNOTATIONS,
  };
}

const WALLET_STATUS = {
  name: "wallet_status",
  title: "Payment status of this local server (free)",
  description:
    "Free, answered locally. How this server pays for paid tools (your wallet, a prepaid key, the shared trial key, or nothing), " +
    "the wallet address and its USDC balance, the per-call and per-day spending caps, what was signed and settled today, and the " +
    "price of every paid tool. No arguments.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: FREE_LOCAL_ANNOTATIONS,
};
const LOCAL_TOOL_NAMES = new Set(["token_safety", WALLET_STATUS.name]);

export function config(env = process.env) {
  // An empty value, or a host's unfilled "${user_config.x}" placeholder, is the same as unset.
  const value = (name) => {
    const s = String(env[name] ?? "").trim();
    return !s || s.startsWith("${") ? null : s;
  };
  const positive = (name, fallback) => {
    const n = Number(value(name));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    base: (value("LOOPHOLETAPE_BASE_URL") || DEFAULT_BASE).replace(/\/+$/, ""),
    apiKey: value("LOOPHOLETAPE_API_KEY"),
    secret: value("SOLANA_PRIVATE_KEY"),
    keypairPath: value("SOLANA_KEYPAIR_PATH"),
    rpcUrl: value("SOLANA_RPC_URL"),
    evmSecret: value("EVM_PRIVATE_KEY"),
    evmRpcUrl: value("EVM_RPC_URL"),
    capCall: toMicro(positive("LOOPHOLETAPE_MAX_USD_PER_CALL", 0.05)),
    capDay: toMicro(positive("LOOPHOLETAPE_MAX_USD_PER_DAY", 1)),
    trial: !["0", "false", "off"].includes((value("LOOPHOLETAPE_TRIAL") || "").toLowerCase()),
    stateDir: value("LOOPHOLETAPE_STATE_DIR") || join(homedir(), ".loopholetape-mcp"),
    ua: value("LOOPHOLETAPE_UA") || `loopholetape-mcp/${VERSION}`,
  };
}

/**
 * The payment terms this server is willing to sign, for the wallets it holds (`wallets` = { solana: address|null, evm: address|null }):
 * on Solana our address, USDC, mainnet, at most maxMicro, and a fee payer that is a Solana address other than the paying wallet (so
 * the wallet never pays the network fee itself); on Base our Base address, native USDC, chain 8453, at most maxMicro (the payer signs
 * an authorization; the facilitator submits and pays gas). Anything else is not signed.
 */
export function pinned(requirements, maxMicro, wallets) {
  if (!isPrice(maxMicro)) return [];
  const holds = typeof wallets === "string" ? { solana: wallets, evm: null } : wallets || {};
  return (requirements || []).filter((r) => {
    try {
      const amount = BigInt(r.amount);
      if (!(r.scheme === "exact" && amount > 0n && amount <= BigInt(maxMicro))) return false;
      if (holds.solana && r.network === SOLANA && r.payTo === PAY_TO && r.asset === USDC) {
        const feePayer = r.extra?.feePayer;
        return typeof feePayer === "string" && BASE58.test(feePayer) && feePayer.length >= 32 && feePayer.length <= 44 && feePayer !== holds.solana;
      }
      if (holds.evm && r.network === BASE_CHAIN && same(r.payTo, PAY_TO_BASE) && same(r.asset, USDC_BASE)) return true;
      return false;
    } catch {
      return false;
    }
  });
}

/** The EVM secret key from EVM_PRIVATE_KEY (0x + 64 hex), or null; an address or anything else is refused without being quoted. */
export function evmSecret(cfg) {
  let raw = cfg.evmSecret ? String(cfg.evmSecret).trim() : "";
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) raw = `0x${raw}`; // the same key without its prefix, as some wallets export it
  if (/^(0x)?[0-9a-fA-F]{40}$/.test(raw)) throw new Error("the EVM key is a public address (40 hex digits); expected the 32-byte private key");
  if (!EVM_KEY.test(raw)) throw new Error("the EVM key is not 0x followed by 64 hex digits");
  return raw;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * What this server signed on one UTC day, in a small file under a lock. A payment is counted BEFORE it is signed and the
 * unsigned part is refunded afterwards, so a crash between the two over-counts and never under-counts; two copies of the
 * server sharing the directory share the cap; a file that cannot be read or written refuses payments instead of forgetting them.
 * `micro` = everything signed today, settled or not (what the cap counts); `settled` = the part the API gave a receipt for.
 */
export class Spend {
  constructor(capDay, dir, now = () => Date.now()) {
    this.capDay = capDay;
    this.dir = dir;
    this.file = join(dir, "spend.json");
    this.lock = join(dir, "spend.lock");
    this.now = now;
  }

  day() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  fresh() {
    return { day: this.day(), micro: 0, settled: 0, payments: 0 };
  }

  /** The file's state for today; `null` when the file exists but cannot be trusted. */
  load() {
    let raw;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      return error?.code === "ENOENT" ? this.fresh() : null;
    }
    let state;
    try {
      state = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!state || typeof state !== "object" || !Number.isSafeInteger(state.micro) || state.micro < 0) return null;
    return state.day === this.day() ? { ...this.fresh(), ...state } : this.fresh();
  }

  save(state) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Runs `fn` with the directory's lock held (a lock older than 30 s is a dead process's and is taken over). */
  locked(fn) {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const deadline = this.now() + 3_000;
    for (;;) {
      let fd;
      try {
        fd = openSync(this.lock, "wx", 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          if (this.now() - statSync(this.lock).mtimeMs > 30_000) unlinkSync(this.lock);
        } catch {
          // the other process released it between the two calls
        }
        if (this.now() > deadline) throw new Error("another copy of this server holds the spend file's lock");
        sleep(15);
        continue;
      }
      try {
        return fn();
      } finally {
        closeSync(fd);
        try {
          unlinkSync(this.lock);
        } catch {
          // already gone
        }
      }
    }
  }

  /** Counts `micro` toward today's cap before anything is signed. Returns null, or the reason the payment is refused. */
  reserve(micro) {
    if (!isPrice(micro)) return "the tool's price is not a whole number of micro-USDC";
    try {
      return this.locked(() => {
        const state = this.load();
        if (!state) return `the spend file ${this.file} exists but cannot be read; fix or remove it before paying`;
        if (state.micro + micro > this.capDay) {
          return `the daily cap of ${usd(this.capDay)} is reached (${usd(state.micro)} signed today, UTC); raise LOOPHOLETAPE_MAX_USD_PER_DAY or wait for the next day`;
        }
        state.micro += micro;
        this.save(state);
        return null;
      });
    } catch (error) {
      return `the spend file ${this.file} cannot be written (${error?.code || error?.message || "error"}); paying needs it (LOOPHOLETAPE_STATE_DIR)`;
    }
  }

  /** After the call: `signed` micro-USDC were actually signed (0 when nothing was), `settled` says whether a receipt came back. */
  settle(reserved, signed, settled) {
    try {
      return this.locked(() => {
        const state = this.load() || this.fresh();
        state.micro = Math.max(0, state.micro - reserved + signed);
        if (settled) {
          state.settled = (state.settled || 0) + signed;
          state.payments = (state.payments || 0) + 1;
        }
        this.save(state);
        return state;
      });
    } catch {
      return this.load() || this.fresh(); // the reservation stands in the file: over-counted, never forgotten
    }
  }

  read() {
    return this.load() || this.fresh();
  }
}

/** One paid HTTP route of the API, from its public manifest (/v1/x402/resources); null when it cannot be trusted. */
export function routeFromResource(resource) {
  const strip = (u) => String(u || "").replace(/^https?:\/\/[^/]+/, "");
  const path = strip(resource.resource);
  const queryForm = resource.query_form ? strip(resource.query_form).replace(/\?.*$/, "") : null;
  const micro = toMicro(resource.price_usd);
  const ok = (p) => p.startsWith("/v1/") && !/[?#\\@:]/.test(p) && !/(^|\/)\.\.?(\/|$)/.test(p);
  if (!resource.mcp_tool || !isPrice(micro) || !ok(path) || (queryForm && !ok(queryForm))) return null;
  return {
    tool: resource.mcp_tool,
    micro,
    path,
    pathParams: Object.keys(resource.input?.path_params || {}),
    queryParams: Object.keys(resource.input?.query?.properties || {}),
    queryForm,
  };
}

const plain = (v) => (Array.isArray(v) ? v.join(",") : String(v));

/** Tool arguments to the route's URL, always on `base`'s origin under /v1/. A pasted link as the id goes through the query form. */
export function buildUrl(base, route, args) {
  let path = route.path;
  const query = new URLSearchParams();
  for (const name of route.pathParams) {
    const value = args?.[name];
    if (value === undefined || value === null || String(value).trim() === "") throw new Refusal(`'${name}' is required`);
    const text = String(value).trim();
    if (/^\.{1,2}$/.test(text)) throw new Refusal(`'${name}' is not an id`);
    if (/[/\\]/.test(text)) {
      if (!route.queryForm) throw new Refusal(`'${name}' must be an id, not a link, for ${route.tool}`);
      path = route.queryForm;
      query.set(name, text);
    } else {
      path = path.replace(`{${name}}`, encodeURIComponent(text));
    }
  }
  for (const name of route.queryParams) {
    const value = args?.[name];
    if (value === undefined || value === null || route.pathParams.includes(name)) continue;
    query.set(name, plain(value));
  }
  const qs = query.toString();
  const url = new URL(base + path + (qs ? `?${qs}` : ""));
  if (url.origin !== new URL(base).origin || !url.pathname.startsWith("/v1/")) throw new Refusal("the request would leave the API");
  return url.href;
}

/** A JSON-RPC answer from a streamable-HTTP MCP endpoint: plain JSON, or the last message of an event stream. */
export function parseRpc(text, contentType = "") {
  if (contentType.includes("text/event-stream")) {
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const message = JSON.parse(line.slice(5).trim());
        if (message && (message.result !== undefined || message.error !== undefined)) last = message;
      } catch {
        // a keep-alive or a partial line
      }
    }
    return last;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The 64-byte secret key, from SOLANA_PRIVATE_KEY (base58 or a JSON byte array, or a path to a file holding one) or
 * SOLANA_KEYPAIR_PATH. A 32-byte value is refused: a pasted public address would otherwise become a "seed" and a fresh,
 * sweepable wallet.
 */
export async function secretBytes(cfg) {
  let raw = cfg.secret ? String(cfg.secret).trim() : "";
  let path = cfg.keypairPath ? String(cfg.keypairPath).trim() : "";
  if (raw && /^(~|\.|\/)/.test(raw)) [path, raw] = [raw, ""];
  if (!raw && path) {
    try {
      raw = readFileSync(path.replace(/^~(?=\/|$)/, homedir()), "utf8").trim();
    } catch {
      throw new Error("the keypair file could not be read");
    }
  }
  if (!raw) return null;
  // Errors below never quote the input: a parser's own message can echo part of the key.
  let bytes;
  if (raw.startsWith("[")) {
    try {
      bytes = Uint8Array.from(JSON.parse(raw));
    } catch {
      throw new Error("the key looks like a JSON array but does not parse");
    }
  } else {
    try {
      const { getBase58Encoder } = await import("@solana/kit");
      bytes = Uint8Array.from(getBase58Encoder().encode(raw));
    } catch {
      throw new Error("the key is neither base58 nor a JSON byte array");
    }
  }
  if (bytes.length !== 64) {
    throw new Error(`the key decodes to ${bytes.length} bytes; expected the 64-byte secret key (solana-keygen's format), not a public address or a seed`);
  }
  return bytes;
}

/** A refusal this server makes itself, before anything is signed or sent. */
export class Refusal extends Error {}

const text = (s) => ({ type: "text", text: s });
const failure = (s) => ({ content: [text(s)], isError: true });

function firstJson(result) {
  for (const item of result?.content || []) {
    if (item?.type !== "text") continue;
    try {
      return JSON.parse(item.text);
    } catch {
      // not JSON: keep looking
    }
  }
  return null;
}

function shorten(description, micro) {
  const s = String(description || "");
  let out = s;
  if (s.length > DESCRIPTION_MAX) {
    const cut = s.slice(0, DESCRIPTION_MAX);
    const stop = cut.lastIndexOf(". ");
    out = (stop > DESCRIPTION_MAX / 2 ? cut.slice(0, stop + 1) : cut) + " …";
  }
  if (micro && !out.includes("$")) out += ` ${usd(micro)} per call.`;
  return out;
}

/** The API's own reasons on a refusal or a 402, for the message a person reads. */
function apiSaid(body) {
  try {
    const doc = JSON.parse(body);
    const parts = [doc.error, doc.reason, doc.hint, doc.detail, doc.message].filter((p) => typeof p === "string" && p);
    return parts.length ? ` The API said: ${parts.join("; ").slice(0, 400)}` : "";
  } catch {
    return "";
  }
}

export class Tape {
  constructor(cfg, fetchImpl = (...args) => globalThis.fetch(...args)) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.spend = new Spend(cfg.capDay, cfg.stateDir);
    this.catalog = null;
    this.catalogFailedAt = 0;
    this.seq = 0;
    this.walletPromise = null;
    this.walletError = null;
  }

  headers(extra) {
    return { "user-agent": this.cfg.ua, accept: "application/json", ...extra };
  }

  async rpc(method, params) {
    const res = await this.fetch(`${this.cfg.base}/mcp`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json", accept: "application/json, text/event-stream" }),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.seq, method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(45_000),
    });
    const message = parseRpc(await res.text(), res.headers.get("content-type") || "");
    if (!message) throw new Error(`api.loopholetape.com answered ${res.status} without a JSON-RPC message`);
    if (message.error) throw new Error(`${message.error.message || "error"} (${message.error.code})`);
    return message.result;
  }

  async loadCatalog() {
    if (this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) return this.catalog;
    if (!this.catalog && Date.now() - this.catalogFailedAt < CATALOG_RETRY_MS) throw new Error("the API could not be reached a moment ago; try again in a minute");
    try {
      const [listed, manifest] = await Promise.all([
        this.rpc("tools/list", {}),
        this.fetch(`${this.cfg.base}/v1/x402/resources`, { headers: this.headers(), redirect: "error", signal: AbortSignal.timeout(30_000) }).then((r) => r.json()),
      ]);
      const routes = new Map();
      for (const resource of (manifest.data || manifest).resources || []) {
        if (resource.method !== "GET" || NOT_TOOLS.has(resource.mcp_tool) || LOCAL_TOOL_NAMES.has(resource.mcp_tool)) continue;
        const route = routeFromResource(resource);
        if (route) routes.set(route.tool, route);
      }
      const defs = [];
      const free = new Set();
      for (const tool of listed.tools || []) {
        const paid = Boolean(tool._meta?.x402);
        if (LOCAL_TOOL_NAMES.has(tool.name)) continue;
        if (paid && !routes.has(tool.name)) continue;
        if (!paid && (HIDDEN_FREE.has(tool.name) || NOT_TOOLS.has(tool.name))) continue;
        if (!paid) free.add(tool.name);
        defs.push({
          name: tool.name,
          ...(tool.title ? { title: tool.title } : {}),
          description: shorten(tool.description, paid ? routes.get(tool.name).micro : 0),
          inputSchema: tool.inputSchema || { type: "object", properties: {} },
          annotations: paid ? PAID_ANNOTATIONS : tool.annotations || {},
        });
      }
      this.catalog = { at: Date.now(), defs, routes, free };
    } catch (error) {
      this.catalogFailedAt = Date.now();
      if (!this.catalog) throw error; // a stale catalog beats none; none is an error the caller reports
    }
    return this.catalog;
  }

  /** Paid tools priced above the per-call cap are left out when a wallet pays: they could never be bought. */
  affordable(route) {
    return Boolean(this.cfg.apiKey) || route.micro <= this.cfg.capCall;
  }

  async tools() {
    let catalog;
    try {
      catalog = await this.loadCatalog();
    } catch {
      return [tokenSafetyDef(null), WALLET_STATUS]; // offline: the two local definitions; a call reports the network error
    }
    const listed = catalog.defs.filter((def) => catalog.free.has(def.name) || this.affordable(catalog.routes.get(def.name)));
    return [tokenSafetyDef(catalog.routes), ...listed, WALLET_STATUS];
  }

  /** A scheme with a clock on payload creation (its RPC reads have no timeout of their own); when the clock wins nothing was sent. */
  static clocked(inner) {
    return {
      scheme: inner.scheme,
      findDefaultAsset: inner.findDefaultAsset,
      createPaymentPayload: (version, requirements) =>
        Promise.race([
          inner.createPaymentPayload(version, requirements),
          new Promise((_, reject) => setTimeout(() => reject(new Error("signing timed out (RPC)")), SIGNING_TIMEOUT_MS).unref?.()),
        ]),
    };
  }

  /**
   * The wallets this server pays with: { solana: {address, scheme}|null, evm: {address, scheme}|null }, or null when none is
   * configured. Both may be set; the API quotes Solana first, so Solana pays when both can. A key that does not load is reported
   * in walletError (never quoted) and the other rail, if any, still works.
   */
  wallet() {
    this.walletPromise ??= (async () => {
      const wallets = { solana: null, evm: null };
      const errors = [];
      try {
        const bytes = await secretBytes(this.cfg);
        if (bytes) {
          const kit = await import("@solana/kit");
          const signer = await kit.createKeyPairSignerFromBytes(bytes);
          bytes.fill(0);
          const { ExactSvmScheme } = await import("@x402/svm/exact/client");
          wallets.solana = { address: String(signer.address), scheme: Tape.clocked(new ExactSvmScheme(signer, this.cfg.rpcUrl ? { rpcUrl: this.cfg.rpcUrl } : undefined)) };
        }
      } catch (error) {
        // secretBytes words its own errors; a signer error (a public half that does not match) gets a fixed one
        errors.push(/^the key/.test(error?.message || "") ? error.message : "the Solana key was read but is not a valid keypair");
      }
      try {
        const key = evmSecret(this.cfg);
        if (key) {
          const { privateKeyToAccount } = await import("viem/accounts");
          const account = privateKeyToAccount(key);
          const { ExactEvmScheme } = await import("@x402/evm/exact/client");
          wallets.evm = { address: account.address, scheme: Tape.clocked(new ExactEvmScheme(account)) };
        }
      } catch (error) {
        errors.push(/^the EVM key/.test(error?.message || "") ? error.message : "the EVM key was read but is not a valid private key");
      }
      this.walletError = errors.length ? errors.join("; ") : null;
      return wallets.solana || wallets.evm ? wallets : null;
    })();
    return this.walletPromise;
  }

  async mode() {
    if (this.cfg.apiKey) return "api_key";
    if (await this.wallet()) return "wallet";
    return this.cfg.trial ? "trial" : "free_only";
  }

  /** GET one paid URL. Returns { res, via, paid, signed } and never signs outside the pinned terms and the caps. */
  async fetchPaid(url, route) {
    const init = (extra) => ({ headers: this.headers(extra), redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (this.cfg.apiKey) {
      return { res: await this.fetch(url, init({ "x-api-key": this.cfg.apiKey })), via: "api_key", signed: 0 };
    }
    const wallet = await this.wallet();
    if (wallet) {
      if (!isPrice(route.micro)) throw new Refusal(`${route.tool} has no usable price in the API's manifest; nothing was paid`);
      if (route.micro > this.cfg.capCall) throw new Refusal(`${route.tool} costs ${usd(route.micro)}, above this server's per-call cap of ${usd(this.cfg.capCall)} (LOOPHOLETAPE_MAX_USD_PER_CALL)`);
      const refused = this.spend.reserve(route.micro); // counted in the file before anything is signed
      if (refused) throw new Refusal(refused);
      let signed = 0; // micro-USDC signed by this call (0 while nothing was)
      try {
        const { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } = await import("@x402/fetch");
        const client = new x402Client();
        if (wallet.solana) client.register(SOLANA, wallet.solana.scheme);
        if (wallet.evm) client.register(BASE_CHAIN, wallet.evm.scheme);
        client
          .setSpendControls({ maxAmountPerPayment: `$${(route.micro / 1e6).toFixed(6)}` }) // the library's own check, beside ours
          .registerPolicy((_version, requirements) => pinned(requirements, route.micro, { solana: wallet.solana?.address || null, evm: wallet.evm?.address || null }))
          .onAfterPaymentCreation(async (context) => {
            signed += Number(context.selectedRequirements.amount);
          });
        const res = await wrapFetchWithPayment(this.fetch, client)(url, init());
        if (!signed) {
          this.spend.settle(route.micro, 0, false); // answered or refused before any payment was asked for
          return { res, via: "wallet", signed: 0 };
        }
        let receipt = null;
        try {
          const header = res.headers.get("payment-response");
          receipt = header ? decodePaymentResponseHeader(header) : null;
        } catch {
          // an unreadable receipt is treated as no receipt
        }
        const settled = Boolean(res.ok && receipt?.success);
        const today = this.spend.settle(route.micro, signed, settled);
        const evmTx = /^0x[0-9a-fA-F]{64}$/;
        const tx = typeof receipt?.transaction === "string" && (TX_SIGNATURE.test(receipt.transaction) || evmTx.test(receipt.transaction)) ? receipt.transaction : null;
        const rail = receipt?.network === BASE_CHAIN ? "Base" : "Solana";
        return { res, via: "wallet", signed, paid: settled ? { micro: signed, tx, rail, today: today.micro } : null };
      } catch (error) {
        this.spend.settle(route.micro, signed, false);
        if (error instanceof Refusal) throw error;
        const what = String(error?.message || error).slice(0, 300);
        if (signed) throw new Refusal(`a payment of ${usd(signed)} was signed and the answer did not arrive (${what}); it counts toward today's cap`);
        if (/filtered out|No payment requirements/i.test(what)) {
          throw new Refusal(`nothing was paid: the API's quote did not match this server's pinned terms (our address, USDC on Solana mainnet or on Base, at most ${usd(route.micro)}, on Solana a fee payer that is not you)`);
        }
        throw new Refusal(`nothing was paid: ${what}`);
      }
    }
    const res = await this.fetch(url, init());
    if (res.status !== 402 || !this.cfg.trial) return { res, via: "none", signed: 0 };
    // No wallet and no key: the API publishes one shared trial key with tiny daily caps in its 402 body.
    const body = await res.clone().json().catch(() => null);
    const match = /^x-api-key:\s*(\S+)\s*$/i.exec(body?.no_x402_client?.public_trial_key?.header || "");
    if (!match) return { res, via: "none", signed: 0 };
    return { res: await this.fetch(url, init({ "x-api-key": match[1] })), via: "trial", signed: 0 };
  }

  howToPay(route, via, body) {
    const lines = [];
    if (via === "api_key") lines.push(`${route.tool} costs ${usd(route.micro)} and the prepaid key did not cover it (out of credit, or the key is wrong).${apiSaid(body)}`);
    else if (via === "wallet") lines.push(`${route.tool} costs ${usd(route.micro)} and the API did not accept the payment (it answered 402 to the signed request, which it does not settle; the signed amount still counts toward today's cap). Check that the wallet holds USDC (on Solana, or on Base for an EVM key): wallet_status shows the balances.${apiSaid(body)}`);
    else if (via === "trial") lines.push(`${route.tool} costs ${usd(route.micro)}. The shared public trial key did not cover it: it pays tools up to $0.02 and has tiny daily caps for everyone together.${apiSaid(body)}`);
    else lines.push(`${route.tool} costs ${usd(route.micro)} per call and no payment method is configured.`);
    if (via !== "wallet") lines.push("Pay per call: set SOLANA_KEYPAIR_PATH (a solana-keygen file) or SOLANA_PRIVATE_KEY (base58, 64-byte secret key) for a Solana wallet that holds USDC, or EVM_PRIVATE_KEY (0x + 64 hex) for a Base wallet that holds USDC. No SOL or ETH is needed; the network fee is paid for you.");
    if (via !== "api_key") lines.push(`Or prepay: set LOOPHOLETAPE_API_KEY to a key bought with a plain USDC transfer (${this.cfg.base}/v1/keys/transfer).`);
    lines.push("Free without any setup: token_safety with depth=free, radar, market_regime, check_coverage.");
    if (this.walletError) lines.push(`Wallet not loaded: ${this.walletError}.`);
    return lines.join("\n");
  }

  async callRoute(route, url) {
    const { res, via, paid, signed } = await this.fetchPaid(url, route);
    let body;
    try {
      body = await res.text();
    } catch (error) {
      const tail = signed ? ` A payment of ${usd(signed)} had been signed; it counts toward today's cap.` : "";
      return failure(`${route.tool}: the answer could not be read (${String(error?.message || error).slice(0, 120)}).${tail}`);
    }
    if (res.ok) {
      let note = null;
      if (via === "wallet" && paid) note = `[paid ${usd(paid.micro)} USDC on ${paid.rail}${paid.tx ? `, tx ${paid.tx}` : ""}; today ${usd(paid.today)} of ${usd(this.cfg.capDay)}]`;
      else if (via === "wallet" && signed) note = `[a payment of ${usd(signed)} was signed and the answer carried no receipt; it counts toward today's cap]`;
      else if (via === "trial") note = "[answered on the shared public trial key: free, with tiny daily caps. Set SOLANA_KEYPAIR_PATH, EVM_PRIVATE_KEY or LOOPHOLETAPE_API_KEY to keep going.]";
      else if (via === "api_key") note = "[charged to the prepaid key]";
      return { content: note ? [text(body), text(note)] : [text(body)] };
    }
    if (res.status === 402 || (via === "trial" && res.status === 429)) return failure(this.howToPay(route, via, body)); // 429: the trial key's daily cap
    // A refusal (uncovered mint, stale feed, a curve we do not model, a bad argument) is never settled by the API.
    const charged = signed
      ? `a payment of ${usd(signed)} had been signed and no receipt came back; the API does not settle a refusal, and the amount still counts toward today's cap`
      : "nothing was charged";
    return failure(`${route.tool} was refused with HTTP ${res.status}; ${charged}.\n${body.slice(0, 1500)}`);
  }

  async tokenSafety(args) {
    const depth = ["auto", "free", "full"].includes(args?.depth) ? args.depth : "auto";
    const token = String(args?.token ?? "").trim();
    if (!token) return failure("'token' is required: a mint address, a pons 0x address or a link to the token.");
    const result = await this.rpc("tools/call", { name: "token_check", arguments: { token } });
    const content = result?.content || [];
    const free = firstJson(result);
    if (result?.isError || !free || depth === "free") return { content, ...(result?.isError ? { isError: true } : {}) };
    const data = free.data || {};
    const live = free.coverage === "full";
    const held = live || data.venue === "pump.fun" || data.venue === "pons"; // a launch venue we record; any other mint has no paid depth
    const offer = depth === "auto" ? (live ? data.next?.verdict : null) : held ? data.next?.card : null;
    const catalog = await this.loadCatalog().catch(() => null);
    // Only the tool this depth is documented to buy, at the manifest's price, on a URL this server builds itself.
    const route = offer?.tool && DEPTH_TOOLS[depth].includes(offer.tool) && catalog ? catalog.routes.get(offer.tool) : null;
    const id = typeof data.token === "string" && data.token ? data.token : token;
    if (!route || route.pathParams.length !== 1) {
      const why = depth === "auto" ? "the token is outside the live window, so the paid verdict would add nothing" : "we hold no depth on this token beyond the free answer";
      return { content: [...content, text(`[free answer; nothing was bought: ${why}]`)] };
    }
    try {
      const bought = await this.callRoute(route, buildUrl(this.cfg.base, route, { [route.pathParams[0]]: id }));
      if (bought.isError) return { content: [...content, text(`[free answer above; the paid ${route.tool} was not delivered]\n${bought.content[0].text}`)] };
      return { content: [...content, text(`--- ${route.tool} (${usd(route.micro)}) ---`), ...bought.content] };
    } catch (error) {
      return { content: [...content, text(`[free answer above; the paid ${route.tool} was not bought: ${error.message}]`)] };
    }
  }

  async usdcBalance(address) {
    try {
      const res = await this.fetch(this.cfg.rpcUrl || DEFAULT_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [address, { mint: USDC }, { encoding: "jsonParsed" }] }),
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      const accounts = (await res.json()).result?.value;
      if (!Array.isArray(accounts)) return null;
      return accounts.reduce((sum, account) => sum + Number(account.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
    } catch {
      return null;
    }
  }

  /** USDC balance of an EVM address on Base: one eth_call of balanceOf(address) on the USDC contract. */
  async usdcBalanceBase(address) {
    try {
      const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`; // balanceOf(address)
      const res = await this.fetch(this.cfg.evmRpcUrl || DEFAULT_EVM_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_BASE, data }, "latest"] }),
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      const hex = (await res.json()).result;
      if (typeof hex !== "string" || !/^0x[0-9a-fA-F]*$/.test(hex)) return null;
      return Number(BigInt(hex || "0x0")) / 1e6;
    } catch {
      return null;
    }
  }

  async walletStatus() {
    const mode = await this.mode();
    const wallet = await this.wallet();
    const today = this.spend.read();
    let prices = null;
    try {
      const catalog = await this.loadCatalog();
      prices = Object.fromEntries([...catalog.routes.values()].filter((route) => this.affordable(route)).map((route) => [route.tool, route.micro / 1e6]));
    } catch {
      // offline: the status is still worth answering
    }
    const status = {
      server: `loopholetape-mcp ${VERSION}`,
      api: this.cfg.base,
      mode,
      mode_meaning: {
        wallet: "paid tools are paid per call in USDC from the wallet(s) below: Solana first when both are set",
        api_key: "paid tools are charged to the prepaid key",
        trial: "no wallet and no key: paid tools up to $0.02 run on the shared public trial key until its tiny daily caps are used up",
        free_only: "no wallet, no key, trial off: free tools only",
      }[mode],
      wallet: wallet?.solana ? { address: wallet.solana.address, usdc: await this.usdcBalance(wallet.solana.address), needs_sol: false, pays_first: true } : null,
      wallet_base: wallet?.evm ? { address: wallet.evm.address, usdc: await this.usdcBalanceBase(wallet.evm.address), needs_eth: false, pays_when: wallet.solana ? "the Solana wallet cannot" : "always" } : null,
      wallet_error: this.walletError,
      pays_only: [
        { to: PAY_TO, asset: "USDC", network: "Solana mainnet", fee_payer: "the facilitator, never this wallet" },
        { to: PAY_TO_BASE, asset: "USDC", network: "Base", gas: "the facilitator, never this wallet" },
      ],
      caps_usd: { per_call: this.cfg.capCall / 1e6, per_day: this.cfg.capDay / 1e6 },
      signed_today_usd: today.micro / 1e6, // what the daily cap counts: every payment signed today (UTC), settled or not
      settled_today_usd: (today.settled || 0) / 1e6,
      payments_today: today.payments || 0,
      spend_file: this.spend.file,
      prices_usd: prices,
    };
    return { content: [text(JSON.stringify(status, null, 2))] };
  }

  async call(name, args) {
    try {
      if (name === "token_safety") return await this.tokenSafety(args);
      if (name === WALLET_STATUS.name) return await this.walletStatus();
      const catalog = await this.loadCatalog();
      const route = catalog.routes.get(name);
      if (route) return await this.callRoute(route, buildUrl(this.cfg.base, route, args || {}));
      if (catalog.free.has(name)) {
        const result = await this.rpc("tools/call", { name, arguments: args || {} });
        return { content: result?.content || [], ...(result?.isError ? { isError: true } : {}) };
      }
      return failure(`unknown tool '${name}'`);
    } catch (error) {
      if (error instanceof Refusal) return failure(error.message);
      return failure(`${name} failed: ${String(error?.message || error).slice(0, 400)}`);
    }
  }
}

export async function main() {
  const tape = new Tape(config());
  const server = new Server({ name: "loopholetape", title: "loophole tape", version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await tape.tools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => tape.call(request.params.name, request.params.arguments || {}));
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; this one line goes to stderr and names no secret
  process.stderr.write(`loopholetape-mcp ${VERSION} ready, mode ${await tape.mode()}${tape.walletError ? ` (wallet not loaded: ${tape.walletError})` : ""}\n`);
}
