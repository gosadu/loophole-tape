"""Drop-in pre-buy filter for a self-built pump.fun bot: ask loophole tape before you buy.

Usage inside your bot's buy path (fails OPEN: any error lets the buy through with a warning):

    from pumpfun_bot_prebuy_filter import prebuy_check
    ok, why = prebuy_check(mint)          # ok=False means the verdict was "avoid"
    if not ok:
        log.warning("skipping %s: %s", mint, why)
        return

What it does, in order:
  1. Free coverage check (no key, no payment): is this mint in the live window (last ~2 hours of pump.fun launches)?
  2. If covered, GET /v1/verdict/{mint} ($0.01) with an X-API-Key header. Pay with a prepaid key (GET /v1/keys/trial = $0.10
     of credit, GET /v1/keys/new = $2.00) or, to try it without any wallet, the shared public trial key published at
     https://api.loopholetape.com/llms.txt under "Try it without a wallet" (tiny daily caps; not for production).
  3. Returns (ok, reason): "avoid" -> False; "caution" / "no_flags_observed" -> True with the observed reasons.

The verdict is one word by a fixed public rule (https://api.loopholetape.com/v1/labels) on calibrated odds
(https://api.loopholetape.com/v1/calibration). "no_flags_observed" is not a safety guarantee. Every call is a plain HTTP
request; nothing here signs transactions. This example sends the User-Agent "loopholetape-example-prebuy/1" so its
usage is visible to the project. Requires: requests (pip install requests).
"""
import os
import requests

BASE = os.environ.get("LOOPHOLETAPE_BASE", "https://api.loopholetape.com")
API_KEY = os.environ.get("LOOPHOLETAPE_API_KEY", "")   # lt_... from /v1/keys/trial, /v1/keys/new, or the public trial key
UA = {"User-Agent": "loopholetape-example-prebuy/1"}
TIMEOUT = 4.0   # a slow check must never hold up a bot; fail open


def prebuy_check(mint: str, avoid_only: bool = True) -> tuple[bool, str]:
    """(ok, reason). ok=False only for an 'avoid' verdict (or, with avoid_only=False, also for 'caution')."""
    try:
        cov = requests.get(f"{BASE}/v1/check/coverage", params={"mints": mint}, headers=UA, timeout=TIMEOUT).json()
        item = (cov.get("data") or {}).get("items", [{}])[0]
        if item.get("coverage") != "covered":
            return True, f"not covered ({item.get('coverage')}): no verdict, buy decision unchanged"
        if not API_KEY:
            return True, "no LOOPHOLETAPE_API_KEY set: coverage only"
        r = requests.get(f"{BASE}/v1/verdict/{mint}", headers={**UA, "X-API-Key": API_KEY}, timeout=TIMEOUT)
        if r.status_code == 402:
            return True, "key has no credit (402): buy decision unchanged; top up at /v1/keys/trial or /v1/keys/new"
        if r.status_code == 429:
            return True, "daily cap reached on this key (429): buy decision unchanged"
        r.raise_for_status()
        data = r.json().get("data") or {}
        verdict = data.get("verdict")
        reasons = "; ".join(x.get("code", "") for x in (data.get("reasons") or [])[:3])
        odds = (data.get("probabilities") or {})
        grad = odds.get("true_graduation")
        summary = f"{verdict}; reasons: {reasons or 'none'}; P(true graduation)={grad}"
        if verdict == "avoid" or (verdict == "caution" and not avoid_only):
            return False, summary
        return True, summary
    except Exception as e:   # network, JSON, timeout: never block the bot
        return True, f"check failed open: {type(e).__name__}"


if __name__ == "__main__":
    import sys
    for m in sys.argv[1:] or ["73sfnFgqQzpSRZSimCC4sxpubqghRGYewYLmiUH2pump"]:
        print(m, prebuy_check(m))
