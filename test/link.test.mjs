// The server's side of screen mode, end to end with fakes: a real server.mjs on a throwaway port, a fake `chalk`
// (logs every call, answers `route` like the real one) and a fake `claude` (speaks stream-json; says something
// out loud only when told to). Covers the Super+/ link, the nudge after a quiet turn, and a question set going
// back on their screen after a restart. No computer, no model.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teach-link-test-"));
const DATA = path.join(tmp, "learning"), STATE = path.join(tmp, "state"), PROJECTS = path.join(tmp, "projects"), WORK = path.join(tmp, "school");
for (const d of [path.join(DATA, "topics"), STATE, PROJECTS, WORK]) fs.mkdirSync(d, { recursive: true });
const LOG = path.join(tmp, "chalk.log"), HEARD = path.join(tmp, "heard.log"), ROUTE = path.join(tmp, "route");

const CHALK = path.join(tmp, "chalk");
fs.writeFileSync(CHALK, `#!/bin/sh
echo "$*" >> ${LOG}
case "$1" in
  route) if [ "$2" = teach ]; then printf '{"to":"teach","slug":"%s"}' "$3" > ${ROUTE}; cat ${ROUTE}; echo
         elif [ "$2" = off ]; then rm -f ${ROUTE}; echo null; else cat ${ROUTE} 2>/dev/null || echo null; fi ;;
  panel) sleep 30 ;;
esac
`, { mode: 0o755 });

// A tutor that answers every message in one turn: plain text, plus a say call when the message contains SAY.
const CLAUDE = path.join(tmp, "claude");
fs.writeFileSync(CLAUDE, `#!${process.execPath}
const fs = require("fs");
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let n = 0;
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type !== "user") return;
  const text = m.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\\n---\\n");
  fs.appendFileSync(${JSON.stringify(HEARD)}, JSON.stringify(text) + "\\n");
  if (!n) out({ type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111" });
  const id = "msg" + ++n, content = [{ type: "text", text: "Here is my answer." }];
  if (text.includes("SAY")) content.push({ type: "tool_use", id: "say" + n, name: "mcp__teach__say", input: { text: "Out loud." } });
  if (text.includes("ASK")) content.push({ type: "tool_use", id: "toolu_live" + n, name: "mcp__teach__ask", input: { purpose: "check", questions: [{ kind: "choice", prompt: "Live?", options: ["yes", "no"], answer: 0 }] } });
  out({ type: "assistant", message: { id, content } });
  out({ type: "result", result: "done", is_error: false });
});
`, { mode: 0o755 });

