#!/usr/bin/env node
import { main } from "../src/server.mjs";

main().catch((error) => {
  process.stderr.write(`loopholetape-mcp could not start: ${String(error?.message || error).slice(0, 300)}\n`);
  process.exit(1);
});
