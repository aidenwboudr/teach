// The end-of-session actions (lib/actions.mjs) and printable documents (lib/doc.mjs): which actions fit which kind of
// topic and in what order, the note-sheet rule read from a topic's own words, settings, the tutor's brief, the
// calendar pieces, delivering, and (when a browser is installed) a real PDF fitted to its page budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teach-actions-test-"));
Object.assign(process.env, { TEACH_DATA: path.join(tmp, "learning"), TEACH_STATE: path.join(tmp, "state"), TEACH_PROJECTS: path.join(tmp, "projects"), TEACH_WORK: path.join(tmp, "work") });
fs.mkdirSync(path.join(tmp, "learning", "topics"), { recursive: true });
const A = await import("../lib/actions.mjs");
const store = await import("../lib/store.mjs");
const ops = await import("../lib/ops.mjs");
const review = await import("../lib/review.mjs");
const { findChrome } = await import("../skill/render-svg.mjs");

const NOW = Date.parse("2026-11-10T20:00:00");
const plan = (statuses) => statuses.map((status, i) => ({ id: String(i + 1), title: `Step ${i + 1}`, status, deps: [] }));
const topic = (o) => store.blankTopic("x", { title: "X", plan: plan(["done", "done", "shaky", "todo"]), ...o });
const kinds = (t, o = {}) => A.tiles(t, { now: NOW, calendar: true, ...o }).tiles.map((x) => x.kind);

test("a course's rule, read from the topic's own words", () => {
  assert.deepEqual(A.parseAllowance("In-class exam Fri Nov 6, ~20 MC; one 8.5x11 two-sided note sheet + calculator allowed."), { kind: "sheet", paper: "letter", sheets: 1, sides: 2, text: A.parseAllowance("In-class exam Fri Nov 6, ~20 MC; one 8.5x11 two-sided note sheet + calculator allowed.").text });
  const e = A.parseAllowance("You are allowed one 8-1/2x11 note sheet (front and back), a calculator, and scratch paper.");
  assert.equal(e.kind, "sheet"); assert.equal(e.sides, 2); assert.equal(e.sheets, 1);
  assert.equal(A.parseAllowance("You may bring a 2-SIDED Equation Sheet (both sides of an 8.5\"x11\" sheet of paper).").sides, 2);
  assert.equal(A.parseAllowance("one 3x5 index card, one side").paper, "index-3x5");
  assert.equal(A.parseAllowance("75 min, closed notes, 3-4 pages").kind, "none");
  assert.equal(A.parseAllowance("open book and open notes").kind, "open");
  assert.equal(A.parseAllowance("No note sheet: I will provide all equations you need").kind, "none");
  assert.equal(A.parseAllowance("Graded homework: parallel problems only."), null);
  // the goal counts only when it names the rule outright ("without notes" there is what to learn)
  assert.equal(A.allowanceOf(topic({ goal: "Solve every problem type without notes" })), null);
  assert.equal(A.allowanceOf(topic({ goal: "Write the 75-minute, closed-notes essay" })).kind, "none");
  // a rule the tutor recorded wins
  assert.equal(A.allowanceOf(topic({ allowance: { kind: "sheet", paper: "index-4x6", sheets: 1, sides: 1 }, integrity: "closed notes" })).paper, "index-4x6");
});

