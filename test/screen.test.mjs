// Screen mode: the teach MCP server's say/watch tools against a fake `chalk`, the inbox that hands the learner's words to
// a waiting watch, and how a screen lesson reads back in the lesson history. Throwaway data, no computer needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teach-screen-test-"));
const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
Object.assign(process.env, { TEACH_DATA: path.join(tmp, "learning"), TEACH_STATE: path.join(tmp, "state"), TEACH_PROJECTS: path.join(tmp, "projects"), TEACH_WORK: path.join(tmp, "school"), TEACH_T3_DB: path.join(tmp, "no-t3.sqlite") });
delete process.env.TEACH_LEARNER;
fs.mkdirSync(path.join(tmp, "learning", "topics"), { recursive: true });

// A fake chalk: `watch` waits WATCH_MS then reports a change (and logs that it ran to the end); `say` logs its words;
// `panel` logs its spec and answers with the next line of panel-results.
const LOG = path.join(tmp, "chalk.log");
const SHOT = path.join(tmp, "shot.png");
fs.writeFileSync(SHOT, Buffer.from("89504e470d0a1a0a", "hex"));
const FAKE = path.join(tmp, "chalk");
fs.writeFileSync(FAKE, `#!/bin/sh
case "$1" in
  watch) echo "watch $*" >> ${LOG}; sleep \${WATCH_S:-0.3}; echo "watch-finished" >> ${LOG}
         echo '{"changed":true,"reason":"screen","waited":0.3,"where":[10,20,30,40],"size":[1920,1280],"shot":"${SHOT}"}' ;;
  say) shift; echo "say $*" >> ${LOG} ;;
  panel) echo "panel $2" >> ${LOG}; n=$(( $(cat ${tmp}/panel-n 2>/dev/null || echo 0) + 1 )); echo $n > ${tmp}/panel-n
         r=$(sed -n "\${n}p" ${tmp}/panel-results); if [ "$r" = WAIT ]; then sleep 5; else echo "$r"; fi ;;
  *) echo "$*" >> ${LOG} ;;
esac
`, { mode: 0o755 });

const store = await import("../lib/store.mjs");
const screen = await import("../lib/screen.mjs");
const tr = await import("../lib/transcript.mjs");
const opsMod = await import("../lib/ops.mjs");
store.createTopic({ slug: "gimp-layers", title: "GIMP layers" });

