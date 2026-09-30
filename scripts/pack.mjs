// Packs the two release files from a fresh build: the npm tarball (for `npx <url>`) and the .mcpb bundle
// (one-click install in Claude Desktop; the package the MCP registry entry points at). Prints their sha256.
//   npm run build && node scripts/pack.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));
if (manifest.version !== version) throw new Error(`mcpb/manifest.json is ${manifest.version}, package.json is ${version}`);

const out = join(root, "release");
const stage = join(out, "mcpb");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(stage, "server"), { recursive: true });
cpSync(join(root, "mcpb", "manifest.json"), join(stage, "manifest.json"));
cpSync(join(root, "dist", "loopholetape-mcp.mjs"), join(stage, "server", "index.mjs"));

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
const mcpb = join(out, `loopholetape-mcp-${version}.mcpb`);
run("npx", ["-y", "@anthropic-ai/mcpb", "validate", join(stage, "manifest.json")], root);
run("npx", ["-y", "@anthropic-ai/mcpb", "pack", stage, mcpb], root);
const tgz = join(out, run("npm", ["pack", "--silent", "--pack-destination", out], root).split("\n").pop());

for (const file of [mcpb, tgz]) {
  console.log(createHash("sha256").update(readFileSync(file)).digest("hex"), statSync(file).size, file.slice(root.length + 1));
}
