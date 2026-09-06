"""Paying-client check for the tape API (also the integrator reference): buys ONE priced call from the public URL with the
official x402 client, paying USDC from a Solana keypair JSON (path in env TAPE_PAYER_KEYPAIR, default ~/.config/solana/payer.json). Setup: pip install "x402[httpx,svm]==2.22.0" "solana==0.36.7"
  python pay_client.py [base_url] [path]
Costs the route price (1 to 2.5 cents). Prints status, settlement (tx signature) and the body head."""
import asyncio, base64, json, os, sys, time
from x402 import x402Client
from x402.http.clients.httpx import x402HttpxClient
from x402.http.utils import decode_payment_response_header
from x402.mechanisms.svm import KeypairSigner
from x402.mechanisms.svm.exact import register_exact_svm_client

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://api.loopholetape.com"
PATH = sys.argv[2] if len(sys.argv) > 2 else "/v1/launches/recent?limit=2"
secret = bytes(json.load(open(os.path.expanduser(os.environ.get("TAPE_PAYER_KEYPAIR", "~/.config/solana/payer.json")))))
signer = KeypairSigner.from_bytes(secret)
print("payer:", signer.address)

async def main():
    x = x402Client()
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
