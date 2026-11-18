// The professor's rules, each on a recorded history: what the evidence was, what it changed and why. Every school week,
// course and note here is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teach-professor-"));
Object.assign(process.env, { TEACH_DATA: path.join(tmp, "learning"), TEACH_STATE: path.join(tmp, "state") });
const C = await import("../lib/courses.mjs");
const P = await import("../lib/professor.mjs");

// A small made-up course: three units, a paper after unit 1, a midterm after unit 2, a final after unit 3.
function course() {
  const c = C.normalizeCourse({
    slug: "test-course", title: "Test Course", code: "TC 101", institution: "Example U", hours: { kind: "mixed", lectureMinutes: 60, pagesPerHour: 15 },
    units: [1, 2, 3].map((n) => ({ n, title: `Unit ${n}`, lectures: [{ title: "a" }, { title: "b" }], readings: [{ title: "r", pages: 30 }] })),
    assignments: [{ id: "paper", kind: "paper", title: "Paper", unit: 1, rubric: [{ criterion: "Thesis", points: 10 }] }],
    exams: [{ id: "mid", kind: "midterm", title: "Midterm", covers: [1, 2], unit: 2, minutes: 60 }, { id: "fin", kind: "final", title: "Final", covers: [1, 2, 3], unit: 3, minutes: 120 }],
    grading: [{ what: "Paper", weight: 30, items: ["paper"] }, { what: "Midterm", weight: 30, items: ["mid"] }, { what: "Final", weight: 40, items: ["fin"] }],
  });
  c.start = "2026-11-02"; c.status = "active";
  c.due = C.paceDue(c, { from: c.start, base: 6 });
  return c;
}
const ev = (o = {}) => ({ today: "2026-11-15", base: 6, ctx: { unitDone: {}, unitPlans: {} }, sessions: [], lastWeek: null, weeks: [], scores: [], units: {}, school: [], notes: [], started: true, startedDays: 13, ...o });
const sess = (day, hour, minutes, finished) => ({ start: new Date(`${day}T${String(hour).padStart(2, "0")}:00:00`).toISOString(), minutes, finished });

test("lighter before a heavy school week, heavier in a break, with the reason and re-paced deadlines", () => {
  const c = course(), before = { ...c.due };
  const made = P.review(c, ev({ school: [
    { monday: "2026-11-16", exams: 2, due: 3, busyHours: 6, labels: ["Example 201 exam Thu", "Lab 7 due"] },
    { monday: "2026-11-23", break: true, breakName: "Thanksgiving break", labels: [] },
  ] }), ["load"]);
  assert.equal(made.length, 1);
  const ch = made[0];
  assert.equal(c.plan.weeks["2026-11-16"].target, 3.5);   // 6 h × 0.6
  assert.equal(c.plan.weeks["2026-11-23"].target, 9);     // 6 h × 1.5
  assert.match(c.plan.weeks["2026-11-16"].why, /lighter week: Example 201 exam Thu \+ Lab 7 due/);
  assert.match(ch.title, /lighter: Example 201 exam Thu \+ Lab 7 due/);
  assert.ok(ch.evidence.some((e) => /2 exam\(s\), 3 deadline\(s\)/.test(e)));
  assert.ok(ch.patch.some((x) => x.path.startsWith("due.")), "deadlines after the change re-paced");
  for (const [id, d] of Object.entries(before)) if (d < "2026-11-16") assert.equal(c.due[id], d, `${id} due this week stays put`);
  // and it can be undone: everything back, and the rule leaves those weeks alone for two weeks
  P.undo(c, ch.id, "2026-11-15");
  assert.deepEqual(c.due, before);
  assert.equal(c.plan.weeks["2026-11-16"], undefined);
  assert.equal(P.review(c, ev({ school: [{ monday: "2026-11-16", exams: 2, due: 3, busyHours: 6 }] }), ["load"]).length, 0);
});

test("finals week and a 'travelling' note both lighten; a light stretch adds a little", () => {
  assert.equal(P.weekFactor({ monday: "2026-12-14", finals: true }).factor, 0.4);
  assert.equal(P.weekFactor({ monday: "2026-11-16" }, [{ monday: "2026-11-16", text: "travelling", load: "away" }]).factor, 0.5);
  assert.equal(P.weekFactor({ monday: "2026-11-16", exams: 0, due: 1 }).factor, 1.2);
  assert.equal(P.weekFactor({ monday: "2026-11-16", exams: 0, due: 2 }).factor, 1);
  assert.equal(P.weekFactor({ monday: "2026-11-16", exams: 1, due: 1 }).factor, 0.8);
});