test("which actions fit which situation, best first", () => {
  const exam = (o) => topic({ why: "exam", deadline: "2026-11-14", ...o });
  // an exam with a note sheet allowed: the sheet leads, then problems
  assert.deepEqual(kinds(exam({ integrity: "one 8.5x11 sheet, front and back" })).slice(0, 3), ["sheet", "worksheet", "practice"]);
  // the night before: the timed practice test leads, and the review session is a last look
  const tonight = kinds(exam({ deadline: "2026-11-11", integrity: "one 8.5x11 sheet, front and back" }));
  assert.equal(tonight[0], "sheet"); assert.ok(tonight.indexOf("practice") < tonight.indexOf("session"));
  // closed-notes essay: practice and a study sheet, no worksheet
  const essay = A.tiles(exam({ goal: "Write the closed-notes in-class essay" }), { now: NOW }).tiles;
  assert.ok(!essay.some((x) => x.kind === "worksheet"));
  assert.equal(essay.find((x) => x.kind === "sheet").title, "Study sheet");
  assert.equal(essay.find((x) => x.kind === "practice").title, "Timed essay practice");
  // a hardware project: the bench card leads; no worksheet near the top
  const proj = kinds(topic({ why: "project" }));
  assert.equal(proj[0], "quickref");
  assert.ok(proj.indexOf("assignment") < proj.indexOf("notes"));
  // learning an app: practice on your own leads
  assert.equal(kinds(topic({ why: "skill" }))[0], "assignment");
  // a class concept: worksheet and notes
  assert.deepEqual(kinds(topic({ why: "class", plan: plan(["done", "done"]) })).slice(0, 2), ["worksheet", "notes"]);
  // nothing taught yet: only the next session
  assert.deepEqual(kinds(topic({ why: "skill", plan: plan(["todo", "todo"]) })), ["session"]);
  // the tutor's picks lead, in its order, with its why
  const picked = A.tiles(topic({ why: "class", suggest: [{ kind: "cards", why: "He asked for these" }, { kind: "notes" }] }), { now: NOW }).tiles;
  assert.deepEqual(picked.slice(0, 2).map((x) => x.kind), ["cards", "notes"]);
  assert.equal(picked[0].why, "He asked for these");
  assert.ok(picked.length <= 8);
  // the ones already made stay, whatever the situation
  assert.ok(kinds(topic({ why: "skill", plan: plan(["todo"]), outputs: { notes: { kind: "notes", state: "ready", files: [] } } })).includes("notes"));
});

test("settings: defaults from the topic, saved ones over them, values checked", () => {
  const t = topic({ why: "exam", deadline: "2026-11-14", integrity: "one 3x5 index card, front and back" });
  const sheet = A.tiles(t, { now: NOW }).tiles.find((x) => x.kind === "sheet");
  const f = Object.fromEntries(sheet.fields.map((x) => [x.key, x.value]));
  assert.equal(f.paper, "index-3x5"); assert.equal(f.sides, "2"); assert.equal(f.columns, "2"); assert.equal(f.purpose, "bring");
  const v = A.normalizeSettings("sheet", t, { sheets: 9, sides: "3", include: ["formulas", "nope"], font: "7" });
  assert.equal(v.sheets, 4); assert.equal(v.sides, "2"); assert.deepEqual(v.include, ["formulas"]); assert.equal(v.font, "7");
  const saved = A.tiles({ ...t, outputs: { sheet: { kind: "sheet", state: "idle", settings: { ...v, sheets: 2 } } } }, { now: NOW }).tiles.find((x) => x.kind === "sheet");
  assert.match(saved.summary, /^2 cards/);
  assert.deepEqual(A.layoutFor("sheet", { ...v, sheets: 1, sides: "2", columns: "3", paper: "letter", font: "auto" }, t), { style: "sheet", paper: "letter", pages: 2, columns: 3, font: "auto", title: "X" });
  // the session: when, from the deadline (the evening before), and the calendar option only with a calendar
  const ses = A.tiles(t, { now: NOW, calendar: true }).tiles.find((x) => x.kind === "session");
  assert.equal(ses.fields.find((x) => x.key === "when").value, "2026-11-13T19:00");
  assert.ok(ses.fields.some((x) => x.key === "calendar"));
  assert.ok(!A.tiles(t, { now: NOW }).tiles.find((x) => x.kind === "session").fields.some((x) => x.key === "calendar"));
  assert.throws(() => A.normalizeSettings("bogus", t, {}), /no action/);
  // an exam today: a couple of hours from now, but never in the small hours
  const today = A.situation(topic({ why: "exam", deadline: "2026-11-17" }), { now: Date.parse("2026-11-17T02:30:00") });
  assert.equal(A.sessionWhen(today, new Date("2026-11-17T02:30:00")), "2026-11-17T08:00");
  assert.equal(A.sessionWhen(today, new Date("2026-11-17T13:20:00")), "2026-11-17T16:00");
  assert.equal(A.sessionWhen(today, new Date("2026-11-17T20:30:00")), "2026-11-18T08:00");
});

