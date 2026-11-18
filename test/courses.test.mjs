// Courses and programs: the pure parts (normalizing, where a course comes from, hours, the schedule, a program's
// timeline, the gradebook), then the server end to end on a throwaway port with a stand-in model
// (test/fixtures/courses-fake-model.mjs) and stand-ins for the calendar, the check-in and the school commands. Every
// school item, course and person here is made up or comes from the example course in examples/.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teach-courses-"));
const D = (x) => path.join(tmp, x);
for (const d of ["learning/topics", "state", "work", "projects"]) fs.mkdirSync(D(d), { recursive: true });
Object.assign(process.env, { TEACH_DATA: D("learning"), TEACH_STATE: D("state") });
const C = await import("../lib/courses.mjs");
const W = await import("../lib/coursework.mjs");
const example = JSON.parse(fs.readFileSync(path.join(APP, "examples/courses/minds-and-machines.json"), "utf8"));
const ppe = JSON.parse(fs.readFileSync(path.join(APP, "examples/programs/ppe.json"), "utf8"));

// ---------- pure ----------

test("the examples normalize: 5 units, 25 lectures, the real exams, grading that adds to 100", () => {
  const c = C.normalizeCourse(example);
  assert.equal(c.units.length, 5);
  assert.equal(c.units.reduce((a, u) => a + u.lectures.length, 0), 25);
  assert.deepEqual(c.exams.filter((x) => ["midterm", "final"].includes(x.kind)).map((x) => x.source), ["real", "real"]);
  assert.equal(c.grading.reduce((a, g) => a + g.weight, 0), 100);
  const p = C.normalizeProgram(ppe);
  assert.equal(p.slots.filter((s) => s.counts).length, 16, "16 course units, plus the statistics prerequisite");
  for (const s of p.slots) for (const a of s.after) assert.ok(p.slots.find((x) => x.id === a).order < s.order, `${s.id} comes after ${a}`);
});

test("provenance: one complete course has no label; several sources, or anything generated, say so", () => {
  const one = { sources: ["lectures", "readings", "assignments", "exams"].map((part) => ({ part, title: "X 101", institution: "Example U", url: "https://example.edu/x101/" })) };
  assert.equal(C.provenance(one).stitched, false);
  const gen = { sources: [...one.sources.slice(0, 2), { part: "exams", generated: true }] };
  assert.equal(C.provenance(gen).stitched, true);
  assert.match(C.provenance(gen).line, /^Lectures and readings from Example U X 101; exams generated in Teach$/);
  const two = { sources: [...one.sources.slice(0, 3), { part: "exams", title: "Y 202", institution: "Other U", url: "https://other.edu/y/" }] };
  assert.match(C.provenance(two).line, /exams from Other U Y 202/);
  assert.equal(C.provenance(C.normalizeCourse(example)).stitched, true, "Minds and Machines takes its written analyses from a second edition");
});

test("hours follow the course's own load and the pre-test: a known unit shrinks, reading less than lessons", () => {
  const c = C.normalizeCourse(example), u = c.units[1];
  const none = C.unitHours(c, u), known = C.unitHours(c, u, { known: 1 });
  assert.equal(none.basis, "before pre-test");
  assert.ok(known.concept < none.concept * 0.3);
  assert.ok(known.reading > none.reading * 0.5, "reading takes the time reading takes");
  const math = C.normalizeCourse({ ...example, hours: { kind: "math", lectureMinutes: 50 } });
  assert.ok(C.unitHours(math, math.units[1]).concept > none.concept, "a math course's lessons take longer than its lectures");
});

test("the schedule: committed due days from weekly budgets, in course order; a lighter week pushes later ones out", () => {
  const c = C.normalizeCourse(example);
  const due = C.paceDue(c, { from: "2026-11-30", base: 6 });
  const order = C.workList(c).map((x) => x.id);
  for (let i = 1; i < order.length; i++) assert.ok(due[order[i]] >= due[order[i - 1]], `${order[i]} after ${order[i - 1]}`);
  c.plan.weeks["2026-11-30"] = { target: 2 };
  const lighter = C.paceDue(c, { from: "2026-11-30", base: 6 });
  assert.ok(lighter.final > due.final);
});

