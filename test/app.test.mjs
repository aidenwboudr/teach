// node --test learning/app/test/*.test.mjs   — runs against a throwaway data folder, never the real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teach-test-"));
process.env.TEACH_DATA = path.join(tmp, "learning");
process.env.TEACH_STATE = path.join(tmp, "state");
process.env.TEACH_PROJECTS = path.join(tmp, "projects");
process.env.TEACH_WORK = path.join(tmp, "school");
process.env.TEACH_T3_DB = path.join(tmp, "no-t3.sqlite");
delete process.env.TEACH_LEARNER;
fs.mkdirSync(path.join(tmp, "learning", "topics"), { recursive: true });

const store = await import("../lib/store.mjs");
const ops = await import("../lib/ops.mjs");
const review = await import("../lib/review.mjs");
const tr = await import("../lib/transcript.mjs");
const sync = await import("../lib/sync.mjs");

test("slugs are short, readable and unique", () => {
  assert.equal(store.slugify("I want to learn how RC circuits charge!"), "rc-circuits-charge");
  const a = store.createTopic({ slug: "rc-circuits", title: "RC" });
  const b = store.createTopic({ slug: "rc-circuits", title: "RC again" });
  assert.equal(a.slug, "rc-circuits");
  assert.equal(b.slug, "rc-circuits-2");
});

test("update validates and appends", () => {
  store.createTopic({ slug: "e-field", title: "E" });
  ops.update("e-field", { goal: "Tell E from B", why: "exam", deadline: "2026-10-20", map: [{ strand: "Coulomb", has: "F = kq1q2/r²" }], facts_add: ["k = 8.99e9"] });
  ops.update("e-field", { facts_add: ["ε₀ = 8.85e-12"], sources_add: [{ label: "L9", path: "/x/L9.pdf" }, { label: "L9" }] });
  const t = store.getTopic("e-field");
  assert.equal(t.goal, "Tell E from B");
  assert.deepEqual(t.facts, ["k = 8.99e9", "ε₀ = 8.85e-12"]);
  assert.equal(t.sources.length, 1);
  assert.throws(() => ops.update("e-field", { deadline: "next week" }));
  assert.throws(() => ops.update("e-field", { why: "fun" }));
});

test("plan keeps step statuses across a re-plan; step marks one current", () => {
  ops.plan("e-field", { nodes: [{ id: "1", title: "Charge" }, { id: "2", title: "Field", deps: ["1", "9"] }] });
  ops.step("e-field", { id: "1", status: "done", result: "2/2" });
  ops.step("e-field", { id: "2", status: "current" });
  ops.plan("e-field", { nodes: [{ id: "1", title: "Charge" }, { id: "2", title: "Field lines" }, { id: "3", title: "Flux", deps: ["2"] }] });
  const t = store.getTopic("e-field");
  assert.deepEqual(t.plan.map((n) => n.status), ["done", "current", "todo"]);
  assert.equal(t.plan[0].result, "2/2");
  ops.step("e-field", { id: "3", status: "current" });
  assert.deepEqual(store.getTopic("e-field").plan.map((n) => n.status), ["done", "todo", "current"]);
  assert.throws(() => ops.step("e-field", { id: "7", status: "done" }), /no step/);
});

test("cards dedupe and validate", () => {
  const r1 = ops.cards("e-field", { items: [{ type: "card", front: "E unit", back: "N/C" }, { type: "mcq", prompt: "q", options: ["a", "b"], answer: 1 }] });
  const r2 = ops.cards("e-field", { items: [{ type: "card", front: "E unit", back: "N/C" }] });
  assert.equal(r1.added, 2);
  assert.equal(r2.added, 0);
  assert.throws(() => ops.cards("e-field", { items: [{ type: "mcq", prompt: "q", options: ["a", "b"], answer: 5 }] }));
  assert.throws(() => ops.cards("e-field", { items: [{ type: "recall", prompt: "q", answer: "a", accept: "(" }] }));
});

test("ask: drops a written-in I don't know, keeps the key, shuffles stably", () => {
  const raw = { purpose: "probe", questions: [{ prompt: "Same in parallel?", options: ["I don't know", "Current", "Voltage", "Resistance"], answer: 2, why: "KVL" }] };
  const a1 = ops.shuffleAsk(ops.normalizeAsk(raw), "seed-1");
  const a2 = ops.shuffleAsk(ops.normalizeAsk(raw), "seed-1");
  const q = a1.questions[0];
  assert.equal(q.options.length, 3);
  assert.equal(q.options[q.answer], "Voltage");
  assert.deepEqual(a1, a2);
  assert.equal(q.idk, true);
  const setup = ops.normalizeAsk({ purpose: "setup", questions: [{ prompt: "Footage?", options: ["Mine", "Stock"] }] });
  assert.equal(setup.questions[0].idk, false);
});