test("the tutor's brief: the choices, the rule, no background work, deliver at the end", () => {
  const t = topic({ why: "exam", deadline: "2026-11-14", integrity: "Graded: parallel problems only. One 8.5x11 sheet, front and back." });
  const v = A.normalizeSettings("sheet", t, { sheets: 2 });
  const b = A.brief("sheet", t, v, { dir: "/d", learner: "Sam" });
  assert.match(b, /^\[Teach app\] action sheet\nSam clicked "Note sheet"/);
  assert.match(b, /2 sheets of Letter/);
  assert.match(b, /is MORE than that/);          // 4 pages over a 2-page rule
  assert.match(b, /no background agents/);
  assert.match(b, /document with source "out\/sheet\.md" and for "sheet"/);
  assert.match(b, /call deliver with kind "sheet"/);
  assert.match(b, /parallel problems/);
  assert.match(A.brief("worksheet", t, A.normalizeSettings("worksheet", t, {}), { dir: "/d" }), /out\/worksheet-key\.md/);
  assert.match(A.brief("sheet", t, v, { dir: "/d", resume: true }), /\(resume\)\n.*Pick up where you stopped/);
  assert.match(A.brief("practice", t, A.normalizeSettings("practice", t, {}), { dir: "/d" }), /Deliver comes after the answers/);
});

test("calendar: an .ics with an alarm, and the calendar command's arguments", () => {
  const ics = A.ics({ uid: "u1@teach", title: "Review: RC, circuits", start: "2026-11-13T01:00:00.000Z", minutes: 30, remind: 30, note: "line one\nline two" });
  assert.match(ics, /DTSTART:20261113T010000Z/); assert.match(ics, /DTEND:20261113T013000Z/);
  assert.match(ics, /SUMMARY:Review: RC\\, circuits/); assert.match(ics, /TRIGGER:-PT30M/); assert.match(ics, /line one\\nline two/);
  assert.ok(ics.includes("\r\n"));
  assert.deepEqual(A.calendarArgs({ title: "T", local: "2026-11-13T19:00", minutes: 45, note: "n", remind: 0 }), ["T", "2026-11-13 19:00", "--for", "45m", "--note", "n"]);
  assert.deepEqual(A.calendarArgs({ title: "T", local: "2026-11-13T19:00", minutes: 30, note: "", remind: 10 }).slice(-2), ["--remind", "10m"]);
});