test("the edge: a week finished with good scores raises the load; one worked hard but not finished lowers it; one skipped doesn't", () => {
  let c = course();
  P.review(c, ev({ lastWeek: { target: 6, hours: 6.5, due: 2, done: 2, sessions: 7 }, scores: [{ id: "paper", pct: 88, units: [1], at: "2026-11-12" }] }), ["edge"]);
  assert.equal(c.plan.edge, 1.1);
  assert.match(c.changes.at(-1).reason, /within reach/);
  c = course();
  P.review(c, ev({ lastWeek: { target: 6, hours: 6, due: 3, done: 1, sessions: 8 } }), ["edge"]);
  assert.equal(c.plan.edge, 0.9);
  c = course();
  assert.equal(P.review(c, ev({ lastWeek: { target: 6, hours: 0.5, due: 3, done: 0, sessions: 1 } }), ["edge"]).length, 0, "not showing up doesn't make it easier");
  assert.equal(c.plan.edge, 1);
});

test("sessions: most ending early unfinished → shorter; most running long and finished → longer", () => {
  let c = course();
  P.review(c, ev({ sessions: [sess("2026-11-10", 19, 25, false), sess("2026-11-12", 20, 30, false), sess("2026-11-14", 19, 28, false)] }), ["sessions"]);
  assert.equal(c.plan.sessionMinutes, 30);
  c = course();
  P.review(c, ev({ sessions: [sess("2026-11-10", 19, 70, true), sess("2026-11-12", 20, 75, true), sess("2026-11-14", 19, 65, true)] }), ["sessions"]);
  assert.equal(c.plan.sessionMinutes, 70);
});

test("time of day follows when they actually study", () => {
  const c = course();
  P.review(c, ev({ sessions: [sess("2026-11-09", 21, 40, true), sess("2026-11-10", 20, 40, true), sess("2026-11-12", 9, 40, true), sess("2026-11-13", 19, 40, true), sess("2026-11-14", 20, 40, true)] }), ["time"]);
  assert.equal(c.plan.preferred, "evening");
});

test("weak retention or a low score adds a review before the next exam; the exam itself is untouched", () => {
  const c = course(), exams = JSON.stringify(c.exams), grading = JSON.stringify(c.grading);
  P.review(c, ev({ units: { 1: { retention: { reviews: 20, again: 9 } } }, scores: [{ id: "paper", title: "Paper", pct: 62, units: [1], at: "2026-11-12" }] }), ["review"]);
  assert.equal(c.plan.reviews.length, 2);
  assert.ok(c.plan.reviews.every((r) => r.before === "mid"));
  const order = C.workList(c).map((x) => x.id);
  assert.ok(order.indexOf("rev-ret-u1") < order.indexOf("mid") && order.indexOf("rev-score-paper") < order.indexOf("mid"));
  assert.equal(JSON.stringify(c.exams), exams);
  assert.equal(JSON.stringify(c.grading), grading);
});

test("strong on the pre-test → fast track (fewer hours), graded work the same", () => {
  const c = course();
  c.pretest = { result: { right: 5, of: 9, byUnit: { 1: { right: 3, of: 3, known: 1 }, 2: { right: 1, of: 3, known: 0.33 }, 3: { right: 1, of: 3, known: 0.33 } } } };
  const h0 = C.unitHours(c, c.units[0], { known: 1 }).total;
  P.review(c, ev(), ["strong"]);
  assert.equal(c.units[0].mode, "fast");
  assert.equal(c.units[1].mode, "normal");
  assert.ok(C.unitHours(c, c.units[0], { known: 1 }).total <= h0);
  assert.equal(c.assignments.length, 1);
});

test("stuck on a step three sessions running → an extra session on that unit", () => {
  const c = course();
  P.review(c, ev({ units: { 2: { stuck: 3, shaky: 0, started: true } } }), ["stuck"]);
  assert.equal(c.units.find((u) => u.n === 2).extraSessions, 1);
});

test("a missed deadline moves to the end of the week once, re-paces the rest; a second miss escalates the check-ins", () => {
  const c = course();
  const unit1 = c.due.u1;
  const day = C.addDays(unit1, 2);
  let made = P.review(c, ev({ today: day }), ["slip"]);
  assert.equal(made.length, 1);
  assert.ok(made[0].urgent);
  const sunday = C.addDays(C.weekOf(day), 6);
  assert.equal(c.due.u1, sunday > day ? sunday : C.addDays(sunday, 7));
  assert.ok(c.due.paper > c.due.u1, "what follows comes after it");
  const day2 = C.addDays(c.due.u1, 1);
  made = P.review(c, ev({ today: day2 }), ["slip"]);
  assert.match(made[0].title, /again/);
  assert.deepEqual(c.plan.checkin, { freq: "twice", style: "text" });
});

test("consistency: no sessions for 5 days → twice-weekly texts; two steady weeks → back to weekly", () => {
  const c = course();
  P.review(c, ev({ sessions: [sess("2026-11-09", 19, 45, true)] }), ["consistency"]);
  assert.deepEqual(c.plan.checkin, { freq: "twice", style: "text" });
  const good = { target: 6, hours: 6, due: 2, done: 2, sessions: 8 };
  P.review(c, ev({ today: "2026-11-29", sessions: [sess("2026-11-28", 19, 45, true)], lastWeek: good, weeks: [good] }), ["consistency"]);
  assert.deepEqual(c.plan.checkin, { freq: "weekly", style: "voice" });
});

