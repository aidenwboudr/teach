// The course layer inside the server: the Courses tab's API, the jobs that need a model (lib/coursework.mjs), exam
// sittings, a program's start rule, the professor's runs (lib/professor.mjs) and the weekly check-in. server.mjs calls
// createCourses() once with the few things it owns (starting a tutor turn, the live events, the calendar command).
//
// Settings (all optional, documented in the README):
//   TEACH_CHECKIN_CMD        gets MESSAGE --key KEY [--urgent]: delivers the check-in (and a program's start) to the learner
//   TEACH_SCHOOL_CMD         the learner's school, as JSON: `weeks --from DAY --weeks N` (load per week ahead) and
//                            `open --from DAY --through DAY` (school work due then that isn't turned in yet)
//   TEACH_CALENDAR_CMD       (shared with the end-of-session actions) adds an event; TEACH_CALENDAR_MOVE_CMD moves one: ID "YYYY-MM-DD HH:MM"
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import * as C from "./courses.mjs";
import * as P from "./professor.mjs";
import * as W from "./coursework.mjs";
import * as store from "./store.mjs";
import * as review from "./review.mjs";
import { STATE, LEARNER, Learner, URL_PUBLIC, splitCmd } from "./paths.mjs";
import { command } from "./platform.mjs";

const env = (k) => process.env[k] || "";
const CHECKIN_CMD = env("TEACH_CHECKIN_CMD"), SCHOOL_CMD = env("TEACH_SCHOOL_CMD"), MOVE_CMD = env("TEACH_CALENDAR_MOVE_CMD");
const SETTINGS = () => path.join(C.COURSES, "settings.json");
const CONTEXT = () => path.join(STATE, "context.json");   // the learner's notes for the professor: this machine only, never in git
const err = (msg, code = 400) => Object.assign(new Error(msg), { code });
const today = () => C.dayOf(Date.now());

export const getSettings = () => ({ checkin: { day: 0, time: "18:00" }, calendarHour: "18:00", ...store.readJSON(SETTINGS(), {}) });
export function setSettings(b) {
  const s = getSettings();
  if (b.checkin) {
    if (Number.isInteger(b.checkin.day) && b.checkin.day >= 0 && b.checkin.day <= 6) s.checkin.day = b.checkin.day;
    if (/^\d{2}:\d{2}$/.test(b.checkin.time || "")) s.checkin.time = b.checkin.time;
  }
  if (/^\d{2}:\d{2}$/.test(b.calendarHour || "")) s.calendarHour = b.calendarHour;
  fs.mkdirSync(C.COURSES, { recursive: true });
  store.writeJSON(SETTINGS(), s);
  return s;
}

// ---------- the learner's notes for the professor (local only) ----------

export const getNotes = () => store.readJSON(CONTEXT(), { notes: [] }).notes;
export function addNote({ text, week, load }) {
  const t = String(text || "").trim().slice(0, 300);
  if (!t) throw err("a note needs text");
  const monday = C.weekOf(/^\d{4}-\d{2}-\d{2}$/.test(week || "") ? week : today());
  const kind = ["light", "heavy", "away"].includes(load) ? load : /travel|away|trip|out of town|vacation/i.test(t) ? "away" : /busy|swamped|heavy|crunch|exam/i.test(t) ? "heavy" : /free|light|quiet|break/i.test(t) ? "light" : "";
  const notes = [...getNotes().filter((n) => C.daysBetween(n.monday, today()) < 60), { id: Date.now().toString(36), monday, text: t, load: kind, at: new Date().toISOString() }];
  store.writeJSON(CONTEXT(), { notes });
  return notes.at(-1);
}
export function dropNote(id) { store.writeJSON(CONTEXT(), { notes: getNotes().filter((n) => n.id !== id) }); }

// ---------- commands ----------

const run = (cmdline, args, timeout = 60e3) => new Promise((resolve) => {
  const [cmd, ...pre] = splitCmd(cmdline);
  const c = command(cmd, [...pre, ...args]);
  execFile(c.file, c.args, { timeout, windowsHide: true, maxBuffer: 8 << 20 }, (e, out, se) => resolve({ ok: !e, out: String(out || "").trim(), err: String(se || e?.message || "").trim() }));
});
async function school(args) {
  if (!SCHOOL_CMD) return null;
  const r = await run(SCHOOL_CMD, args);
  if (!r.ok) { console.error("teach: school command:", r.err.slice(-300)); return null; }
  try { return JSON.parse(r.out); } catch { console.error("teach: school command printed no JSON"); return null; }
}
export async function deliver(message, key, urgent = false) {
  if (!CHECKIN_CMD) return { ok: false, why: "no check-in command (TEACH_CHECKIN_CMD)" };
  const r = await run(CHECKIN_CMD, [message, "--key", key, ...(urgent ? ["--urgent"] : [])]);
  return { ok: r.ok, out: (r.ok ? r.out : r.err).slice(-300) };
}

// ---------- the server's side ----------