test("deliver: only what's being made, a PDF first, and a deck goes into review", () => {
  store.createTopic({ slug: "rc", title: "RC", why: "exam", deadline: "2099-01-01" });
  assert.throws(() => ops.deliver("rc", { kind: "sheet", summary: "x" }), /nothing is being made/);
  ops.setOutput("rc", "sheet", { state: "working", settings: {} });
  assert.throws(() => ops.deliver("rc", { kind: "sheet", summary: "x" }), /render it with document/);
  const pdf = path.join(store.topicDir("rc"), "out", "sheet.pdf");
  fs.mkdirSync(path.dirname(pdf), { recursive: true }); fs.writeFileSync(pdf, "%PDF");
  ops.deliver("rc", { kind: "sheet", summary: "1 sheet", files: ["out/sheet.pdf"] });
  assert.equal(store.getTopic("rc").outputs.sheet.state, "ready");
  assert.throws(() => ops.deliver("rc", { kind: "sheet", summary: "again" }), /isn't being made/);
  assert.throws(() => ops.deliver("rc", { kind: "sheet", summary: "x", files: ["../../etc/passwd"] }));
  // flashcards on "every day until the exam": in review, and seen-yesterday cards are due again today
  ops.cards("rc", { items: [{ type: "card", front: "τ", back: "RC" }] });
  ops.setOutput("rc", "cards", { state: "working", settings: { schedule: "exam" } });
  ops.deliver("rc", { kind: "cards", summary: "1 card" });
  assert.equal(store.getTopic("rc").settings.cramUntil, "2099-01-01");
  const id = store.getDeck("rc").items[0].id;
  review.gradeItem("rc", id, true);
  assert.equal(review.queue({ slug: "rc" }).length, 0);   // seen today
  const f = path.join(process.env.TEACH_STATE, "review.json"), st = JSON.parse(fs.readFileSync(f, "utf8"));
  st.items[`rc/${id}`].last -= 86400e3;                     // seen yesterday, due in days on the spaced schedule
  fs.writeFileSync(f, JSON.stringify(st));
  assert.equal(review.queue({ slug: "rc" }).length, 1);
  // update: allowance and the tutor's picks
  ops.update("rc", { allowance: { kind: "sheet", paper: "a4", sheets: 1, sides: 1, source: "syllabus" }, suggest: ["sheet", { kind: "worksheet", why: "w" }, { kind: "nope" }, "sheet"] });
  const t = store.getTopic("rc");
  assert.equal(t.allowance.paper, "a4");
  assert.deepEqual(t.suggest, [{ kind: "sheet", why: "" }, { kind: "worksheet", why: "w" }]);
});

// A real render, where a browser is installed (CI's runners have one).
test("a note sheet fits its page budget; problems come back", { skip: !findChrome() && "no browser" }, async () => {
  const { renderDoc, describe } = await import("../lib/doc.mjs");
  const dir = path.join(tmp, "doc");
  fs.mkdirSync(dir, { recursive: true });
  const body = Array.from({ length: 40 }, (_, i) => `## Section ${i + 1}\n- The time constant $\\tau = RC$ and $v(t) = V_0 e^{-t/\\tau}$.\n- A step that matters, with **bold** words in it and enough text to wrap a line or two.\n\n$$i(t) = \\frac{V}{R} e^{-t/RC}$$\n`).join("\n");
  fs.writeFileSync(path.join(dir, "sheet.md"), `# Test sheet\n\n${body}\n$\\frac{1}{$ broken\n`);
  const r = await renderDoc(path.join(dir, "sheet.md"), path.join(dir, "sheet.pdf"), { style: "sheet", pages: 1, columns: 3 });
  assert.equal(r.pages, 1);
  assert.ok(r.fits);
  assert.ok(r.font >= 5.5 && r.font < 10.5, `font ${r.font}`);
  assert.ok(r.problems.some((p) => p.kind === "math"), "the broken formula is reported");
  assert.ok(fs.statSync(r.pdf).size > 1000);
  assert.ok(r.previews.length >= 1 && fs.existsSync(r.previews[0]));
  assert.match(describe(r), /1 page of Letter/);
  // twice the budget at the same content: a bigger font
  const r2 = await renderDoc(path.join(dir, "sheet.md"), path.join(dir, "sheet2.pdf"), { style: "sheet", pages: 2, columns: 3 }, { preview: false });
  assert.ok(r2.font > r.font, `${r2.font} > ${r.font}`);
  // images: one that loads lays out before the PDF prints (the page waits on timers, which headless Chrome's
  // virtual time waits for; a bare await on decode() let it dump an unfinished page), one that doesn't is a problem
  fs.writeFileSync(path.join(dir, "fig.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#36c"/></svg>');
  fs.writeFileSync(path.join(dir, "img.md"), `# Figures\n\n![a figure](${path.join(dir, "fig.svg")})\n\n![missing](${path.join(dir, "nope.png")})\n\nAfter, $x^2$.\n`);
  const ri = await renderDoc(path.join(dir, "img.md"), path.join(dir, "img.pdf"), { style: "doc", pages: 2 }, { preview: false });
  assert.equal(ri.pages, 1);
  assert.deepEqual(ri.problems.map((p) => p.kind), ["image"]);
  assert.match(ri.problems[0].text, /nope\.png/);
  // too much for the budget at the smallest font: it says so
  fs.writeFileSync(path.join(dir, "long.md"), body.repeat(8));
  const r3 = await renderDoc(path.join(dir, "long.md"), path.join(dir, "long.pdf"), { style: "sheet", pages: 1, columns: 3 }, { preview: false });
  assert.equal(r3.fits, false);
  assert.match(describe(r3), /DOESN'T FIT/);
});