test("it never lowers the bar: no rule may touch exams, assignments, rubrics or grading", () => {
  for (const p of ["exams.0.questions", "assignments.0.rubric", "grading.0.weight", "passMark", "exams.1.minutes", "units.1.readings"]) assert.equal(P.allowedPath(p), false, p);
  const c = course();
  assert.throws(() => P.apply(c, { id: "x", patch: [{ path: "exams.0.minutes", from: 60, to: 30 }] }), /may not change/);
  // the whole weekly run over a rough history leaves the graded work exactly as it was
  const graded = JSON.stringify([c.exams, c.assignments, c.grading, c.passMark]);
  P.review(c, ev({ today: C.addDays(c.due.u1, 3), lastWeek: { target: 6, hours: 6, due: 3, done: 0, sessions: 8 }, scores: [{ id: "paper", pct: 40, units: [1], at: "2026-11-12" }],
    units: { 1: { retention: { reviews: 30, again: 20 }, stuck: 4 } }, sessions: [sess("2026-11-10", 19, 20, false), sess("2026-11-11", 19, 20, false), sess("2026-11-12", 19, 20, false)],
    school: [{ monday: C.addDays(C.weekOf(C.addDays(c.due.u1, 3)), 7), finals: true }] }));
  assert.equal(JSON.stringify([c.exams, c.assignments, c.grading, c.passMark]), graded);
  assert.ok(c.changes.length >= 4);
  for (const ch of c.changes) { assert.ok(ch.reason && ch.title && Array.isArray(ch.evidence) && ch.evidence.length, `${ch.rule} logs its evidence and reason`); }
});

test("undo refuses when the thing changed again since", () => {
  const c = course();
  P.review(c, ev({ sessions: [sess("2026-11-10", 19, 25, false), sess("2026-11-12", 20, 30, false), sess("2026-11-14", 19, 28, false)] }), ["sessions"]);
  const id = c.changes.at(-1).id;
  c.plan.sessionMinutes = 50;
  assert.throws(() => P.undo(c, id, "2026-11-15"), /changed again/);
});

test("check-in: Sunday 18:00 by default, Wednesday too at twice a week; its lines say what was due, done, behind and next", () => {
  const sun = new Date("2026-11-22T18:30:00"), sat = new Date("2026-11-21T12:00:00");
  assert.ok(P.checkinDue({ day: 0, time: "18:00" }, "weekly", null, sun));
  assert.equal(P.checkinDue({ day: 0, time: "18:00" }, "weekly", sun.toISOString(), new Date("2026-11-22T19:00:00")), null);
  assert.equal(P.checkinDue({ day: 0, time: "18:00" }, "weekly", new Date("2026-11-15T18:05:00").toISOString(), sat), null);
  assert.ok(P.checkinDue({ day: 0, time: "18:00" }, "twice", new Date("2026-11-15T18:05:00").toISOString(), new Date("2026-11-18T18:30:00")), "Wednesday when twice a week");
  const c = course();
  const day = C.addDays(C.weekOf(c.due.u1), 6);
  const { lines, behind } = P.checkinLines(c, { today: day, ctx: { unitDone: {} } });
  assert.match(lines[0], /TC 101 Test Course: 0 of \d+ things due this week done/);
  assert.match(lines.at(-1), /Due this coming week|Nothing due this coming week/);
  assert.equal(typeof behind, "boolean");
});

test("undo holds each thing it was about for two weeks: a missed deadline isn't moved again the next day, a stuck unit isn't re-added", () => {
  const c = course();
  const day = C.addDays(c.due.u1, 2);
  const [slip] = P.review(c, ev({ today: day }), ["slip"]);
  P.undo(c, slip.id, day);
  assert.equal(P.review(c, ev({ today: C.addDays(day, 1) }), ["slip"]).filter((x) => x.patch.some((p) => p.path === "due.u1")).length, 0);
  const [stuck] = P.review(c, ev({ units: { 2: { stuck: 3 } } }), ["stuck"]);
  P.undo(c, stuck.id, "2026-11-15");
  assert.equal(P.review(c, ev({ today: "2026-11-16", units: { 2: { stuck: 4 } } }), ["stuck"]).length, 0);
});

test("sessions are counted on local days: a Sunday-evening session is Sunday's, whatever UTC says", () => {
  const c = course();
  const sun = new Date("2026-11-15T19:30:00");   // local; in UTC west of Greenwich it's already Monday
  P.review(c, ev({ today: "2026-11-19", sessions: [{ start: sun.toISOString(), minutes: 40, finished: true }] }), ["consistency"]);
  assert.equal(c.plan.checkin.freq, "weekly", "4 days since Sunday's session, not 3 or 5");
});
