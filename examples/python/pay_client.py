"""Paying-client check for the tape API (also the integrator reference): buys ONE priced call from the public URL with the
official x402 client, paying USDC from a Solana keypair JSON (path in env TAPE_PAYER_KEYPAIR, default ~/.config/solana/payer.json). Setup: pip install -r requirements-client.txt
  python pay_client.py [base_url] [path]
Costs the route price (1 to 2.5 cents). Prints status, settlement (tx signature) and the body head."""
import asyncio, base64, json, os, sys, time
from x402 import x402Client
from x402.http.clients.httpx import x402HttpxClient
from x402.http.utils import decode_payment_response_header
from x402.mechanisms.svm import KeypairSigner
from x402.mechanisms.svm.exact import register_exact_svm_client

# --- payment guard (reference policy): never sign anything but OUR recipient, network and asset, at or under the route's price.
PAY_TO = "9HkwyUhDMyjbpSpnyu5xuZ9vRaFQeajnJsavhie7XcsT"; NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
MAX_USD_PER_CALL = float(os.environ.get("TAPE_MAX_USD_PER_CALL", "0.03"))   # highest list price is $0.025

def loophole_guard(version, reqs):
    """x402 client policy: drop every payment requirement that is not exactly ours or costs more than the cap; an empty list means the client refuses to pay."""
    def g(r, *names):
        for n in names:
            v = getattr(r, n, None)
            if v is not None: return v
        return None
    keep = []
    for r in reqs:
        amount = int(g(r, "amount", "max_amount_required", "maxAmountRequired") or 0)   # USDC atomic units (6 decimals)
        if g(r, "pay_to", "payTo") == PAY_TO and g(r, "network") == NETWORK and g(r, "asset") == USDC and 0 < amount <= int(MAX_USD_PER_CALL * 1e6): keep.append(r)
    if not keep: print("payment refused: requirements are not the tape API's own (recipient/network/asset) or exceed the per-call cap", file=sys.stderr)
    return keep


BASE = sys.argv[1] if len(sys.argv) > 1 else "https://api.loopholetape.com"
PATH = sys.argv[2] if len(sys.argv) > 2 else "/v1/launches/recent?limit=2"
secret = bytes(json.load(open(os.path.expanduser(os.environ.get("TAPE_PAYER_KEYPAIR", "~/.config/solana/payer.json")))))
signer = KeypairSigner.from_bytes(secret)
print("payer:", signer.address)

async def main():
    x = x402Client()
    x.register_policy(loophole_guard)
    register_exact_svm_client(x, signer)
    async with x402HttpxClient(x, timeout=60) as client:
        t0 = time.time()
        r = await client.get(BASE + PATH)
        dt = time.time() - t0
        print("status", r.status_code, f"in {dt:.1f}s")
        pr = r.headers.get("payment-response") or r.headers.get("x-payment-response")
        if pr:
            try:
                s = decode_payment_response_header(pr)
                print("settlement:", {"success": s.success, "transaction": getattr(s, "transaction", None), "network": getattr(s, "network", None), "payer": getattr(s, "payer", None), "error": getattr(s, "error_reason", None)})
            except Exception as e:
                print("raw payment-response:", base64.b64decode(pr)[:300], e)
        else:
            print("no payment-response header; headers:", {k: v[:80] for k, v in r.headers.items() if k.lower().startswith(("payment", "x-tape", "extension"))})
        ext = r.headers.get("extension-responses")
        if ext:
            print("extension-responses:", base64.b64decode(ext)[:300])
        body = r.text
        print("body head:", body[:300])

asyncio.run(main())
