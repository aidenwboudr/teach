// A tutor on Codex, end to end through the real server: a fake `codex` that prints Codex's own JSONL (thread.started,
// item.started/completed with mcp_tool_call items, agent_message, turn.completed) for each `codex exec [resume]`, the
// way codex-cli 0.169 does. Checks that the board and question cards come up, answers resume the same Codex session,
// the session is recorded with its provider and Teach's transcript, and a restarted server rebuilds the lesson from
// that transcript.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teach-codex-server-test-"));
const DATA = path.join(tmp, "learning"), STATE = path.join(tmp, "state"), WORK = path.join(tmp, "school");
for (const d of [path.join(DATA, "topics"), STATE, WORK]) fs.mkdirSync(d, { recursive: true });
Object.assign(process.env, { TEACH_DATA: DATA, TEACH_STATE: STATE, TEACH_WORK: WORK, TEACH_PROJECTS: path.join(tmp, "projects") });
const store = await import("../lib/store.mjs");

const CODEX = path.join(tmp, "codex.cjs"), CALLS = path.join(tmp, "calls.log");
fs.writeFileSync(CODEX, `
const fs = require("fs");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  const argv = process.argv.slice(2);
  fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ argv, input, anthropic: Object.keys(process.env).filter((k) => k.startsWith("ANTHROPIC_")) }) + "\\n");
  const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
  const id = argv.includes("resume") ? argv[argv.indexOf("resume") + 1] : "01a1e6ab-bd3b-7360-bb42-86a18ca1f723";
  out({ type: "thread.started", thread_id: id });
  out({ type: "turn.started" });
  let n = 0;
  const mcp = (tool, args) => {
    const item = { id: "item_" + n++, type: "mcp_tool_call", server: "teach", tool, arguments: args, result: null, error: null, status: "in_progress" };
    out({ type: "item.started", item });
    out({ type: "item.completed", item: { ...item, result: { content: [{ type: "text", text: "ok" }] }, status: "completed" } });
  };
  const msg = input.split("[Teach app] the session starts here").pop();
  if (msg.includes("[Teach app] start")) {
    mcp("update", { title: "Pull-downs", goal: "Why an input pin needs one" });
    mcp("board", { put: [{ id: "idea", title: "The idea", body: "A floating pin reads noise." }] });
    mcp("ask", { purpose: "probe", questions: [{ prompt: "Unconnected, the pin reads?", options: ["noise", "0"], answer: 0, why: "It floats." }] });
    out({ type: "item.completed", item: { id: "item_" + n++, type: "agent_message", text: "First, a quick check." } });
  } else {
    out({ type: "item.completed", item: { id: "item_" + n++, type: "agent_message", text: "Right: it floats. On to the resistor." } });
  }
  out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
});
`);

let PORT = 7600 + Math.floor(Math.random() * 90), server;
function start() {
  server = spawn(process.execPath, [path.join(APP, "server.mjs")], {
    env: { ...process.env, TEACH_PROVIDER: "codex", TEACH_CODEX: CODEX, TEACH_T3_DB: path.join(tmp, "no.sqlite"), TEACH_SYNC: "off", TEACH_LEARNER: "", TEACH_PORT: String(PORT),
      TEACH_SOCKET: "", TEACH_CHALK: "/nonexistent", TEACH_CHALK_MCP: "/nonexistent", ANTHROPIC_BASE_URL: "http://proxy.invalid" },
    stdio: ["ignore", "ignore", "inherit"] });
}
const stop = async () => { if (server.exitCode !== null) return; server.kill("SIGTERM"); await new Promise((r) => server.once("exit", r)); };
start();
after(async () => { await stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, body) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`, body ? { method: "POST", headers: { "X-Teach": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
      return await r.json();
    } catch { await sleep(100); }
  }
  throw new Error("server didn't come up");
}
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(80); }
  return fn();
}
const calls = () => fs.readFileSync(CALLS, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("a Codex tutor: the board, a question card, answers that resume the session, and a lesson rebuilt from Teach's transcript", async () => {
  const { slug } = await api("/api/topics", { text: "teach me pull-down resistors" });
  const board = await until(async () => { const b = (await api(`/api/topics/${slug}/board`)).board; return b.blocks.some((x) => x.kind === "ask") && b; });
  assert.deepEqual(board.blocks.map((x) => x.kind), ["note", "ask"]);
  assert.equal(board.blocks[0].title, "The idea");
  const first = calls()[0];
  assert.equal(first.argv[0], "exec");
  assert.ok(!first.argv.includes("resume"));
  assert.ok(first.argv.join(" ").includes("--disable shell_tool"), "restricted by default");
  assert.deepEqual(first.anthropic, [], "Claude Code's variables (a proxy, a key) never reach another vendor's CLI");
  assert.match(first.input, /^\[Teach app\] instructions/, "the app's instructions and the skill come in the first message");
  assert.match(first.input, /# The teach skill\n\n/);
  let t = (await api(`/api/topics/${slug}`));
  assert.ok((await api(`/api/topics/${slug}/history`)).items.some((i) => i.t === "chip" && i.text === "goal set"), "the update call shows as a chip (the fake doesn't run the MCP server, so the topic itself is unchanged)");
  assert.deepEqual(t.tutor, { provider: "codex", label: "Codex (OpenAI)", models: false, effort: true });
  assert.equal(t.features.screen, false);

  const ask = board.blocks.find((x) => x.kind === "ask");
  const r = await api(`/api/topics/${slug}/answer`, { id: ask.id, answers: [{ choice: ask.ask.questions[0].answer }] });
  assert.equal(r.results[0].ok, true);
  await until(async () => calls().length === 2 && !(await api(`/api/topics/${slug}`)).status.busy);
  const second = calls()[1];
  assert.deepEqual(second.argv.slice(second.argv.indexOf("resume"), second.argv.indexOf("resume") + 2), ["resume", "01a1e6ab-bd3b-7360-bb42-86a18ca1f723"]);
  assert.match(second.input, /^\[Answers to question set /, "a later turn is just the message");

  t = (await api(`/api/topics/${slug}`)).topic;
  assert.equal(t.sessions.length, 1);
  assert.equal(t.sessions[0].provider, "codex");
  assert.ok(fs.existsSync(t.sessions[0].transcript));
  const before = (await api(`/api/topics/${slug}/history`)).items;
  assert.deepEqual(before.filter((i) => i.t === "text").map((i) => i.text), ["First, a quick check.", "Right: it floats. On to the resistor."]);
  assert.equal(before.find((i) => i.t === "ask").status, "answered");

  await stop(); PORT++; start();
  const afterRestart = (await api(`/api/topics/${slug}/history`)).items;
  assert.deepEqual(afterRestart.map((i) => i.t), before.map((i) => i.t), "the same lesson, rebuilt from Teach's transcript");
  const b2 = (await api(`/api/topics/${slug}/board`)).board;
  assert.ok(b2.blocks.some((x) => x.id === "idea"));
});
