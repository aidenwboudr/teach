// Courses and programs: whole courses (a real course's syllabus, units, readings, graded work and exams) and programs
// above them (a self-study major or track: requirement slots, each filled by a course, in the order they're taken).
// A course's units are taught as ordinary Teach topics, one per unit, created when the learner starts the unit.
//
// Plain files in the learning folder, like topics:
//   courses/<slug>/course.json   the course: units, assignments, exams, grading, schedule, pre-test, work, attempts,
//                                the professor's plan and its change log (lib/professor.mjs)
//   courses/<slug>/work/         what the learner wrote for an assignment (Markdown)
//   programs/<slug>.json         a program: its slots (each with the free course behind it), pace and start rule
//
// This module is pure logic plus the store: no model calls (lib/coursework.mjs makes those) and no HTTP.
import fs from "node:fs";
import path from "node:path";
import { LEARNING, STATE } from "./paths.mjs";
import { readJSON, writeJSON, now, slugify, validSlug } from "./store.mjs";

export const COURSES = path.join(LEARNING, "courses");
export const PROGRAMS = path.join(LEARNING, "programs");
const DAY = 86400e3;
const str = (v, max = 400) => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const num = (v, d = null) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
const fail = (msg) => { throw Object.assign(new Error(msg), { code: 400 }); };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const url = (v) => (/^https?:\/\/\S+$/.test(str(v, 800)) ? str(v, 800) : "");

export const SLOT_KINDS = ["foundation", "core", "theme", "capstone", "prereq", "elective"];
export const WORK_KINDS = ["argument-analysis", "paper", "pset", "problems", "memo", "essay", "project"];
export const EXAM_KINDS = ["midterm", "final", "quiz"];
export const PARTS = ["lectures", "readings", "assignments", "exams"];

// ---------- dates (local calendar days, "YYYY-MM-DD") ----------

export const dayOf = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
export const addDays = (day, n) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + n); return dayOf(d); };
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / DAY);
// The Monday of the week a day is in (weeks run Monday to Sunday).
export const weekOf = (day) => { const d = new Date(`${day}T12:00:00`); return addDays(day, -((d.getDay() + 6) % 7)); };

// ---------- normalizing what an import (a person, an agent, the course loader) hands in ----------

function source(s) {
  if (!s || typeof s !== "object") return null;
  const part = PARTS.includes(s.part) ? s.part : fail(`each source needs a part (one of ${PARTS.join(", ")})`);
  return { part, title: str(s.title, 200), institution: str(s.institution, 120), url: url(s.url), generated: !!s.generated, note: str(s.note, 300) };
}

function rubric(r) {
  return (Array.isArray(r) ? r : []).map((c) => ({ criterion: str(c.criterion || c.name, 200), points: num(c.points, 0), detail: str(c.detail, 800) }))
    .filter((c) => c.criterion);
}

// A question for a test (an exam, a pre-test): the ask tool's kinds, plus points and the official answer for written ones.
export function normalizeQuestion(q, i) {
  const kind = ["choice", "multi", "text", "number"].includes(q.kind) ? q.kind : "choice";
  const out = { n: i + 1, kind, prompt: str(q.prompt, 6000) || fail(`question ${i + 1} needs a prompt`), points: num(q.points, kind === "text" ? 10 : 1), part: str(q.part, 120), unit: num(q.unit) };
  if (kind === "choice" || kind === "multi") {
    out.options = (q.options || []).map((o) => str(String(o), 800)).filter(Boolean);
    if (out.options.length < 2) fail(`question ${i + 1} needs at least 2 options`);
    // the key as an index, or as the option's own text (a model often gives that); anything else isn't a key
    const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const idx = (a) => (Number.isInteger(a) && out.options[a] !== undefined ? a : typeof a === "string" && a.trim() ? out.options.findIndex((o) => norm(o) === norm(a)) : -1);
    if (kind === "choice" && q.answer !== undefined && idx(q.answer) >= 0) out.answer = idx(q.answer);
    if (kind === "multi" && Array.isArray(q.answer)) { const a = q.answer.map(idx).filter((i) => i >= 0); if (a.length === q.answer.length) out.answer = [...new Set(a)]; }
  }
  if (kind === "number" && Number.isFinite(Number(q.answer))) { out.answer = Number(q.answer); out.tolerance = num(q.tolerance, Math.abs(out.answer) * 0.01 || 1e-9); out.unit_label = str(q.unit_label, 30); }
  if (kind === "text") { out.model = str(q.model || q.answer, 6000); out.words = num(q.words); }
  out.why = str(q.why, 1500);
  return out;
}

