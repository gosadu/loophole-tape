"""Offline buyer policy/retry tests. No keypair, RPC or payment is used."""
import base64
import copy
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

from risk_client import BASE, NETWORK, PAY_TO, USDC, Buyer, Journal, micro, select_offer

MINTS = ["1" * 32, "2" * 32]


def offer(resource):
    return {"x402Version": 2, "resource": {"url": resource}, "accepts": [{"scheme": "exact", "network": NETWORK,
             "asset": USDC, "payTo": PAY_TO, "amount": "10000", "maxTimeoutSeconds": 60, "extra": {}}]}


class BuyerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = self.enterContext(tempfile.TemporaryDirectory())
        self.path = Path(self.temp) / "buyer-state.json"

    def journal(self, transport="http"):
        journal = Journal(self.path, MINTS, transport)
        self.addCleanup(journal.close)
        return journal

    def test_guards_reject_wrong_terms_resource_and_overspend(self):
        url = BASE + "/v1/check/watchlist"
        valid = offer(url)
        self.assertEqual(select_offer(valid, url, 10000, 10000)["amount"], "10000")
        for key, value in (("payTo", "somebody-else"), ("network", "eip155:8453"), ("asset", "SOL"),
                           ("scheme", "upto"), ("amount", "10001"), ("amount", "-1"), ("amount", "nan")):
            bad = copy.deepcopy(valid)
            bad["accepts"][0][key] = value
            with self.assertRaises(ValueError):
                select_offer(bad, url, 10000, 10000)
        with self.assertRaises(ValueError):
            select_offer(valid, url + "/other", 10000, 10000)
        with self.assertRaises(ValueError):
            select_offer(valid, url, 10000, 9999)
        self.assertEqual(micro("0.005"), 5000)
        for value in ("NaN", "Infinity", "-1", "0.0000001"):
            with self.assertRaises(ValueError):
                micro(value)

    async def test_unavailable_and_unchanged_never_load_signer(self):
        journal = self.journal()
        sign = AsyncMock(side_effect=AssertionError("must not sign"))
        for body, status in (({"ok": False, "charged": False, "error": "feed_stale"}, 503),
                             ({"ok": True, "data": {"charged": False, "status": "no_new_events"}}, 200)):
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(status, json=body))) as http:
                self.assertEqual(await Buyer(http, journal, sign).check(), body)
        sign.assert_not_called()
        self.assertEqual(journal.data["authorized_micro"], 0)

    async def test_lost_response_retries_identical_proof_once(self):
        journal = self.journal()
        signed = []
        async def handler(request):
            if "payment-signature" not in request.headers:
                return httpx.Response(402, json=offer(str(request.url)))
            signed.append(request.headers["payment-signature"])
            if len(signed) == 1:
                raise httpx.ReadError("offline response lost")
            return httpx.Response(200, headers={"payment-response": "offline-receipt"},
                                  json={"ok": True, "data": {"result_id": "original", "cursor": "cursor"}})
        async def sign(required):
            return {"x402Version": 2, "accepted": required["accepts"][0], "payload": {"transaction": "offline-proof"}}
        signer = AsyncMock(side_effect=sign)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            with patch("risk_client.asyncio.sleep", new=AsyncMock()):
                body = await Buyer(http, journal, signer).check()
        self.assertEqual(body["data"]["result_id"], "original")
        self.assertEqual(signed[0], signed[1])
        signer.assert_awaited_once()
        self.assertEqual(journal.data["authorized_micro"], 10000)
        self.assertIsNone(journal.data["pending"])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    async def test_pending_survives_restart_without_resigning(self):
        first = Journal(self.path, MINTS, "http")
        buyer = Buyer(None, first, None)
        proof = {"payload": {"transaction": "original-proof"}}
        first.data.update(authorized_micro=10000, pending={"operation": buyer.operation("check"), "proof": proof, "created": time.time()})
        first.save()
        first.close()
        journal = self.journal()
        def handler(request):
            self.assertEqual(json.loads(base64.b64decode(request.headers["payment-signature"])), proof)
            return httpx.Response(200, headers={"payment-response": "offline-receipt"}, json={"ok": True, "data": {"cursor": "new"}})
        sign = AsyncMock(side_effect=AssertionError("must not sign"))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            await Buyer(http, journal, sign, budget=10000).check()
        sign.assert_not_called()
        self.assertEqual(journal.data["authorized_micro"], 10000)

    async def test_unknown_or_expired_attempt_stops_with_state_intact(self):
        journal = self.journal()
        buyer = Buyer(None, journal, AsyncMock())
        journal.data["pending"] = {"operation": buyer.operation("check"), "proof": {}, "created": time.time()}
        buyer.send = AsyncMock(return_value=(409, {"ok": False, "charged": None, "error": "payment_outcome_unknown"}, None))
        with self.assertRaises(RuntimeError):
            await buyer.check()
        self.assertIsNotNone(journal.data["pending"])
        journal.data["pending"]["created"] -= 601
        buyer.send.reset_mock()
        with self.assertRaises(RuntimeError):
            await buyer.check()
        buyer.send.assert_not_called()
        buyer.sign.assert_not_called()

    async def test_mcp_payment_and_budget_cap(self):
        journal = self.journal("mcp")
        async def handler(request):
            req = json.loads(request.content)
            payment = req["params"].get("_meta", {}).get("x402/payment")
            body = {"ok": True, "data": {"cursor": "cursor"}} if payment else offer(BASE + "/mcp#check_watchlist_risk")
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {
                "structuredContent": body, "isError": not bool(payment), "_meta": {"x402/payment-response": {"success": True}} if payment else {}}})
        signer = AsyncMock(return_value={"payload": {"transaction": "offline"}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            buyer = Buyer(http, journal, signer, budget=10000)
            self.assertTrue((await buyer.check())["ok"])
            with self.assertRaises(ValueError):
                await buyer.check()
        signer.assert_awaited_once()

    def test_journal_prevents_concurrent_spending(self):
        self.journal()
        with self.assertRaises(BlockingIOError):
            Journal(self.path, MINTS, "http")


if __name__ == "__main__":
    unittest.main()