export function createCourses({ turn, emit, broadcast, engineBusy, calendarCmd, provider, ask, noteFor, now = () => Date.now() }) {
  const jobs = new Map();   // "course:key" → { cancel }
  const changed = (slug) => broadcast?.({ t: "courses", course: slug });

  // ----- what a course's units are doing (their topics) -----
  const unitTopic = (c, u) => (u.topic ? store.getTopic(u.topic) : null);
  function ctxOf(c) {
    const unitDone = {}, unitPlans = {};
    for (const u of c.units) {
      const t = unitTopic(c, u);
      if (!t) continue;
      const plan = t.plan || [];
      unitDone[u.n] = t.status === "done" || (plan.length > 0 && plan.every((n) => ["done", "skipped"].includes(n.status)));
      if (plan.length) unitPlans[u.n] = { total: plan.length, left: plan.filter((n) => ["todo", "current"].includes(n.status)).length };
    }
    return { unitDone, unitPlans };
  }
  const programOf = (c) => (c.program ? C.getProgram(c.program) : null) || C.listPrograms().map(C.getProgram).find((p) => p?.slots.some((s) => s.course === c.slug)) || null;
  const baseOf = (c) => { const p = programOf(c); return p ? p.pace.hoursPerWeek / p.pace.concurrent : c.plan?.hoursPerWeek || 6; };

  // ----- study sessions, from the activity the app records -----
  function record(slug, entry) {
    try { C.mutateCourse(slug, (c) => { c.activity = [...(c.activity || []), { at: new Date(now()).toISOString(), ...entry }].slice(-600); }); } catch { /* gone */ }
  }
  function sessions(c) {
    const acts = (c.activity || []).slice().sort((a, b) => a.at.localeCompare(b.at));
    const out = [];
    for (const a of acts) {
      const last = out.at(-1), t = Date.parse(a.at);
      if (last && t - Date.parse(last.end) < 30 * 60e3) { last.end = a.at; last.acts.push(a); }
      else out.push({ start: a.at, end: a.at, acts: [a] });
    }
    return out.map((s) => {
      const done = s.acts.map((a) => a.done ?? null).filter((x) => x !== null);
      const finished = s.acts.some((a) => ["exam", "pretest", "work", "unit-done"].includes(a.kind)) || (done.length > 1 && done.at(-1) > done[0]) || (done.length && s.acts[0].doneBefore !== undefined && done.at(-1) > s.acts[0].doneBefore);
      return { start: s.start, minutes: Math.round((Date.parse(s.end) - Date.parse(s.start)) / 60e3) + 10, finished, units: [...new Set(s.acts.map((a) => a.unit).filter(Boolean))], steps: s.acts.map((a) => a.current).filter(Boolean) };
    });
  }

  // ----- the evidence the professor reads -----
  async function evidence(c, { schoolWeeks } = {}) {
    const day = today(), ctx = ctxOf(c), base = baseOf(c), ss = sessions(c);
    const weekStats = (monday) => {
      const sunday = C.addDays(monday, 6), items = C.workList(c, ctx).filter((x) => c.due?.[x.id] >= monday && c.due[x.id] <= sunday);
      const inWeek = ss.filter((s) => C.dayOf(s.start) >= monday && C.dayOf(s.start) <= sunday);
      return { monday, target: C.weekBudget(c.plan, monday, base), hours: inWeek.reduce((a, s) => a + s.minutes, 0) / 60, due: items.length, done: items.filter((x) => x.done).length, sessions: inWeek.length };
    };
    const thisMon = C.weekOf(day), endedMon = new Date(`${day}T12:00:00`).getDay() === 0 ? thisMon : C.addDays(thisMon, -7);
    const units = {};
    for (const u of c.units) {
      const t = unitTopic(c, u);
      const steps = ss.flatMap((s) => (s.units.includes(u.n) ? [s.steps.at(-1)] : [])).filter(Boolean);
      const lastStep = steps.at(-1);
      let stuck = 0; for (let i = steps.length - 1; i >= 0 && steps[i] === lastStep; i--) stuck++;
      const cur = t?.plan?.find((n) => n.status === "current");
      units[u.n] = { started: !!t, retention: t ? review.stats(t.slug) : { reviews: 0, again: 0 }, stuck: cur && cur.id === lastStep ? stuck : 0, shaky: (t?.plan || []).filter((n) => n.status === "shaky").length };
    }
    const scores = [...c.exams, ...c.assignments].map((x) => {
      const s = C.itemScore(c, x.id);
      return s && { id: x.id, title: x.title, pct: s.pct, at: s.at ? C.dayOf(s.at) : undefined, practice: !!x.practice, units: x.covers?.length ? x.covers : [x.unit] };
    }).filter(Boolean).sort((a, b) => (a.at || "").localeCompare(b.at || ""));
    const sw = schoolWeeks ?? (await school(["weeks", "--from", thisMon, "--weeks", "3"]))?.weeks ?? [];
    return { today: day, base, ctx, sessions: ss, lastWeek: weekStats(endedMon), weeks: [weekStats(C.addDays(endedMon, -7)), weekStats(C.addDays(endedMon, -14))],
      scores, units, school: sw, notes: getNotes(), started: !!c.start && c.start <= day, startedDays: c.start ? C.daysBetween(c.start, day) : 0 };
  }

  // Run the professor on a course; tell a live unit tutor what changed for it; keep the calendar in step.
  // The evidence is gathered first (it may wait on the school command); the rules then run on a fresh read of the
  // course inside the write, so a sitting handed in or a grade that landed meanwhile is never overwritten.
  async function oversee(slug, rules, opts = {}) {
    const c0 = C.getCourse(slug);
    if (!c0 || !c0.start || c0.status !== "active") return [];
    const ev = await evidence(c0, opts);
    let made = [];
    const c = C.mutateCourse(slug, (cc) => { made = cc.start && cc.status === "active" ? P.review(cc, ev, rules) : []; return made.length ? undefined : false; });
    if (!made.length) return [];
    for (const ch of made) {
      for (const u of c.units.filter((u) => u.topic && ch.patch.some((x) => x.path.startsWith(`units.${u.n}.`) || x.path === "plan.sessionMinutes")))
        noteFor?.(u.topic, `[Teach app] professor\nThe course's plan changed: ${ch.title}. ${ch.reason}${unitDirective(c, u)}`);
    }
    if (c.calendar?.events?.length) await syncCalendar(slug).catch(() => {});
    changed(slug);
    return made;
  }

  const overseeSoon = (slug) => oversee(slug, ["review", "slip"], { schoolWeeks: [] }).catch((e) => console.error("teach: professor:", e.message));

  // ----- views -----
  function courseSummary(c) {
    const ctx = ctxOf(c), h = C.courseHours(c, ctx), g = C.gradebook(c);
    return { slug: c.slug, title: c.title, code: c.code, institution: c.institution, instructors: c.instructors, program: c.program, slot: c.slot, status: c.status, start: c.start,
      progress: C.courseProgress(c, ctx), hours: { total: h.total, left: h.left, basis: h.basis }, grade: g.current, letter: g.letter, provenance: C.provenance(c),
      behind: C.behind(c, today(), ctx).length, pretest: c.pretest?.result ? { right: c.pretest.result.right, of: c.pretest.result.of } : null };
  }
  function hoursOfSlot(s) {
    const c = s.course ? C.getCourse(s.course) : null;
    if (c) { const h = C.courseHours(c, ctxOf(c)); return { total: h.total, left: h.left, basis: h.basis }; }
    return { ...C.candidateHours(s.candidate), left: null };
  }
  function programView(slug) {
    const p = C.getProgram(slug) || (() => { throw err("no such program", 404); })();
    const startDay = p.start.started || p.start.date || (p.start.gate?.through ? C.addDays(p.start.gate.through, 1) : today());
    const tl = C.timeline(p, { hoursOf: hoursOfSlot, startDay });
    const slots = p.slots.map((s) => {
      const c = s.course ? C.getCourse(s.course) : null;
      const ctx = c ? ctxOf(c) : {};
      return { ...s, status: C.slotStatus(s, c, ctx), course: c ? courseSummary(c) : null, courseSlug: s.course, when: tl.slots.find((x) => x.slot === s.id),
        provenance: c ? C.provenance(c) : C.provenance({ sources: s.candidate?.sources || [] }) };
    });
    const counted = slots.filter((s) => s.counts);
    return { program: { ...p, slots: undefined }, slots, timeline: { weeks: tl.weeks, finish: tl.finish, perCourse: tl.perCourse, estimated: p.start.state !== "started" },
      progress: { total: counted.length, done: counted.filter((s) => s.status === "done").length, active: counted.filter((s) => s.status === "active").length },
      start: startView(p), tiles: programTiles(p, slots) };
  }
  function startView(p) {
    const s = p.start;
    if (s.state === "started") return { state: "started", text: `Started ${s.started}`, date: s.started };
    if (s.kind === "gate") return { state: s.state, text: s.label || "Starts when the condition is met", last: s.last, through: s.gate.through, askAfter: s.gate.askAfter };
    if (s.kind === "date") return { state: "waiting", text: `Starts ${s.date}`, date: s.date };
    return { state: "waiting", text: "Starts when you say go" };
  }

  // ----- the "What next?" grids (the same genbutton grid as the end-of-session actions) -----
  const out = (c, key) => c.outputs?.[key] || { state: "idle" };
  const tile = (kind, o) => ({ kind, state: "idle", sub: "", hint: null, glyph: "i-task", ...o });
  function courseTiles(c) {
    const ctx = ctxOf(c), list = [];
    const pre = out(c, "pretest");
    if (c.pretest?.result) list.push(tile("pretest", { title: "Pre-test", glyph: "i-check", state: "ready", sub: `${c.pretest.result.right} of ${c.pretest.result.of} right · lessons plan only the gaps`, hint: "See results", score: 5 }));
    else if (c.pretest?.questions) list.push(tile("pretest", { title: "Take the pre-test", glyph: "i-check", state: "ready", sub: `${c.pretest.questions.length} questions, ~${Math.ceil(c.pretest.questions.length * 0.75)} min. What you know already gets skipped.`, hint: "Start", score: 100 }));
    else list.push(tile("pretest", { title: "Pre-test the course", glyph: "i-check", state: pre.state, sub: pre.state === "failed" ? pre.error : pre.progress || "Multiple choice on every unit, so the lessons skip what you already know.", generative: true, score: 100 }));
    const nextUnit = c.units.find((u) => !ctx.unitDone[u.n]);
    if (nextUnit) {
      const t = unitTopic(c, nextUnit);
      list.push(tile(`unit-${nextUnit.n}`, { title: `${t ? "Continue" : "Start"} unit ${nextUnit.n}`, glyph: "i-notes", state: t ? "ready" : out(c, `unit-${nextUnit.n}`).state, unit: nextUnit.n, topic: t?.slug,
        sub: `${nextUnit.title}${c.due?.[`u${nextUnit.n}`] ? ` · due ${fmt(c.due[`u${nextUnit.n}`])}` : ""}${nextUnit.mode === "fast" ? " · fast track" : ""}`, hint: t ? "Open the lesson" : "Start the lesson", generative: !t, score: c.pretest?.result || !c.pretest ? 90 : 60 }));
    }
    for (const r of (c.plan.reviews || []).filter((r) => !c.reviewsDone?.[r.id])) list.push(tile(`review-${r.id}`, { title: `Review: unit${r.units.length > 1 ? "s" : ""} ${r.units.join(", ")}`, glyph: "i-cards", review: r.id, state: out(c, `review-${r.id}`).state,
      sub: `${r.why === "retention" ? "Your review cards show it fading" : "A score under 70%"}${c.due?.[r.id] ? ` · by ${fmt(c.due[r.id])}` : ""}`, generative: true, score: 80 }));
    const nextA = c.assignments.find((a) => !["graded"].includes(c.work?.[a.id]?.state));
    if (nextA) {
      const w = c.work?.[nextA.id] || {};
      list.push(tile(`work-${nextA.id}`, { title: nextA.title, glyph: "i-worksheet", work: nextA.id, state: w.state === "grading" ? "working" : w.state === "failed" ? "failed" : "idle",
        sub: w.state === "grading" ? "Being graded" : w.state === "failed" ? w.error : `${nextA.length || ""}${c.due?.[nextA.id] ? ` · due ${fmt(c.due[nextA.id])}` : ""}`.replace(/^ · /, ""), hint: w.state === "draft" ? "Keep writing" : "Open", score: 70 }));
    }
    // the next exam only (and its practice version): the first real one not yet handed in, in course order
    const order = C.workList(c).map((w) => w.id);
    const x = c.exams.filter((e) => !e.practice && !["submitted", "grading", "graded"].includes(c.attempts?.[e.id]?.state)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))[0];
    if (x) {
      const a = c.attempts?.[x.id], o = out(c, `exam-${x.id}`);
      if (a) list.push(tile(`exam-${x.id}`, { title: x.title, glyph: "i-timer", exam: x.id, state: "working", sub: "In progress: go back to it", hint: "Open", score: 95 }));
      else if (C.examLoaded(c.slug, x.id)) list.push(tile(`exam-${x.id}`, { title: x.title, glyph: "i-timer", exam: x.id, state: "ready", sub: `${x.source === "real" ? "Real exam" : "Generated"} · one sitting · ${x.minutes} min${x.closedBook ? " · closed book" : ""}${c.due?.[x.id] ? ` · by ${fmt(c.due[x.id])}` : ""}`, hint: "Go to the exam", score: 60 }));
      else if (x.url && x.source === "real") list.push(tile(`exam-${x.id}`, { title: `Load the real ${x.title.toLowerCase()}`, glyph: "i-timer", exam: x.id, state: o.state, sub: o.state === "failed" ? o.error : o.progress || "From the course's own exam, word for word. You won't see it until you sit it.", generative: true, score: 40 }));
      else list.push(tile(`exam-${x.id}`, { title: `Make the ${x.title.toLowerCase()}`, glyph: "i-timer", exam: x.id, state: o.state, sub: o.state === "failed" ? o.error : "The course publishes none: a generated one, labelled so.", generative: true, score: 30 }));
      const pr = c.exams.filter((y) => y.practice && y.of === x.id);
      const po = out(c, `practice-${x.id}`);
      list.push(tile(`practice-${x.id}`, { title: `Practice ${x.title.toLowerCase()}`, glyph: "i-timer", practiceOf: x.id, exam: pr.at(-1)?.id, state: pr.length && po.state !== "working" ? "ready" : po.state,
        sub: pr.length ? `Practice · ${pr.length} version${pr.length > 1 ? "s" : ""}${C.itemScore(c, pr.at(-1).id) ? ` · last ${C.itemScore(c, pr.at(-1).id).pct}%` : ""}` : po.state === "failed" ? po.error : "New questions in the exam's format, retake as often as you like. Doesn't count.", generative: !pr.length, hint: pr.length ? "Take it" : null, score: 35 }));
    }
    const cal = (c.calendar?.events || []).filter((e) => !e.done).length;
    list.push(tile("calendar", { title: cal ? "Deadlines on your calendar" : "Put deadlines on my calendar", glyph: "i-calendar", state: cal ? "ready" : out(c, "calendar").state,
      sub: !c.start ? "Once the course starts" : cal ? `${cal} events · kept in step when the plan changes${c.calendar?.stale?.length ? ` · ${c.calendar.stale.length} old ones to delete by hand` : ""}` : calendarCmd ? "Each unit and every graded item, on your calendar." : "Download them as an .ics file.", hint: cal ? "Update" : null, disabled: !c.start, score: c.start && !cal ? 85 : 20 }));
    return list.sort((a, b) => b.score - a.score).slice(0, 8);
  }
  function unitTiles(c, u) {
    const t = unitTopic(c, u), list = [];
    list.push(tile(`unit-${u.n}`, { title: t ? "Continue the lesson" : "Start the lesson", glyph: "i-notes", unit: u.n, topic: t?.slug, state: t ? "ready" : out(c, `unit-${u.n}`).state, generative: !t,
      sub: t ? `${(t.plan || []).filter((n) => n.status === "done").length} of ${(t.plan || []).length} steps` : c.pretest?.result ? "The tutor probes what the pre-test didn't settle, then teaches the gaps." : "Starts with a short probe of what you know.", hint: t ? "Open" : "Start" }));
    for (const a of c.assignments.filter((x) => x.unit === u.n)) list.push(tile(`work-${a.id}`, { title: a.title, glyph: "i-worksheet", work: a.id, state: c.work?.[a.id]?.state === "graded" ? "ready" : "idle", sub: c.work?.[a.id]?.grade ? scoreText(c.work[a.id].grade) : a.length, hint: "Open" }));
    for (const x of c.exams.filter((x) => x.unit === u.n && !x.practice)) list.push(tile(`exam-${x.id}`, { title: x.title, glyph: "i-timer", exam: x.id, state: c.attempts?.[x.id]?.state === "graded" ? "ready" : "idle", sub: c.attempts?.[x.id]?.grade ? scoreText(c.attempts[x.id].grade) : `after this unit · ${x.minutes} min`, hint: "Open" }));
    return list;
  }
  function programTiles(p, slots) {
    const list = [];
    const open = slots.filter((s) => s.status !== "done" && s.status !== "open").slice(0, p.pace.concurrent + 1);
    for (const s of open) {
      const name = s.candidate ? `${s.candidate.code} ${s.candidate.title}`.trim() : s.area;
      if (!s.courseSlug) {
        const o = out({ outputs: p.outputs }, `load-${s.id}`);
        list.push(tile(`load-${s.id}`, { title: `Load ${name}`, glyph: "i-sheet", slot: s.id, state: o.state, generative: true, sub: o.state === "failed" ? o.error : o.progress || "Reads the course's own pages into units, readings, work and exams.", score: 50 - s.order }));
      } else {
        const c = C.getCourse(s.courseSlug);
        for (const t of courseTiles(c).filter((x) => ["pretest", "calendar"].includes(x.kind) || x.kind.startsWith("unit-")).slice(0, 2)) list.push({ ...t, course: c.slug, title: `${t.title} · ${c.code || c.title}`, score: 100 - s.order });
      }
    }
    return list.sort((a, b) => b.score - a.score).slice(0, 6);
  }
  const fmt = (d) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const scoreText = (g) => (g && g.max ? `${Math.round((g.score / g.max) * 100)}% (${g.score}/${g.max})` : "");

  function courseView(slug) {
    const c = C.getCourse(slug) || (() => { throw err("no such course", 404); })();
    const ctx = ctxOf(c), p = programOf(c);
    const exams = c.exams.map((x) => examPublic(c, x));
    const units = c.units.map((u) => ({ ...u, hours: C.unitHours(c, u, { known: c.pretest?.result?.byUnit?.[u.n]?.known ?? null, plan: ctx.unitPlans[u.n] }), done: !!ctx.unitDone[u.n], due: c.due?.[`u${u.n}`] || "",
      pretest: c.pretest?.result?.byUnit?.[u.n] || null, topicTitle: unitTopic(c, u)?.title || "", retention: u.topic ? review.stats(u.topic) : null, directive: unitDirective(c, u).trim(), tiles: unitTiles(c, u) }));
    return { course: { ...courseSummary(c), edition: c.edition, url: c.url, summary: c.summary, grading: c.grading, plan: c.plan, sources: c.sources, passMark: c.passMark, hoursKind: c.hours.kind },
      program: p ? { slug: p.slug, title: p.title } : null, units, assignments: c.assignments.map((a) => ({ ...a, questions: undefined, solutions: c.work?.[a.id]?.state === "graded" ? a.solutions : "", problems: a.count || 0, work: workView(c, a) })), exams,
      schedule: C.schedule(c, ctx), behind: C.behind(c, today(), ctx), gradebook: C.gradebook(c), changes: [...c.changes].reverse(), checkins: (c.checkins || []).slice(-6).reverse(),
      tiles: courseTiles(c), pretest: c.pretest ? { state: c.pretest.result ? "taken" : c.pretest.questions ? "ready" : "none", result: c.pretest.result, at: c.pretest.at } : null,
      calendar: { events: c.calendar?.events || [], can: !!calendarCmd }, settings: getSettings(), today: today(), busy: [...jobs.keys()].filter((k) => k.startsWith(`${slug}:`)).map((k) => k.slice(slug.length + 1)) };
  }

  function unitDirective(c, u) {
    const bits = [];
    if (u.mode === "fast") bits.push("This unit is on the fast track: the pre-test shows the learner knows most of it. Probe briefly to confirm, then teach only what the probe finds missing.");
    if (u.extraSessions) bits.push(`The professor added ${u.extraSessions} extra session${u.extraSessions > 1 ? "s" : ""} here because the learner got stuck: try a different explanation, and smaller steps.`);
    if (c.plan.sessionMinutes) bits.push(`Sessions are planned at about ${c.plan.sessionMinutes} minutes: aim each one at a stopping point that long.`);
    return bits.length ? `\n${bits.join(" ")}` : "";
  }

  // ----- the unit's lesson: a Teach topic, created when it's started -----
  function startUnit(slug, n) {
    const c = C.getCourse(slug), u = c?.units.find((x) => x.n === n);
    if (!u) throw err("no such unit", 404);
    if (u.topic && store.getTopic(u.topic)) return u.topic;
    const pre = c.pretest?.result?.byUnit?.[n], qs = (c.pretest?.questions || []).map((q, i) => ({ q, a: c.pretest.answers?.[i] })).filter((x) => x.q.unit === n);
    const t = store.createTopic({ slug: `${slug}-u${n}`, title: `${c.code || c.title} · ${u.title}`, goal: u.summary || `Unit ${n} of ${c.title}`, why: "class", course: `${c.code} ${c.title}`.trim(),
      deadline: c.due?.[`u${n}`] || "", phase: "frame", unit: { course: slug, n } });
    C.mutateCourse(slug, (x) => { x.units.find((y) => y.n === n).topic = t.slug; if (x.status === "planned") x.status = "active"; });
    const next = [...c.assignments.filter((a) => a.unit === n).map((a) => `${a.title} (${a.length || a.kind})`), ...c.exams.filter((x) => x.unit === n && !x.practice).map((x) => `the ${x.title}`)];
    const text = [
      `Unit ${n} of ${c.code ? `${c.code} ` : ""}${c.title} (${c.institution}${c.instructors.length ? `, ${c.instructors.join(" and ")}` : ""}): ${u.title}.${u.summary ? ` ${u.summary}` : ""}`,
      `This is one unit of a whole course ${Learner} is taking on their own in Teach${programOf(c) ? `, part of the ${programOf(c).title} program` : ""}. Teach this unit, to the course's standard.`,
      u.lectures.length ? `The course's lectures for it:\n${u.lectures.map((l) => `- ${l.title}${l.url ? ` (${l.url})` : ""}${l.minutes ? `, ${l.minutes} min` : ""}`).join("\n")}` : "",
      u.readings.length ? `Its readings (assign them as you go: a reading is a task card with the link, and the check after it is on what it argues):\n${u.readings.map((r) => `- ${r.author ? `${r.author}, ` : ""}${r.title}${r.url ? ` (${r.url})` : ""}${r.pages ? `, ${r.pages} pp.` : ""}${r.required ? "" : " (optional)"}`).join("\n")}` : "",
      pre ? `The course pre-test already covered this unit: ${pre.right} of ${pre.of} right${pre.idk ? `, ${pre.idk} "I don't know"` : ""}.\n${qs.map((x) => `- ${x.q.prompt.split("\n")[0].slice(0, 200)} → ${x.a?.idk ? "I don't know" : x.a?.choice === x.q.answer ? "right" : x.a?.choice !== undefined ? `wrong (picked "${x.q.options[x.a.choice]}")` : "skipped"}`).join("\n")}\nStart with Phase 1, but probe only what this didn't settle, and plan only the gaps.` : "Start with Phase 1: probe what they already know of this unit, then plan only the gaps.",
      next.length ? `After this unit comes ${next.join(" and ")}. That graded work is the course's: practise with parallel problems and arguments, never write or grade the real thing (a separate grader does).` : "",
      "Don't look for the course's exams or their answers (Teach keeps them sealed until the sitting), and don't quiz from them: a real exam is one sitting, and seeing it first would spend it.",
      unitDirective(c, u).trim(),
    ].filter(Boolean).join("\n\n");
    record(slug, { kind: "lesson", unit: n });
    turn(t.slug, [], { start: text, files: [] });
    changed(slug);
    return t.slug;
  }

  // A lesson turn on a unit's topic ended: record it (study sessions are built from these).
  function onTurnEnd(topicSlug) {
    const t = store.getTopic(topicSlug);
    if (!t?.unit?.course) return;
    const plan = t.plan || [];
    record(t.unit.course, { kind: "lesson", unit: t.unit.n, done: plan.filter((n) => n.status === "done").length, current: plan.find((n) => n.status === "current")?.id || "" });
    if (t.status === "done") record(t.unit.course, { kind: "unit-done", unit: t.unit.n });
  }

  // ----- jobs (each made only when clicked; pause cancels, a click starts it again) -----
  function setOut(target, key, patch) {
    const mut = (x) => { x.outputs = x.outputs || {}; x.outputs[key] = { ...(x.outputs[key] || { state: "idle" }), ...patch, at: new Date(now()).toISOString() }; };
    if (target.program) C.mutateProgram(target.program, mut); else C.mutateCourse(target.course, mut);
    changed(target.course || target.program);
  }
  function startJob(target, key, kind, args, done) {
    const id = `${target.course || target.program}:${key}`;
    if (jobs.has(id)) return;
    if (!key.startsWith("grade-")) setOut(target, key, { state: "working", progress: { load: "Reading the course's pages", pretest: "Writing the pre-test", "exam-real": "Reading the real exam", "exam-practice": "Writing a practice version", "grade-work": "Grading", "grade-answers": "Grading the written answers" }[kind] || "Working", error: "" });
    const j = W.job(kind, args, { provider, ask, model: "opus", effort: kind.startsWith("grade") ? "high" : "medium" });
    jobs.set(id, j);
    const mine = () => jobs.get(id) === j;
    const quiet = key.startsWith("grade-");   // (a grading's state is on the sitting or the work, not a tile)
    j.promise.then((r) => {
      if (!mine()) return;
      jobs.delete(id);
      try { done(r); if (!quiet) setOut(target, key, { state: "ready", progress: "", error: "" }); }
      catch (e) { console.error(`teach: course job ${kind} (saving):`, e.message); setOut(target, key, { state: "failed", progress: "", error: String(e.message || e).slice(0, 240) }); }
    })
      .catch((e) => { if (!mine()) return; jobs.delete(id); if (e.cancelled) return; console.error(`teach: course job ${kind}:`, e.message); if (!key.startsWith("grade-")) setOut(target, key, { state: "failed", progress: "", error: String(e.message || e).slice(0, 240) }); try { done?.(null, e); } catch (e2) { console.error(`teach: course job ${kind}:`, e2.message); } });
  }
  function pauseJob(target, key) {
    const id = `${target.course || target.program}:${key}`, j = jobs.get(id);
    if (j) { j.cancel(); jobs.delete(id); }
    setOut(target, key, { state: "paused", progress: "Stopped. A click starts it again." });
  }

  // ----- the pre-test -----
  function makePretest(slug) {
    const c = C.getCourse(slug);
    if (c.pretest?.questions) throw err("the pre-test is made already", 409);
    startJob({ course: slug }, "pretest", "pretest", { course: c }, (r) => { if (r) C.mutateCourse(slug, (x) => { x.pretest = { questions: r.questions, at: null, answers: null, result: null, made: new Date(now()).toISOString() }; }); });
  }
  const forPage = (q) => ({ n: q.n, kind: q.kind, prompt: q.prompt, options: q.options, points: q.points, part: q.part, words: q.words, unit_label: q.unit_label, unit: q.unit });
  async function answerPretest(slug, answers) {
    const c = C.getCourse(slug);
    if (!c?.pretest?.questions) throw err("no pre-test yet", 409);
    if (c.pretest.result) throw err("already taken", 409);
    const result = W.pretestResult(c.pretest.questions, answers);
    C.mutateCourse(slug, (x) => { x.pretest.answers = answers; x.pretest.result = result; x.pretest.at = new Date(now()).toISOString(); });
    record(slug, { kind: "pretest" });
    const fresh = C.getCourse(slug);
    if (fresh.start) repaceFrom(slug, today(), "the pre-test result");
    await oversee(slug, ["strong"], { schoolWeeks: [] }).catch((e) => console.error("teach: professor:", e.message));
    changed(slug);
    return { result, questions: fresh.pretest.questions };
  }
  // A plan that hasn't run yet (no committed due days, or new hours from a pre-test): due days from `from`.
  function repaceFrom(slug, from, why) {
    C.mutateCourse(slug, (c) => {
      const due = C.paceDue(c, { from, base: baseOf(c), ctx: ctxOf(c), keep: c.due || {}, keepUntil: C.addDays(from, -1) });
      const moved = Object.entries(due).filter(([id, d]) => c.due?.[id] && c.due[id] !== d);
      c.due = due;
      if (moved.length && why) c.changes.push({ id: `repace-${from}-${Date.now().toString(36)}`, at: from, rule: "repace", key: why, title: `Deadlines re-paced from ${why}`, reason: "The hours changed, so the deadlines from today on follow them.", evidence: moved.slice(0, 6).map(([id, d]) => `${id}: ${d}`), patch: [], applied: new Date(now()).toISOString(), auto: true });
    });
  }

  // ----- exams: a real one is one sitting; a practice version can be retaken -----
  // An exam as the page sees it: never its questions, and the real exam's own page and answers only once it's graded.
  function examPublic(c, x) {
    const graded = c.attempts?.[x.id]?.state === "graded";
    const loaded = C.examLoaded(c.slug, x.id);
    return { ...x, questions: undefined, loaded, count: loaded ? x.count : 0, url: graded || x.practice ? x.url : "", solutions: graded ? x.solutions : "", attempt: attemptView(c, x, false) };
  }
  function attemptView(c, x, withQuestions) {
    const a = c.attempts?.[x.id];
    if (!a) return null;
    const v = { state: a.state, started: a.started, ends: a.ends, away: a.away || 0, grade: a.grade || null, error: a.error || "", history: (a.history || []).map((h) => h.grade && { score: h.grade.score, max: h.grade.max, at: h.grade.at }) };
    const qs = withQuestions && C.examQuestions(c.slug, x.id);
    if (qs) {
      v.questions = qs.map((q) => (a.state === "graded" ? q : forPage(q)));
      v.answers = a.answers || [];
      v.results = a.state === "graded" ? a.results : null;
    }
    return v;
  }
  function examView(slug, id) {
    const c = C.getCourse(slug), x = c?.exams.find((y) => y.id === id);
    if (!x) throw err("no such exam", 404);
    return { course: { slug: c.slug, title: c.title, code: c.code }, exam: examPublic(c, x), attempt: attemptView(c, x, true), now: new Date(now()).toISOString() };
  }
  function startExam(slug, id) {
    const c = C.getCourse(slug), x = c?.exams.find((y) => y.id === id);
    if (!x) throw err("no such exam", 404);
    if (!C.examLoaded(slug, id)) throw err("this exam isn't loaded yet", 409);
    const a = c.attempts?.[id];
    if (a && !x.practice) throw err("a real exam is one sitting: you've opened this one already", 409);
    if (a?.state === "in-progress") return examView(slug, id);
    if (a?.state === "grading") throw err("the last sitting is still being graded", 409);
    C.mutateCourse(slug, (cc) => {
      const prev = cc.attempts?.[id];
      cc.attempts = cc.attempts || {};
      const t0 = now();
      cc.attempts[id] = { state: "in-progress", started: new Date(t0).toISOString(), ends: new Date(t0 + (x.minutes || 120) * 60e3).toISOString(), answers: [], away: 0, history: prev ? [...(prev.history || []), { grade: prev.grade, results: prev.results }] : [] };
    });
    record(slug, { kind: "exam-start", exam: id });
    timeUp(slug, id);
    changed(slug);
    return examView(slug, id);
  }
  function saveExam(slug, id, answers, away) {
    const c = C.getCourse(slug), a = c?.attempts?.[id];
    if (!a || a.state !== "in-progress") throw err("no exam in progress", 409);
    if (now() > Date.parse(a.ends) + 90e3) { submitExam(slug, id); throw err("time's up: it was handed in with what was saved", 409); }
    C.mutateCourse(slug, (cc) => { if (Array.isArray(answers)) cc.attempts[id].answers = answers; if (away) cc.attempts[id].away = (cc.attempts[id].away || 0) + 1; });
  }
  // Hand in a sitting: the key grades what it can now, the grader the written answers. Grading is keyed by the sitting
  // (a practice retake can't take another's result), and one that failed or was cut off by a restart is tried again.
  function submitExam(slug, id) {
    const c = C.getCourse(slug), a = c?.attempts?.[id];
    if (!a || a.state !== "in-progress") return;
    const qs = C.examQuestions(slug, id);
    const results = qs ? W.autoGrade(qs, a.answers || []) : [];
    C.mutateCourse(slug, (cc) => { Object.assign(cc.attempts[id], { state: "grading", submitted: new Date(now()).toISOString(), results, error: qs ? "" : "The exam's questions are missing from this machine's state folder: it's handed in (your answers are kept), but it can't be graded here." }); });
    record(slug, { kind: "exam", exam: id });
    gradeExam(slug, id);
  }
  function gradeExam(slug, id) {
    const c = C.getCourse(slug), x = c?.exams.find((y) => y.id === id), a = c?.attempts?.[id];
    if (!x || a?.state !== "grading") return;
    const sitting = a.started, qs = C.examQuestions(slug, id);
    if (!qs) { C.mutateCourse(slug, (cc) => { if (cc.attempts[id]?.started !== sitting) return false; cc.attempts[id].error = "The exam's questions are missing from this machine's state folder: it can't be graded here."; }); return; }
    const items = (a.results || []).filter((r) => r.pending).map((r) => ({ ...qs[r.n - 1], answer: r.answer }));
    const finish = (graded) => C.mutateCourse(slug, (cc) => {
      const at = cc.attempts[id];
      if (!at || at.started !== sitting || at.state !== "grading") return;
      at.results = at.results.map((r) => { const g = graded?.find((y) => y.n === r.n); return g ? { ...r, points: g.points, comment: g.comment, pending: false } : r; });
      at.state = at.results.some((r) => r.pending) ? "grading" : "graded";
      at.grade = { ...W.total(at.results), at: new Date(now()).toISOString(), by: items.length ? "grader" : "key", ungraded: at.results.filter((r) => r.ungraded).length };
      at.error = "";
    });
    if (!items.length) { finish([]); overseeSoon(slug); changed(slug); return; }
    startJob({ course: slug }, `grade-${id}-${Date.parse(sitting)}`, "grade-answers", { course: c, title: x.title, items }, (r, e) => {
      if (r) { finish(r.answers); overseeSoon(slug); return; }
      C.mutateCourse(slug, (cc) => { const at = cc.attempts[id]; if (at?.started === sitting) at.error = `Grading failed (${String(e?.message || "").slice(0, 160)}). It's handed in; grade it again from the exam page.`; });
    });
  }
  // A sitting is handed in at its time even if the page is gone (with the same 90 s grace a late save gets).
  const timers = new Map();
  function timeUp(slug, id) {
    const a = C.getCourse(slug)?.attempts?.[id];
    if (a?.state !== "in-progress") return;
    clearTimeout(timers.get(`${slug}:${id}`));
    timers.set(`${slug}:${id}`, setTimeout(() => { timers.delete(`${slug}:${id}`); try { submitExam(slug, id); changed(slug); } catch (e) { console.error("teach: hand-in at time:", e.message); } }, Math.min(2 ** 31 - 1, Math.max(0, Date.parse(a.ends) + 90e3 - now()))).unref());
  }
  function makeExam(slug, id, practice) {
    const c = C.getCourse(slug), x = c?.exams.find((y) => y.id === id);
    if (!x) throw err("no such exam", 404);
    if (practice) {
      startJob({ course: slug }, `practice-${id}`, "exam-practice", { course: c, exam: x }, (r) => r && C.mutateCourse(slug, (cc) => {
        const n = cc.exams.filter((y) => y.practice && y.of === id).length + 1;
        const pid = `${id}-practice-${n}`;
        C.sealExam(slug, pid, r.questions);
        cc.exams.push({ ...x, id: pid, title: `Practice ${x.title.toLowerCase()}${n > 1 ? ` ${n}` : ""}`, practice: true, of: id, source: "generated", url: "", solutions: "", loaded: true, count: r.questions.length });
      }));
      return;
    }
    if (C.examLoaded(slug, id)) throw err("already loaded", 409);
    const kind = x.url && x.source === "real" ? "exam-real" : "exam-practice";
    startJob({ course: slug }, `exam-${id}`, kind, { course: c, exam: x }, (r) => r && C.mutateCourse(slug, (cc) => {
      const e = cc.exams.find((y) => y.id === id);
      C.sealExam(slug, id, r.questions);
      e.loaded = true; e.count = r.questions.length;
      if (kind === "exam-practice") e.source = "generated";
      if (r.minutes && !e.minutes) e.minutes = r.minutes;
      if (r.rules && !e.rules) e.rules = r.rules;
      if (r.missing?.length) e.missing = r.missing.map(String);
    }));
  }

  // ----- written work -----
  const workFile = (slug, id) => path.join(C.courseDir(slug), "work", `${id}.md`);
  function workView(c, a) {
    const w = c.work?.[a.id] || {};
    return { state: w.state || "", saved: w.saved || null, submitted: w.submitted || null, grade: w.grade || null, error: w.error || "", words: w.words || 0 };
  }
  function getWork(slug, id) {
    const c = C.getCourse(slug), a = c?.assignments.find((x) => x.id === id);
    if (!a) throw err("no such assignment", 404);
    const qs = C.workQuestions(slug, id), graded = c.work?.[id]?.state === "graded";
    return { assignment: { ...a, questions: qs ? (graded ? qs : qs.map(forPage)) : undefined, solutions: graded ? a.solutions : "" }, work: workView(c, a), text: store.readText(workFile(slug, id)) || "", answers: c.work?.[id]?.answers || [], results: c.work?.[id]?.results || null, course: { slug, title: c.title, code: c.code } };
  }
  function saveWork(slug, id, { text, answers }) {
    const c = C.getCourse(slug), a = c?.assignments.find((x) => x.id === id);
    if (!a) throw err("no such assignment", 404);
    if (["grading", "graded"].includes(c.work?.[id]?.state)) throw err("it's handed in", 409);
    if (typeof text === "string") { fs.mkdirSync(path.dirname(workFile(slug, id)), { recursive: true }); fs.writeFileSync(workFile(slug, id), text.slice(0, 200000)); }
    C.mutateCourse(slug, (cc) => { cc.work = cc.work || {}; cc.work[id] = { ...(cc.work[id] || {}), state: "draft", saved: new Date(now()).toISOString(), words: typeof text === "string" ? (text.match(/\S+/g) || []).length : cc.work[id]?.words || 0, ...(Array.isArray(answers) ? { answers } : {}) }; });
    if (!c.work?.[id]) record(slug, { kind: "work-start", work: id });
  }
  function submitWork(slug, id) {
    const c = C.getCourse(slug), a = c?.assignments.find((x) => x.id === id), w = c?.work?.[id];
    if (!a) throw err("no such assignment", 404);
    if (["grading", "graded"].includes(w?.state)) throw err("it's handed in", 409);
    const text = store.readText(workFile(slug, id)) || "";
    if (!a.count && (text.match(/\S+/g) || []).length < 50) throw err("write it first (at least a paragraph)", 400);
    C.mutateCourse(slug, (cc) => { cc.work[id] = { ...(cc.work[id] || {}), state: "grading", submitted: new Date(now()).toISOString(), error: "" }; });
    record(slug, { kind: "work", work: id });
    gradeWork(slug, id);
  }
  // Grade handed-in work (also after a restart cut a grading short). It stays handed in; a failed grading is tried
  // again, never sent back for rewriting.
  function gradeWork(slug, id) {
    const c = C.getCourse(slug), a = c?.assignments.find((x) => x.id === id), w = c?.work?.[id];
    if (!a || w?.state !== "grading") return;
    const text = store.readText(workFile(slug, id)) || "";
    const done = (patch) => { C.mutateCourse(slug, (cc) => { if (cc.work[id]?.state === "grading") cc.work[id] = { ...cc.work[id], ...patch }; }); overseeSoon(slug); };
    const failed = (e) => done({ error: `Grading failed (${String(e?.message || "").slice(0, 160)}). It's handed in; grade it again from here.` });
    if (a.count) {
      const qs = C.workQuestions(slug, id);
      if (!qs) return failed(new Error("its problems are missing from this machine's state folder"));
      const results = W.autoGrade(qs, w?.answers || []);
      const items = results.filter((r) => r.pending).map((r) => ({ ...qs[r.n - 1], answer: r.answer }));
      const fin = (graded) => { const res = results.map((r) => { const g = graded.find((y) => y.n === r.n); return g ? { ...r, points: g.points, comment: g.comment, pending: false } : r; }); done({ state: "graded", results: res, grade: { ...W.total(res), at: new Date(now()).toISOString(), by: items.length ? "grader" : "key" } }); };
      if (!items.length) return fin([]);
      return startJob({ course: slug }, `grade-${id}`, "grade-answers", { course: c, title: a.title, items }, (r, e) => (r ? fin(r.answers) : failed(e)));
    }
    startJob({ course: slug }, `grade-${id}`, "grade-work", { course: c, assignment: a, text }, (r, e) => (r ? done({ state: "graded", grade: r.grade, error: "" }) : failed(e)));
  }

  // ----- loading a course into a program slot -----
  function loadSlot(programSlug, slotId, { urls, hint } = {}) {
    const p = C.getProgram(programSlug), s = p?.slots.find((x) => x.id === slotId);
    if (!s) throw err("no such slot", 404);
    const list = (urls?.length ? urls : [s.candidate?.syllabus, s.candidate?.url, ...(s.candidate?.sources || []).map((x) => x.url)]).filter(Boolean);
    if (!list.length) throw err("no course pages to read: paste the course's address", 400);
    const slug = store.slugify(`${s.candidate?.code || ""} ${s.candidate?.title || s.area}`);
    startJob({ program: programSlug }, `load-${slotId}`, "load", { urls: [...new Set(list)], hint: hint || `${s.candidate?.code || ""} ${s.candidate?.title || ""}: ${s.candidate?.note || ""}`, slug, program: programSlug, slot: slotId }, (r) => {
      if (!r) return;
      const extra = (s.candidate?.sources || []).filter((x) => !r.course.sources.some((y) => y.part === x.part));
      C.importCourse({ ...r.course, sources: [...r.course.sources, ...extra], missing: r.missing }, { replace: !!C.getCourse(r.course.slug) });
      C.linkCourses(C.mutateProgram(programSlug, (pp) => { pp.slots.find((x) => x.id === slotId).course = r.course.slug; }));
    });
  }
  function swapSlot(programSlug, slotId, b) {
    return C.mutateProgram(programSlug, (p) => {
      const s = p.slots.find((x) => x.id === slotId) || (() => { throw err("no such slot", 404); })();
      if (b.course !== undefined) { if (b.course && !C.getCourse(b.course)) throw err("no such course"); s.course = b.course || ""; return; }
      const alt = Number.isInteger(b.alternate) ? s.alternates[b.alternate] : null;
      if (alt) { const old = s.candidate; s.candidate = alt; s.alternates.splice(b.alternate, 1); if (old) s.alternates.unshift(old); s.course = ""; return; }
      if (/^https?:\/\/\S+$/.test(b.url || "")) { const old = s.candidate; s.candidate = { id: store.slugify(b.title || b.url), code: "", title: String(b.title || "").slice(0, 200) || b.url, institution: "", url: b.url, sources: [], graded: {} }; if (old) s.alternates.unshift(old); s.course = ""; return; }
      throw err("say which: an alternate, a course, or a url");
    });
  }

  // ----- starting a course and a program -----
  function startCourse(slug, day) {
    C.mutateCourse(slug, (c) => { c.start = day; c.status = "active"; });
    repaceFrom(slug, day);
    changed(slug);
  }
  async function startProgram(slug, { by = "learner", why = "" } = {}) {
    const day = today();
    let p = null, already = true;
    // the state changes inside the write, from waiting or asked only: a start can't happen twice
    C.mutateProgram(slug, (x) => { if (x.start.state !== "started") { already = false; x.start.state = "started"; x.start.started = day; } p = x; });
    if (already) return p;
    const first = p.slots.filter((s) => s.course && C.getCourse(s.course)?.status !== "done").slice(0, p.pace.concurrent);
    for (const s of first) startCourse(s.course, day);
    const c = first[0] && C.getCourse(first[0].course);
    if (c && !c.pretest) makePretest(c.slug);
    const msg = `${p.title} starts today${why ? ` (${why})` : ""}. First up: ${c ? `${c.code ? `${c.code} ` : ""}${c.title}, starting with its pre-test, being made in Teach now (about 15 minutes of multiple choice: whatever you already know gets skipped)` : "loading the first course"}. ${URL_PUBLIC}/courses/p/${slug}`;
    const r = by === "learner" ? { ok: false, why: "started by hand" } : await deliver(msg, `teach-start-${slug}`);
    C.mutateProgram(slug, (x) => { x.start.last = { at: new Date(now()).toISOString(), result: "started", by, delivered: r.ok }; });
    changed(slug);
    return C.getProgram(slug);
  }

  // The start gate: everything school has due through `through` turned in → start; past `askAfter` and still not → ask once.
  async function checkGate(slug) {
    const p = C.getProgram(slug);
    if (!p || p.start.kind !== "gate" || p.start.state === "started") return null;
    const g = p.start.gate, day = today();
    if (!g.from || !g.through) return null;   // (normalizeProgram sets from; a gate without through can't be checked)
    const r = await school(["open", "--from", g.from, "--through", g.through]);
    const last = { at: new Date(now()).toISOString(), ok: !!r, open: r?.open?.map((x) => `${x.course}: ${x.title} (due ${C.dayOf(Date.parse(x.due) || Date.now())})`) || null, fresh: r?.fresh || null, error: r ? "" : "the school check didn't answer" };
    // what school says counts only when it's recent: no time stamp, or one over 12 hours old, isn't proof
    const stale = !r?.fresh || !(now() - Date.parse(r.fresh) <= 12 * 3600e3);
    if (C.getProgram(slug)?.start.state === "started") return null;   // (started by hand while the check ran)
    if (r && !stale && Array.isArray(r.open) && r.open.length === 0) {
      C.mutateProgram(slug, (x) => { x.start.last = { ...last, result: "met" }; });
      return startProgram(slug, { by: "gate", why: "your school work through the end of next week is turned in" });
    }
    let ask = false;
    if (g.askAfter && day >= g.askAfter) C.mutateProgram(slug, (x) => { if (x.start.state === "waiting") { x.start.state = "asked"; ask = true; } });
    if (ask) {
      const list = last.open?.slice(0, 4).join("; ");
      const d = await deliver(`${p.title} was going to start once the school work due through ${g.through} was turned in. ${list ? `Still showing as not turned in: ${list}.` : "Teach couldn't confirm it from the school check."} Ask ${LEARNER === "the learner" ? "them" : LEARNER} whether to start now: say go in Teach (or tell Claude), and until then Teach keeps checking.`, `teach-start-ask-${slug}`);
      C.mutateProgram(slug, (x) => { x.start.last = { ...last, result: "asked", delivered: d.ok }; });
      changed(slug);
      return null;
    }
    C.mutateProgram(slug, (x) => { if (x.start.state !== "started") x.start.last = { ...last, result: r && stale ? "stale" : "waiting" }; });
    changed(slug);
    return null;
  }

  // ----- calendar -----
  // Deadlines on the calendar, one sync at a time per course. A moved deadline is moved (TEACH_CALENDAR_MOVE_CMD); a
  // move that fails is kept and tried again next time, never added twice. Without a move command the new time is
  // added and the old event listed as stale (to delete by hand). Done items keep their event and its id.
  const calChain = new Map();
  function syncCalendar(slug) {
    const p = (calChain.get(slug) || Promise.resolve()).catch(() => {}).then(() => syncCalendarNow(slug));
    calChain.set(slug, p);
    return p;
  }
  async function syncCalendarNow(slug) {
    const c = C.getCourse(slug);
    if (!c.start) throw err("the course hasn't started", 409);
    const want = C.calendarEvents(c, { hour: getSettings().calendarHour, link: `${URL_PUBLIC}/courses/c/${slug}` });
    const have = c.calendar?.events || [], stale = [...(c.calendar?.stale || [])];
    const next = [];
    let added = 0, moved = 0, failed = "";
    for (const e of want) {
      const old = have.find((h) => h.id === e.id);
      if (old && old.local === e.local) { next.push({ ...old, pendingMove: undefined, done: undefined }); continue; }
      if (old?.ref && MOVE_CMD) {
        const r = await run(MOVE_CMD, [old.ref, e.local]);
        if (r.ok) { next.push({ ...old, ...e, ref: old.ref, pendingMove: undefined, done: undefined }); moved++; }
        else { failed = r.err.slice(-200); next.push({ ...old, pendingMove: e.local }); }
        continue;
      }
      if (!calendarCmd) { next.push({ ...e, ref: "" }); continue; }
      const r = await run(calendarCmd, [e.title, e.local, "--for", `${e.minutes}m`, "--note", e.note, "--remind", e.minutes > 60 ? "1440m" : "60m"]);
      if (!r.ok) { failed = r.err.slice(-200); if (old) next.push(old); continue; }
      if (old?.ref) stale.push({ title: old.title, local: old.local, ref: old.ref });
      next.push({ ...e, ref: (r.out.match(/\[([0-9a-z]{4,})\]/i) || r.out.match(/\b([0-9a-f]{4,})\b/i) || [])[1] || "" });
      added++;
    }
    for (const h of have) if (!want.some((e) => e.id === h.id) && h.ref) next.push({ ...h, done: true });   // (done: its event stays, with its id)
    C.mutateCourse(slug, (x) => { x.calendar = { events: next, stale: stale.slice(-50), at: new Date(now()).toISOString(), error: failed }; });
    changed(slug);
    if (failed && !added && !moved) throw err(`the calendar command failed: ${failed}`, 502);
    return { added, moved, total: next.filter((e) => !e.done).length, stale: stale.length };
  }
  function ics(slug) {
    const c = C.getCourse(slug);
    const evs = C.calendarEvents(c, { hour: getSettings().calendarHour, link: `${URL_PUBLIC}/courses/c/${slug}` });
    const t = (local) => local.replace(/[-:]/g, "").replace(" ", "T") + "00";
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Teach//Courses//EN", ...evs.flatMap((e) => ["BEGIN:VEVENT", `UID:${e.key}@teach`, `DTSTART:${t(e.local)}`, `DURATION:PT${e.minutes}M`, `SUMMARY:${e.title.replace(/[,;]/g, "\\$&")}`, `DESCRIPTION:${e.note.replace(/[,;]/g, "\\$&")}`, "END:VEVENT"]), "END:VCALENDAR", ""].join("\r\n");
  }

  // ----- the weekly check-in -----
  async function checkin({ force = false, dry = false } = {}) {
    const st = getSettings();
    const active = C.listCourses().map(C.getCourse).filter((c) => c?.status === "active" && c.start && c.start <= today());
    if (!active.length) return { sent: false, why: "no course has started" };
    const freq = active.some((c) => c.plan.checkin?.freq === "twice") ? "twice" : "weekly";
    const last = store.readJSON(path.join(STATE, "checkin.json"), {}).last;
    const slot = force ? new Date(now()) : P.checkinDue(st.checkin, freq, last, new Date(now()));
    if (!slot) return { sent: false, why: "not due" };
    const sw = (await school(["weeks", "--from", C.weekOf(today()), "--weeks", "3"]))?.weeks ?? [];
    const parts = [];
    let urgent = false;
    for (const c0 of active) {
      const sunday = new Date(slot).getDay() === st.checkin.day;
      const made = dry ? [] : await oversee(c0.slug, sunday ? P.WEEKLY : P.BETWEEN, { schoolWeeks: sw });
      const c = C.getCourse(c0.slug);
      const lines = P.checkinLines(c, { today: today(), ctx: ctxOf(c), recentChanges: made });
      urgent ||= lines.behind || c.plan.checkin?.style === "text";
      parts.push(lines.lines.join(" "));
    }
    const late = active.flatMap((c) => C.behind(C.getCourse(c.slug), today(), ctxOf(C.getCourse(c.slug))).map((x) => `${x.title} (${c.code || c.title}, was due ${fmt(x.due)})`));
    // a mention for the next conversation (the voice says it in its own words); being behind is a text, written like one
    const msg = urgent && late.length
      ? `You're behind on ${late.slice(0, 3).join(" and ")}. ${parts.map((x) => x.match(/Due this coming week: [^.]*\./)?.[0] || "").filter(Boolean).join(" ")} The plan's re-paced around it: ${URL_PUBLIC}/courses`.replace(/\s+/g, " ")
      : `Weekly check-in on ${LEARNER === "the learner" ? "their" : `${LEARNER}'s`} self-study courses, to bring up with them: ${parts.join(" ")} ${URL_PUBLIC}/courses`;
    const key = `teach-checkin-${today()}`;
    if (dry) return { sent: false, message: msg, urgent };
    const r = await deliver(msg, key, urgent);
    store.writeJSON(path.join(STATE, "checkin.json"), { last: new Date(now()).toISOString(), key, urgent, delivered: r.ok, message: msg });
    for (const c of active) C.mutateCourse(c.slug, (x) => { x.checkins = [...(x.checkins || []), { at: new Date(now()).toISOString(), urgent, delivered: r.ok, text: parts[active.indexOf(c)] }].slice(-30); });
    return { sent: r.ok, message: msg, urgent, why: r.ok ? "" : r.why || r.out };
  }

  // Between check-ins: a missed deadline (and the other quick rules) as soon as it happens, with a text for a slip.
  async function between() {
    for (const s of C.listCourses()) {
      const made = await oversee(s, P.BETWEEN, { schoolWeeks: [] }).catch((e) => { console.error("teach: professor:", e.message); return []; });
      for (const ch of made.filter((x) => x.urgent)) {
        const c = C.getCourse(s);
        await deliver(ch.rule === "slip" ? `Missed one in ${c.code || c.title}: ${ch.title.replace(/: missed .*/, "")}. I moved it to ${fmt(ch.patch.find((x) => x.path.startsWith("due."))?.to || today())} and re-paced the rest around it. ${URL_PUBLIC}/courses/c/${s}`
          : `${c.code || c.title}: ${ch.title}. ${ch.reason} ${URL_PUBLIC}/courses/c/${s}`, `teach-${ch.id}`, true);
      }
    }
  }

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      for (const p of C.listPrograms()) await checkGate(p).catch((e) => console.error("teach: start check:", e.message));
      for (const s of C.listCourses()) { const c = C.getCourse(s); for (const [id, a] of Object.entries(c?.attempts || {})) if (a.state === "in-progress" && now() > Date.parse(a.ends) + 90e3) try { submitExam(s, id); } catch (e) { console.error("teach: hand-in at time:", e.message); } }
      await between();
      await checkin().catch((e) => console.error("teach: check-in:", e.message));
    } finally { ticking = false; }
  }

  // ----- HTTP -----
  const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
  async function route(req, res, url, readBody) {
    const p = url.pathname, m = req.method;
    if (!p.startsWith("/api/courses") && !p.startsWith("/api/programs") && p !== "/api/context") return false;
    const body = async () => (m === "GET" ? {} : JSON.parse((await readBody(req)).toString() || "{}"));
    try {
      let mm;
      if (p === "/api/courses" && m === "GET") {
        return json(res, 200, { programs: C.listPrograms().map((s) => { const v = programView(s); return { ...v.program, progress: v.progress, timeline: v.timeline, start: v.start, slots: v.slots.map((x) => ({ id: x.id, order: x.order, kind: x.kind, area: x.area, status: x.status, counts: x.counts, title: x.course?.title || x.candidate?.title || "", code: x.course?.code || x.candidate?.code || "" })) }; }),
          courses: C.listCourses().map((s) => courseSummary(C.getCourse(s))), settings: getSettings(), notes: getNotes(), features: { checkin: !!CHECKIN_CMD, school: !!SCHOOL_CMD, calendar: !!calendarCmd } }), true;
      }
      if (p === "/api/courses/settings" && m === "PUT") return json(res, 200, { settings: setSettings(await body()) }), true;
      if (p === "/api/courses/checkin" && m === "POST") { const b = await body(); return json(res, 200, await checkin({ force: true, dry: !!b.dry })), true; }
      if (p === "/api/context") {
        if (m === "GET") return json(res, 200, { notes: getNotes() }), true;
        const b = await body();
        if (m === "POST") return json(res, 200, { note: addNote(b) }), true;
        if (m === "DELETE") { dropNote(String(b.id || "")); return json(res, 200, { ok: true }), true; }
      }
      if (p === "/api/courses/import" && m === "POST") { const b = await body(); const c = C.importCourse(b.course, { replace: !!b.replace }); changed(c.slug); return json(res, 200, { slug: c.slug }), true; }
      if (p === "/api/programs/import" && m === "POST") { const b = await body(); const x = C.importProgram(b.program, { replace: !!b.replace }); return json(res, 200, { slug: x.slug }), true; }
      if ((mm = p.match(/^\/api\/programs\/([a-z0-9-]+)(?:\/([a-z-]+))?$/))) {
        const [, slug, action = ""] = mm;
        if (m === "GET" && !action) return json(res, 200, programView(slug)), true;
        const b = await body();
        if (action === "pace") { C.mutateProgram(slug, (x) => { if (Number(b.hoursPerWeek) >= 1 && Number(b.hoursPerWeek) <= 40) x.pace.hoursPerWeek = Number(b.hoursPerWeek); if ([1, 2, 3].includes(Number(b.concurrent))) x.pace.concurrent = Number(b.concurrent); });
          for (const s of C.getProgram(slug).slots) if (s.course && C.getCourse(s.course)?.start) repaceFrom(s.course, today(), "a new weekly pace");
          changed(slug); return json(res, 200, programView(slug)), true; }
        if (action === "start") { await startProgram(slug, { by: "learner" }); return json(res, 200, programView(slug)), true; }
        if (action === "check") { await checkGate(slug); return json(res, 200, programView(slug)), true; }
        if (action === "status") { C.mutateProgram(slug, (x) => { if (["active", "alternative", "paused", "done"].includes(b.status)) x.status = b.status; }); return json(res, 200, programView(slug)), true; }
        if (action === "slot") {
          if (b.op === "load") loadSlot(slug, b.slot, b);
          else if (b.op === "pause") pauseJob({ program: slug }, `load-${b.slot}`);
          else swapSlot(slug, b.slot, b);
          changed(slug);
          return json(res, 200, programView(slug)), true;
        }
        return json(res, 404, { error: "unknown action" }), true;
      }
      if ((mm = p.match(/^\/api\/courses\/([a-z0-9-]+)(?:\/([a-z-]+))?(?:\/([a-z0-9-]+))?$/))) {
        const [, slug, action = "", id = ""] = mm;
        if (!C.getCourse(slug)) return json(res, 404, { error: "no such course" }), true;
        if (m === "GET" && !action) return json(res, 200, courseView(slug)), true;
        if (m === "GET" && action === "pretest") { const c = C.getCourse(slug); return json(res, 200, { pretest: c.pretest ? { questions: c.pretest.result ? c.pretest.questions : c.pretest.questions?.map(forPage), answers: c.pretest.answers, result: c.pretest.result } : null, course: { slug, title: c.title, code: c.code } }), true; }
        if (m === "GET" && action === "exam") return json(res, 200, examView(slug, id)), true;
        if (m === "GET" && action === "work") return json(res, 200, getWork(slug, id)), true;
        if (m === "GET" && action === "ics") { res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="${slug}.ics"` }); res.end(ics(slug)); return true; }
        const b = await body();
        switch (action) {
          case "pretest":
            if (b.op === "make") { makePretest(slug); break; }
            if (b.op === "pause") { pauseJob({ course: slug }, "pretest"); break; }
            if (b.op === "answer") return json(res, 200, await answerPretest(slug, Array.isArray(b.answers) ? b.answers : [])), true;
            throw err("op must be make, pause or answer");
          case "unit": { const t = startUnit(slug, Number(id || b.n)); return json(res, 200, { topic: t }), true; }
          case "review": {
            const c = C.getCourse(slug), r = (c.plan.reviews || []).find((x) => x.id === (id || b.id));
            if (!r) throw err("no such review", 404);
            const u = c.units.find((x) => r.units.includes(x.n) && x.topic);
            if (!u) throw err("the unit's lesson hasn't started", 409);
            turn(u.topic, [{ type: "text", text: `[Teach app] course review\nThe course's professor added a review of unit${r.units.length > 1 ? "s" : ""} ${r.units.join(", ")} (${r.why === "retention" ? "the review cards show it fading" : "a graded score under 70%"}). Run it now: about ${Math.round(r.hours * 60)} minutes of retrieval practice on the weakest points, re-teach what slipped, and log how it went.` }], {});
            C.mutateCourse(slug, (x) => { x.reviewsDone = { ...(x.reviewsDone || {}), [r.id]: today() }; });
            record(slug, { kind: "lesson", unit: r.units[0] });
            return json(res, 200, { topic: u.topic }), true;
          }
          case "exam":
            if (b.op === "load") makeExam(slug, id, false);
            else if (b.op === "practice") makeExam(slug, id, true);
            else if (b.op === "pause") pauseJob({ course: slug }, b.key || `exam-${id}`);
            else if (b.op === "start") return json(res, 200, startExam(slug, id)), true;
            else if (b.op === "save") saveExam(slug, id, b.answers, b.away);
            else if (b.op === "submit") { saveExam(slug, id, b.answers); submitExam(slug, id); }
            else if (b.op === "regrade") { const at = C.getCourse(slug).attempts?.[id]; if (at && jobs.has(`${slug}:grade-${id}-${Date.parse(at.started)}`)) throw err("it's being graded now", 409); gradeExam(slug, id); }
            else throw err("op must be load, practice, pause, start, save, submit or regrade");
            break;
          case "work":
            if (b.op === "save") saveWork(slug, id, b);
            else if (b.op === "submit") { if (b.text !== undefined || b.answers) saveWork(slug, id, b); submitWork(slug, id); }
            else if (b.op === "regrade") { if (jobs.has(`${slug}:grade-${id}`)) throw err("it's being graded now", 409); gradeWork(slug, id); }
            else throw err("op must be save, submit or regrade");
            break;
          case "calendar": return json(res, 200, await syncCalendar(slug)), true;
          case "start": if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || "")) throw err("date is YYYY-MM-DD"); startCourse(slug, b.date); break;
          case "undo": C.mutateCourse(slug, (c) => { P.undo(c, b.id, today()); }); if (C.getCourse(slug).calendar?.events?.length) await syncCalendar(slug).catch(() => {}); break;
          case "oversee": await oversee(slug, b.weekly ? P.WEEKLY : P.BETWEEN); break;
          default: return json(res, 404, { error: "unknown action" }), true;
        }
        changed(slug);
        return json(res, 200, courseView(slug)), true;
      }
      return false;
    } catch (e) {
      json(res, e.code && e.code < 600 ? e.code : 400, { error: String(e.message || e) });
      return true;
    }
  }

  // A restart stops every job: what was being made is marked paused (a click starts it again).
  for (const s of C.listCourses()) { const c = C.getCourse(s); if (Object.values(c.outputs || {}).some((o) => o.state === "working")) C.mutateCourse(s, (x) => { for (const o of Object.values(x.outputs)) if (o.state === "working") Object.assign(o, { state: "paused", progress: "Teach restarted. A click starts it again." }); }); }
  for (const s of C.listPrograms()) { const p = C.getProgram(s); if (Object.values(p.outputs || {}).some((o) => o.state === "working")) C.mutateProgram(s, (x) => { for (const o of Object.values(x.outputs)) if (o.state === "working") Object.assign(o, { state: "paused", progress: "Teach restarted. A click starts it again." }); }); }

  setTimeout(() => {
    for (const s of C.listCourses()) {
      const c = C.getCourse(s);
      try {
        for (const [id, a] of Object.entries(c?.attempts || {})) { if (a.state === "in-progress") timeUp(s, id); if (a.state === "grading") gradeExam(s, id); }
        for (const [id, w] of Object.entries(c?.work || {})) if (w.state === "grading") gradeWork(s, id);
      } catch (e) { console.error(`teach: picking up ${s}'s gradings:`, e.message); }
    }
  }, 3000).unref();

  return { route, tick, onTurnEnd, startUnit, checkin, checkGate, startProgram, oversee, evidence, courseView, programView, sessions, syncCalendar };
}