// Talk to mcp.mjs over stdio like Claude Code does.
function mcp(env = {}) {
  const p = spawn(process.execPath, [path.join(APP, "mcp.mjs")], { env: { ...process.env, TEACH_TOPIC: "gimp-layers", TEACH_SCREEN: "1", TEACH_CHALK: FAKE, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "", n = 0;
  const waiting = new Map();
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); }
  });
  const req = (method, params) => { const id = ++n; p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return { id, done: new Promise((r) => waiting.set(id, r)) }; };
  return { p, req, notify: (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"), close: () => p.kill() };
}
const log = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("screen tools only exist in screen mode", async () => {
  const on = mcp(), off = mcp({ TEACH_SCREEN: "0" });
  const names = async (s) => (await s.req("tools/list", {}).done).result.tools.map((t) => t.name);
  assert.ok((await names(on)).includes("watch") && (await names(on)).includes("say"));
  assert.ok(!(await names(off)).includes("watch"));
  on.close(); off.close();
});

test("say speaks through chalk and returns at once; voice off says so instead", async () => {
  fs.rmSync(LOG, { force: true });
  const s = mcp();
  const r = await s.req("tools/call", { name: "say", arguments: { text: "Open the  Layers panel." } }).done;
  assert.match(r.result.content[0].text, /^Speaking \(about \d+ s\)/);
  await sleep(200);
  assert.match(log(), /say Open the Layers panel\./);
  store.mutateTopic("gimp-layers", (t) => { t.settings.voice = false; });
  const q = await s.req("tools/call", { name: "say", arguments: { text: "Quiet now." } }).done;
  assert.match(q.result.content[0].text, /Voice is off/);
  await sleep(200);
  assert.doesNotMatch(log(), /Quiet now/);
  store.mutateTopic("gimp-layers", (t) => { t.settings.voice = true; });
  s.close();
});

test("watch returns the change with the screenshot, and sets the Super+/ route", async () => {
  fs.rmSync(LOG, { force: true });
  const s = mcp();
  const r = await s.req("tools/call", { name: "watch", arguments: { expect: "open Layers", timeout: 30 } }).done;
  const [text, img] = r.result.content;
  assert.match(text.text, /changed after 0\.3 s, mostly around \[10, 20, 30, 40\]/);
  assert.equal(img.type, "image");
  assert.match(log(), /--route \{"to":"teach","slug":"gimp-layers","title":"GIMP layers","ttl":1800\}/);
  s.close();
});

test("words he sends during a watch end it at once and stop chalk watching", async () => {
  fs.rmSync(LOG, { force: true });
  const s = mcp({ WATCH_S: "5" });
  const call = s.req("tools/call", { name: "watch", arguments: {} });
  await sleep(400);
  screen.toInbox("gimp-layers", "which one is the eye icon?");
  const t0 = Date.now();
  const r = await call.done;
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(tr.saidInWatch(r.result.content[0].text), "which one is the eye icon?");
  await sleep(5500);
  assert.doesNotMatch(log(), /watch-finished/, "the chalk watch should have been killed");
  s.close();
});

test("a message that arrived between watches is answered by the next watch", async () => {
  screen.toInbox("gimp-layers", "done");
  screen.toInbox("gimp-layers", "what now?");
  const s = mcp();
  const r = await s.req("tools/call", { name: "watch", arguments: {} }).done;
  assert.match(r.result.content[0].text, /while you were busy/);
  assert.equal(tr.saidInWatch(r.result.content[0].text), "done\n\nwhat now?");
  assert.deepEqual(screen.takeInbox("gimp-layers"), []);
  s.close();
});

test("a cancelled watch stops", async () => {
  fs.rmSync(LOG, { force: true });
  const s = mcp({ WATCH_S: "4" });
  const call = s.req("tools/call", { name: "watch", arguments: {} });
  await sleep(300);
  s.notify("notifications/cancelled", { requestId: call.id });
  const r = await call.done;
  assert.equal(r.result.content[0].text, "Stopped.");
  await sleep(4500);
  assert.doesNotMatch(log(), /watch-finished/);
  s.close();
});

test("history: spoken lines read as the tutor's, words from a watch as his", () => {
  const dir = path.join(process.env.TEACH_PROJECTS, "p");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "s.jsonl");
  const e = (type, content, uuid) => JSON.stringify({ type, uuid, timestamp: "2026-11-02T10:00:00Z", message: { role: type, content } });
  fs.writeFileSync(file, [
    e("assistant", [{ type: "tool_use", id: "say1", name: "mcp__teach__say", input: { text: "Click Windows, then Dockable Dialogs." } },
      { type: "tool_use", id: "w1", name: "mcp__teach__watch", input: { expect: "open the Layers dialog" } }], "a1"),
    e("user", [{ type: "tool_result", tool_use_id: "w1", content: [{ type: "text", text: "Sam said: “I don't see Windows”\n(Call screen_look if you need to see what he means.)" }] }], "u1"),
    e("user", [{ type: "text", text: "[Teach app] screen on\nSam switched this lesson onto their screen." }], "u2"),
  ].join("\n") + "\n");
  const items = tr.history([{ path: file }]);
  const said = items.find((i) => i.id === "say1");
  assert.equal(said.t, "text"); assert.equal(said.said, true);
  assert.equal(items.find((i) => i.id === "w1").label, "Watching your screen: open the Layers dialog");
  assert.equal(items.find((i) => i.t === "user").text, "I don't see Windows");
  assert.equal(items.find((i) => i.t === "note").text, "On your screen");
});