test("a program's timeline: prerequisites first, courses at a time, each course's own hours", () => {
  const p = C.normalizeProgram(ppe);
  const hours = (s) => ({ total: 60, left: 60 });
  const one = C.timeline(p, { hoursOf: hours, startDay: "2026-11-30" });
  const two = C.timeline({ ...p, pace: { hoursPerWeek: 12, concurrent: 2 } }, { hoursOf: hours, startDay: "2026-11-30" });
  assert.ok(two.weeks < one.weeks);
  const at = (t, id) => t.slots.find((x) => x.slot === id);
  assert.ok(at(two, "strategic-reasoning").startWeek >= at(two, "micro").endWeek, "game theory waits for micro");
  assert.ok(at(two, "capstone").startWeek >= at(two, "statistics").endWeek);
});

test("the gradebook weights what's graded; practice and the pre-test don't count", () => {
  const c = C.normalizeCourse(example);
  c.attempts.midterm = { state: "graded", grade: { score: 40, max: 50 } };
  c.work["aa1-written"] = { state: "graded", grade: { score: 27, max: 30 } };
  c.exams.push({ ...c.exams[1], id: "midterm-practice-1", practice: true, of: "midterm" });
  c.attempts["midterm-practice-1"] = { state: "graded", grade: { score: 10, max: 50 } };
  const g = C.gradebook(c);
  assert.equal(g.weightGraded, 40);
  assert.equal(g.current, Math.round(((90 * 10 + 80 * 30) / 40) * 10) / 10);
  assert.equal(g.practice[0].score.pct, 20);
});

test("an answer key given as the option's text is matched to the option; one that matches nothing isn't a key", () => {
  assert.equal(C.normalizeQuestion({ kind: "choice", prompt: "Who?", options: ["U. T. Place", "John Searle"], answer: "U.T. Place" }, 0).answer, 0);
  assert.deepEqual(C.normalizeQuestion({ kind: "multi", prompt: "Which?", options: ["a", "b", "c"], answer: ["b", 2] }, 0).answer, [1, 2]);
  assert.equal(C.normalizeQuestion({ kind: "choice", prompt: "Who?", options: ["a", "b"], answer: "nobody" }, 0).answer, undefined);
  assert.equal(C.normalizeQuestion({ kind: "multi", prompt: "Which?", options: ["a", "b"], answer: ["a", "zz"] }, 0).answer, undefined, "a partly unmatched key isn't trusted");
});

test("a pre-test's result per unit counts 'I don't know' as not known; auto-grading leaves written answers for the grader", () => {
  const qs = [1, 1, 2].map((unit, i) => ({ n: i + 1, unit, kind: "choice", options: ["a", "b"], answer: 0 }));
  const r = W.pretestResult(qs, [{ choice: 0 }, { idk: true }, { choice: 1 }]);
  assert.deepEqual(r.byUnit[1], { right: 1, of: 2, idk: 1, known: 0.5 });
  assert.equal(r.byUnit[2].known, 0);
  const res = W.autoGrade([{ n: 1, kind: "choice", options: ["a", "b"], answer: 1, points: 2 }, { n: 2, kind: "text", prompt: "Why?", points: 5 }], [{ choice: 1 }, { text: "because" }]);
  assert.equal(res[0].points, 2);
  assert.ok(res[1].pending);
});

