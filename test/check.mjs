// `npm run check`: a syntax check of every script, on any platform (the shell loop it replaces needed bash).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dirs = { ".": /\.mjs$/, lib: /\.mjs$/, test: /\.mjs$/, skill: /\.mjs$/, public: /\.js$/ };
let n = 0;
for (const [d, re] of Object.entries(dirs)) {
  for (const f of fs.readdirSync(path.join(APP, d)).filter((x) => re.test(x)).sort()) {
    execFileSync(process.execPath, ["--check", path.join(APP, d, f)], { stdio: "inherit" });
    n++;
  }
}
console.log(`check: ${n} files parse`);
