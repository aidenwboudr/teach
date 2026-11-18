// The professor: an overseer above a course's unit tutors. It reads the evidence (pre-test and exam scores, review
// retention, pace against the committed deadlines, the sessions the learner actually finishes and when, where they got
// stuck, and the weeks ahead: school load, breaks, their own notes) and changes how they get there: the week's load,
// session length, extra review, skipping ahead where they're strong, a missed deadline moved and the rest re-paced,
// the check-in's style and frequency.
//
// Small rules, each checkable on its own (test/professor.test.mjs runs them on recorded histories). Every change is
// logged with its evidence and reason and can be undone. It never lowers the bar: a change may only touch the paths in
// ALLOWED (the plan, extra review, unit mode, due days, the check-in), never an exam, an assignment, a rubric or the
// grading, and a learner who stops showing up gets more accountability, not an easier course.
import { workList, paceDue, weekOf, addDays, daysBetween, weekBudget, dayOf } from "./courses.mjs";

const ALLOWED = [/^plan\.sessionMinutes$/, /^plan\.preferred$/, /^plan\.edge$/, /^plan\.weeks\.\d{4}-\d{2}-\d{2}$/, /^plan\.checkin$/, /^plan\.reviews$/,
  /^plan\.slips\.[a-z0-9-]+$/, /^units\.\d+\.(mode|extraSessions)$/, /^due\.[a-z0-9-]+$/];
export const allowedPath = (p) => ALLOWED.some((r) => r.test(p));

// ---------- reading and writing a path in a course ----------

