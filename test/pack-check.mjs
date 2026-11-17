// CI: the npm package (npm pack --dry-run) has what an install needs and none of the repo's tests, docs or private files.
import { execFileSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const out = execFileSync(npm, ["pack", "--dry-run", "--json"], { encoding: "utf8", shell: process.platform === "win32" });
const j = JSON.parse(out);
const entry = Array.isArray(j) ? j[0] : j.files ? j : Object.values(j)[0];   // (npm 11: an array; newer: keyed by package)
const files = entry.files.map((f) => f.path);
const need = ["cli.mjs", "server.mjs", "mcp.mjs", "screen.md", "lib/engine.mjs", "lib/platform.mjs", "lib/setup.mjs", "lib/files.mjs", "lib/providers/index.mjs", "lib/providers/turns.mjs", "lib/providers/translate.mjs", "lib/providers/relay.mjs", "skill/SKILL.md", "skill/render-svg.mjs",
  "public/index.html", "examples/demo/PROFILE.md", "examples/PROFILE.template.md", "LICENSE", "README.md"];
const missing = need.filter((f) => !files.includes(f));
const extra = files.filter((f) => /^(test|docs|design|private|\.github|\.fork)\/|^skill\/local\.md$/.test(f));
if (missing.length || extra.length) {
  console.error(`missing: ${missing.join(", ") || "none"}\nshould not ship: ${extra.join(", ") || "none"}`);
  process.exit(1);
}
console.log(`pack: ${files.length} files, all needed ones in, nothing private`);