const PORT = 7900 + Math.floor(Math.random() * 90);
let server = null;
function start() {
  server = spawn(process.execPath, [path.join(APP, "server.mjs")], {
    env: { ...process.env, TEACH_T3_DB: path.join(tmp, "no-t3.sqlite"), TEACH_SYNC: "off", TEACH_CAPTURE_CMD: "", TEACH_OPEN_CMD: "", TEACH_LEARNER: "", TEACH_DATA: DATA, TEACH_STATE: STATE, TEACH_PROJECTS: PROJECTS, TEACH_WORK: WORK, TEACH_PORT: String(PORT),
      TEACH_SOCKET: "", TEACH_CHALK: CHALK, TEACH_CLAUDE: CLAUDE, TEACH_CHALK_MCP: "/bin/true" },
    stdio: ["ignore", "ignore", "inherit"] });
}
async function stop() { if (!server) return; server.kill("SIGTERM"); await new Promise((r) => server.once("exit", r)); server = null; }
after(stop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, body) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`, body ? { method: "POST", headers: { "X-Teach": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
      return await r.json();
    } catch { await sleep(100); }   // server still starting
  }
  throw new Error("server didn't come up");
}
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
  return fn();
}
const log = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "");
const heard = () => (fs.existsSync(HEARD) ? fs.readFileSync(HEARD, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

let slug;

test("a new screen lesson links Super+/ to its tutor, and the page can see it", async () => {
  start();
  const r = await api("/api/topics", { text: "Neural network from scratch", screen: true });
  slug = r.slug;
  assert.ok(await until(() => log().includes(`route teach ${slug}`)), "route set on the first turn");
  const t = await until(async () => { const d = await api(`/api/topics/${slug}`); return d.link?.ok && d; });
  assert.equal(t.link.slug, slug);
  assert.match(log(), /toast Super\+\/ asks your tutor · Neural network from scratch/);
});

test("a turn that answers without saying anything gets a nudge on the next message; one that speaks doesn't", async () => {
  await until(() => heard().length >= 1);
  await sleep(300);
  await api(`/api/topics/${slug}/message`, { text: "what's a delta?" });
  await until(() => heard().length >= 2);
  assert.match(heard()[1], /^\[Teach app\] voice\n.*reached only the Teach window/s, "the quiet first turn is pointed out");
  assert.match(heard()[1], /what's a delta\?$/);
  await sleep(300);
  await api(`/api/topics/${slug}/message`, { text: "SAY it please" });
  await until(() => heard().length >= 3);
  assert.match(heard()[2], /\[Teach app\] voice/, "the second turn was quiet too");
  await sleep(300);
  await api(`/api/topics/${slug}/message`, { text: "and now?" });
  await until(() => heard().length >= 4);
  assert.doesNotMatch(heard()[3], /\[Teach app\] voice/, "after a turn that spoke, no nudge");
});

test("after a restart the link comes back by itself, and a waiting question set goes back on his screen", async () => {
  // the tutor's transcript: one pending question set
  const dir = path.join(PROJECTS, WORK.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const ask = { purpose: "check", questions: [{ kind: "choice", prompt: "Which factor?", options: ["h(1-h)", "w"], answer: 0 }] };
  fs.writeFileSync(path.join(dir, "11111111-1111-4111-8111-111111111111.jsonl"), [
    { type: "user", uuid: "u1", timestamp: new Date().toISOString(), message: { role: "user", content: "start" } },
    { type: "assistant", uuid: "a1", timestamp: new Date().toISOString(), message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "toolu_ask1", name: "mcp__teach__ask", input: ask }] } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  await stop();
  fs.rmSync(ROUTE, { force: true });   // say the learner's computer rebooted too
  fs.writeFileSync(LOG, "");
  start();
  assert.ok(await until(() => log().includes(`route teach ${slug}`), 8000), "the beat after start re-links the live lesson");
  assert.ok(await until(() => /^panel .*teach-ask-toolu_ask1/m.test(log()), 8000), "the pending set is back on screen");
  assert.ok(await until(async () => (await api(`/api/topics/${slug}/board`)).board.blocks.find((x) => x.id === "toolu_ask1")?.onScreen), "the board's card says it's on the screen");
});

test("a question set asked in screen mode goes on the board marked as on the screen", async () => {
  await api(`/api/topics/${slug}/message`, { text: "ASK" });
  const card = await until(async () => (await api(`/api/topics/${slug}/board`)).board.blocks.find((x) => x.kind === "ask" && x.id.startsWith("toolu_live") && x.onScreen));
  assert.ok(card, "the live card is on the board with its on-screen flag");
  assert.ok(await until(() => new RegExp(`^panel .*teach-ask-${card.id}`, "m").test(log())), "and on the screen");
});

test("turning screen mode off takes Super+/ back to plain chalk, only for its own lesson", async () => {
  fs.writeFileSync(LOG, "");
  await api(`/api/topics/${slug}/settings`, { screen: false });
  assert.ok(await until(() => log().includes("route off")));
  assert.ok(await until(() => !fs.existsSync(ROUTE)), "the route is gone");   // (the fake chalk logs before it removes it)
  assert.match(log(), /toast Super\+\/ is plain chalk again/);
  // another lesson's switch-off doesn't touch a route it doesn't own
  const other = (await api("/api/topics", { text: "RC filters", screen: true })).slug;
  await until(() => log().includes(`route teach ${other}`));
  fs.writeFileSync(LOG, "");
  await api(`/api/topics/${slug}/pause`, {});   // the first lesson pausing: Super+/ belongs to the other one now
  await sleep(800);
  assert.doesNotMatch(log(), /route off/);
  assert.equal(JSON.parse(fs.readFileSync(ROUTE, "utf8")).slug, other);
});