function locate(c, p) {
  const parts = p.split(".");
  let o = c;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (Array.isArray(o) && k !== "") { o = o.find((x) => String(x.n) === k); if (!o) return null; continue; }
    o[k] = o[k] ?? {};
    o = o[k];
  }
  return { o, k: parts.at(-1) };
}
export function getPath(c, p) { const l = locate(structuredClone(c), p); return l ? l.o[l.k] : undefined; }
function setPath(c, p, v) {
  if (!allowedPath(p)) throw new Error(`the professor may not change ${p}`);
  const l = locate(c, p);
  if (!l) throw new Error(`no ${p}`);
  if (v === undefined) delete l.o[l.k]; else l.o[l.k] = v;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A change: what, why, the evidence, and the patch (each path's value before and after).
function change(c, { rule, key, title, reason, evidence, set, urgent = false, today, hold }) {
  const patch = Object.entries(set).map(([p, to]) => ({ path: p, from: getPath(c, p), to })).filter((x) => !same(x.from, x.to));
  if (!patch.length) return null;
  for (const x of patch) if (!allowedPath(x.path)) throw new Error(`the professor may not change ${x.path}`);
  return { id: `${rule}-${today}-${key}`.replace(/[^a-z0-9-]/gi, "-"), at: today, rule, key, hold: hold || [key], title, reason, evidence, patch, urgent };
}

export function apply(c, ch) {
  if (c.changes.some((x) => x.id === ch.id)) return false;
  for (const x of ch.patch) setPath(c, x.path, structuredClone(x.to));
  c.changes.push({ ...ch, applied: new Date().toISOString() });
  return true;
}

// Undo a change: each path goes back if nobody has changed it since; the rule then leaves that thing alone for two weeks.
export function undo(c, id, today) {
  const ch = c.changes.find((x) => x.id === id);
  if (!ch) throw Object.assign(new Error("no such change"), { code: 404 });
  if (ch.undone) return ch;
  const moved = ch.patch.filter((x) => !same(getPath(c, x.path), x.to));
  if (moved.length) throw Object.assign(new Error(`can't undo: ${moved.map((x) => x.path).join(", ")} changed again since`), { code: 409 });
  for (const x of ch.patch) setPath(c, x.path, structuredClone(x.from));
  ch.undone = new Date().toISOString();
  // the rule leaves each thing this change was about alone for two weeks (one hold per unit, item or week)
  c.holds = { ...(c.holds || {}), ...Object.fromEntries((ch.hold || [ch.key]).map((k) => [`${ch.rule}:${k}`, addDays(today, 14)])) };
  return ch;
}
const held = (c, rule, key, today) => (c.holds?.[`${rule}:${key}`] || "") >= today;

// ---------- the evidence the rules read ----------
//
// ev = {
//   today: "YYYY-MM-DD", base: hours per week for this course, ctx: { unitDone, unitPlans } (lib/courses.mjs),
//   sessions: [{ start: ISO, minutes, finished }],             // study sessions on this course (lessons, exams, work)
//   lastWeek: { target, hours, due, done },                    // the week just ended: hours studied, items due and done
//   weeks: [{ target, hours, due, done, sessions }],           // the weeks before, newest first (for "recovered")
//   scores: [{ id, pct, units: [n], practice }],               // graded work and exams, newest last
//   units: { [n]: { retention: { reviews, again }, stuck, shaky, started } },
//   school: [{ monday, exams, due, busyHours, finals, break, labels: [] }],   // the weeks ahead (lib/context)
//   notes: [{ monday, text, load: "light"|"heavy"|"away" }],
// }

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const round5 = (x) => Math.round(x / 5) * 5;
const roundHalf = (x) => Math.max(1, Math.round(x * 2) / 2);
const bucket = (iso) => { const h = new Date(iso).getHours(); return h < 12 ? "morning" : h < 17 ? "afternoon" : h < 22 ? "evening" : "night"; };
export const plannedSessions = (target, minutes) => Math.max(1, Math.round((target * 60) / (minutes || 45)));

// How heavy a week ahead is, from school and the learner's notes: a factor on the week's hours, and why.
export function weekFactor(w = {}, notes = []) {
  const mine = notes.filter((n) => n.monday === w.monday);
  const why = [...(w.labels || [])];
  for (const n of mine) why.push(`your note: "${n.text}"`);
  if (w.finals) return { factor: 0.4, kind: "lighter", why: ["finals week", ...why] };
  if (mine.some((n) => n.load === "away")) return { factor: 0.5, kind: "lighter", why };
  if (w.break) return { factor: 1.5, kind: "heavier", why: [w.breakName || "a break from school", ...why] };
  const score = (w.exams || 0) * 2 + (w.due || 0) * 0.5 + (w.busyHours || 0) / 6 + (mine.some((n) => n.load === "heavy") ? 2 : 0);
  if (score >= 4) return { factor: 0.6, kind: "lighter", why };
  if (score >= 2.5) return { factor: 0.8, kind: "lighter", why };
  if (mine.some((n) => n.load === "light") || (score <= 0.5 && !mine.length && w.monday)) return { factor: 1.2, kind: "heavier", why: why.length ? why : ["a light week at school"] };
  return { factor: 1, kind: "normal", why };
}

// ---------- the rules ----------

// Re-pace: due days of everything not done and due from `from` on, against the weekly budgets (the plan as it would
// be after the change). Returns the due.* patch entries.
function repace(c, ev, from, planPatch = {}) {
  const trial = structuredClone(c);
  for (const [p, v] of Object.entries(planPatch)) setPath(trial, p, v);
  const due = paceDue(trial, { from, base: ev.base, ctx: ev.ctx, keep: c.due || {}, keepUntil: addDays(from, -1) });
  const out = {};
  for (const [id, d] of Object.entries(due)) if (c.due?.[id] !== d) out[`due.${id}`] = d;
  return out;
}

export const RULES = {
  // The weeks ahead: lighter before heavy school weeks (exams, finals, many deadlines, "busy" notes), heavier in light
  // stretches and breaks. Sets next week's and the week after's targets, and re-paces what's due from then on.
  load(c, ev) {
    const out = [];
    const next = addDays(weekOf(ev.today), 7);
    const set = {}, why = [], ev2 = [];
    for (const monday of [next, addDays(next, 7)]) {
      if (held(c, "load", monday, ev.today)) continue;
      const w = (ev.school || []).find((x) => x.monday === monday) || { monday };
      const f = weekFactor(w, ev.notes || []);
      const target = roundHalf(ev.base * (c.plan.edge || 1) * f.factor);
      const cur = c.plan.weeks?.[monday]?.target;
      if (cur === target || (cur === undefined && f.factor === 1)) continue;
      set[`plan.weeks.${monday}`] = { target, why: f.kind === "normal" ? "a normal week" : `${f.kind} week: ${f.why.join(" + ")}`, factor: f.factor };
      why.push(`week of ${monday}: ${target} h${f.kind !== "normal" ? ` (${f.kind}: ${f.why.join(" + ")})` : ""}`);
      ev2.push(`${monday}: ${w.exams || 0} exam(s), ${w.due || 0} deadline(s), ${Math.round(w.busyHours || 0)} h on the calendar${w.finals ? ", finals" : ""}${w.break ? ", break" : ""}`);
    }
    if (!Object.keys(set).length) return out;
    const ch = change(c, { rule: "load", key: next, hold: Object.keys(set).map((k) => k.slice("plan.weeks.".length)), today: ev.today, title: why.length === 1 ? why[0][0].toUpperCase() + why[0].slice(1) : `Next two weeks: ${why.join("; ")}`,
      reason: "The weekly load follows school: lighter before heavy weeks, heavier in light stretches and breaks. Deadlines from then on are re-paced to match.",
      evidence: ev2, set: { ...set, ...repace(c, ev, next, set) } });
    if (ch) out.push(ch);
    return out;
  },

  // Stay at the edge: finished everything with good scores and retention → a little more; worked but couldn't finish,
  // or scores or retention fell → a little less. Not showing up doesn't lower it (that's the consistency rule's job).
  edge(c, ev) {
    const lw = ev.lastWeek;
    if (!lw || !lw.target || held(c, "edge", "edge", ev.today)) return [];
    const r = lw.due ? lw.done / lw.due : lw.hours / lw.target;
    const recent = (ev.scores || []).filter((s) => !s.practice && daysBetween(s.at ? dayOf(s.at) : ev.today, ev.today) <= 21);
    const mean = recent.length ? recent.reduce((a, s) => a + s.pct, 0) / recent.length : null;
    const ret = Object.values(ev.units || {}).reduce((a, u) => ({ reviews: a.reviews + (u.retention?.reviews || 0), again: a.again + (u.retention?.again || 0) }), { reviews: 0, again: 0 });
    const againRate = ret.reviews >= 10 ? ret.again / ret.reviews : null;
    const planned = plannedSessions(lw.target, c.plan.sessionMinutes);
    const showedUp = (lw.sessions ?? 0) >= Math.max(1, planned * 0.5);
    const edge = c.plan.edge || 1;
    const evidence = [`last week: ${Math.round(lw.hours * 10) / 10} of ${lw.target} h, ${lw.done} of ${lw.due} items done, ${lw.sessions ?? 0} of ${planned} sessions`,
      mean !== null ? `scores in the last 3 weeks: ${Math.round(mean)}% average` : "no graded work in the last 3 weeks",
      againRate !== null ? `review: ${Math.round(againRate * 100)}% missed (${ret.reviews} reviews)` : "too few reviews to judge retention"];
    let to = edge, title = "", reason = "";
    if (r >= 0.9 && lw.hours >= 0.8 * lw.target && (mean === null || mean >= 80) && (againRate === null || againRate < 0.25) && edge < 1.5) {
      to = Math.min(1.5, Math.round((edge + 0.1) * 10) / 10); title = `More next week (×${to})`; reason = "You finished the week's work with good scores and retention: it was within reach, so the pressure goes up a notch.";
    } else if (showedUp && (r < 0.6 || (mean !== null && mean < 65) || (againRate !== null && againRate > 0.4)) && edge > 0.6) {
      to = Math.max(0.6, Math.round((edge - 0.1) * 10) / 10); title = `A little less per week (×${to})`; reason = "You put the time in but the week was more than you could finish well: the load comes down a notch so understanding keeps up. Deadlines and exams stay as they are; later ones are re-paced.";
    } else return [];
    const set = { "plan.edge": to };
    const ch = change(c, { rule: "edge", key: "edge", today: ev.today, title, reason, evidence, set: { ...set, ...repace(c, ev, addDays(weekOf(ev.today), 7), set) } });
    return ch ? [ch] : [];
  },

  // Session length follows what they finish: most sessions ending early and unfinished → shorter (and so more of
  // them); most running long and finishing → longer.
  sessions(c, ev) {
    const recent = (ev.sessions || []).filter((s) => daysBetween(dayOf(s.start), ev.today) <= 14);
    if (recent.length < 3 || held(c, "sessions", "length", ev.today)) return [];
    const P = c.plan.sessionMinutes || 45, m = median(recent.map((s) => s.minutes));
    const early = recent.filter((s) => s.minutes < 0.75 * P && !s.finished).length, long = recent.filter((s) => s.minutes > 1.3 * P && s.finished).length;
    let to = P;
    if (early >= (2 / 3) * recent.length) to = Math.max(20, Math.min(P - 5, round5(m)));
    else if (long >= (2 / 3) * recent.length) to = Math.min(90, Math.max(P + 5, round5(m)));
    if (to === P) return [];
    const ch = change(c, { rule: "sessions", key: "length", today: ev.today, title: `Sessions of ${to} min instead of ${P}`,
      reason: to < P ? "Most recent sessions stopped before the planned length without finishing what they set out to do: shorter sessions you finish beat long ones you don't. The weekly hours stay the same, in more sessions." : "Most recent sessions ran long and finished: longer sessions fit how you work.",
      evidence: [`last ${recent.length} sessions: median ${Math.round(m)} min (planned ${P}); ${early} ended early unfinished, ${long} ran long and finished`], set: { "plan.sessionMinutes": to } });
    return ch ? [ch] : [];
  },

  // When they study: the time of day most of their sessions actually happen (for the calendar's study blocks and the nudges).
  time(c, ev) {
    const recent = (ev.sessions || []).slice(-10);
    if (recent.length < 4 || held(c, "time", "preferred", ev.today)) return [];
    const by = {};
    for (const s of recent) by[bucket(s.start)] = (by[bucket(s.start)] || 0) + 1;
    const [top, n] = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
    if (n / recent.length < 0.6 || top === c.plan.preferred) return [];
    const ch = change(c, { rule: "time", key: "preferred", today: ev.today, title: `Study time: ${top}s`, reason: `You actually study in the ${top}: planned sessions go there.`,
      evidence: [`${n} of your last ${recent.length} sessions started in the ${top}`], set: { "plan.preferred": top } });
    return ch ? [ch] : [];
  },

  // Review where it's slipping: weak retention on a unit's cards, or a graded score under 70%, adds a review block
  // before the next exam that covers it.
  review(c, ev) {
    const out = [];
    const reviews = [...(c.plan.reviews || [])];
    const nextExam = (units) => c.exams.filter((x) => !x.practice && !["submitted", "grading", "graded"].includes(c.attempts?.[x.id]?.state) && units.some((n) => x.covers.includes(n) || x.unit >= n))
      .sort((a, b) => (c.due?.[a.id] || "9").localeCompare(c.due?.[b.id] || "9"))[0];
    const add = (key, units, hours, why, evidence, title) => {
      if (held(c, "review", key, ev.today) || reviews.some((r) => r.key === key)) return;
      const x = nextExam(units);
      reviews.push({ id: `rev-${key}`, key, units, before: x?.id || "", hours, why });
      out.push({ key, why, evidence, title: `${title}${x ? ` before the ${x.title}` : ""}` });
    };
    for (const [n, u] of Object.entries(ev.units || {})) {
      const r = u.retention || {};
      if (r.reviews >= 10 && r.again / r.reviews > 0.35) add(`ret-u${n}`, [Number(n)], 1, "retention", [`unit ${n}: missed ${r.again} of ${r.reviews} reviews (${Math.round((r.again / r.reviews) * 100)}%)`], `Review of unit ${n}`);
    }
    for (const s of ev.scores || []) {
      if (s.practice || s.pct >= 70) continue;
      add(`score-${s.id}`, s.units, 1.5, "score", [`${s.title || s.id}: ${s.pct}%`], `Review of unit${s.units.length > 1 ? "s" : ""} ${s.units.join(", ")}`);
    }
    if (!out.length) return [];
    const set = { "plan.reviews": reviews };
    const ch = change(c, { rule: "review", key: out.map((x) => x.key).join("+"), hold: out.map((x) => x.key), today: ev.today, title: out.map((x) => x.title).join("; "),
      reason: "Where retention or a score shows it hasn't stuck, a review block goes in before the next exam on it. The exam itself doesn't change.",
      evidence: out.flatMap((x) => x.evidence), set: { ...set, ...repace(c, ev, ev.today, set) } });
    return ch ? [ch] : [];
  },

  // Skip ahead where they're strong: a unit the pre-test shows they mostly know becomes a fast unit (the tutor probes,
  // confirms, and teaches only what the probe finds missing).
  strong(c, ev) {
    const fast = c.units.filter((u) => u.mode === "normal" && !ev.units?.[u.n]?.started && (c.pretest?.result?.byUnit?.[u.n]?.known ?? 0) >= 0.8 && !held(c, "strong", `u${u.n}`, ev.today));
    if (!fast.length) return [];
    const set = Object.fromEntries(fast.map((u) => [`units.${u.n}.mode`, "fast"]));
    const ch = change(c, { rule: "strong", key: fast.map((u) => `u${u.n}`).join("+"), hold: fast.map((u) => `u${u.n}`), today: ev.today, title: `Fast track: unit${fast.length > 1 ? "s" : ""} ${fast.map((u) => u.n).join(", ")}`,
      reason: "The pre-test shows you already know most of it: the unit's tutor confirms that with its probe and teaches only the gaps. The unit's graded work and exams stay as they are.",
      evidence: fast.map((u) => { const r = c.pretest.result.byUnit[u.n]; return `unit ${u.n}: ${r.right} of ${r.of} right on the pre-test`; }), set: { ...set, ...repace(c, ev, ev.today, set) } });
    return ch ? [ch] : [];
  },

  // Stuck: the same step across three sessions, or two shaky steps, gets an extra session on that unit.
  stuck(c, ev) {
    const out = [];
    for (const [n, u] of Object.entries(ev.units || {})) {
      if (!(u.stuck >= 3 || u.shaky >= 2) || ev.ctx?.unitDone?.[n] || held(c, "stuck", `u${n}`, ev.today)) continue;
      const unit = c.units.find((x) => String(x.n) === n);
      if (!unit || (unit.extraSessions || 0) >= 3) continue;
      const set = { [`units.${n}.extraSessions`]: (unit.extraSessions || 0) + 1 };
      const ch = change(c, { rule: "stuck", key: `u${n}-${(unit.extraSessions || 0) + 1}`, hold: [`u${n}`], today: ev.today, title: `An extra session on unit ${n}`,
        reason: "You've been on the same part for a while: one more session for it, and the tutor hears to try a different explanation. The rest is re-paced around it.",
        evidence: [u.stuck >= 3 ? `unit ${n}: the same step was current for ${u.stuck} sessions` : `unit ${n}: ${u.shaky} steps marked shaky`], set: { ...set, ...repace(c, ev, ev.today, set) } });
      if (ch) out.push(ch);
    }
    return out;
  },

  // A missed deadline: moved once to the end of this week (the rest re-paced from there) and a text, not a mention.
  // Missed again: it stays this week's top item and the check-ins go to twice a week, by text.
  slip(c, ev) {
    const out = [];
    const late = workList(c, ev.ctx).filter((x) => !x.done && c.due?.[x.id] && c.due[x.id] < ev.today);
    for (const it of late) {
      if (held(c, "slip", it.id, ev.today)) continue;
      const n = (c.plan.slips?.[it.id] || 0) + 1;
      const sunday = addDays(weekOf(ev.today), 6), to = sunday > ev.today ? sunday : addDays(sunday, 7);
      const set = { [`due.${it.id}`]: to, [`plan.slips.${it.id}`]: n };
      if (n >= 2) set["plan.checkin"] = { freq: "twice", style: "text" };
      // what comes after it is re-paced from its new day
      const trial = structuredClone(c);
      for (const [p, v] of Object.entries(set)) setPath(trial, p, v);
      for (const [p, v] of Object.entries(repace(trial, ev, addDays(to, 1)))) if (p !== `due.${it.id}`) set[p] = v;
      const ch = change(c, { rule: "slip", key: `${it.id}-${n}`, hold: [it.id], today: ev.today, urgent: true,
        title: `${it.title}: missed ${c.due[it.id]}${n >= 2 ? " again" : ""}, now due ${to}`,
        reason: n >= 2 ? "Missed twice: it's this week's first job, and check-ins go to twice a week by text until you're back on track." : "Missed: it moves to the end of this week, and everything after it is re-paced from there. The work itself doesn't shrink.",
        evidence: [`due ${c.due[it.id]}, not done ${daysBetween(c.due[it.id], ev.today)} day(s) later`], set });
      if (ch) out.push(ch);
      break;   // one at a time: the next run sees the re-paced plan
    }
    return out;
  },

  // Consistency: few sessions last week, or none for 5 days → check-ins twice a week by text. Two good weeks in a row
  // → back to the weekly mention.
  consistency(c, ev) {
    if (!ev.started || held(c, "consistency", "checkin", ev.today)) return [];
    const lw = ev.lastWeek, cur = c.plan.checkin || { freq: "weekly", style: "voice" };
    const last = (ev.sessions || []).map((s) => dayOf(s.start)).sort().at(-1);
    const idle = last ? daysBetween(last, ev.today) : ev.startedDays ?? 0;
    const planned = lw?.target ? plannedSessions(lw.target, c.plan.sessionMinutes) : 0;
    if ((idle >= 5 || (lw && planned && (lw.sessions ?? 0) < planned * 0.5)) && cur.freq !== "twice") {
      const ch = change(c, { rule: "consistency", key: "checkin", hold: ["checkin"], today: ev.today, urgent: true, title: "Check-ins twice a week, by text",
        reason: "Consistency is slipping: more frequent check-ins until it's back. The plan doesn't get easier for it.",
        evidence: [idle >= 5 ? `no study session for ${idle} days` : `${lw.sessions ?? 0} of ${planned} planned sessions last week`], set: { "plan.checkin": { freq: "twice", style: "text" } } });
      return ch ? [ch] : [];
    }
    const good = (w) => w && w.target && (w.due ? w.done / w.due : w.hours / w.target) >= 0.8 && (w.sessions ?? 0) >= plannedSessions(w.target, c.plan.sessionMinutes) * 0.8;
    if (cur.freq === "twice" && good(lw) && good(ev.weeks?.[0])) {
      const ch = change(c, { rule: "consistency", key: "recovered", hold: ["checkin"], today: ev.today, title: "Back to the weekly check-in",
        reason: "Two steady weeks in a row: the Sunday check-in is enough again.", evidence: ["the last two weeks: at least 80% of the work and the sessions"], set: { "plan.checkin": { freq: "weekly", style: "voice" } } });
      return ch ? [ch] : [];
    }
    return [];
  },
};

// Which rules run when: all of them at the weekly check-in; the ones that react to a slip, a grade, a pre-test or a
// stuck unit whenever the app looks in between.
export const WEEKLY = ["slip", "consistency", "edge", "load", "sessions", "time", "review", "strong", "stuck"];
export const BETWEEN = ["slip", "review", "strong", "stuck"];

// Run the rules in order, applying each change before the next rule looks (a later rule sees the re-paced plan).
// Returns the changes made. `c` is changed in place.
export function review(c, ev, rules = WEEKLY) {
  const made = [];
  for (const name of rules) {
    for (const ch of RULES[name](c, ev)) if (ch && apply(c, ch)) made.push(ch);
  }
  return made;
}

// ---------- the check-in ----------

// One course's lines for the weekly check-in: the week that ended (what was due, what got done, scores), what's behind,
// what the professor changed, and what's due in the week ahead.
export function checkinLines(c, { today, ctx, recentChanges = [] }) {
  const items = workList(c, ctx);
  const monday = weekOf(today), lastMon = addDays(monday, today === addDays(monday, 6) ? 0 : -7);
  const lastSun = addDays(lastMon, 6), nextMon = addDays(lastSun, 1), nextSun = addDays(nextMon, 6);
  const dueIn = (a, b) => items.filter((x) => c.due?.[x.id] && c.due[x.id] >= a && c.due[x.id] <= b);
  const was = dueIn(lastMon, lastSun), next = dueIn(nextMon, nextSun);
  const late = items.filter((x) => !x.done && c.due?.[x.id] && c.due[x.id] < today);
  const scores = [...c.exams, ...c.assignments].map((x) => ({ x, g: c.attempts?.[x.id]?.grade || c.work?.[x.id]?.grade })).filter((s) => s.g && s.g.at && dayOf(s.g.at) >= lastMon);
  const name = c.code ? `${c.code} ${c.title}` : c.title;
  const lines = [];
  lines.push(`${name}: ${was.length ? `${was.filter((x) => x.done).length} of ${was.length} things due this week done (${was.map((x) => `${x.title}${x.done ? " ✓" : ""}`).join(", ")})` : "nothing was due this week"}.`);
  if (c.pretest?.result && c.pretest.at && dayOf(c.pretest.at) >= lastMon) lines.push(`Pre-test: ${c.pretest.result.right} of ${c.pretest.result.of}.`);
  for (const s of scores) lines.push(`${s.x.title}${s.x.practice ? " (practice)" : ""}: ${Math.round((s.g.score / s.g.max) * 100)}%.`);
  if (late.length) lines.push(`Behind: ${late.map((x) => `${x.title} (due ${c.due[x.id]})`).join(", ")}.`);
  for (const ch of recentChanges.filter((x) => !x.undone)) lines.push(`Changed: ${ch.title}.`);
  lines.push(next.length ? `Due this coming week: ${next.map((x) => `${x.title} by ${new Date(`${c.due[x.id]}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" })}`).join(", ")}.` : "Nothing due this coming week.");
  return { lines, behind: late.length > 0, late };
}

// When the next check-in is due: the chosen day and time each week (Sunday 18:00 by default), plus Wednesday when the
// professor has check-ins at twice a week.
export function nextCheckins(settings = {}, freq = "weekly", from = new Date()) {
  const day = Number.isInteger(settings.day) ? settings.day : 0, [hh, mm] = String(settings.time || "18:00").split(":").map(Number);
  const days = freq === "twice" ? [day, (day + 3) % 7] : [day];
  const out = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(from); d.setDate(d.getDate() + i); d.setHours(hh, mm || 0, 0, 0);
    if (days.includes(d.getDay()) && d > from) out.push(d);
  }
  return out.sort((a, b) => a - b);
}

// Is a check-in due now: its slot has passed since the last one sent.
export function checkinDue(settings, freq, last, nowD = new Date()) {
  const weekAgo = new Date(nowD.getTime() - 7 * 86400e3);
  const slots = nextCheckins(settings, freq, weekAgo).filter((d) => d <= nowD);
  const slot = slots.at(-1);
  return slot && (!last || Date.parse(last) < slot.getTime()) ? slot : null;
}

export { weekBudget };