test("history: answers that reached the tutor mid-turn, the app's record of answers, and sets the lesson moved past", () => {
  const dir = path.join(process.env.TEACH_PROJECTS, "p");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "q.jsonl");
  const at = "2026-11-04T05:31:00Z";
  const ask = (id, mid) => JSON.stringify({ type: "assistant", uuid: `a-${id}`, timestamp: at, message: { id: mid, role: "assistant",
    content: [{ type: "tool_use", id, name: "mcp__teach__ask", input: { questions: [{ prompt: "Which?", options: ["a", "b"], answer: 0 }] } }] } });
  fs.writeFileSync(file, [
    ask("set1", "m1"),                      // answered on their screen while the tutor was still talking: a queued_command
    ask("set2", "m2"),                      // the tutor asked the next set in that same turn
    JSON.stringify({ type: "attachment", uuid: "att1", timestamp: at, attachment: { type: "queued_command", timestamp: at,
      prompt: [{ type: "text", text: "[Answers to question set set1]\n1. Which?\n   → \"a\" (correct)" }] } }),
    ask("set3", "m3"),                      // set2 never answered, and the lesson moved on to set3
    ask("set4", "m4"),                      // answered in the app; its message isn't in the transcript yet
  ].join("\n") + "\n");
  const items = tr.history([{ path: file }], { answers: { set4: { answers: [{ choice: 0 }], results: [{ ok: true }] } } });
  const st = (id) => items.find((i) => i.id === id);
  assert.equal(st("set1").status, "answered");
  assert.equal(st("set2").status, "skipped"); assert.equal(st("set2").moved, true);
  assert.equal(st("set3").status, "skipped");
  assert.equal(st("set4").status, "answered"); assert.deepEqual(st("set4").results, [{ ok: true }]);
  assert.ok(!items.some((i) => i.t === "user" && /Answers to question set/.test(i.text)), "his answers don't show as a chat line");
});

test("scene: a spec for the stage, prediction gates validated and sorted; history keeps it with his predictions", () => {
  const spec = { title: "RC", objects: [{ id: "ax", axes: [0, 0, 100, 50] }], steps: [{ say: "a" }, { say: "b" }, { say: "c" }] };
  const sc = opsMod.normalizeScene({ scene: spec, predict: [{ step: 2, prompt: "Then?", kind: "number", answer: -20, unit: "dB" }, { step: 1, prompt: "Which?", options: ["up", "down"], answer: 1 }] });
  assert.deepEqual(sc.predict.map((p) => p.step), [1, 2]);
  assert.equal(sc.predict[1].tolerance, 1);
  assert.throws(() => opsMod.normalizeScene({ scene: spec, predict: [{ step: 0, prompt: "x", options: ["a", "b"] }] }), /later step/);
  assert.throws(() => opsMod.normalizeScene({ scene: { title: "empty" } }), /objects/);
  const dir = path.join(process.env.TEACH_PROJECTS, "p"), file = path.join(dir, "sc.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "assistant", uuid: "s1", timestamp: "2026-11-04T08:00:00Z", message: { id: "m", role: "assistant",
    content: [{ type: "tool_use", id: "scene1", name: "mcp__teach__scene", input: { scene: spec, predict: [{ step: 1, prompt: "Which?", options: ["up", "down"], answer: 1 }] } }] } }) + "\n");
  const it = tr.history([{ path: file }], { predictions: { scene1: { 1: { answer: { choice: 1 }, result: { ok: true } } } } }).find((i) => i.t === "scene");
  assert.equal(it.scene.title, "RC");
  assert.equal(it.predictions[1].result.ok, true);
});

test("ask -> a panel spec: shuffled options and keys as the app shows them, the box, the plan's progress", () => {
  const ops = opsMod;
  const topic = { title: "Neural network from scratch (Python)", plan: [{ id: "1", title: "A neuron", status: "done" }, { id: "2", title: "Loss", status: "current" }, { id: "3", title: "GD", status: "todo" }] };
  const ask = ops.shuffleAsk(ops.normalizeAsk({ purpose: "check", node: "2", box: [10, 20, 300, 18], questions: [
    { prompt: "σ(0)?", options: ["0", "0.5", "1"], answer: 1, why: "e^0 = 1" }, { kind: "text", prompt: "Why square it?" }] }), "toolu_1");
  const spec = screen.askPanel(topic, "toolu_1", ask);
  assert.equal(spec.tag, "teach-ask-toolu_1");
  assert.equal(spec.sub, "Neural network from scratch · step 2 of 3");
  assert.equal(spec.title, "Quick check: Loss");
  assert.deepEqual(spec.box, [10, 20, 300, 18]);
  assert.equal(spec.questions[0].options[spec.questions[0].answer], "0.5");
  assert.ok(screen.screenable(ask));
  assert.ok(!screen.screenable(ops.normalizeAsk({ questions: [{ kind: "order", prompt: "Order these", options: ["a", "b"] }] })));
});

