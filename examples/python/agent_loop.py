"""A whole trading-agent loop against the tape API in one file: buy a $2 prepaid key ONCE with x402, then poll the launches delta feed
and buy compact risk checks with a plain header, no x402 client in the loop.

  pip install -r requirements-client.txt httpx
  TAPE_PAYER_KEYPAIR=~/.config/solana/payer.json python agent_loop.py [--every 30] [--grad-min 0.3] [--check-max 20]

First run: one x402 payment of $2.00 (USDC on Solana from the keypair) buys the key, saved 0600 in --state (default
~/.config/loophole-tape/agent_loop.json). Every later run reuses it. Each poll costs $0.001, each compact check $0.005, both
deducted from the key; the loop stops when --check-max checks were bought or the key is short. Nothing here is advice.
"""
import argparse, asyncio, json, os, sys, time
import httpx

BASE = os.environ.get("TAPE_BASE", "https://api.loopholetape.com")
PAY_TO = "9HkwyUhDMyjbpSpnyu5xuZ9vRaFQeajnJsavhie7XcsT"; NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
KEY_PRICE_MICRO = 2_000_000   # the only x402 payment this script ever signs: GET /v1/keys/new at $2.00


def guard(version, reqs):
    """Sign only the tape API's own key purchase: our recipient, network, asset, exactly $2.00."""
    def g(r, *names):
        for n in names:
            v = getattr(r, n, None)
            if v is not None: return v
        return None
    keep = [r for r in reqs if g(r, "pay_to", "payTo") == PAY_TO and g(r, "network") == NETWORK and g(r, "asset") == USDC
            and int(g(r, "amount", "max_amount_required", "maxAmountRequired") or 0) == KEY_PRICE_MICRO]
    if not keep: print("payment refused: not the tape API's $2.00 key purchase", file=sys.stderr)
    return keep


async def buy_key() -> str:
    from x402 import x402Client
    from x402.http.clients.httpx import x402HttpxClient
    from x402.mechanisms.svm import KeypairSigner
    from x402.mechanisms.svm.exact import register_exact_svm_client
    secret = bytes(json.load(open(os.path.expanduser(os.environ.get("TAPE_PAYER_KEYPAIR", "~/.config/solana/payer.json")))))
    signer = KeypairSigner.from_bytes(secret)
    x = x402Client(); x.register_policy(guard); register_exact_svm_client(x, signer)
    async with x402HttpxClient(x, timeout=90) as client:
        r = await client.get(BASE + "/v1/keys/new")
        if r.status_code != 200:
            raise SystemExit(f"key purchase failed: HTTP {r.status_code} {r.text[:200]}")
        key = r.json()["data"]["key"]
        print("bought key", key[:6] + "…", "settlement header present:", bool(r.headers.get("payment-response")))
        return key


def load_state(path: str) -> dict:
    try:
        with open(path) as fh: return json.load(fh)
    except (OSError, ValueError): return {}


def save_state(path: str, state: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh: json.dump(state, fh)
    os.chmod(path, 0o600)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--every", type=float, default=30.0, help="seconds between polls ($0.001 each)")
    ap.add_argument("--grad-min", type=float, default=0.3, help="buy a compact check when P(true graduation) is at least this")
    ap.add_argument("--check-max", type=int, default=20, help="stop after this many checks ($0.005 each)")
    ap.add_argument("--state", default=os.path.expanduser("~/.config/loophole-tape/agent_loop.json"))
    a = ap.parse_args()
    state = load_state(a.state)
    if not state.get("key"):
        state["key"] = asyncio.run(buy_key()); save_state(a.state, state)
    headers = {"X-API-Key": state["key"], "Accept": "application/json"}
    with httpx.Client(timeout=30) as h:
        bal = h.get(BASE + "/v1/keys/balance", headers=headers)
        if bal.status_code != 200:
            raise SystemExit(f"key not usable: HTTP {bal.status_code} {bal.text[:200]} (delete {a.state} to buy a new one)")
        print("credit remaining: $%.3f" % bal.json()["data"]["remaining_usd"])
        cursor, checks, seen = state.get("cursor"), 0, set()
        while checks < a.check_max:
            r = h.get(BASE + "/v1/launches/since", params={"since": cursor} if cursor else None, headers=headers)
            if r.status_code == 402:
                raise SystemExit("key is out of credit: delete the state file to buy a new one, or top up with another purchase")
            if r.status_code != 200:
                print("poll error", r.status_code, r.text[:120]); time.sleep(a.every); continue
            d = r.json()["data"]
            cursor = d["next_cursor"]; state["cursor"] = cursor; save_state(a.state, state)
            for it in d["items"]:
                p = it["probabilities"]
                print(f"{it['created_at']:.0f} {it['mint'][:8]}… {str(it.get('symbol') or '')[:8]:8} buys {it.get('n_buys')} P(rug300) {p.get('rug_within_300s')} P(grad) {p.get('true_graduation')}")
                if it["mint"] not in seen and (p.get("true_graduation") or 0) >= a.grad_min and checks < a.check_max:
                    seen.add(it["mint"]); checks += 1
                    c = h.get(it["check_url"], headers=headers)
                    if c.status_code == 200:
                        item = c.json()["data"]["items"][0]
                        print(f"   check: {item['status']} {item['risk_label']} findings {[f['code'] for f in item['findings']]} P(rug300) {item['probabilities'].get('rug_within_300s')}")
                    else:
                        print("   check failed", c.status_code, c.text[:100])
            time.sleep(a.every)
    print("done:", checks, "checks bought; balance:", h.get(BASE + "/v1/keys/balance", headers=headers).json()["data"]["remaining_usd"] if False else "see /v1/keys/balance")


if __name__ == "__main__":
    main()