test("grading and the answers message", () => {
  const ask = ops.normalizeAsk({ questions: [
    { prompt: "V?", options: ["1", "2"], answer: 1 },
    { kind: "number", prompt: "I?", answer: 4, unit: "A" },
    { kind: "order", prompt: "Order", options: ["a", "b", "c"] },
    { kind: "text", prompt: "Predict" },
    { prompt: "Pick", options: ["x", "y"], answer: 0 },
  ] });
  ops.shuffleAsk(ask, "s");
  const order = ask.questions[2].correct.map((c) => ask.questions[2].options.indexOf(c));
  const answers = [{ choice: ask.questions[0].answer }, { value: "4.01" }, { order }, { text: "it rises" }, { idk: true }];
  const m = ops.answersMessage("toolu_X", ask, answers);
  assert.match(m.text, /^\[Answers to question set toolu_X\]/);
  assert.equal(m.right, 3);
  assert.equal(m.graded, 4);
  assert.match(m.text, /"it rises"/);
  assert.match(m.text, /I don't know/);
});

test("review: new items are due, a good grade pushes them out, again brings them back", () => {
  ops.update("e-field", {});
  const q1 = review.queue();
  assert.ok(q1.length >= 2);
  const first = q1[0];
  review.gradeItem(first.slug, first.id, true);
  assert.ok(!review.queue().some((x) => x.id === first.id));
  review.gradeItem(first.slug, first.id, false);
  const s = review.queue({ cram: true, slug: first.slug });
  assert.equal(s[0].id, first.id);   // weakest first when cramming
  store.mutateTopic("e-field", (t) => { t.settings.review = false; });
  assert.equal(review.counts().by["e-field"], undefined);
});

test("history: app asks, answers, chips, hidden app notes; fork duplicates and filler skipped", () => {
  const dir = path.join(tmp, "projects", "s");
  fs.mkdirSync(dir, { recursive: true });
  const L = (o) => JSON.stringify(o);
  const lines = [
    L({ type: "user", uuid: "u1", timestamp: "t", message: { content: [{ type: "text", text: "[Teach app] start\nNew topic.\nSam wrote:\nE vs B\n[end]\nLoad the skill." }] } }),
    L({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "Sam, first a probe." }, { type: "tool_use", id: "T1", name: "mcp__teach__ask", input: { questions: [{ prompt: "F on q?", options: ["qE", "qB"], answer: 0 }] } }] } }),
    L({ type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "T1", content: "Shown." }] } }),
    L({ type: "user", uuid: "u3", message: { content: [{ type: "text", text: "[Answers to question set T1]\n1. F on q?\n   → \"qE\" (correct)" }] } }),
    L({ type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", id: "T2", name: "mcp__teach__step", input: { id: "1", status: "done", result: "2/2" } }, { type: "tool_use", id: "T3", name: "Read", input: { file_path: "/x/L9.pdf" } }] } }),
    L({ type: "user", uuid: "u4", message: { content: [{ type: "text", text: "<task-notification>done</task-notification>" }] } }),
  ];
  fs.writeFileSync(path.join(dir, "a.jsonl"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "b.jsonl"), lines.join("\n") + "\n" + L({ type: "assistant", uuid: "a3", message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } }) + "\n" + L({ type: "user", uuid: "u5", message: { content: [{ type: "text", text: "why qE?" }] } }) + "\n");
  const h = tr.history([{ path: path.join(dir, "a.jsonl") }, { path: path.join(dir, "b.jsonl") }], { answers: { T1: { answers: [{ choice: 0 }], results: [{ ok: true }] } }, plan: [{ id: "1", title: "Charge" }] });
  const kinds = h.map((i) => i.t);
  assert.deepEqual(kinds, ["divider", "user", "text", "ask", "chip", "activity", "divider", "user"]);
  assert.equal(h[1].text, "E vs B");
  assert.equal(h[3].status, "answered");
  assert.equal(h[4].text, "Step 1 · Charge · done · 2/2");
  assert.equal(h.at(-1).text, "why qE?");
});

