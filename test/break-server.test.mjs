// A stop picked on the tutor's break card ends the session the way the app's Stop for today button (P) does, end
// to end: a real server.mjs on a throwaway port and a fake `claude` that asks a break card (BREAK), marks step 2
// done (CHECKED), and on the app's pause message sets the status and suggests actions as a tutor would.
// "Stop here for today" sends the same pause message as the button at once, "Do step 2 and then stop" once step 2 is
// through, "Keep going" none; each stop raises the page's "ending" event (the end-of-session grid).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teach-break-test-"));
const DATA = path.join(tmp, "learning"), STATE = path.join(tmp, "state"), PROJECTS = path.join(tmp, "projects"), WORK = path.join(tmp, "school");
for (const d of [path.join(DATA, "topics"), STATE, PROJECTS, WORK]) fs.mkdirSync(d, { recursive: true });
Object.assign(process.env, { TEACH_DATA: DATA, TEACH_STATE: STATE, TEACH_PROJECTS: PROJECTS, TEACH_WORK: WORK });
const store = await import("../lib/store.mjs");
const ops = await import("../lib/ops.mjs");

const TOPICS = ["stop-now", "stop-after", "keep-going", "button"];
for (const slug of TOPICS) {
  store.createTopic({ slug, title: slug });
  ops.plan(slug, { nodes: [{ id: "1", title: "Weak AI", status: "done" }, { id: "2", title: "Strong AI", status: "current" }, { id: "3", title: "Intentionality" }] });
}

const CLAUDE = path.join(tmp, "claude"), HEARD = path.join(tmp, "heard.log");
fs.writeFileSync(CLAUDE, `#!${process.execPath}
const fs = require("fs");
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const slug = (process.argv.join(" ").match(/TEACH_TOPIC\\W+([a-z-]+)/) || [])[1];
const ops = import(${JSON.stringify(pathToFileURL(path.join(APP, "lib/ops.mjs")).href)});
let n = 0;
require("readline").createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.type !== "user") return;
  const text = m.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\\n");
  fs.appendFileSync(${JSON.stringify(HEARD)}, JSON.stringify({ slug, text }) + "\\n");
  if (!n) out({ type: "system", subtype: "init", session_id: "44444444-4444-4444-8444-44444444444" + (slug.length % 10) });
  const id = "msg" + ++n, content = [{ type: "text", text: "Reply " + n + "." }];
  const tool = (name, input) => content.push({ type: "tool_use", id: "toolu_" + name + n + slug.replace(/-/g, ""), name: "mcp__teach__" + name, input });
  const O = await ops;
  if (text.includes("BREAK")) tool("ask", { purpose: "break", intro: "One step done.", finish: "2", questions: [{ prompt: "Step 2 is short. Your call?" }] });
  if (text.includes("CHECKED")) O.step(slug, { id: "2", status: "done", result: "2/2" });
  if (text.includes("[Teach app] pause")) O.update(slug, { status: "paused", next: "Step 3", suggest: [{ kind: "notes", why: "recap" }] });
  out({ type: "assistant", message: { id, content } });
  out({ type: "result", result: "done", is_error: false });
});
`, { mode: 0o755 });

const PORT = 7820 + Math.floor(Math.random() * 70);
const server = spawn(process.execPath, [path.join(APP, "server.mjs")], {
  env: { ...process.env, TEACH_T3_DB: path.join(tmp, "no-t3.sqlite"), TEACH_SYNC: "off", TEACH_CAPTURE_CMD: "", TEACH_OPEN_CMD: "", TEACH_LEARNER: "Sam", TEACH_PORT: String(PORT),
    TEACH_SOCKET: "", TEACH_CHALK: "/bin/true", TEACH_CHALK_MCP: "/bin/true", TEACH_CLAUDE: CLAUDE, TEACH_URL: "" },
  stdio: ["ignore", "ignore", "inherit"] });