export function normalizeCourse(inp, { slug } = {}) {
  if (!inp || typeof inp !== "object") fail("a course is a JSON object");
  const title = str(inp.title, 160) || fail("a course needs a title");
  const s = slug || (validSlug(inp.slug) ? inp.slug : slugify(`${inp.code || ""} ${title}`));
  const units = (Array.isArray(inp.units) ? inp.units : []).map((u, i) => ({
    n: num(u.n, i + 1), title: str(u.title, 200) || fail(`unit ${i + 1} needs a title`), summary: str(u.summary, 1500),
    lectures: (u.lectures || []).map((l, j) => ({ n: num(l.n, j + 1), title: str(l.title, 200), url: url(l.url || l.video), minutes: num(l.minutes), slides: url(l.slides) })).filter((l) => l.title),
    readings: (u.readings || []).map((r) => ({ author: str(r.author, 200), title: str(r.title, 300), url: url(r.url), pages: num(r.pages), required: r.required !== false, note: str(r.note, 300) })).filter((r) => r.title),
    topic: validSlug(u.topic) ? u.topic : "",
    mode: u.mode === "fast" ? "fast" : "normal", extraReview: num(u.extraReview, 0), extraSessions: num(u.extraSessions, 0),
  }));
  if (!units.length) fail("a course needs at least one unit");
  for (const u of units) if (!Number.isInteger(u.n) || u.n < 0 || u.n > 999) fail(`unit numbers are whole numbers (got ${u.n})`);
  const ns = new Set(units.map((u) => u.n));
  if (ns.size !== units.length) fail("unit numbers must be unique");
  const assignments = (Array.isArray(inp.assignments) ? inp.assignments : []).map((a, i) => ({
    id: str(a.id, 40).replace(/[^a-z0-9-]/gi, "-").toLowerCase() || `a${i + 1}`,
    kind: WORK_KINDS.includes(a.kind) ? a.kind : "paper", title: str(a.title, 200) || fail(`assignment ${i + 1} needs a title`),
    prompt: str(a.prompt, 12000), length: str(a.length, 120), unit: ns.has(num(a.unit)) ? num(a.unit) : units.at(-1).n,
    rubric: rubric(a.rubric), rubricSource: str(a.rubricSource, 300), points: num(a.points, 100),
    questions: Array.isArray(a.questions) && a.questions.length ? a.questions.map(normalizeQuestion) : undefined,   // problems checked against a key (sealed on import)
    count: 0,
    url: url(a.url || a.source_url), solutions: url(a.solutions || a.solutions_url), source: a.source === "generated" ? "generated" : "real", hours: num(a.hours),
  }));
  const exams = (Array.isArray(inp.exams) ? inp.exams : []).map((x, i) => ({
    id: str(x.id, 40).replace(/[^a-z0-9-]/gi, "-").toLowerCase() || `x${i + 1}`,
    kind: EXAM_KINDS.includes(x.kind) ? x.kind : "quiz", title: str(x.title, 200) || `${x.kind || "Exam"}`,
    covers: (Array.isArray(x.covers || x.covers_units) ? (x.covers || x.covers_units) : []).map(Number).filter((n) => ns.has(n)),
    unit: ns.has(num(x.unit)) ? num(x.unit) : Math.max(...((x.covers || x.covers_units || []).map(Number).filter((n) => ns.has(n))), units[0].n),
    minutes: num(x.minutes, 120), closedBook: x.closedBook ?? x.closed_book ?? true, rules: str(x.rules || x.format, 2000),
    source: x.source === "generated" ? "generated" : "real", url: url(x.url || x.real_exam_url), solutions: url(x.solutions || x.solutions_url),
    practice: !!x.practice, of: str(x.of, 40),
    questions: Array.isArray(x.questions) && x.questions.length ? x.questions.map(normalizeQuestion) : undefined,   // sealed on import (below)
    loaded: false, count: 0,   // (set when its questions are sealed, never by an import)
  }));
  const ids = [...assignments.map((a) => a.id), ...exams.map((x) => x.id)];
  if (new Set(ids).size !== ids.length) fail("assignment and exam ids must be unique");
  const grading = (Array.isArray(inp.grading) ? inp.grading : []).map((g) => ({ what: str(g.what, 200), weight: num(String(g.weight).replace("%", ""), 0), items: (g.items || []).map(String).filter((id) => ids.includes(id)) })).filter((g) => g.what);
  return {
    v: 1, slug: s, title, code: str(inp.code, 60), institution: str(inp.institution, 120), instructors: (inp.instructors || []).map((x) => str(x, 120)).filter(Boolean),
    edition: str(inp.edition, 300), url: url(inp.url), summary: str(inp.summary, 2000),
    program: validSlug(inp.program) ? inp.program : "", slot: str(inp.slot, 40),
    sources: (Array.isArray(inp.sources) ? inp.sources : []).map(source).filter(Boolean),
    hours: { pagesPerHour: num(inp.hours?.pagesPerHour, 15), lectureMinutes: num(inp.hours?.lectureMinutes, 60), kind: ["reading", "math", "mixed"].includes(inp.hours?.kind) ? inp.hours.kind : "mixed" },
    grading, units, assignments, exams, passMark: num(inp.passMark),
    start: isDate(inp.start) ? inp.start : "", status: ["planned", "active", "done", "dropped"].includes(inp.status) ? inp.status : "planned",
    // what the app and the professor keep (an import doesn't set these)
    due: {}, pretest: null, work: {}, attempts: {}, calendar: { events: [] }, outputs: {},
    plan: { sessionMinutes: 45, preferred: "", edge: 1, weeks: {}, checkin: { freq: "weekly", style: "voice" }, reviews: [], slips: {} },
    changes: [], holds: {}, activity: [], checkins: [], reviewsDone: {},
    created: now(), updated: now(),
  };
}

