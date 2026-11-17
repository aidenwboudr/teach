// The end-of-session actions end to end: a real server.mjs on a throwaway port, a fake `claude` that acts on the
// app's "[Teach app] action …" briefs, and a fake calendar command. Nothing is made until a click; one made by the
// tutor goes queued → working → ready; a pause interrupts the tutor's turn (the model stops) and a resume continues;
// a turn that ends without delivering fails; a session goes on the calendar with no model at all.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teach-actions-server-"));
const DATA = path.join(tmp, "learning"), STATE = path.join(tmp, "state"), PROJECTS = path.join(tmp, "projects"), WORK = path.join(tmp, "school");
for (const d of [path.join(DATA, "topics"), STATE, PROJECTS, WORK]) fs.mkdirSync(d, { recursive: true });
Object.assign(process.env, { TEACH_DATA: DATA, TEACH_STATE: STATE, TEACH_PROJECTS: PROJECTS, TEACH_WORK: WORK });
const store = await import("../lib/store.mjs");

const SLUG = "rc-exam";
store.createTopic({ slug: SLUG, title: "RC exam", why: "exam", settings: { ...store.blankTopic("x").settings, screen: true }, deadline: "2099-01-10", integrity: "one 8.5x11 sheet, front and back",
  plan: [{ id: "1", title: "Charging", status: "done", deps: [] }, { id: "2", title: "Discharging", status: "shaky", deps: [] }] });

// The fake tutor. worksheet: writes both PDFs and delivers. notes: starts, then works until interrupted (a resume
// delivers). cards: ends the turn without delivering. Everything it hears goes to HEARD; interrupts to STOPS.
const CLAUDE = path.join(tmp, "claude"), HEARD = path.join(tmp, "heard.log"), STOPS = path.join(tmp, "stops.log");
fs.writeFileSync(CLAUDE, `#!${process.execPath}
const fs = require("fs"), path = require("path");
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const ops = import(${JSON.stringify(path.join(APP, "lib/ops.mjs"))});
const store = import(${JSON.stringify(path.join(APP, "lib/store.mjs"))});
let n = 0, waiting = false;
const end = () => out({ type: "result", result: "done", is_error: false });
require("readline").createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.type === "control_request" && m.request?.subtype === "interrupt") { fs.appendFileSync(${JSON.stringify(STOPS)}, "stop\\n"); if (waiting) { waiting = false; end(); } return; }
  if (m.type !== "user") return;
  const text = m.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\\n");
  fs.appendFileSync(${JSON.stringify(HEARD)}, JSON.stringify(text) + "\\n");
  if (!n++) out({ type: "system", subtype: "init", session_id: "33333333-3333-4333-8333-333333333333" });
  out({ type: "assistant", message: { id: "m" + n, content: [{ type: "text", text: "On it." }] } });
  const O = await ops, S = await store, dir = S.topicDir(${JSON.stringify(SLUG)});
  if (text.includes("[Teach app] action worksheet")) {
    fs.mkdirSync(path.join(dir, "out"), { recursive: true });
    for (const f of ["worksheet.pdf", "worksheet-key.pdf"]) fs.writeFileSync(path.join(dir, "out", f), "%PDF-1.4");
    O.setOutput(${JSON.stringify(SLUG)}, "worksheet", { files: [{ label: "Worksheet", path: path.join(dir, "out/worksheet.pdf"), pages: 2 }, { label: "Answer key", path: path.join(dir, "out/worksheet-key.pdf"), pages: 3 }] });
    O.deliver(${JSON.stringify(SLUG)}, { kind: "worksheet", summary: "8 problems" });
    return end();
  }
  if (text.includes("[Teach app] action notes") && !text.includes("(resume)")) { waiting = true; return; }   // works until interrupted
  if (text.includes("[Teach app] action notes")) {
    fs.mkdirSync(path.join(dir, "out"), { recursive: true }); fs.writeFileSync(path.join(dir, "out/notes.pdf"), "%PDF-1.4");
    O.deliver(${JSON.stringify(SLUG)}, { kind: "notes", summary: "2 pages", files: ["out/notes.pdf"] });
    return end();
  }
  end();   // cards, and anything else: a turn with nothing delivered
});
`, { mode: 0o755 });
const CAL = path.join(tmp, "cal"), CALLOG = path.join(tmp, "cal.log");
fs.writeFileSync(CAL, `#!${process.execPath}\nrequire("fs").appendFileSync(${JSON.stringify(CALLOG)}, JSON.stringify(process.argv.slice(2)) + "\\n"); console.log("added 4f2a");\n`, { mode: 0o755 });

const PORT = 7600 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, [path.join(APP, "server.mjs")], {
  env: { ...process.env, TEACH_T3_DB: path.join(tmp, "no-t3.sqlite"), TEACH_SYNC: "off", TEACH_CAPTURE_CMD: "", TEACH_OPEN_CMD: "", TEACH_LEARNER: "Sam", TEACH_PORT: String(PORT),
    TEACH_SOCKET: "", TEACH_CHALK: "/bin/true", TEACH_CHALK_MCP: "/bin/true", TEACH_CLAUDE: CLAUDE, TEACH_CALENDAR_CMD: `${CAL} add`, TEACH_URL: "" },
  stdio: ["ignore", "ignore", "inherit"] });
