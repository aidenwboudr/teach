// The tutor taking a step onto the learner's screen by itself (the `screen` tool): the guard that decides whether it
// may (lib/screen.mjs liveDecision), the readiness probe (`chalk ready`), and the whole path through a real server.mjs,
// mcp.mjs and the engine's hook gate, with a fake `chalk` and a fake `claude`. No screen, no model.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const LINUX = { skip: process.platform !== "linux" && "screen mode is Linux-only (the fakes are shell scripts)" };
const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teach-live-test-"));
const DATA = path.join(tmp, "learning"), STATE = path.join(tmp, "state"), PROJECTS = path.join(tmp, "projects"), WORK = path.join(tmp, "school");
for (const d of [path.join(DATA, "topics"), STATE, PROJECTS, WORK]) fs.mkdirSync(d, { recursive: true });

// A fake chalk: logs every command; `ready` answers as $tmp/ready-mode says (ok, locked, asleep, off = ssh can't reach
// the laptop, old = a chalk that doesn't know `ready`); `route` answers like chalk does.
const LOG = path.join(tmp, "chalk.log"), MODE = path.join(tmp, "ready-mode");
const CHALK = path.join(tmp, "chalk");
fs.writeFileSync(CHALK, `#!/bin/sh
echo "$*" >> ${LOG}
case "$1" in
  ready) case "$(cat ${MODE} 2>/dev/null)" in
      locked) echo '{"ready": false, "locked": true, "awake": true}' ;;
      asleep) echo '{"ready": false, "locked": false, "awake": false}' ;;
      off) echo "ssh: connect to host laptop port 22: Connection timed out" >&2; exit 255 ;;
      old) echo "chalk: let an agent draw on your screen (Sway) to explain what's on it."; exit 1 ;;
      *) echo '{"ready": true, "locked": false, "awake": true}' ;;
    esac ;;
  route) if [ "$2" = off ]; then echo null; else echo "{\\"to\\": \\"teach\\", \\"slug\\": \\"$3\\"}"; fi ;;
esac
`, { mode: 0o755 });

Object.assign(process.env, { TEACH_DATA: DATA, TEACH_STATE: STATE, TEACH_PROJECTS: PROJECTS, TEACH_WORK: WORK, TEACH_CHALK: CHALK, TEACH_T3_DB: path.join(tmp, "no-t3.sqlite") });
delete process.env.TEACH_LEARNER;
const store = await import("../lib/store.mjs");
const screen = await import("../lib/screen.mjs");

// ---------- the guard ----------

const T0 = 1_000_000;
const decide = (o) => screen.liveDecision({ to: "screen", now: T0, probe: { ready: true, locked: false, awake: true }, ...o });

test("guard: the screen when chalk is here, it's unlocked and awake, and nobody's typing", () => {
  assert.deepEqual(decide({}), { ok: true, change: "live", reason: "" });
  const first = screen.liveDecision({ to: "screen", now: T0 });   // everything else allows it: ask the screen first
  assert.equal(first.probe, true); assert.equal(first.ok, false);
});