test("review on screen: each due card as a panel, graded into the review schedule, a toast at the end", async () => {
  const ops = opsMod;
  ops.cards("gimp-layers", { items: [{ type: "card", front: "What does the eye icon do?", back: "Hides the layer" },
    { type: "mcq", prompt: "Which layer is drawn on top?", options: ["The bottom one", "The top one"], answer: 1 }] });
  fs.writeFileSync(path.join(tmp, "panel-results"), '{"status":"answered","button":"good"}\n{"status":"answered","answers":[{"choice":0}]}\n');
  fs.rmSync(path.join(tmp, "panel-n"), { force: true });
  fs.rmSync(LOG, { force: true });
  const s = mcp();
  const r = await s.req("tools/call", { name: "review", arguments: { count: 5 } }).done;
  const text = r.result.content[0].text;
  assert.match(text, /2 graded, 1 good/);
  assert.match(text, /eye icon.*good/);
  assert.match(text, /drawn on top.*again/);
  const panels = log().split("\n").filter((l) => l.startsWith("panel ")).map((l) => JSON.parse(l.slice(6)));
  assert.equal(panels.length, 2);
  assert.equal(panels[0].reveal, "Hides the layer");
  assert.equal(panels[1].questions[0].answer, 1);
  assert.equal(panels[0].tag, panels[1].tag);            // one panel that turns into the next card
  assert.match(log(), /toast Review done · 1 of 2 good/);
  const st = JSON.parse(fs.readFileSync(path.join(process.env.TEACH_STATE, "review.json"), "utf8"));
  const boxes = Object.values(st.items).map((x) => x.box).sort();
  assert.deepEqual(boxes, [0, 1]);
  s.close();
});

test("review on screen: a card he grades in the app's Review tab meanwhile comes down from his screen", async () => {
  const review = await import("../lib/review.mjs");
  const st0 = JSON.parse(fs.readFileSync(path.join(process.env.TEACH_STATE, "review.json"), "utf8"));
  for (const k of Object.keys(st0.items)) st0.items[k].due = 0;   // both cards due now, graded long ago
  for (const k of Object.keys(st0.items)) st0.items[k].last = 1;
  fs.writeFileSync(path.join(process.env.TEACH_STATE, "review.json"), JSON.stringify(st0));
  fs.writeFileSync(path.join(tmp, "panel-results"), 'WAIT\n{"status":"answered","button":"good"}\n');
  fs.rmSync(path.join(tmp, "panel-n"), { force: true });
  fs.rmSync(LOG, { force: true });
  const s = mcp();
  const pending = s.req("tools/call", { name: "review", arguments: { count: 2 } }).done;
  await sleep(600);
  const first = JSON.parse(log().split("\n").find((l) => l.startsWith("panel ")).slice(6));
  const firstId = review.queue({ slug: "gimp-layers" }).find((x) => first.text === x.front || first.questions?.[0]?.prompt === x.prompt).id;
  review.gradeItem("gimp-layers", firstId, true);                 // they did it in the app
  const r = await pending;
  assert.match(r.result.content[0].text, /graded in the Teach app/);
  assert.match(log(), /remove teach-review-/);                    // taken down
  assert.equal(log().split("\n").filter((l) => l.startsWith("panel ")).length, 2, "and the next card came up");
  s.close();
});

test("step progress shows as a toast on his screen", async () => {
  const ops = opsMod;
  ops.plan("gimp-layers", { nodes: [{ id: "1", title: "Layers panel" }, { id: "2", title: "Hide a layer" }] });
  fs.rmSync(LOG, { force: true });
  const s = mcp();
  await s.req("tools/call", { name: "step", arguments: { id: "1", status: "done", result: "2/2" } }).done;
  await s.req("tools/call", { name: "step", arguments: { id: "2", status: "current" } }).done;
  await sleep(200);
  assert.match(log(), /toast Step 1 done · 1 of 2 --color green/);
  assert.match(log(), /toast Step 2 of 2 · Hide a layer --color blue/);
  s.close();
});