after(async () => { server.kill("SIGTERM"); await new Promise((r) => server.once("exit", r)); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, body) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`, body ? { method: "POST", headers: { "X-Teach": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
      return r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
    } catch { await sleep(100); }
  }
  throw new Error("server didn't come up");
}
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(80); }
  return fn();
}
const heard = () => (fs.existsSync(HEARD) ? fs.readFileSync(HEARD, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const tile = async (kind) => (await api(`/api/topics/${SLUG}/actions`)).tiles.find((x) => x.kind === kind);
const act = (kind, op, extra = {}) => api(`/api/topics/${SLUG}/actions`, { kind, op, ...extra });

test("nothing is made until it's clicked: the grid is all grey and the tutor hears nothing", async () => {
  const v = await api(`/api/topics/${SLUG}/actions`);
  assert.equal(v.tiles[0].kind, "sheet");
  assert.match(v.tiles[0].why, /front and back/);
  assert.ok(v.tiles.every((x) => x.state === "idle"));
  assert.ok(v.calendar);
  await act("sheet", "save", { settings: { sheets: 2, font: "8" } });
  assert.match((await tile("sheet")).summary, /^2 sheets .* 8 pt/);
  await sleep(300);
  assert.equal(heard().length, 0, "saving settings runs no model");
});

test("generate: queued → working → ready, files on the tile", async () => {
  store.mutateTopic(SLUG, (x) => { x.status = "paused"; });
  await act("worksheet", "start", { settings: { count: 8 } });
  const done = await until(async () => (await tile("worksheet")).state === "ready" && tile("worksheet"));
  assert.equal(done.state, "ready");
  assert.deepEqual(done.files.map((f) => f.label), ["Worksheet", "Answer key"]);
  assert.equal(done.made, "8 problems");
  const first = heard().find((h) => h.includes("[Teach app] action worksheet"));
  // a fresh session reads up first and does only this; never the usual "continue: review, then the next step"
  assert.match(first, /^\[Teach app\] context\n.*Then do only what the next message asks/s);
  assert.doesNotMatch(first, /\[Teach app\] continue/);
  assert.doesNotMatch(first, /\[Teach app\] screen on/);
  const brief = first.slice(first.indexOf("[Teach app] action worksheet"));
  assert.match(brief, /Sam clicked "Worksheet \+ key"/);
  assert.match(brief, /8 problems/);
  assert.equal(store.getTopic(SLUG).status, "paused", "making something doesn't resume the lesson");
});

test("pause stops the tutor's turn; resume picks it up; the tutor hears it once each", async () => {
  await act("notes", "start");
  await until(async () => (await tile("notes")).state === "working");
  await sleep(200);
  await act("notes", "pause");
  assert.equal((await tile("notes")).state, "paused");
  await until(() => fs.existsSync(STOPS));
  assert.equal(fs.readFileSync(STOPS, "utf8").trim(), "stop", "the model's turn was interrupted");
  await sleep(300);
  assert.equal((await tile("notes")).state, "paused", "the interrupted turn's end doesn't mark it failed");
  await act("notes", "resume");
  const t = await until(async () => (await tile("notes")).state === "ready" && tile("notes"));
  assert.equal(t.made, "2 pages");
  assert.equal(heard().filter((h) => h.includes("[Teach app] action notes")).length, 2);
  assert.match(heard().findLast((h) => h.includes("[Teach app] action notes")), /\(resume\)/);
});

test("a turn that ends without delivering fails, with a retry", async () => {
  await act("cards", "start");
  const t = await until(async () => (await tile("cards")).state === "failed" && tile("cards"));
  assert.match(t.error, /stopped before it was done/);
});

test("a session goes on the calendar (no model), with an .ics; begin starts it", async () => {
  const before = heard().length;
  await act("session", "start", { settings: { when: "2099-01-09T19:00", minutes: "45", calendar: true, remind: "30", mode: "warmup" }, at: "2099-01-10T02:00:00.000Z" });
  const t = await tile("session");
  assert.equal(t.state, "ready");
  assert.ok(t.session.calendar.ok);
  assert.equal(heard().length, before, "scheduling runs no model");
  const args = JSON.parse(fs.readFileSync(CALLOG, "utf8").trim());
  assert.deepEqual(args.slice(0, 5), ["add", "Exam warm-up: RC exam", "2099-01-09 19:00", "--for", "45m"]);
  assert.ok(args.includes("--remind") && args.includes("30m"));
  const ics = await api(`/api/topics/${SLUG}/session-ics`);
  assert.match(ics, /DTSTART:20990110T020000Z/);
  assert.match(ics, /TRIGGER:-PT30M/);
  await act("session", "begin");
  await until(() => heard().some((h) => h.includes("[Teach app] scheduled session")));
  assert.match(heard().find((h) => h.includes("[Teach app] scheduled session")), /exam warm-up/);
});

test("the close asks for picks, not material", async () => {
  await api(`/api/topics/${SLUG}/done`, {});
  const note = await until(() => heard().find((h) => h.includes("[Teach app] close")));
  assert.match(note, /update with `suggest`/);
  assert.match(note, /Don't make any of them/);
  assert.doesNotMatch(note, /deck\.json/);
});
