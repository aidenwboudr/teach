// The lesson board end to end: a real server.mjs on a throwaway port and a fake `claude` that makes the tool calls a
// tutor would (board notes, a question set, a new plan step), driven by keywords in each message. Checks what the
// board holds after each, the learner's own board actions, and that the `board` tool (mcp.mjs) reads it back.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teach-board-test-"));
const DATA = path.join(tmp, "learning"), STATE = path.join(tmp, "state"), PROJECTS = path.join(tmp, "projects"), WORK = path.join(tmp, "school");
for (const d of [path.join(DATA, "topics"), STATE, PROJECTS, WORK]) fs.mkdirSync(d, { recursive: true });
Object.assign(process.env, { TEACH_DATA: DATA, TEACH_STATE: STATE, TEACH_PROJECTS: PROJECTS, TEACH_WORK: WORK });
const store = await import("../lib/store.mjs");
const ops = await import("../lib/ops.mjs");

// A tutor that answers each message in one turn. NOTE puts a note on the board; TEMP another one; ASK asks a question
// set; STEP2 starts plan step 2 (and puts that step's note up in the same turn); PIN puts a pinned note; SCENE puts a
// scene up; MORPH changes the scene that's up, replacing the call before.
const CLAUDE = path.join(tmp, "claude"), HEARD = path.join(tmp, "heard.log"), HOSTLOG = path.join(tmp, "scenehost.log");

// A scene host that only logs what it's asked to do (the server talks to chalk's scenehost.py the same way).
const HOST = path.join(tmp, "scenehost.cjs");
fs.writeFileSync(HOST, `require("readline").createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l); require("fs").appendFileSync(${JSON.stringify(HOSTLOG)}, m.op + " " + m.id + "\\n"); });\n`);
fs.writeFileSync(CLAUDE, `#!${process.execPath}
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let n = 0;
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type !== "user") return;
  const text = m.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\\n");
  require("fs").appendFileSync(${JSON.stringify(HEARD)}, JSON.stringify(text) + "\\n");
  if (!n) out({ type: "system", subtype: "init", session_id: "22222222-2222-4222-8222-222222222222" });
  const id = "msg" + ++n, content = [{ type: "text", text: "Reply " + n + "." }];
  const tool = (name, input) => content.push({ type: "tool_use", id: "toolu_" + name + n, name: "mcp__teach__" + name, input });
  if (text.includes("NOTE")) tool("board", { put: [{ id: "idea", title: "The idea", body: "A pull-down holds the pin **low**." }] });
  const spec = (title) => ({ title, size: [400, 300], objects: [{ type: "text", text: title, at: [10, 10] }] });
  if (text.includes("SCENE")) { tool("scene", { scene: spec("RC") }); global.scene = content.at(-1).id; }
  if (text.includes("MORPH")) { tool("scene", { scene: spec("RC " + n), replaces: global.scene }); global.scene = content.at(-1).id; }
  if (text.includes("TEMP")) tool("board", { put: [{ id: "temp", body: "for now" }] });
  if (text.includes("PIN")) tool("board", { put: [{ id: "pinmap", body: "D9 BCLK", pin: true }] });
  if (text.includes("ASK")) tool("ask", { purpose: "check", node: "1", questions: [{ prompt: "Unpressed, the pin reads?", options: ["low", "high"], answer: 0, why: "The pull-down." }] });
  if (text.includes("STEP2")) { tool("step", { id: "2", status: "current" }); tool("board", { put: [{ id: "step2", body: "Step two's idea" }] }); }
  out({ type: "assistant", message: { id, content } });
  out({ type: "result", result: "done", is_error: false });
});
`, { mode: 0o755 });

const PORT = 7700 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, [path.join(APP, "server.mjs")], {
  env: { ...process.env, TEACH_T3_DB: path.join(tmp, "no-t3.sqlite"), TEACH_SYNC: "off", TEACH_CAPTURE_CMD: "", TEACH_OPEN_CMD: "", TEACH_LEARNER: "", TEACH_PORT: String(PORT),
    TEACH_SOCKET: "", TEACH_CHALK: "/bin/true", TEACH_CLAUDE: CLAUDE, TEACH_CHALK_MCP: "/bin/true", TEACH_SCENEHOST: HOST, TEACH_SCENE_PYTHON: process.execPath },
  stdio: ["ignore", "ignore", "inherit"] });
