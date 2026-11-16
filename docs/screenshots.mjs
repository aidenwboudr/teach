// Screenshots and the demo GIF for the README, from the demo data only: a throwaway copy of examples/demo, a made-up
// lesson transcript, a real server.mjs on a spare port, a scripted stand-in for the tutor (no model runs) and headless
// Chromium through Playwright. The GIF needs ffmpeg.
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs [CHROMIUM=/path/to/chrome] node docs/screenshots.mjs [--gif-only]
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
// The stand-in tutor: it answers the learner's answers to the natural-frequencies check the way a tutor would, with
// streamed text, a note on the board and the plan moving on.
const fakeClaude = path.join(tmp, "claude.cjs");
fs.writeFileSync(fakeClaude, `
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
require("readline").createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.type !== "user") return;
  // like Claude Code, it keeps the session's transcript (the app rebuilds the lesson from it)
  const log = (o) => require("fs").appendFileSync(${JSON.stringify(path.join(projectDir(WORK), `${id}.jsonl`))}, JSON.stringify({ uuid: "f" + Date.now() + Math.random(), timestamp: new Date().toISOString(), ...o }) + "\\n");
  log({ type: "user", message: m.message });
  if (!n++) out({ type: "system", subtype: "init", session_id: ${JSON.stringify(id)} });
  await wait(900);
  const id = "r" + n, text = "Right: about **89** false positives against **9** true ones. So out of everyone who tests positive, only 9 in 98 actually have it. That's the whole of Bayes' theorem, and the next step writes it as a formula.";
  out({ type: "stream_event", event: { type: "message_start", message: { id } } });
  out({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
  for (const w of text.match(/\\S+\\s*/g)) { out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: w } } }); await wait(45); }
  const op = (args) => fetch("http://127.0.0.1:${PORT}/api/topics/bayes-theorem/op", { method: "POST", headers: { "X-Teach": "1", "Content-Type": "application/json" }, body: JSON.stringify({ op: "step", args }) });
  let k = 0;
  const tool = (name, input) => ({ type: "tool_use", id: "toolu_demo_" + name + n + "_" + k++, name: "mcp__teach__" + name, input });
  const content = [{ type: "text", text },
    tool("step", { id: "4", status: "done", result: "1/1" }), tool("step", { id: "5", status: "current" }),
    tool("board", { put: [{ id: "positive", title: "What a positive test means", body: "| | test positive | total |\\n|---|---|---|\\n| has it | 9 | 10 |\\n| doesn't | 89 | 990 |\\n| **total** | **98** | 1,000 |\\n\\n$$P(\\\\text{has it} \\\\mid +) = \\\\frac{9}{9 + 89} \\\\approx 9\\\\%$$" }] })];
  log({ type: "assistant", message: { id, content } });
  out({ type: "assistant", message: { id, content } });
  await op({ id: "4", status: "done", result: "1/1" }); await op({ id: "5", status: "current" });   // (what the teach MCP server does for these calls)
  out({ type: "result", result: "done", is_error: false });
});
`);
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
  const GIF_ONLY = process.argv.includes("--gif-only");
  for (const [name, url, wait] of GIF_ONLY ? [] : [["home", "/", ".section"], ["lesson", "/t/bayes-theorem", ".q"], ["review", "/review", "main"]]) {
    await page.goto(base + url);
    await page.waitForSelector(wait, { timeout: 15e3 }).catch(() => console.error(`(${name}: ${wait} never showed)`));
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    console.log(`docs/${name}.png`);
  }
  await page.close();
  await gif(browser);
} finally {
  await browser?.close();
  server.kill();
  if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true }); else console.log(tmp);
}

// The demo GIF: home, into the lesson, answer the check, the tutor's reply and the board moving on, then review.
async function gif(browser) {
  const { execFileSync } = await import("node:child_process");
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { console.error("(no ffmpeg: no demo.gif)"); return; }
  const size = { width: 1200, height: 750 };
  const ctx = await browser.newContext({ viewport: size });
  const page = await ctx.newPage();
  const pause = (ms) => page.waitForTimeout(ms);
  // Frames from Chrome's screencast (Playwright's own video recorder needs its own ffmpeg build), each shown until the next.
  const frames = path.join(tmp, "frames");
  fs.mkdirSync(frames);
  const shots = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const f = path.join(frames, `${String(shots.length).padStart(5, "0")}.png`);
    fs.writeFileSync(f, Buffer.from(data, "base64"));
    shots.push({ f, t: metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 });
  await page.goto(base + "/");
  await page.waitForSelector(".section");
  await pause(1800);
  await page.click(`.topic-title a[href="/t/bayes-theorem"]`);
  await page.waitForSelector(".q");
  await pause(2200);
  await page.getByText("About 89", { exact: true }).click();
  await pause(900);
  await page.keyboard.press("Enter");
  await pause(2400);
  await page.waitForFunction(() => document.body.innerText.includes("What a positive test means"), null, { timeout: 15e3 }).catch(() => console.error("(the reply never showed)"));
  await pause(3500);
  if (process.env.KEEP) { await page.screenshot({ path: path.join(tmp, "lesson-after.png") }); fs.writeFileSync(path.join(tmp, "board.json"), JSON.stringify(await (await fetch(base + "/api/topics/bayes-theorem/board")).json(), null, 1)); }
  await page.goto(base + "/review");
  await page.waitForSelector("main");
  await pause(1500);
  await page.keyboard.press("Space");
  await pause(2500);
  await page.screenshot({ path: path.join(tmp, "last.png") });
  await cdp.send("Page.stopScreencast");
  const end = Date.now() / 1000;
  await ctx.close();
  const list = shots.map((x, i) => `file '${x.f}'\nduration ${((shots[i + 1]?.t ?? end) - x.t).toFixed(3)}`).join("\n") + `\nfile '${shots.at(-1).f}'\n`;
  fs.writeFileSync(path.join(tmp, "frames.txt"), list);
  const out = path.join(APP, "docs", "demo.gif");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(tmp, "frames.txt"), "-vf",
    "fps=12,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", out]);
  console.log(`docs/demo.gif (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
}
