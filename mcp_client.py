"""MCP paying-client check for the tape API: connects to <base>/mcp over streamable HTTP, lists tools, calls the free
market_regime tool, then buys one paid tool call with x402 over MCP (USDC from TAPE_PAYER_KEYPAIR, default
~/.config/solana/payer.json). Setup: pip install "x402[httpx,svm]==2.22.0" "solana==0.36.7" "mcp<2"
  TAPE_PAYER_KEYPAIR=~/.config/solana/payer.json python mcp_client.py [base_url] [tool] [json-args]
"""
import asyncio, json, os, sys, time
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from x402 import x402Client
from x402.mcp import x402MCPSession
from x402.mechanisms.svm import KeypairSigner
from x402.mechanisms.svm.exact import register_exact_svm_client

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://api.loopholetape.com"
TOOL = sys.argv[2] if len(sys.argv) > 2 else "recent_rugs"
ARGS = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {"limit": 2}


async def main():
    signer = KeypairSigner.from_bytes(bytes(json.load(open(os.path.expanduser(os.environ.get("TAPE_PAYER_KEYPAIR", "~/.config/solana/payer.json"))))))
    x = x402Client()
    register_exact_svm_client(x, signer)
    async with streamablehttp_client(BASE + "/mcp") as (read, write, _):
        async with ClientSession(read, write) as session:
            sess = x402MCPSession(session, x, auto_payment=True)
            await sess.initialize()
            tools = await sess.list_tools()
            print("tools:", [t.name for t in tools.tools])
            t0 = time.time()
            free = await session.call_tool("market_regime", {})
            print(f"free market_regime: isError={free.isError} in {time.time()-t0:.1f}s; text head: {(free.content[0].text if free.content else '')[:120]}")
            t0 = time.time()
            res = await sess.call_tool(TOOL, ARGS)
            print(f"paid {TOOL}: {time.time()-t0:.1f}s")
            for k, v in vars(res).items():
                s = str(v)
                print(f"  {k}: {s[:300]}")

asyncio.run(main())