// ---------- the store ----------

// An exam's questions and key, once loaded, are sealed: kept in this machine's state (not the learning folder, which
// tutors read and git syncs), encoded so a text search over the folder doesn't turn them up. course.json says only
// that it's loaded and how many questions it has. The page gets them when the sitting starts, the key after it's graded.
const SEALED = path.join(STATE, "sealed");
const sealFile = (slug, id) => path.join(SEALED, slug, `${String(id).replace(/[^a-z0-9-]/gi, "-")}.json`);
export function sealExam(slug, id, questions) {
  fs.mkdirSync(path.dirname(sealFile(slug, id)), { recursive: true });
  fs.writeFileSync(sealFile(slug, id), JSON.stringify({ v: 1, q: Buffer.from(JSON.stringify(questions)).toString("base64") }), { mode: 0o600 });
}
export function examQuestions(slug, id) {
  try { const q = JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(sealFile(slug, id), "utf8")).q, "base64").toString("utf8")); return Array.isArray(q) && q.length ? q : null; } catch { return null; }
}
export const examLoaded = (slug, id) => !!examQuestions(slug, id);
// An assignment's problems and key are sealed the same way (as "work-<id>").
export const workQuestions = (slug, id) => examQuestions(slug, `work-${id}`);

export const courseDir = (slug) => path.join(COURSES, slug);
const courseFile = (slug) => path.join(courseDir(slug), "course.json");
export const programFile = (slug) => path.join(PROGRAMS, `${slug}.json`);