test("guard: no chalk, locked, asleep or unreachable each say no, with why", () => {
  assert.match(decide({ installed: false }).reason, /no chalk/);
  assert.match(decide({ probe: { ready: false, locked: true, awake: true } }).reason, /locked/);
  assert.match(decide({ probe: { ready: false, locked: false, awake: false } }).reason, /asleep/);
  assert.match(decide({ probe: { unreachable: true, error: "Connection timed out" } }).reason, /isn't reachable.*timed out/);
  for (const p of [{ locked: true }, { awake: false }, { unreachable: true }]) assert.equal(decide({ probe: p }).change, null);
  assert.equal(decide({ probe: { ready: null } }).change, "live", "an older chalk that can't tell: the screen only has to answer");
});

test("guard: typing in Teach holds it back for a few seconds, an unsent draft for longer", () => {
  const typing = (ago, draft) => decide({ typing: { at: T0 - ago, draft } });
  assert.match(typing(2e3, false).reason, /typing/);
  assert.equal(typing(screen.TYPING_MS + 1, false).change, "live");
  assert.match(typing(30e3, true).reason, /typing/, "a draft they're still writing");
  assert.equal(typing(screen.DRAFT_MS + 1, true).change, "live", "a draft left alone long ago doesn't count");
});

test("guard: 'stay on the board' is final for the topic; already on the screen is a no-op", () => {
  const r = decide({ settings: { autoScreen: false } });
  assert.equal(r.ok, false); assert.match(r.reason, /stay on the board.*don't ask again/);
  assert.deepEqual([decide({ settings: { screen: true } }).change, decide({ live: { since: "x" } }).change], [null, null]);
  assert.equal(decide({ settings: { screen: true } }).ok, true);
});

test("guard: back to the board ends the tutor's stretch, never the learner's switch", () => {
  assert.equal(screen.liveDecision({ to: "board", live: { by: "tutor" } }).change, "board");
  const theirs = screen.liveDecision({ to: "board", settings: { screen: true }, who: "Sam" });
  assert.equal(theirs.ok, false); assert.match(theirs.reason, /Sam turned "On my screen" on themselves/);
  assert.equal(screen.liveDecision({ to: "board", by: "learner", settings: { screen: true } }).ok, true);
  assert.deepEqual(screen.liveDecision({ to: "board" }), { ok: true, change: null, reason: "The lesson is on the board already." });
  assert.equal(screen.liveDecision({ to: "sideways" }).ok, false);
});

test("isLive: their switch or the tutor's stretch", () => {
  assert.equal(screen.isLive({ settings: { screen: true } }, {}), true);
  assert.equal(screen.isLive({ settings: {} }, { live: { since: "x" } }), true);
  assert.equal(screen.isLive({ settings: {} }, {}), false);
  assert.equal(screen.isLive(null, null), false);
});

// ---------- the probe ----------

test("ready(): what `chalk ready` said, an unreachable laptop, and an older chalk", LINUX, async () => {
  const as = async (mode) => { fs.writeFileSync(MODE, mode); return screen.ready(); };
  assert.deepEqual(await as("ok"), { ready: true, locked: false, awake: true });
  assert.deepEqual(await as("locked"), { ready: false, locked: true, awake: true });
  assert.deepEqual(await as("asleep"), { ready: false, locked: false, awake: false });
  assert.deepEqual(await as("off"), { unreachable: true, error: "ssh: connect to host laptop port 22: Connection timed out" });
  assert.deepEqual(await as("old"), { ready: null });
  fs.writeFileSync(MODE, "ok");
});

// ---------- end to end: server, mcp.mjs, the engine's hook gate ----------

// A fake tutor: logs what it hears (and the initialize request), and on "DRAW" asks the engine's PreToolUse hook about
// a chalk screen_draw the way Claude Code does, logging the answer.
const FAKE = path.join(tmp, "claude"), HEARD = path.join(tmp, "heard.log"), CTRL = path.join(tmp, "control.log");
fs.writeFileSync(FAKE, `#!${process.execPath}
const fs = require("fs"), out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let n = 0;
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type === "control_request" || m.type === "control_response") { fs.appendFileSync(${JSON.stringify(CTRL)}, JSON.stringify(m) + "\\n"); return; }
  if (m.type !== "user") return;
  const text = m.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\\n");
  fs.appendFileSync(${JSON.stringify(HEARD)}, JSON.stringify(text) + "\\n");
  if (!n) out({ type: "system", subtype: "init", session_id: "33333333-3333-4333-8333-333333333333" });
  n++;
  if (text.includes("DRAW")) out({ type: "control_request", request_id: "hook" + n, request: { subtype: "hook_callback", callback_id: "screen-gate", input: { hook_event_name: "PreToolUse", tool_name: "mcp__chalk__screen_draw" } } });
  out({ type: "assistant", message: { id: "msg" + n, content: [{ type: "text", text: "Reply " + n + "." }] } });
  out({ type: "result", result: "done", is_error: false });
});
`, { mode: 0o755 });

const PORT = 7600 + Math.floor(Math.random() * 90);
const SERVER = `http://127.0.0.1:${PORT}`;
const SLUG = "quartus-pins";
store.createTopic({ slug: SLUG, title: "Quartus pin assignments" });
let srv = null;
const children = new Set();   // every mcp.mjs started here: a failed check mustn't leave one keeping the run alive
after(async () => {
  for (const c of children) c.kill();
  if (srv) { srv.kill("SIGTERM"); await new Promise((r) => srv.once("exit", r)); }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, body) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(SERVER + p, body ? { method: "POST", headers: { "X-Teach": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
      return await r.json();
    } catch { await sleep(100); }
  }
  throw new Error("server didn't come up");
}
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(60); }
  return fn();
}
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
const lines = (f) => read(f).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const chalkLog = () => read(LOG);

// mcp.mjs over stdio, like Claude Code runs it for the tutor.
function mcp(env = {}) {
  const p = spawn(process.execPath, [path.join(APP, "mcp.mjs")], { env: { ...process.env, TEACH_TOPIC: SLUG, TEACH_SCREEN: "1", TEACH_SERVER: SERVER, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  children.add(p);
  let buf = "", n = 0;
  const waiting = new Map();
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); }
  });
  const req = (method, params) => { const id = ++n; p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return new Promise((r) => waiting.set(id, r)); };
  return { call: async (name, args = {}) => { const r = (await req("tools/call", { name, arguments: args })).result; return { error: !!r.isError, text: r.content.map((c) => c.text || "").join(" ") }; },
    names: async () => (await req("tools/list", {})).result.tools.map((t) => t.name), close: () => p.kill() };
}