test("page text: HTML escaped inside an attribute (as Open edX ships problems) comes out as text, entities decoded", () => {
  const t = W.htmlText(`<div data-content="&lt;p&gt;Who wrote &amp;ldquo;the phenomenological fallacy&amp;rdquo;?&lt;/p&gt;&lt;label&gt;Ren&amp;eacute;&lt;/label&gt;"></div>`);
  assert.doesNotMatch(t, /[<>]|&[a-z]+;/);
  assert.match(t, /Who wrote "the phenomenological fallacy"\?/);
  assert.match(t, /René/);
});

test("an Open edX page's problems, which load by script, come in through each problem's public handler, in page order", async () => {
  const course = "https://learn.example.edu/courses/course-v1:EX+101x+2020";
  const ids = ["a".repeat(32), "b".repeat(32)].map((h) => `block-v1:EX+101x+2020+type@problem+block@${h}`);
  const site = {
    [`${course}/courseware/exam/`]: `<h2>Part I</h2>${ids.map((id) => `<div data-usage-id="${id}">Loading…</div>`).join("")}`,
    ...Object.fromEntries(ids.map((id, i) => [`${course}/xblock/${id}/handler/xmodule_handler/problem_get`, JSON.stringify({ html: `<h3>Problem ${i + 1}</h3><p>Question ${i + 1}?</p>` })])),
  };
  const fetchFn = async (u) => ({ ok: !!site[u], status: site[u] ? 200 : 404, headers: new Map([["content-type", u.includes("problem_get") ? "application/json" : "text/html"]]),
    text: async () => site[u], json: async () => JSON.parse(site[u]) });
  const [p] = await W.gather([`${course}/courseware/exam/`], { fetchFn, max: 1 });
  assert.match(p.text, /Problem 1\s+Question 1\?[\s\S]*Problem 2\s+Question 2\?/);
});

test("a course's pages: text from HTML, and the same site's course pages followed", async () => {
  const site = {
    "https://example.edu/c/x101/": `<html><body><nav>skip</nav><h1>X 101</h1><p>Intro &amp; more</p><a href="/c/x101/pages/syllabus/">Syllabus</a><a href="/c/x101/pages/exams/">Exams</a><a href="https://elsewhere.org/">away</a></body></html>`,
    "https://example.edu/c/x101/pages/syllabus/": "<p>Grading: final 50%</p>",
    "https://example.edu/c/x101/pages/exams/": "<p>Midterm with solutions</p>",
  };
  const fetchFn = async (u) => ({ ok: !!site[u], status: site[u] ? 200 : 404, headers: new Map([["content-type", "text/html"]]), text: async () => site[u] });
  const pages = await W.gather(["https://example.edu/c/x101/"], { fetchFn });
  assert.deepEqual(pages.map((p) => p.url).sort(), Object.keys(site).sort());
  assert.match(pages[0].text, /Intro & more/);
  assert.doesNotMatch(pages[0].text, /skip/);
});

// ---------- the server ----------

const port = await new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const BASE = `http://127.0.0.1:${port}`;
const exe = (name, body) => { fs.writeFileSync(D(name), body, { mode: 0o755 }); return D(name); };
const logger = (name) => exe(`${name}.mjs`, `#!/usr/bin/env node\nimport("node:fs").then((fs) => { fs.appendFileSync(${JSON.stringify(D(`${name}.log`))}, JSON.stringify(process.argv.slice(2)) + "\\n"); console.log("added  [ab12cd]"); });\n`);
fs.writeFileSync(D("open.json"), JSON.stringify([{ course: "EXMP 101", title: "Homework 9", due: "2026-11-20T23:59:00Z" }]));
const SCHOOL = exe("school.mjs", `#!/usr/bin/env node\nimport("node:fs").then((fs) => { const c = process.argv[2]; console.log(c === "open" ? JSON.stringify({ open: JSON.parse(fs.readFileSync(${JSON.stringify(D("open.json"))}, "utf8")), fresh: new Date().toISOString() }) : JSON.stringify({ weeks: [] })); });\n`);
const env = { ...process.env, TEACH_CONFIG: "/dev/null", TEACH_DATA: D("learning"), TEACH_STATE: D("state"), TEACH_WORK: D("work"), TEACH_PROJECTS: D("projects"), TEACH_PORT: String(port),
  TEACH_VISUALIZE_CMD: path.join(APP, "test/fixtures/courses-fake-model.mjs"), TEACH_CALENDAR_CMD: logger("cal"), TEACH_CALENDAR_MOVE_CMD: logger("move"), TEACH_CHECKIN_CMD: logger("checkin"), TEACH_SCHOOL_CMD: SCHOOL, TEACH_CLAUDE: process.execPath };