export function listCourses() {
  try { return fs.readdirSync(COURSES).filter((s) => validSlug(s) && fs.existsSync(courseFile(s))); } catch { return []; }
}
export function getCourse(slug) { return validSlug(slug) ? readJSON(courseFile(slug), null) : null; }
export function saveCourse(c) { c.updated = now(); writeJSON(courseFile(c.slug), c); return c; }
export function mutateCourse(slug, fn) {
  const c = getCourse(slug) || fail(`no course "${slug}"`);
  if (fn(c) === false) return c;   // (nothing changed: no write, so no sync churn)
  return saveCourse(c);
}
// An import: a new course, or a new version of one (what the learner did, the plan and the log stay).
export function importCourse(inp, { replace = false } = {}) {
  const c = normalizeCourse(inp);
  const old = getCourse(c.slug);
  if (old && !replace) fail(`a course "${c.slug}" exists (import with replace to update it)`);
  if (old) {
    for (const k of ["due", "pretest", "work", "attempts", "calendar", "outputs", "plan", "changes", "holds", "activity", "checkins", "reviewsDone", "created", "start", "status", "program", "slot"]) if (old[k] !== undefined && !(k === "program" || k === "slot") || (old[k] && !c[k])) c[k] = old[k];
    for (const u of c.units) { const o = old.units.find((x) => x.n === u.n); if (o) Object.assign(u, { topic: o.topic, mode: o.mode, extraReview: o.extraReview, extraSessions: o.extraSessions }); }
    for (const x of c.exams) {
      const o = old.exams.find((y) => y.id === x.id);
      if (old.attempts?.[x.id]) delete x.questions;   // a sat exam keeps the questions its results are marked against
      if (!x.questions && o && examLoaded(c.slug, x.id)) { x.loaded = true; x.count = o.count; }
    }
    for (const a of c.assignments) { const o = old.assignments.find((y) => y.id === a.id); if (old.work?.[a.id]?.state && ["grading", "graded"].includes(old.work[a.id].state)) delete a.questions; if (!a.questions && o?.count) a.count = o.count; }
    // an exam that's been sat stays what it was: a new version can't turn it into practice (a retake) or drop it
    for (const o of old.exams.filter((y) => old.attempts?.[y.id])) {
      const x = c.exams.find((y) => y.id === o.id);
      if (!x) c.exams.push(o);
      else if (x.practice !== o.practice) fail(`exam "${o.id}" has been sat: it can't change between real and practice`);
    }
  }
  for (const x of c.exams) if (x.questions) { sealExam(c.slug, x.id, x.questions); x.loaded = true; x.count = x.questions.length; delete x.questions; }
  for (const a of c.assignments) if (a.questions) { sealExam(c.slug, `work-${a.id}`, a.questions); a.count = a.questions.length; delete a.questions; }
  fs.mkdirSync(path.join(courseDir(c.slug), "work"), { recursive: true });
  return saveCourse(c);
}

export function listPrograms() {
  try { return fs.readdirSync(PROGRAMS).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter(validSlug); } catch { return []; }
}
export function getProgram(slug) { return validSlug(slug) ? readJSON(programFile(slug), null) : null; }
export function saveProgram(p) { p.updated = now(); writeJSON(programFile(p.slug), p); return p; }
export function mutateProgram(slug, fn) { const p = getProgram(slug) || fail(`no program "${slug}"`); fn(p); return saveProgram(p); }

// A candidate course behind a slot, before it's loaded: what the course's own pages say.
function candidate(c) {
  if (!c || typeof c !== "object") return null;
  return {
    id: str(c.id, 60) || slugify(`${c.code || ""} ${c.title || ""}`), code: str(c.code, 60), title: str(c.title, 200), institution: str(c.institution, 120),
    instructors: (c.instructors || []).map((x) => str(x, 120)).filter(Boolean), edition: str(c.edition, 200), url: url(c.url), syllabus: url(c.syllabus || c.syllabus_url),
    lectures: num(c.lectures), videos: !!c.videos, weeks: num(c.weeks), hoursPerWeek: num(c.hoursPerWeek ?? c.hours_per_week),
    kind: ["reading", "math", "mixed"].includes(c.kind) ? c.kind : "mixed",
    graded: { psets: !!c.graded?.psets, papers: !!c.graded?.papers, midterm: !!c.graded?.midterm, final: !!c.graded?.final, solutions: !!c.graded?.solutions, notes: str(c.graded?.notes, 600) },
    prereqs: str(c.prereqs || c.prereqs_stated, 400),
    sources: (Array.isArray(c.sources) ? c.sources : []).map(source).filter(Boolean),
    note: str(c.note, 600),
  };
}

