// Screenshots for the README, from the demo data only: a throwaway copy of examples/demo, a made-up lesson
// transcript, a real server.mjs on a spare port (no tutor runs) and headless Chromium through Playwright.
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs [CHROMIUM=/path/to/chrome] node docs/screenshots.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teach-shots-"));
const DATA = path.join(tmp, "data"), STATE = path.join(tmp, "state"), WORK = path.join(tmp, "work"), PROJECTS = path.join(tmp, "projects");
fs.cpSync(path.join(APP, "examples/demo"), DATA, { recursive: true, filter: (f) => !f.endsWith(".mjs") });
fs.mkdirSync(WORK, { recursive: true });
Object.assign(process.env, { TEACH_DATA: DATA, TEACH_STATE: STATE, TEACH_WORK: WORK, TEACH_PROJECTS: PROJECTS, TEACH_T3_DB: path.join(tmp, "none") });
const store = await import("../lib/store.mjs");
const { projectDir } = await import("../lib/paths.mjs");

// one session of the Bayes lesson, as Claude Code would have written it
const id = "0b6f3c1e-8a52-4d0e-9a7c-5c1f2d3e4a5b", at = (m) => new Date(Date.now() - (40 - m) * 60e3).toISOString();
const L = (o) => JSON.stringify(o);
const ask1 = { purpose: "check", node: "3", title: "Base rates", questions: [
  { prompt: "1 in 100 people have the condition. In a town of 1,000, how many have it?", kind: "number", answer: 10, why: "One percent of 1,000 is 10." },
  { prompt: "Before any test, how likely is it that a random person has it?", options: ["1%", "10%", "90%"], answer: 0, why: "That's the base rate: the share of everyone who has it." }] };
const ask2 = { purpose: "check", node: "4", title: "Natural frequencies", questions: [
  { prompt: "Of the 990 people who don't have it, the test wrongly flags 9%. About how many false positives is that?", options: ["About 9", "About 89", "About 900"], answer: 1, why: "9% of 990 is 89.1: far more than the 9 true positives." }] };
const lines = [
  L({ type: "user", uuid: "u1", timestamp: at(0), message: { content: [{ type: "text", text: "[Teach app] start\nNew topic.\nThe learner wrote:\nBayes' theorem for my stats exam, I always mix up which way the probability goes\n[end]" }] } }),
  L({ type: "assistant", uuid: "a1", timestamp: at(20), message: { id: "m1", content: [{ type: "text", text: "Step 3 done, and base rates are solid now. One check before we move on:" }, { type: "tool_use", id: "toolu_ask1", name: "mcp__teach__ask", input: ask1 }] } }),
  L({ type: "user", uuid: "u2", timestamp: at(21), message: { content: [{ type: "tool_result", tool_use_id: "toolu_ask1", content: "Shown." }] } }),
  L({ type: "user", uuid: "u3", timestamp: at(23), message: { content: [{ type: "text", text: "[Answers to question set toolu_ask1]\n1. → 10 (correct)\n2. → \"1%\" (correct)" }] } }),
  L({ type: "assistant", uuid: "a2", timestamp: at(24), message: { id: "m2", content: [{ type: "tool_use", id: "toolu_s3", name: "mcp__teach__step", input: { id: "3", status: "done", result: "2/2" } }, { type: "tool_use", id: "toolu_s4", name: "mcp__teach__step", input: { id: "4", status: "current" } }] } }),
  L({ type: "assistant", uuid: "a3", timestamp: at(25), message: { id: "m3", content: [
    { type: "text", text: "**Step 4: natural frequencies.** Instead of percentages, follow 1,000 real people through the test: the table is on the board. Before I fill in the second row, commit to a guess on the card." },
    { type: "tool_use", id: "toolu_board1", name: "mcp__teach__board", input: { put: [{ id: "thousand", title: "1,000 people through the test", body:
      "| | test positive | test negative | total |\n|---|---|---|---|\n| has it | 9 | 1 | 10 |\n| doesn't | ? | | 990 |\n| total | | | 1,000 |\n\n" +
      "The test catches 90% of people who have it, so $0.9 \\times 10 = 9$ true positives." }] } },
    { type: "tool_use", id: "toolu_ask2", name: "mcp__teach__ask", input: ask2 }] } }),
  L({ type: "user", uuid: "u4", timestamp: at(26), message: { content: [{ type: "tool_result", tool_use_id: "toolu_ask2", content: "Shown." }] } }),
];
fs.mkdirSync(projectDir(WORK), { recursive: true });
fs.writeFileSync(path.join(projectDir(WORK), `${id}.jsonl`), lines.join("\n") + "\n");
store.mutateTopic("bayes-theorem", (t) => { t.sessions = [{ id, cwd: WORK, via: "app", started: at(0) }]; });
store.mutateRuntime("bayes-theorem", (r) => { r.answers = { toolu_ask1: { answers: [{ number: 10, text: "10" }, { choice: 0 }], results: [{ ok: true }, { ok: true }], at: at(23), via: "app" } }; });

const PORT = 7870 + Math.floor(Math.random() * 20);
const fakeClaude = path.join(tmp, "claude");
fs.writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const server = spawn(process.execPath, [path.join(APP, "server.mjs")], {
  env: { ...process.env, TEACH_PORT: String(PORT), TEACH_CLAUDE: fakeClaude, TEACH_SOCKET: "", TEACH_CHALK: path.join(tmp, "no-chalk") }, stdio: "inherit" });
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i++) { try { await fetch(base + "/api/home"); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }

const out = path.join(APP, "docs");
let browser;
try {
  const pw = await import(process.env.PLAYWRIGHT ? pathToFileURL(process.env.PLAYWRIGHT).href : "playwright");
  browser = await pw.chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1.5 });
  for (const [name, url, wait] of [["home", "/", ".section"], ["lesson", "/t/bayes-theorem", ".q"], ["review", "/review", "main"]]) {
    await page.goto(base + url);
    await page.waitForSelector(wait, { timeout: 15e3 }).catch(() => console.error(`(${name}: ${wait} never showed)`));
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    console.log(`docs/${name}.png`);
  }
} finally {
  await browser?.close();
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
