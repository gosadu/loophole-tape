"""Budgeted HTTP/MCP buyer. See README before using a funded wallet.

The private state file preserves the exact signed payment across a timeout or
restart. Never commit it. Budget counts authorizations conservatively, including
unsettled attempts; it is not a statement of on-chain spend.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import fcntl
import json
import os
import re
import tempfile
import time
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlencode, urlsplit

import httpx

BASE = "https://api.loopholetape.com"
PAY_TO = "9HkwyUhDMyjbpSpnyu5xuZ9vRaFQeajnJsavhie7XcsT"
NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"


def micro(value: str) -> int:
    amount = Decimal(value) * 1_000_000
    if not amount.is_finite() or amount < 0 or amount != amount.to_integral_value():
        raise ValueError("Use a nonnegative USD amount with at most six decimals.")
    return int(amount)


def select_offer(required: dict, resource: str, cap: int, remaining: int) -> dict:
    if required.get("x402Version") != 2 or required.get("resource", {}).get("url") != resource:
        raise ValueError("Refusing an unexpected payment version or resource.")
    for offer in required.get("accepts", []):
        amount = offer.get("amount", "")
        if (offer.get("scheme") == "exact" and offer.get("payTo") == PAY_TO and offer.get("network") == NETWORK
                and offer.get("asset") == USDC and isinstance(amount, str) and re.fullmatch(r"[0-9]+", amount)
                and 0 < int(amount) <= min(cap, remaining)):
            return offer
    raise ValueError("Payment refused: wrong recipient/network/asset, or per-call/run budget exceeded.")


class Journal:
    """One active process per state file; flock releases automatically on exit."""
    def __init__(self, path: Path, mints: list[str], transport: str):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.data = json.loads(path.read_text()) if path.exists() else {
                "mints": mints, "transport": transport, "authorized_micro": 0, "pending": None, "cursor": None}
            if self.data["mints"] != mints or self.data["transport"] != transport:
                raise ValueError("State belongs to another mint set/transport. Use a separate --state file.")
        except Exception:
            os.close(self.lock)
            raise

    def save(self):
        fd, temp = tempfile.mkstemp(dir=self.path.parent, prefix=".buyer-state-")
        try:
            with os.fdopen(fd, "w") as out:
                json.dump(self.data, out, separators=(",", ":"))
                out.flush()
                os.fsync(out.fileno())
            os.replace(temp, self.path)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)

    def close(self):
        os.close(self.lock)


class Buyer:
    def __init__(self, http, journal, sign, budget=50_000, cap=10_000):
        self.http, self.journal, self.sign = http, journal, sign
        self.budget, self.cap = budget, cap
        self.mints = journal.data["mints"]
        self.mcp = journal.data["transport"] == "mcp"

    def operation(self, kind: str, cursor=None):
        single = len(self.mints) == 1
        args = {"mint": self.mints[0]} if kind == "check" and single else {"mints": self.mints}
        if cursor is not None:
            args["cursor"] = cursor
        tool = {"coverage": "check_coverage", "watch": "watchlist_updates",
                "check": "check_pumpfun_risk" if single else "check_watchlist_risk"}[kind]
        if self.mcp:
            return {"url": BASE + "/mcp", "resource": BASE + "/mcp#" + tool,
                    "body": {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}}}
        path = "/v1/check/mint/" + self.mints[0] if kind == "check" and single else "/v1/check/" + ("watchlist" if kind == "check" else kind)
        query = {k: ",".join(v) if isinstance(v, list) else v for k, v in args.items() if k != "mint"}
        url = BASE + path + ("?" + urlencode(query) if query else "")
        return {"url": url, "resource": url, "body": None}

    async def send(self, operation, proof=None):
        # No redirects, even when loading a persisted request.
        if urlsplit(operation["url"]).netloc != "api.loopholetape.com" or not operation["url"].startswith(BASE + "/v1/check/") and operation["url"] != BASE + "/mcp":
            raise ValueError("Refusing an unexpected API origin/path.")
        headers = {"Accept": "application/json, text/event-stream"}
        body = operation["body"]
        if body is not None:
            body = json.loads(json.dumps(body))
            if proof is not None:
                body["params"]["_meta"] = {"x402/payment": proof}
        elif proof is not None:
            headers["PAYMENT-SIGNATURE"] = base64.b64encode(json.dumps(proof, separators=(",", ":")).encode()).decode()
        response = await self.http.request("POST" if body is not None else "GET", operation["url"],
                                           json=body, headers=headers, follow_redirects=False)
        payload = response.json()
        receipt = response.headers.get("payment-response")
        if body is not None and "result" in payload:
            result = payload["result"]
            receipt = (result.get("_meta") or {}).get("x402/payment-response")
            payload = result.get("structuredContent") or json.loads(result["content"][0]["text"])
        return response.status_code, payload, receipt

    async def recover(self):
        pending = self.journal.data["pending"]
        if time.time() - pending["created"] >= 600:
            raise RuntimeError("Pending payment is beyond the replay window. Reconcile it before authorizing another; state retained.")
        # Replays never call the signer or reserve another part of the budget.
        for attempt in range(3):
            try:
                status, body, receipt = await self.send(pending["operation"], pending["proof"])
            except (httpx.TransportError, ValueError):
                if attempt == 2:
                    raise RuntimeError("Response unavailable. Re-run with this state file to retry the original payment.") from None
                await asyncio.sleep(attempt + 1)
                continue
            if status < 300 and body.get("ok") is True and (receipt or body.get("data", {}).get("charged") is False):
                self.journal.data.update(pending=None, cursor=body.get("data", {}).get("cursor"))
                self.journal.save()
                return body
            if body.get("charged") is False:
                self.journal.data["pending"] = None
                self.journal.save()
                return body
            raise RuntimeError("Payment outcome needs reconciliation; exact request retained. No new payment was authorized.")

    async def check(self):
        if self.journal.data["pending"]:
            return await self.recover()
        operation = self.operation("check", self.journal.data["cursor"])
        status, body, _ = await self.send(operation)
        if body.get("x402Version") != 2:
            return body  # Unavailable or unchanged: do not load a wallet.
        offer = select_offer(body, operation["resource"], min(self.cap, 5_000 if len(self.mints) == 1 else 10_000),
                             self.budget - self.journal.data["authorized_micro"])
        required = {**body, "accepts": [offer]}
        proof = await self.sign(required)
        self.journal.data["authorized_micro"] += int(offer["amount"])
        self.journal.data["pending"] = {"operation": operation, "proof": proof, "created": time.time()}
        self.journal.save()  # Persist before any signed request leaves this process.
        return await self.recover()


async def sign_payment(required):
    # Lazy imports/key access keep coverage and unavailable checks wallet-free.
    from x402 import x402Client
    from x402.extensions.payment_identifier import append_payment_identifier_to_extensions
    from x402.mechanisms.svm import KeypairSigner
    from x402.mechanisms.svm.exact import register_exact_svm_client
    from x402.schemas import PaymentRequired

    key_path = os.environ.get("TAPE_PAYER_KEYPAIR")
    if not key_path:
        raise ValueError("Set TAPE_PAYER_KEYPAIR to your funded Solana keypair JSON to authorize payment.")
    signer = KeypairSigner.from_bytes(bytes(json.loads(Path(key_path).expanduser().read_text())))
    client = register_exact_svm_client(x402Client(), signer, networks=NETWORK)
    append_payment_identifier_to_extensions(required.setdefault("extensions", {}))
    proof = await client.create_payment_payload(PaymentRequired.model_validate(required))
    return proof.model_dump(by_alias=True, exclude_none=True)


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mints", help="One to five distinct caller-selected mints, comma-separated")
    parser.add_argument("--transport", choices=["http", "mcp"], default="http")
    parser.add_argument("--coverage", action="store_true", help="Free availability only; no wallet needed")
    parser.add_argument("--budget", default="0.05", help="Cumulative authorization cap for this state file, USD")
    parser.add_argument("--max-per-call", default="0.01")
    parser.add_argument("--polls", type=int, default=0, help="After a check, poll free availability this many times at 15 s intervals")
    parser.add_argument("--state", type=Path, default=Path("buyer-state.json"))
    args = parser.parse_args()
    mints = sorted(args.mints.split(","))
    if not 1 <= len(mints) <= 5 or len(set(mints)) != len(mints) or any(not re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{32,44}", m) for m in mints):
        parser.error("Provide one to five distinct base58 mint addresses.")
    journal = Journal(args.state, mints, args.transport)
    try:
        async with httpx.AsyncClient(timeout=60) as http:
            buyer = Buyer(http, journal, sign_payment, micro(args.budget), micro(args.max_per_call))
            if args.coverage:
                print(json.dumps((await buyer.send(buyer.operation("coverage")))[1], indent=2))
                return
            print(json.dumps(await buyer.check(), indent=2))
            for _ in range(max(0, args.polls)):
                if not journal.data["cursor"]:
                    break
                await asyncio.sleep(15)
                _, availability, _ = await buyer.send(buyer.operation("watch", journal.data["cursor"]))
                if availability.get("data", {}).get("has_new_events"):
                    print(json.dumps(await buyer.check(), indent=2))
    finally:
        journal.close()


if __name__ == "__main__":
    asyncio.run(main())
