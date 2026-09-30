// Builds dist/loopholetape-mcp.mjs: the server and its dependencies in one readable file (not minified), so that
// `npx` and the .mcpb bundle start without installing anything. Run with: npm run build
import { build } from "esbuild";
import { chmodSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "loopholetape-mcp.mjs");
await build({
  entryPoints: [join(root, "bin", "loopholetape-mcp.mjs")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "inline",
  logLevel: "warning",
  // CommonJS dependencies inside an ES module bundle still call require() for Node's own modules
  banner: { js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);' },
});
chmodSync(outfile, 0o755);
console.log("built", outfile, statSync(outfile).size, "bytes");