export function normalizeProgram(inp) {
  if (!inp || typeof inp !== "object") fail("a program is a JSON object");
  const title = str(inp.title, 160) || fail("a program needs a title");
  const slots = (inp.slots || []).map((s, i) => ({
    id: str(s.id, 40).replace(/[^a-z0-9-]/gi, "-").toLowerCase() || `s${i + 1}`,
    order: num(s.order, i + 1), kind: SLOT_KINDS.includes(s.kind) ? s.kind : fail(`slot ${i + 1}: kind must be one of ${SLOT_KINDS.join(", ")}`),
    area: str(s.area, 160) || fail(`slot ${i + 1} needs an area`), requirement: str(s.requirement, 600), counts: s.counts !== false && s.kind !== "prereq",
    course: validSlug(s.course) ? s.course : "", candidate: candidate(s.candidate), alternates: (s.alternates || []).map(candidate).filter(Boolean),
    after: (s.after || []).map((x) => str(x, 40)), why: str(s.why, 600),
  })).sort((a, b) => a.order - b.order);
  const ids = new Set(slots.map((s) => s.id));
  if (ids.size !== slots.length) fail("slot ids must be unique");
  for (const s of slots) for (const a of s.after) if (!ids.has(a)) fail(`slot ${s.id}: "after" names ${a}, which isn't a slot`);
  const st = inp.start || {};
  return {
    v: 1, slug: validSlug(inp.slug) ? inp.slug : slugify(title), title, kind: inp.kind === "track" ? "track" : "major",
    model: str(inp.model, 300), modelUrl: url(inp.modelUrl), about: str(inp.about, 2000), theme: inp.theme ? { name: str(inp.theme.name, 160), why: str(inp.theme.why, 1500) } : null,
    status: ["active", "alternative", "paused", "done"].includes(inp.status) ? inp.status : "active",
    pace: { hoursPerWeek: num(inp.pace?.hoursPerWeek, 6), concurrent: Math.min(3, Math.max(1, num(inp.pace?.concurrent, 1))) },
    // when it starts: a day, or a condition (`gate`) the app checks, with a day after which it asks instead of starting
    start: { kind: st.kind === "gate" ? "gate" : isDate(st.date) ? "date" : "manual", date: isDate(st.date) ? st.date : "", label: str(st.label, 300),
      gate: st.kind === "gate" ? { check: str(st.gate?.check, 40) || "school-open", from: isDate(st.gate?.from) ? st.gate.from : dayOf(Date.now()), through: isDate(st.gate?.through) ? st.gate.through : "", askAfter: isDate(st.gate?.askAfter) ? st.gate.askAfter : "" } : null,
      state: ["waiting", "asked", "started"].includes(st.state) ? st.state : isDate(st.date) && st.kind !== "gate" ? "started" : "waiting", started: isDate(st.started) ? st.started : "", last: st.last || null },
    slots, created: now(), updated: now(),
  };
}

export function importProgram(inp, { replace = false } = {}) {
  const p = normalizeProgram(inp);
  const old = getProgram(p.slug);
  if (old && !replace) fail(`a program "${p.slug}" exists (import with replace to update it)`);
  if (old) { p.created = old.created; p.outputs = old.outputs; p.start = { ...p.start, state: old.start.state, started: old.start.started, last: old.start.last }; for (const s of p.slots) { const o = old.slots.find((x) => x.id === s.id); if (o?.course && !s.course) s.course = o.course; } }
  saveProgram(p);
  linkCourses(p);
  return p;
}

// A program's slots name their courses; each course names its program and slot back (the course page and the
// professor's pace read them).
export function linkCourses(p) {
  for (const s of p.slots) {
    const c = s.course && getCourse(s.course);
    if (c && (c.program !== p.slug || c.slot !== s.id)) { c.program = p.slug; c.slot = s.id; saveCourse(c); }
  }
}

// ---------- where it comes from: one complete real course, or stitched ----------