const streams = [];
after(async () => { for (const s of streams) s.abort(); server.kill("SIGTERM"); await new Promise((r) => server.once("exit", r)); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, body) {
  for (let i = 0; i < 60; i++) {
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
const heard = (slug) => (fs.existsSync(HEARD) ? fs.readFileSync(HEARD, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((h) => h.slug === slug).map((h) => h.text);
const idle = async (slug) => !(await api(`/api/topics/${slug}`)).status.busy;
// The page's live events for a topic (what the end-of-session grid listens to).
function events(slug) {
  const got = [], ctl = new AbortController();
  streams.push(ctl);
  (async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/events?topic=${slug}`, { signal: ctl.signal });
    let buf = "";
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString();
      for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) { const d = buf.slice(0, i).match(/^data: (.*)$/m); if (d) got.push(JSON.parse(d[1])); }
    }
  })().catch(() => {});
  return got;
}
// Start the session and put up the break card; resolves to the card's block.
async function breakCard(slug) {
  await api(`/api/topics/${slug}`);   // (the server is up)
  await api(`/api/topics/${slug}/message`, { text: "BREAK" });
  return until(async () => (await idle(slug)) && (await api(`/api/topics/${slug}/board`)).board.blocks.find((x) => x.kind === "ask" && x.status === "pending"));
}
const pauseNote = (texts) => texts.find((x) => x.includes("[Teach app] pause"));
const noteBody = (text) => text.slice(text.indexOf("[Teach app] pause"));

test("the break card carries the app's own options", async () => {
  const card = await breakCard("stop-now");
  assert.equal(card.ask.purpose, "break");
  assert.deepEqual(card.ask.questions[0].options, ["Stop here for today", "Do step 2 and then stop", "Keep going"]);
});

test("Stop here for today ends the session at once, exactly as Stop for today (P) does", async () => {
  const ev = events("stop-now");
  await sleep(200);
  const card = (await api(`/api/topics/stop-now/board`)).board.blocks.find((x) => x.kind === "ask" && x.status === "pending");
  await api(`/api/topics/stop-now/answer`, { id: card.id, answers: [{ choice: 0 }] });
  const t = await until(async () => { const x = (await api(`/api/topics/stop-now`)).topic; return x.status === "paused" && x; });
  assert.equal(t.status, "paused");
  assert.equal(t.next, "Step 3");
  const last = heard("stop-now").at(-1);
  assert.match(last, /^\[Answers to question set [^\]]+\][^]*→ "Stop here for today"\n\[Teach app\] pause/, "the tutor sees what was picked, then the pause message");
  assert.match(last, /\[Teach app\] pause\nSam is stopping here for today\. Don't start anything new\. Run Phase 4/);
  assert.ok(await until(() => ev.some((e) => e.t === "ending" && e.action === "pause")), "the page opens the end-of-session grid");
  assert.ok(await until(async () => !(await api(`/api/topics/stop-now`)).status.alive), "the session closes after the tutor's recap");

  // the Pause button on another topic: the same message, word for word
  await api(`/api/topics/button/message`, { text: "hello" });
  await until(() => idle("button"));
  await api(`/api/topics/button/pause`, {});
  await until(async () => (await api(`/api/topics/button`)).topic.status === "paused");
  assert.equal(noteBody(pauseNote(heard("button"))), noteBody(last));
});

test("Do step 2 and then stop: the session goes on until step 2 is through, then ends the same way", async () => {
  const ev = events("stop-after");
  const card = await breakCard("stop-after");
  await api(`/api/topics/stop-after/answer`, { id: card.id, answers: [{ choice: 1 }] });
  await until(() => idle("stop-after"));
  await sleep(300);
  let texts = heard("stop-after");
  assert.match(texts.at(-1), /\[Teach app\] break\nThe app ends the session once step 2 \(Strong AI\) is through/);
  assert.match(texts.at(-1), /without starting step 3/);
  assert.equal(pauseNote(texts), undefined, "not yet: step 2 isn't through");
  assert.equal((await api(`/api/topics/stop-after`)).topic.status, "active");
  assert.ok(!ev.some((e) => e.t === "ending"));

  await api(`/api/topics/stop-after/message`, { text: "my answer to the step 2 check CHECKED" });
  const t = await until(async () => { const x = (await api(`/api/topics/stop-after`)).topic; return x.status === "paused" && x; });
  assert.equal(t.status, "paused");
  texts = heard("stop-after");
  assert.match(texts.at(-1), /^\[Teach app\] break\nStep 2 is through: this is the stop Sam picked on your break card\.\n\n?/);
  assert.equal(noteBody(texts.at(-1)), noteBody(pauseNote(heard("button"))), "the same pause message as the button");
  assert.ok(await until(() => ev.some((e) => e.t === "ending" && e.action === "pause")));
});

test("Keep going is just an answer: no stop", async () => {
  const ev = events("keep-going");
  const card = await breakCard("keep-going");
  await api(`/api/topics/keep-going/answer`, { id: card.id, answers: [{ choice: 2 }] });
  await until(() => idle("keep-going"));
  await sleep(400);
  assert.match(heard("keep-going").at(-1), /"Keep going"/);
  assert.equal(pauseNote(heard("keep-going")), undefined);
  assert.equal((await api(`/api/topics/keep-going`)).topic.status, "active");
  assert.ok(!ev.some((e) => e.t === "ending"));
  // and marking step 2 done later doesn't end anything: no stop is waiting
  await api(`/api/topics/keep-going/message`, { text: "CHECKED" });
  await until(() => idle("keep-going"));
  await sleep(400);
  assert.equal((await api(`/api/topics/keep-going`)).topic.status, "active");
});