test("entries reads a transcript as it grows (cuts mid-line and mid-character) and drops tool screenshots", () => {
  const f = path.join(tmp, "projects", "s", "grow.jsonl");
  const shot = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(3 << 20) } };
  const all = Buffer.from([
    JSON.stringify({ type: "user", uuid: "g1", message: { content: [{ type: "text", text: "héllo ∂L/∂w" }] } }),
    JSON.stringify({ type: "user", uuid: "g2", toolUseResult: [shot], message: { content: [{ type: "tool_result", tool_use_id: "L1", content: [{ type: "text", text: "looked" }, shot] }] } }),
    JSON.stringify({ type: "user", uuid: "g3", message: { content: [{ type: "text", text: "ü".repeat(2 << 20) }] } }),
  ].join("\n") + "\n");
  fs.writeFileSync(f, "");
  for (const cut of [3, 15, 1 << 20, (1 << 20) + 1, 5 << 20, all.length]) {
    fs.writeFileSync(f, all.subarray(0, cut));
    tr.entries(f);
  }
  const e = tr.entries(f);
  assert.deepEqual(e.map((x) => x.uuid), ["g1", "g2", "g3"]);
  assert.equal(e[0].message.content[0].text, "héllo ∂L/∂w");
  assert.equal(e[2].message.content[0].text.length, 2 << 20);
  assert.deepEqual(e[1].message.content[0].content, [{ type: "text", text: "looked" }]);
  assert.equal(e[1].toolUseResult, undefined);
  fs.writeFileSync(f, all.subarray(0, all.indexOf(10) + 1));     // rewritten shorter: read again from the start
  assert.deepEqual(tr.entries(f).map((x) => x.uuid), ["g1"]);
});

test("a restarted server stops the tutors the old one left running, and nothing else", async () => {
  const { spawn } = await import("node:child_process");
  const { Engine } = await import("../lib/engine.mjs");
  const fake = (slug) => spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", JSON.stringify({ TEACH_TOPIC: slug })]);
  const left = fake("nn"), other = fake("rc");
  const dir = path.join(process.env.TEACH_STATE, "tutors");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "nn.pid"), String(left.pid));
  fs.writeFileSync(path.join(dir, "e-field.pid"), String(other.pid));    // a pid since reused by something else
  await new Promise((r) => setTimeout(r, 200));
  const gone = new Promise((r) => left.on("exit", r));
  new Engine(() => {});
  await gone;
  assert.equal(other.exitCode, null);
  assert.deepEqual(fs.readdirSync(dir), []);
  other.kill();
});

test("pendingAsk finds an unanswered AskUserQuestion from a chat session", () => {
  const f = path.join(tmp, "projects", "s", "c.jsonl");
  fs.writeFileSync(f, [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "Q1", name: "AskUserQuestion", input: { questions: [{ question: "Series C: same?", header: "Series", options: [{ label: "Charge" }, { label: "Voltage" }], multiSelect: false }] } }] } }),
  ].join("\n") + "\n");
  const p = tr.pendingAsk(f);
  assert.equal(p.id, "Q1");
  assert.equal(p.ask.questions[0].options.length, 2);
  assert.equal(p.legacy, true);
});

test("findSessions streams transcripts: a marker across a chunk edge counts, app sessions and big chatter don't", () => {
  const dir = path.join(tmp, "projects", "-srv-x-notes");
  fs.mkdirSync(dir, { recursive: true });
  const user = (text) => JSON.stringify({ type: "user", cwd: "/srv/x/notes", message: { content: [{ type: "text", text }] } });
  const skill = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "S1", name: "Skill", input: { skill: "teach", args: "Neural nets from scratch" } }] } });
  const pad = (n) => user("é".repeat(n));                              // two-byte text, like real transcripts
  // The marker "skill":"teach" straddles the first 1 MB chunk boundary.
  const head = user("teach me neural nets");
  const markerAt = (filler) => Buffer.byteLength(head + "\n" + filler + "\n") + skill.indexOf('"skill":"teach"');
  const filler = pad(Math.floor((2 ** 20 - 6 - markerAt(pad(0))) / 2));
  assert.ok(markerAt(filler) < 2 ** 20 && markerAt(filler) + 15 > 2 ** 20);
  fs.writeFileSync(path.join(dir, "edge.jsonl"), [head, filler, skill].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "app.jsonl"), [user("[Teach app] start"), skill].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "chat.jsonl"), [user("unrelated"), pad(3 * 2 ** 20)].join("\n") + "\n");
  const ids = tr.findSessions().flatMap((g) => g.sessions.map((s) => s.id));
  assert.deepEqual(ids, ["edge"]);
  assert.equal(tr.findSessions()[0].title, "Neural nets from scratch");
});

test("sync sees every changed file, the first one included", async () => {
  const { execFileSync } = await import("node:child_process");
  const repo = path.join(tmp, "repo"), git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  for (const f of ["learning/topics/a/topic.json", "learning/topics/b/log.md", "learning/app/x.mjs"]) {
    fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), "1\n");
  }
  git("init", "-q"); git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  fs.writeFileSync(path.join(repo, "learning/topics/a/topic.json"), "2\n");   // " M", sorts first
  fs.writeFileSync(path.join(repo, "learning/app/x.mjs"), "2\n");             // the app: not data
  fs.writeFileSync(path.join(repo, "learning/topics/b/étude.md"), "new\n");    // non-ASCII name
  const got = (await sync.changedFiles(repo, "learning")).map((c) => c.code + c.file);
  assert.deepEqual(got, [" Mlearning/topics/a/topic.json", "??learning/topics/b/étude.md"]);
});