// A course's sources by part (lectures, readings, assignments, exams). It's "stitched" when the parts come from more
// than one course, or any part is generated: the app says so, plainly, wherever the course shows. One complete real
// course (every part from it, nothing generated) gets no label.
export function provenance(c) {
  const srcs = c?.sources?.length ? c.sources : [];
  const key = (s) => s.generated ? "generated" : (s.url ? s.url.replace(/^https?:\/\/(www\.)?/, "").split(/[/?#]/).slice(0, 3).join("/") : `${s.institution} ${s.title}`).toLowerCase();
  const parts = PARTS.map((part) => ({ part, from: srcs.filter((s) => s.part === part) })).filter((p) => p.from.length);
  const distinct = new Set(srcs.filter((s) => !s.generated).map(key));
  const generated = srcs.some((s) => s.generated);
  const stitched = generated || distinct.size > 1;
  // one clause per source, naming the parts it gives: "Lectures and readings from Open Yale Courses PLSC 114; exams generated"
  const name = (s) => [s.institution, s.title].filter(Boolean).join(" ");
  const by = new Map();
  for (const s of srcs) { const k = key(s); if (!by.has(k)) by.set(k, { s, parts: [] }); if (!by.get(k).parts.includes(s.part)) by.get(k).parts.push(s.part); }
  const and = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0]);
  const line = stitched ? [...by.values()].map(({ s, parts: ps }) => `${and(ps)} ${s.generated ? "generated in Teach" : `from ${name(s)}`}`).join("; ") : "";
  return { stitched, generated, parts, line: line ? line[0].toUpperCase() + line.slice(1) : "" };
}

// ---------- hours: what each course really takes ----------

// Hours per unit, from the course's own load: lecture time, reading pages at the learner's reading speed, the graded
// work, and how much the pre-test (or the unit's own probe and plan) shows they already know. Concept time shrinks with
// what they know; reading takes the time reading takes (a known idea is skimmed, so it shrinks less).
export const WORK_HOURS = { "argument-analysis": 5, paper: 8, essay: 6, memo: 3, pset: 4, problems: 1.5, project: 10 };
export function unitHours(c, u, { known = null, plan = null } = {}) {
  const lectureMin = u.lectures.reduce((a, l) => a + (l.minutes || c.hours.lectureMinutes), 0) || c.hours.lectureMinutes;
  const pages = u.readings.filter((r) => r.required).reduce((a, r) => a + (r.pages || 20), 0);
  const k = known ?? 0;
  let concept = (lectureMin / 60) * (c.hours.kind === "math" ? 1.6 : 1.1) * (1 - 0.8 * k) + 0.5;   // lessons + checks (+ the unit's probe)
  let basis = known === null ? "before pre-test" : "from pre-test";
  if (plan && plan.total) { concept = Math.max(0.3, plan.left * 0.35); basis = "from the unit plan"; }
  if (u.mode === "fast" && !(plan && plan.total)) concept = Math.min(concept, 0.75 + 0.15 * u.lectures.length);
  const reading = (pages / c.hours.pagesPerHour) * (1 - 0.4 * k);
  const extra = (u.extraReview || 0) * 0.5 + (u.extraSessions || 0) * (c.plan?.sessionMinutes || 45) / 60;
  return { concept: round1(concept), reading: round1(reading), extra: round1(extra), total: round1(concept + reading + extra), basis, pages };
}
const round1 = (x) => Math.round(x * 10) / 10;
export const workHours = (a) => a.hours || (a.count ? Math.max(1, a.count * 0.15) : WORK_HOURS[a.kind] || 4);
export const examHours = (x) => round1((x.minutes || 120) / 60 + 2);   // the sitting, plus review before it

// The learner's work in order: each unit, then what's due after it. Each item has its hours.
export function workList(c, ctx = {}) {
  const out = [], reviews = c.plan?.reviews || [];
  for (const u of c.units) {
    const known = c.pretest?.result?.byUnit?.[u.n]?.known ?? null;
    const plan = ctx.unitPlans?.[u.n] || null;
    const h = unitHours(c, u, { known, plan });
    out.push({ id: `u${u.n}`, kind: "unit", n: u.n, title: `Unit ${u.n}: ${u.title}`, hours: h.total, basis: h.basis, detail: h, done: !!ctx.unitDone?.[u.n] });
    for (const a of c.assignments.filter((x) => x.unit === u.n)) out.push({ id: a.id, kind: "assignment", title: a.title, hours: round1(workHours(a)), done: ["graded", "submitted", "grading"].includes(c.work?.[a.id]?.state) });
    for (const x of c.exams.filter((y) => y.unit === u.n && !y.practice)) {
      for (const r of reviews.filter((y) => y.before === x.id)) out.push(reviewItem(r));
      out.push({ id: x.id, kind: "exam", title: x.title, hours: examHours(x), done: ["submitted", "grading", "graded"].includes(c.attempts?.[x.id]?.state) });
    }
  }
  for (const r of reviews.filter((y) => !y.before || !c.exams.some((x) => x.id === y.before))) out.push(reviewItem(r));
  return out;
  function reviewItem(r) { return { id: r.id, kind: "review", title: `Review: unit${r.units.length > 1 ? "s" : ""} ${r.units.join(", ")}`, hours: r.hours, done: !!c.reviewsDone?.[r.id], units: r.units }; }
}

export function courseHours(c, ctx = {}) {
  const items = workList(c, ctx);
  const total = round1(items.reduce((a, x) => a + x.hours, 0));
  const left = round1(items.filter((x) => !x.done).reduce((a, x) => a + x.hours, 0));
  const bases = new Set(items.filter((x) => x.kind === "unit").map((x) => x.basis));
  return { total, left, basis: bases.has("before pre-test") ? (bases.size > 1 ? "partly from pre-test" : "before pre-test") : bases.has("from pre-test") ? "from pre-test" : "from the unit plans", items };
}

// A course that isn't loaded yet: a rough figure from what its pages say (lecture count, its weekly hours), by kind.
export function candidateHours(cand) {
  if (!cand) return { total: null, basis: "unknown" };
  const perLecture = cand.kind === "math" ? 2.6 : cand.kind === "reading" ? 2.4 : 2.2;   // the lecture, the reading or problems around it
  let total = cand.lectures ? cand.lectures * perLecture : cand.weeks && cand.hoursPerWeek ? cand.weeks * cand.hoursPerWeek * 2.5 : 60;
  const g = cand.graded || {};
  total += (g.psets ? 20 : 0) + (g.papers ? 15 : 0) + (g.midterm ? 4 : 0) + (g.final ? 5 : 0);
  return { total: Math.round(total), basis: "rough: not loaded yet" };
}

// ---------- the schedule: committed deadlines from weekly budgets ----------

// Hours available in the week starting `monday`: the base, times the professor's edge and that week's target if it set
// one (lib/professor.mjs: school load, breaks, notes).
export function weekBudget(plan, monday, base) {
  const w = plan?.weeks?.[monday];
  if (w && Number.isFinite(w.target)) return w.target;
  return base * (plan?.edge || 1);
}

// Walk the work list against the weekly budgets from `from` (a day): each item's due day is the day the budget
// covering it runs out. Items before `keepUntil` keep their committed due days. Returns { [id]: "YYYY-MM-DD" }.
export function paceDue(c, { from, base, ctx = {}, keep = {}, keepUntil = "" }) {
  const items = workList(c, ctx);
  const out = {};
  let day = from, left = 0, week = null;
  const daily = (d) => weekBudget(c.plan, weekOf(d), base) / 7;
  for (const it of items) {
    if (keep[it.id] && (it.done || (keepUntil && keep[it.id] <= keepUntil))) { out[it.id] = keep[it.id]; continue; }
    let need = it.hours;
    if (week === null) { week = weekOf(day); left = daily(day); }
    let guard = 0;
    while (need > left + 1e-9 && guard++ < 3000) { need -= left; day = addDays(day, 1); left = daily(day); }
    left -= need;
    out[it.id] = day;
  }
  return out;
}

// The schedule as weeks: each week's items with their due days, from the committed due days (course.due).
export function schedule(c, ctx = {}) {
  const items = workList(c, ctx);
  const weeks = new Map();
  for (const it of items) {
    const due = c.due?.[it.id];
    if (!due) continue;
    const w = weekOf(due);
    if (!weeks.has(w)) weeks.set(w, []);
    weeks.get(w).push({ ...it, due });
  }
  return [...weeks.entries()].sort().map(([monday, list], i) => ({ week: i + 1, monday, items: list, target: c.plan?.weeks?.[monday]?.target ?? null, why: c.plan?.weeks?.[monday]?.why || "" }));
}

// What's late: committed due days that have passed with the item not done.
export function behind(c, today, ctx = {}) {
  return workList(c, ctx).filter((x) => !x.done && c.due?.[x.id] && c.due[x.id] < today).map((x) => ({ ...x, due: c.due[x.id], late: daysBetween(c.due[x.id], today) }));
}

// ---------- grades ----------

export function itemScore(c, id) {
  const w = c.work?.[id], a = c.attempts?.[id];
  const g = w?.grade || a?.grade;
  return g && Number.isFinite(g.score) && g.max ? { score: g.score, max: g.max, pct: Math.round((g.score / g.max) * 1000) / 10, at: g.at } : null;
}

export function gradebook(c) {
  const rows = [];
  for (const g of c.grading) {
    const parts = g.items.map((id) => ({ id, score: itemScore(c, id), title: [...c.assignments, ...c.exams].find((x) => x.id === id)?.title || id }));
    const got = parts.filter((p) => p.score);
    const pct = got.length ? got.reduce((a, p) => a + p.score.pct, 0) / got.length : null;
    rows.push({ what: g.what, weight: g.weight, items: parts, pct: pct === null ? null : Math.round(pct * 10) / 10 });
  }
  const counted = rows.filter((r) => r.pct !== null && r.weight > 0);
  const w = counted.reduce((a, r) => a + r.weight, 0);
  const current = w ? Math.round((counted.reduce((a, r) => a + r.pct * r.weight, 0) / w) * 10) / 10 : null;
  const practice = c.exams.filter((x) => x.practice).map((x) => ({ id: x.id, title: x.title, score: itemScore(c, x.id) }));
  return { rows, current, weightGraded: w, weightTotal: rows.reduce((a, r) => a + r.weight, 0), practice, pretest: c.pretest?.result || null, letter: letter(current), passMark: c.passMark };
}
export const letter = (p) => (p === null || p === undefined ? "" : p >= 93 ? "A" : p >= 90 ? "A-" : p >= 87 ? "B+" : p >= 83 ? "B" : p >= 80 ? "B-" : p >= 77 ? "C+" : p >= 73 ? "C" : p >= 70 ? "C-" : p >= 60 ? "D" : "F");

// ---------- progress ----------

export function courseProgress(c, ctx = {}) {
  const items = workList(c, ctx);
  const units = items.filter((x) => x.kind === "unit");
  return { units: units.length, unitsDone: units.filter((x) => x.done).length, items: items.length, done: items.filter((x) => x.done).length,
    steps: items.map((x) => (x.done ? "done" : "todo")), pretested: !!c.pretest?.result, started: !!c.start };
}

// A slot's status: open (no course), candidate (a course picked, not loaded), loaded, pretested, active, done.
export function slotStatus(slot, course, ctx) {
  if (!slot.course && !slot.candidate) return "open";
  if (!course) return "candidate";
  if (course.status === "done") return "done";
  const p = courseProgress(course, ctx);
  if (p.done === p.items && p.items) return "done";
  if (p.done || course.units.some((u) => u.topic)) return "active";
  if (course.pretest?.result) return "pretested";
  return "loaded";
}

// ---------- the program's timeline ----------

// Courses in the program's order, each starting once a lane is free (pace.concurrent courses at a time) and the slots
// it comes after are done; each runs at hoursPerWeek / concurrent, so a course's weeks follow its own hours.
export function timeline(p, { hoursOf, startDay }) {
  const lanes = Array.from({ length: p.pace.concurrent }, () => 0);   // week each lane is free from
  const end = new Map();
  const per = p.pace.hoursPerWeek / p.pace.concurrent;
  const out = [];
  for (const s of p.slots) {
    const h = hoursOf(s);
    const weeks = h.left === 0 ? 0 : Math.max(1, Math.ceil((h.left ?? h.total ?? 60) / per));
    const ready = Math.max(0, ...s.after.map((a) => end.get(a) ?? 0));
    lanes.sort((a, b) => a - b);
    const begin = Math.max(lanes[0], ready);
    lanes[0] = begin + weeks;
    end.set(s.id, begin + weeks);
    out.push({ slot: s.id, startWeek: begin, endWeek: begin + weeks, weeks, hours: h, start: startDay ? addDays(startDay, begin * 7) : "", end: startDay ? addDays(startDay, (begin + weeks) * 7 - 1) : "" });
  }
  const last = Math.max(0, ...out.map((x) => x.endWeek));
  return { slots: out, weeks: last, finish: startDay ? addDays(startDay, last * 7 - 1) : "", perCourse: per };
}

// ---------- calendar ----------

// The deadlines as calendar events (title, local "YYYY-MM-DD HH:MM", minutes, note), with a stable key each, so
// adding them again adds only what's new or moved.
export function calendarEvents(c, { hour = "18:00", link = "" } = {}) {
  const out = [];
  for (const it of workList(c)) {
    const due = c.due?.[it.id];
    if (!due || it.done) continue;
    const exam = it.kind === "exam" ? c.exams.find((x) => x.id === it.id) : null;
    const label = it.kind === "unit" ? `${it.title} done` : exam ? `${it.title}${exam.practice ? " (practice)" : ""}` : `${it.title} due`;
    out.push({ key: `${c.slug}:${it.id}:${due}`, id: it.id, title: `${c.code || c.title}: ${label}`, local: `${due} ${hour}`, minutes: exam ? exam.minutes : 30,
      note: `${c.title}${link ? `. Open it in Teach: ${link}` : ""}` });
  }
  return out;
}