test("end to end: the tutor takes a step onto the screen, the learner says stay on the board", LINUX, async () => {
  fs.writeFileSync(MODE, "ok");
  srv = spawn(process.execPath, [path.join(APP, "server.mjs")], {
    env: { ...process.env, TEACH_SYNC: "off", TEACH_CAPTURE_CMD: "", TEACH_OPEN_CMD: "", TEACH_PORT: String(PORT), TEACH_SOCKET: "", TEACH_CLAUDE: FAKE, TEACH_CHALK_MCP: "/bin/true" },
    stdio: ["ignore", "ignore", "inherit"] });
  const tutor = mcp();
  assert.ok((await tutor.names()).includes("screen"), "the screen tool comes with the screen tools");
  const bare = mcp({ TEACH_SCREEN: "0" });
  assert.ok(!(await bare.names()).includes("screen"), "no chalk: no screen tool, the choice never comes up");
  bare.close();

  // the tutor starts on the board: the screen tools refuse, and its hook gate is set up
  await api(`/api/topics/${SLUG}/message`, { text: "How do I assign pins in Quartus? DRAW" });
  await until(() => lines(CTRL).some((m) => m.type === "control_response" && m.response?.request_id?.startsWith("hook")));
  const init = lines(CTRL).find((m) => m.request?.subtype === "initialize");
  assert.equal(init.request.hooks.PreToolUse[0].matcher, "mcp__chalk__.*", "chalk's tools go through the hook");
  const denied = lines(CTRL).find((m) => m.type === "control_response" && m.response.request_id.startsWith("hook"));
  assert.equal(denied.response.response.hookSpecificOutput.permissionDecision, "deny", "on the board, chalk's draw is refused");
  assert.match(denied.response.response.hookSpecificOutput.permissionDecisionReason, /call the teach tool "screen"/);
  const off = await tutor.call("say", { text: "Open the Pin Planner." });
  assert.ok(off.error && /on the Teach board right now/.test(off.text), "say refuses on the board");
  await until(async () => !(await api(`/api/topics/${SLUG}`)).status.busy);

  // typing in Teach holds it back; a locked screen too, then it goes
  await api(`/api/topics/${SLUG}/typing`, { draft: true });
  let r = await tutor.call("screen", { to: "screen", why: "find Pin Planner" });
  assert.ok(r.error && /typing in the Teach window/.test(r.text), r.text);
  await api(`/api/topics/${SLUG}/typing`, { sent: true });
  fs.writeFileSync(MODE, "locked");
  r = await tutor.call("screen", { to: "screen", why: "find Pin Planner" });
  assert.ok(r.error && /locked/.test(r.text), r.text);
  assert.equal((await api(`/api/topics/${SLUG}`)).live, null);
  fs.writeFileSync(MODE, "ok");
  r = await tutor.call("screen", { to: "screen", why: "find Pin Planner" });
  assert.ok(!r.error && /^Live on the learner's screen now/.test(r.text), r.text);
  const t = await api(`/api/topics/${SLUG}`);
  assert.equal(t.live.why, "find Pin Planner"); assert.equal(t.topic.settings.screen, false, "their own switch stays as it was");
  assert.equal(t.status.screen, true);
  await until(() => /route teach quartus-pins/.test(chalkLog()));
  assert.match(chalkLog(), /toast On your screen · find Pin Planner/);
  const on = await tutor.call("say", { text: "Open the Pin Planner." });
  assert.ok(!on.error && /Speaking/.test(on.text), "live: say works");
  await api(`/api/topics/${SLUG}/message`, { text: "DRAW again" });
  await until(() => lines(CTRL).filter((m) => m.type === "control_response" && m.response.request_id.startsWith("hook")).length === 2);
  assert.deepEqual(lines(CTRL).filter((m) => m.type === "control_response" && m.response.request_id.startsWith("hook")).at(-1).response.response, {}, "live: chalk's draw is allowed");
  await until(async () => !(await api(`/api/topics/${SLUG}`)).status.busy);

  // the learner presses "Stay on the board": back, the screen cleared, the voice stopped, the tutor told, no going back
  const before = lines(HEARD).length;
  r = await api(`/api/topics/${SLUG}/live`, { to: "board", stay: true, by: "learner" });
  assert.equal(r.change, "board");
  const back = await api(`/api/topics/${SLUG}`);
  assert.equal(back.live, null); assert.equal(back.topic.settings.autoScreen, false);
  await until(() => /route off/.test(chalkLog()) && /hush/.test(chalkLog()));
  assert.match(chalkLog(), /clear --marks/); assert.match(chalkLog(), /toast Back on the Teach board/);
  await until(() => lines(HEARD).length > before);
  assert.match(lines(HEARD).at(-1), /pressed "Stay on the board"/);
  r = await tutor.call("screen", { to: "screen", why: "again" });
  assert.ok(r.error && /asked to stay on the board/.test(r.text), r.text);
  assert.ok((await tutor.call("watch", {})).error, "watch refuses on the board");

  // their own switch: the tutor can't take that lesson back to the board
  await until(async () => !(await api(`/api/topics/${SLUG}`)).status.busy);
  await api(`/api/topics/${SLUG}/settings`, { screen: true });
  store.mutateTopic(SLUG, (x) => { x.settings.autoScreen = true; });
  r = await tutor.call("screen", { to: "board", stay: true });
  assert.ok(r.error && /turned "On my screen" on themselves/.test(r.text), r.text);
  assert.equal((await api(`/api/topics/${SLUG}`)).topic.settings.autoScreen, true, "a refused stay changes nothing");
  tutor.close();
});

test("end to end: the tutor's own way back, and an unreachable laptop", LINUX, async () => {
  store.mutateTopic(SLUG, (x) => { x.settings.screen = false; x.settings.autoScreen = true; });
  await until(async () => !(await api(`/api/topics/${SLUG}`)).status.busy);
  const tutor = mcp();
  fs.writeFileSync(MODE, "off");
  let r = await tutor.call("screen", { to: "screen", why: "the datasheet" });
  assert.ok(r.error && /isn't reachable/.test(r.text), r.text);
  fs.writeFileSync(MODE, "ok");
  r = await tutor.call("screen", { to: "screen", why: "the datasheet" });
  assert.ok(!r.error, r.text);
  fs.rmSync(LOG, { force: true });
  r = await tutor.call("screen", { to: "board" });
  assert.ok(!r.error && /^Back on the Teach board/.test(r.text), r.text);
  assert.equal((await api(`/api/topics/${SLUG}`)).live, null);
  assert.equal((await api(`/api/topics/${SLUG}`)).topic.settings.autoScreen, true, "coming back by itself doesn't stop the next time");
  await until(() => /route off/.test(chalkLog()));
  assert.doesNotMatch(chalkLog(), /hush/, "its wrap-up line plays out");
  tutor.close();
});