after(async () => { server.kill("SIGTERM"); await new Promise((r) => server.once("exit", r)); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, body) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`, body ? { method: "POST", headers: { "X-Teach": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
      return await r.json();
    } catch { await sleep(100); }
  }
  throw new Error("server didn't come up");
}
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(80); }
  return fn();
}
const heard = () => fs.readFileSync(HEARD, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const SLUG = "pull-downs";
const board = async () => (await api(`/api/topics/${SLUG}/board`)).board;
const ids = (b) => b.blocks.map((x) => x.id);
const say = async (text) => { const before = (await board()).turn; await api(`/api/topics/${SLUG}/message`, { text }); return until(async () => { const b = await board(); return b.turn > before && b.reply.parts.length && !(await api(`/api/topics/${SLUG}`)).status.busy && b; }); };

store.createTopic({ slug: SLUG, title: "Pull-downs" });
ops.plan(SLUG, { nodes: [{ id: "1", title: "What a pull-down does", status: "current" }, { id: "2", title: "Wiring a button" }] });

test("the tutor's notes and question sets go on the board; the reply card holds only this turn's reply", async () => {
  let b = await say("hi NOTE ASK");
  assert.deepEqual(b.blocks.map((x) => x.kind), ["note", "ask"]);
  assert.equal(b.blocks[0].title, "The idea");
  assert.equal(b.reply.user.text, "hi NOTE ASK");
  assert.deepEqual(b.reply.parts.map((p) => p.text), ["Reply 1."]);
  b = await say("and again NOTE");
  assert.deepEqual(ids(b).filter((x) => x === "idea"), ["idea"], "the same note id replaces, it doesn't pile up");
  assert.deepEqual(b.reply.parts.map((p) => p.text), ["Reply 2."]);
});

test("an answered card stays for the tutor's reaction, then leaves on the learner's next move", async () => {
  const ask = (await board()).blocks.find((x) => x.kind === "ask");
  const r = await api(`/api/topics/${SLUG}/answer`, { id: ask.id, answers: [{ choice: ask.ask.questions[0].answer }] });
  assert.deepEqual(r.results, [{ ok: true, text: "\"low\" (correct)" }]);
  let b = await until(async () => { const x = await board(); return x.reply.parts.length && x; });
  assert.equal(b.blocks.find((x) => x.id === ask.id)?.status, "answered");
  assert.equal(b.reply.user, null, "answers aren't shown as something they said");
  b = await say("ok, next");
  assert.equal(b.blocks.some((x) => x.id === ask.id), false);
});

test("the learner closes, pins and keeps; the tutor hears about it on the next turn", async () => {
  let r = await api(`/api/topics/${SLUG}/board`, { op: "pin", target: "idea" });
  assert.equal(r.ok, true);
  r = await api(`/api/topics/${SLUG}/board`, { op: "keep" });
  const kept = r.id;
  let b = await board();
  assert.deepEqual(b.blocks.find((x) => x.id === kept), { ...b.blocks.find((x) => x.id === kept), kind: "note", pin: true, kept: true, body: "Reply 4." });
  r = await api(`/api/topics/${SLUG}/board`, { op: "dismiss", target: "nope" });
  assert.match(r.error, /isn't on the board/);
  b = await say("PIN");
  assert.deepEqual(ids(b), ["idea", kept, "pinmap"]);
  const told = heard().at(-1);
  assert.match(told, /\[Teach app\] board\n.*pinned "The idea" \(`idea`\) on the board\./);
  assert.match(told, /kept your last reply on the board as a pinned note/);
  assert.match(told, /PIN$/, "their own words come after the app's notes");
  // the learner's actions were kept with the topic, so a rebuilt board has them too
  assert.equal(store.getRuntime(SLUG).boardOps.length, 2);
});

test("a new plan step turns the page: earlier blocks leave unless pinned; the new step's note stays", async () => {
  let b = await say("TEMP");                          // an unpinned note from an earlier turn
  const kept = b.blocks.find((x) => x.kept).id;
  assert.deepEqual(ids(b), ["idea", kept, "pinmap", "temp"]);
  b = await say("STEP2");
  assert.equal(b.step, "2");
  assert.deepEqual(ids(b), ["idea", kept, "pinmap", "step2"], "temp leaves; the pinned ones and step 2's own note stay");
});

test("a scene changed twice (each change replacing the one before) morphs the scene that's up, both times", async () => {
  const b0 = await say("SCENE");
  const root = b0.blocks.find((x) => x.kind === "scene").id;
  await say("MORPH");
  const b = await say("MORPH");
  const scenes = b.blocks.filter((x) => x.kind === "scene");
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].id, root);
  assert.match(scenes[0].scene.title, /^RC \d+$/);
  const ops = () => (fs.existsSync(HOSTLOG) ? fs.readFileSync(HOSTLOG, "utf8").trim().split("\n") : []).filter((l) => !l.startsWith("refresh"));
  await until(() => ops().length >= 3);
  await sleep(300);
  assert.deepEqual(ops(), [`open ${root}`, `replace ${root}`, `replace ${root}`], "no second scene opened behind the first");
});

test("the board tool reads the board back and refuses to overwrite a question set with a note", async () => {
  const mcp = spawn(process.execPath, [path.join(APP, "mcp.mjs")], { env: { ...process.env, TEACH_TOPIC: SLUG, TEACH_SERVER: `http://127.0.0.1:${PORT}` }, stdio: ["pipe", "pipe", "inherit"] });
  const replies = [];
  let buf = "";
  mcp.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const call = async (id, name, args) => {
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    return until(() => replies.find((r) => r.id === id), 4000);
  };
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  const list = await until(() => replies.find((r) => r.id === 1), 4000);
  assert.ok(list.result.tools.some((t) => t.name === "board"));
  const r = await call(2, "board", { put: [{ id: "extra", body: "One more thing" }] });
  const text = r.result.content[0].text;
  assert.match(text, /^Done\.\nOn the board now \(oldest first\):/);
  assert.match(text, /note `pinmap`: D9 BCLK · pinned/);
  assert.match(text, /note `extra`: One more thing/);
  const bad = await call(3, "board", { put: [{ id: "has space", body: "x" }] });
  assert.equal(bad.result.isError, true);
  mcp.kill();
});