delete env.TEACH_SOCKET;
const server = spawn(process.execPath, [path.join(APP, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let out = ""; server.stdout.on("data", (d) => (out += d)); server.stderr.on("data", (d) => (out += d));
after(() => { server.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });
for (let i = 0; i < 80 && !/teach: http/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
const api = async (p, body, method) => { const r = await fetch(BASE + p, { method: method || (body ? "POST" : "GET"), headers: { "X-Teach": "1", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
const until = async (fn, what, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 150)); } assert.fail(`timed out: ${what}\n${out.slice(-2000)}`); };
const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA"); };

test("server: a program starts when its gate opens, hands the start on, and makes the first pre-test", async () => {
  assert.equal((await api("/api/courses/import", { course: example })).slug, "minds-and-machines");
  assert.equal((await api("/api/programs/import", { program: { ...ppe, start: { kind: "gate", label: "When school work is in", gate: { from: plus(0), through: plus(10), askAfter: plus(12) } } } })).slug, "ppe");
  let v = await api("/api/programs/ppe/check", {});
  assert.equal(v.start.state, "waiting");
  assert.equal(v.start.last.open.length, 1);
  assert.equal((await api("/api/courses/minds-and-machines")).course.start, "", "nothing starts while it waits");
  fs.writeFileSync(D("open.json"), "[]");
  v = await api("/api/programs/ppe/check", {});
  assert.equal(v.start.state, "started");
  const sent = fs.readFileSync(D("checkin.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(sent.some((a) => a.includes("teach-start-ppe") && !a.includes("--urgent")));
  await until(async () => (await api("/api/courses/minds-and-machines")).pretest?.state === "ready", "the pre-test");
});

test("server: a gate past its ask-after day asks once and keeps checking, never starts by itself", async () => {
  await api("/api/programs/import", { program: { ...ppe, slug: "ppe-two", slots: ppe.slots.map((s) => ({ ...s, course: "" })), start: { kind: "gate", gate: { from: plus(-20), through: plus(-6), askAfter: plus(-1) } } } });
  fs.writeFileSync(D("open.json"), JSON.stringify([{ course: "EXMP 101", title: "Lab 7", due: "2026-11-20" }]));
  let v = await api("/api/programs/ppe-two/check", {});
  assert.equal(v.start.state, "asked");
  v = await api("/api/programs/ppe-two/check", {});
  assert.equal(v.start.state, "asked");
  const asks = fs.readFileSync(D("checkin.log"), "utf8").split("\n").filter((l) => l.includes("teach-start-ask-ppe-two"));
  assert.equal(asks.length, 1, "asked once");
});

test("server: the pre-test hides its key until it's taken, then shapes the plan", async () => {
  const pt = await api("/api/courses/minds-and-machines/pretest");
  assert.ok(pt.pretest.questions.every((q) => q.answer === undefined && q.why === undefined));
  const answers = pt.pretest.questions.map((q) => (q.unit <= 2 ? { choice: 0 } : { idk: true }));
  const r = await api("/api/courses/minds-and-machines/pretest", { op: "answer", answers });
  assert.equal(r.result.byUnit[1].known, 1);
  const v = await api("/api/courses/minds-and-machines");
  assert.equal(v.units[0].mode, "fast");
  assert.ok(v.changes.some((c) => c.rule === "strong"));
  assert.equal((await api("/api/courses/minds-and-machines/pretest", { op: "answer", answers })).status, 409, "taken once");
});

test("server: a real exam is one sitting; its questions stay hidden until then; a practice version can be retaken", async () => {
  await api("/api/courses/minds-and-machines/exam/midterm", { op: "load" });
  await until(async () => (await api("/api/courses/minds-and-machines")).exams.find((x) => x.id === "midterm").loaded, "the real midterm");
  const page = JSON.stringify(await api("/api/courses/minds-and-machines"));
  assert.doesNotMatch(page, /Explain Gertler's argument/);
  const s = await api("/api/courses/minds-and-machines/exam/midterm", { op: "start" });
  assert.ok(s.attempt.questions.every((q) => q.answer === undefined && q.model === undefined), "no key in the sitting");
  await api("/api/courses/minds-and-machines/exam/midterm", { op: "submit", answers: [{ choice: 2 }, { choice: 0 }, { text: "Conceivability of disembodiment." }] });
  const g = await until(async () => { const x = await api("/api/courses/minds-and-machines/exam/midterm"); return x.attempt?.state === "graded" && x; }, "graded");
  assert.equal(g.attempt.grade.score, 3 + 1 + 2);
  assert.equal((await api("/api/courses/minds-and-machines/exam/midterm", { op: "start" })).status, 409);
  await api("/api/courses/minds-and-machines/exam/midterm", { op: "practice" });
  const pid = await until(async () => (await api("/api/courses/minds-and-machines")).exams.find((x) => x.practice)?.id, "a practice version");
  for (let i = 0; i < 2; i++) {
    assert.equal((await api(`/api/courses/minds-and-machines/exam/${pid}`, { op: "start" })).status, 200);
    await api(`/api/courses/minds-and-machines/exam/${pid}`, { op: "submit", answers: [{ choice: 0 }] });
    await until(async () => (await api(`/api/courses/minds-and-machines/exam/${pid}`)).attempt?.state === "graded", "practice graded");
  }
  assert.ok((await api("/api/courses/minds-and-machines")).exams.find((x) => x.id === pid).title.startsWith("Practice"));
});

test("server: an exam's questions and key are sealed outside the learning folder; a sat exam can't become practice on re-import", async () => {
  const found = fs.readdirSync(D("learning"), { recursive: true }).filter((f) => fs.statSync(path.join(D("learning"), f)).isFile())
    .filter((f) => fs.readFileSync(path.join(D("learning"), f), "utf8").includes("Explain Gertler's argument"));
  assert.deepEqual(found, [], "no file in the learning folder holds the exam's text");
  assert.ok(fs.existsSync(D("state/sealed/minds-and-machines/midterm.json")));
  assert.doesNotMatch(fs.readFileSync(D("state/sealed/minds-and-machines/midterm.json"), "utf8"), /Gertler/);
  const swapped = { ...example, exams: example.exams.map((x) => (x.id === "midterm" ? { ...x, practice: true } : x)) };
  const r = await api("/api/courses/import", { course: swapped, replace: true });
  assert.equal(r.status, 400);
  assert.match(r.error, /has been sat/);
  const dropped = { ...example, exams: example.exams.filter((x) => x.id !== "midterm") };
  await api("/api/courses/import", { course: dropped, replace: true });
  assert.ok((await api("/api/courses/minds-and-machines")).exams.some((x) => x.id === "midterm"), "a sat exam isn't dropped by a new version");
});

test("server: a practice sitting being graded can't be retaken; a pre-test can't be remade once taken", async () => {
  const pid = (await api("/api/courses/minds-and-machines")).exams.find((x) => x.practice).id;
  await api(`/api/courses/minds-and-machines/exam/${pid}`, { op: "start" });
  await api(`/api/courses/minds-and-machines/exam/${pid}`, { op: "submit", answers: [{ choice: 0 }, { text: "a long answer for the grader" }] });
  const now = await api(`/api/courses/minds-and-machines/exam/${pid}`);
  if (now.attempt.state === "grading") assert.equal((await api(`/api/courses/minds-and-machines/exam/${pid}`, { op: "start" })).status, 409);
  await until(async () => (await api(`/api/courses/minds-and-machines/exam/${pid}`)).attempt?.state === "graded", "graded");
  assert.equal((await api("/api/courses/minds-and-machines/pretest", { op: "make" })).status, 409);
});

test("server: a sitting whose sealed questions are gone is handed in with an error, and the server keeps running", async () => {
  const pid = (await api("/api/courses/minds-and-machines")).exams.find((x) => x.practice).id;
  await api(`/api/courses/minds-and-machines/exam/${pid}`, { op: "start" });
  fs.rmSync(D(`state/sealed/minds-and-machines/${pid}.json`));
  await api(`/api/courses/minds-and-machines/exam/${pid}`, { op: "submit", answers: [{ choice: 0 }] });
  const v = await api(`/api/courses/minds-and-machines/exam/${pid}`);
  assert.match(v.attempt?.error || "", /missing/);
  assert.equal(v.exam.loaded, false, "loaded follows the sealed store");
  assert.equal((await api("/api/courses")).status, 200, "still up");
});

test("server: written work goes to the grader once; the grade is against the rubric", async () => {
  assert.equal((await api("/api/courses/minds-and-machines/work/aa1-written", { op: "submit", text: "too short" })).status, 400);
  await api("/api/courses/minds-and-machines/work/aa1-written", { op: "submit", text: "Searle replies to the brain simulator. ".repeat(30) });
  const w = await until(async () => { const x = await api("/api/courses/minds-and-machines/work/aa1-written"); return x.work.state === "graded" && x; }, "graded");
  assert.equal(w.work.grade.score, 20);
  assert.equal(w.work.grade.max, 30);
  assert.equal((await api("/api/courses/minds-and-machines/work/aa1-written", { op: "submit", text: "again" })).status, 409);
});

test("server: deadlines on the calendar once, moved not re-added; undo a change; the check-in", async () => {
  const r = await api("/api/courses/minds-and-machines/calendar", {});
  assert.ok(r.added >= 8);
  await api("/api/courses/minds-and-machines/calendar", {});
  const titles = fs.readFileSync(D("cal.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)[0]);
  assert.equal(new Set(titles).size, titles.length, "nothing is added twice: a deadline the professor moved is moved on the calendar (TEACH_CALENDAR_MOVE_CMD)");
  const v = await api("/api/courses/minds-and-machines");
  const ch = v.changes.find((c) => c.rule === "strong" && !c.undone);
  await api("/api/courses/minds-and-machines/undo", { id: ch.id });
  assert.equal((await api("/api/courses/minds-and-machines")).units[0].mode, "normal");
  const dry = await api("/api/courses/checkin", { dry: true });
  assert.match(dry.message, /Minds and Machines/);
  const before = fs.readFileSync(D("checkin.log"), "utf8");
  await api("/api/courses/checkin", { dry: true });
  assert.equal(fs.readFileSync(D("checkin.log"), "utf8"), before, "a dry run sends nothing");
});

test("server: a professor run that changes nothing doesn't rewrite the course (no sync churn)", async () => {
  const f = D("learning/courses/minds-and-machines/course.json");
  await api("/api/courses/minds-and-machines/oversee", {});
  const before = fs.statSync(f).mtimeMs;
  await api("/api/courses/minds-and-machines/oversee", {});
  assert.equal(fs.statSync(f).mtimeMs, before);
});

test("server: notes for the professor stay in the state folder, not the learning folder", async () => {
  await api("/api/context", { text: "busy week, travelling" });
  assert.ok(fs.existsSync(D("state/context.json")));
  assert.doesNotMatch(JSON.stringify(fs.readdirSync(D("learning"), { recursive: true })), /context/);
});
