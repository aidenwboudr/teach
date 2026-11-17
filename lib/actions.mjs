// What to do at the end of a session: a grid of actions, each one made only when the learner clicks it. Nothing here
// runs a model by itself. This module is the catalog: which actions fit a topic (and in what order), each action's
// settings and their defaults, a course's note-sheet rule read out of free text, the brief a tutor gets to make one,
// and the calendar pieces (an .ics file, a calendar command's arguments). The server runs them (server.mjs, "actions").
//
// Made things live in the topic folder's out/ (Markdown source + PDF), and their record in topic.json's `outputs`,
// one per kind (the latest): { kind, state, settings, files: [{ label, path, pages }], summary, at, error }.
import path from "node:path";
import { PAPERS } from "./doc.mjs";

const DAY = 86400e3;
const str = (v, max = 400) => (typeof v === "string" ? v.trim().slice(0, max) : "");
export const STATES = ["idle", "queued", "working", "paused", "ready", "failed"];

// ---------- a course's note-sheet rule ----------

// Read what an exam allows from free text (the topic's integrity note, its facts, a syllabus line): one 8.5×11 sheet
// front and back, an index card, closed notes, open book. Returns null when the text says nothing about it.
export function parseAllowance(text) {
  const t = String(text || "").replace(/[ \t]+/g, " ");
  if (!t) return null;
  const num = { one: 1, a: 1, single: 1, two: 2, three: 3, "1": 1, "2": 2, "3": 3 };
  const two = /front and back|both sides|two[- ]sided|2[- ]sided|double[- ]sided|front & back|front\/back/i.test(t);
  const one = /one[- ]sided|single[- ]sided|one side only|1 side/i.test(t);
  const card = t.match(/\b(one|a|single|two|1|2)?\s*\(?(3|4)\s*["”]?\s*[x×]\s*(5|6)\s*["”]?\)?\s*(?:inch\s*)?(?:index\s*)?card/i) || t.match(/\b(one|a|single|two|1|2)?\s*index card/i);
  const sheet = t.match(/\b(one|a|single|two|three|1|2|3)?\s*\(?\s*(?:8\.5|8-1\/2|8½|8 1\/2|8-12)\s*["”]?\s*[x×]\s*11\s*["”]?\)?\s*(?:inch\s*)?(?:page|sheet|piece)?(?: of paper)?(?:[^.;]{0,40}?)(note|equation|formula|cheat|crib|reference)?\s*(?:sheet|page)?/i);
  const named = t.match(/\b(one|a|single|two|three|1|2|3)?\s*(?:hand-?written\s*)?(note|equation|formula|cheat|crib)\s*sheets?/i);
  if (card) return { kind: "sheet", paper: card[3] === "6" || card[2] === "4" ? "index-4x6" : "index-3x5", sheets: num[(card[1] || "one").toLowerCase()] || 1, sides: two ? 2 : 1, text: snippet(t, card.index) };
  if (sheet || (named && !/\bno\s+(note|equation|formula|cheat|crib)/i.test(t))) {
    const m = sheet || named;
    return { kind: "sheet", paper: "letter", sheets: num[(m[1] || "one").toLowerCase()] || 1, sides: one ? 1 : two ? 2 : 1, text: snippet(t, m.index) };
  }
  if (/closed[- ](notes?|book)|no notes|no note ?sheet|without notes|from memory/i.test(t)) return { kind: "none", text: snippet(t, t.search(/closed|no notes|no note|without notes|from memory/i)) };
  if (/open[- ](notes?|book)/i.test(t)) return { kind: "open", text: snippet(t, t.search(/open[- ]/i)) };
  return null;
}
// The sentence (or clause) the rule is in.
const snippet = (t, i) => {
  const start = Math.max(t.lastIndexOf(". ", i) + 2, t.lastIndexOf("; ", i) + 2, t.lastIndexOf("\n", i) + 1, 0, i - 160);
  const ends = [". ", "\n"].map((c) => t.indexOf(c, i)).filter((x) => x >= 0);
  return t.slice(start, Math.min(ends.length ? Math.min(...ends) + 1 : t.length, i + 220)).trim();
};

export function normalizeAllowance(a) {
  if (!a || typeof a !== "object") return null;
  const kind = ["sheet", "none", "open", "unknown"].includes(a.kind) ? a.kind : "unknown";
  const out = { kind, text: str(a.text, 300), source: str(a.source, 300) };
  if (kind === "sheet") {
    out.paper = PAPERS[a.paper] ? a.paper : "letter";
    out.sheets = Math.min(4, Math.max(1, Math.round(Number(a.sheets) || 1)));
    out.sides = Number(a.sides) === 1 ? 1 : 2;
  }
  return out;
}

// The rule for a topic: what the tutor recorded, else whatever its own text says.
export function allowanceOf(t) {
  if (t.allowance?.kind && t.allowance.kind !== "unknown") return t.allowance;
  // the goal only counts when it names the rule outright ("without notes" there is usually what to learn, not a rule)
  return parseAllowance([t.integrity, ...(t.facts || [])].join("\n"))
    || (/closed[- ](notes?|book)/i.test(t.goal || "") ? { kind: "none", text: snippet(t.goal, t.goal.search(/closed/i)) } : null)
    || t.allowance || null;
}

// ---------- the situation ----------

export function situation(t, { now = Date.now(), deck = 0 } = {}) {
  const plan = t.plan || [];
  const taught = plan.filter((n) => ["done", "shaky", "current"].includes(n.status));
  const left = plan.filter((n) => n.status === "todo" || n.status === "current");
  const due = t.deadline ? new Date(t.deadline + "T23:59:59") : null;
  const days = due ? Math.ceil((due - now) / DAY) - 1 : null;   // 0 = today
  const writing = t.why === "writing" || /essay|paragraph|write .*(page|essay)|in-class writing/i.test(`${t.goal} ${t.title}`);
  const interview = /interview|online assessment|\bOA\b|hackerrank|leetcode/i.test(`${t.goal} ${t.title} ${t.course}`);
  return {
    why: t.why || "class", exam: t.why === "exam", days, upcoming: days !== null && days >= 0, past: days !== null && days < 0,
    writing, interview, hands: t.why === "project" || t.why === "skill",
    taught: taught.length, left: left.length, total: plan.length, shaky: plan.filter((n) => n.status === "shaky").length,
    deck, allowance: allowanceOf(t),
  };
}

// ---------- the catalog ----------

const opts = (pairs) => pairs.map(([value, label]) => ({ value, label }));
const stepOptions = (t) => (t.plan || []).filter((n) => n.status !== "skipped").map((n) => ({ value: n.id, label: n.title }));
const taughtIds = (t) => (t.plan || []).filter((n) => ["done", "shaky", "current"].includes(n.status)).map((n) => n.id);

// Local "YYYY-MM-DDTHH:MM" for a Date (the server's clock; the page sends its own).
const localStamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// When a review session should go: the evening before an exam that's 2+ days out; about two hours from now when it's
// today or tomorrow (on the hour, never before 8 am or after 9 pm: then 8 the next morning); otherwise two days from now
// (spacing), at 7 pm.
export function sessionWhen(s, now = new Date()) {
  const d = new Date(now);
  if (s.upcoming && s.days <= 1) {
    d.setHours(d.getHours() + 2 + (d.getMinutes() ? 1 : 0), 0, 0, 0);
    if (d.getHours() < 8 && d.getDate() === new Date(now).getDate()) d.setHours(8);
    else if (d.getHours() > 21 || d.getDate() !== new Date(now).getDate()) { d.setDate(new Date(now).getDate() + 1); d.setHours(8); }
    return localStamp(d);
  }
  d.setDate(d.getDate() + (s.upcoming ? Math.max(1, s.days - 1) : 2));
  d.setHours(19, 0, 0, 0);
  return localStamp(d);
}

// Each action: what it's called, its glyph, whether it fits (a score; 0 = don't show) and why, its settings form
// (fields with defaults from the topic), and whether a tutor makes it (generative) or the app does it alone.
export const ACTIONS = {
  sheet: {
    glyph: "i-sheet", generative: true,
    title: (t, s) => (s.allowance?.kind === "none" || (s.writing && s.allowance?.kind !== "sheet") ? "Study sheet" : s.exam ? "Note sheet" : "Summary sheet"),
    fit(t, s) {
      if (!s.taught) return [0];
      const a = s.allowance;
      if (s.exam && s.upcoming && a?.kind === "sheet") return [100, `The exam allows ${allowanceText(a)}: one built from this topic, sized to fit.`];
      if (s.exam && s.upcoming && a?.kind === "none") return [55, "Closed notes, so a page to read before you go in, not to bring."];
      if (s.exam && s.upcoming) return [80, "A sheet built from this topic, sized to what your exam allows."];
      if (s.exam && s.past) return [40, "Keep one for the final while it's fresh."];
      if (t.why === "class") return [45, "Everything this topic covered on one page."];
      return [s.hands ? 10 : 25, "Everything this topic covered on one page."];
    },
    fields(t, s) {
      const a = s.allowance?.kind === "sheet" ? s.allowance : null;
      const purpose = s.allowance?.kind === "none" || (s.writing && !a) ? "study" : s.exam ? "bring" : "study";
      return [
        { key: "purpose", label: "For", type: "select", options: opts([["bring", "Bringing into the exam"], ["study", "Studying from beforehand"]]), value: purpose },
        { key: "paper", label: "Paper", type: "select", options: Object.entries(PAPERS).map(([value, p]) => ({ value, label: p.label })), value: a?.paper || "letter" },
        { key: "sheets", label: "Sheets", type: "number", min: 1, max: 4, value: a?.sheets || 1 },
        { key: "sides", label: "Sides", type: "select", options: opts([["2", "Front and back"], ["1", "One side"]]), value: String(a ? a.sides : purpose === "bring" ? 2 : 1) },
        { key: "columns", label: "Columns", type: "select", options: opts([["2", "2"], ["3", "3"], ["4", "4"]]), value: (a?.paper || "letter").startsWith("index") ? "2" : "3" },
        { key: "font", label: "Font size", type: "select", options: opts([["auto", "As big as fits"], ["6", "6 pt"], ["7", "7 pt"], ["8", "8 pt"], ["9", "9 pt"], ["10", "10 pt"]]), value: "auto" },
        { key: "include", label: "Include", type: "multi", options: opts([["formulas", "Formulas"], ["methods", "Step-by-step methods"], ["examples", "Mini worked examples"], ["mistakes", "My mistakes to avoid"], ["figures", "Small diagrams"], ["definitions", "Definitions"], ["constants", "Constants and units"]]),
          value: s.writing ? ["definitions", "mistakes", "examples"] : ["formulas", "methods", "examples", "mistakes"] },
        { key: "extra", label: "Anything else", type: "text", value: "", placeholder: "e.g. leave out chapter 4" },
      ];
    },
    summary: (v) => `${v.sheets} ${v.paper.startsWith("index") ? "card" : "sheet"}${v.sheets > 1 ? "s" : ""} · ${v.sides === "2" ? "both sides" : "one side"} · ${v.font === "auto" ? "font fits" : `${v.font} pt`}`,
  },
  worksheet: {
    glyph: "i-worksheet", generative: true,
    title: () => "Worksheet + key",
    fit(t, s) {
      if (!s.taught || s.writing || s.interview && !/code|coding|leetcode|hackerrank/i.test(`${t.goal}`)) return [s.taught && s.interview ? 20 : 0, "Practice problems with a separate answer key."];
      if (s.exam && s.upcoming) return [85, "Fresh problems like the exam's, printable, with a separate key to check yourself."];
      if (s.exam) return [50, "Practice for the final, with a separate key."];
      if (["class", "homework", "curiosity"].includes(t.why)) return [70, "Problems on what you just learned, printable, with a separate key."];
      return [s.hands ? 15 : 35, "Problems to work on paper, with a key."];
    },
    fields(t, s) {
      return [
        { key: "count", label: "Problems", type: "number", min: 3, max: 20, value: s.exam ? 8 : 6 },
        { key: "difficulty", label: "Difficulty", type: "select", options: opts([["ramp", "Easy up to exam level"], ["warmup", "Warm-up"], ["exam", "Exam level"], ["harder", "Harder than the exam"]]), value: s.exam ? "ramp" : "warmup" },
        { key: "steps", label: "On", type: "multi", options: stepOptions(t), value: taughtIds(t) },
        { key: "formats", label: "Kinds", type: "multi", options: opts([["numeric", "Problems with numbers"], ["choice", "Multiple choice"], ["short", "Short explanation"], ["sketch", "Draw or sketch"]]), value: ["numeric", "short"] },
        { key: "space", label: "Work space", type: "select", options: opts([["some", "Some"], ["lots", "Lots"], ["none", "None (answer sheet)"]]), value: "some" },
        { key: "key", label: "Key", type: "select", options: opts([["worked", "Fully worked solutions"], ["answers", "Answers only"]]), value: "worked" },
        { key: "minutes", label: "Time limit (min)", type: "number", min: 0, max: 180, value: 0, hint: "0 = untimed" },
      ];
    },
    summary: (v) => `${v.count} problems · ${{ ramp: "easy → exam", warmup: "warm-up", exam: "exam level", harder: "harder" }[v.difficulty]} · ${v.key === "worked" ? "worked key" : "answer key"}`,
  },
  practice: {
    glyph: "i-timer", generative: true,
    title: (t, s) => (s.writing ? "Timed essay practice" : s.interview ? "Mock round" : "Practice test"),
    fit(t, s) {
      if (!s.taught) return [0];
      if (s.exam && s.upcoming) return [s.days <= 1 ? 90 : 75, s.writing ? "A timed prompt under exam conditions; the tutor edits what you write." : "A timed set like the real thing, graded right here in Teach."];
      if (s.writing) return [50, "A timed prompt; the tutor edits what you write."];
      if (t.why === "class") return [30, "A short timed set, graded in Teach."];
      return [0];
    },
    fields(t, s) {
      return [
        { key: "count", label: "Questions", type: "number", min: 1, max: 12, value: s.writing ? 1 : 6 },
        { key: "minutes", label: "Minutes", type: "number", min: 5, max: 120, value: s.writing ? 25 : 20 },
        { key: "format", label: "Format", type: "select", options: opts([["exam", "Like the real exam"], ["problems", "Worked problems"], ["choice", "Multiple choice"], ["essay", "Essay prompt"]]), value: s.writing ? "essay" : "exam" },
        { key: "steps", label: "On", type: "multi", options: stepOptions(t), value: taughtIds(t) },
      ];
    },
    summary: (v) => `${v.count} question${v.count === 1 ? "" : "s"} · ${v.minutes} min`,
  },
  session: {
    glyph: "i-calendar", generative: false,
    title: (t, s) => (s.left && !s.exam ? "Next session" : s.exam && s.upcoming ? "Review before the exam" : "Review session later"),
    fit(t, s) {
      if (!s.total) return [t.status === "done" ? 0 : 40, "Put the next session on your calendar so it doesn't stall."];
      if (s.exam && s.upcoming && s.days >= 1) return [70, `${s.days === 1 ? "Tomorrow's" : "The"} exam: a short review the evening before, on your calendar.`];
      if (s.exam && s.upcoming) return [20, "A last look a couple of hours from now."];
      if (s.left) return [65, `${s.left} step${s.left === 1 ? "" : "s"} left: put the next session on your calendar so it doesn't stall.`];
      return [55, "A short review in a couple of days, when it's starting to fade: that's when it sticks."];
    },
    fields(t, s, ctx = {}) {
      const mode = s.left && !(s.exam && s.upcoming) ? "continue" : "review";
      return [
        { key: "mode", label: "Session", type: "select", options: opts([["review", "Review what we covered"], ["continue", "Continue the plan"], ["warmup", "Exam warm-up (mixed practice)"]]), value: mode },
        { key: "when", label: "When", type: "datetime", value: sessionWhen(s, ctx.now ? new Date(ctx.now) : new Date()) },
        { key: "minutes", label: "Length", type: "select", options: opts([["20", "20 min"], ["30", "30 min"], ["45", "45 min"], ["60", "1 hour"]]), value: "30" },
        ...(ctx.calendar ? [{ key: "calendar", label: "Put it on my calendar", type: "check", value: true }] : []),
        { key: "remind", label: "Reminder", type: "select", options: opts([["0", "None"], ["10", "10 min before"], ["30", "30 min before"], ["60", "1 hour before"]]), value: "30" },
      ];
    },
    summary: (v) => `${whenText(v.when)} · ${v.minutes} min`,
  },
  cards: {
    glyph: "i-cards", generative: true,
    title: () => "Flashcards",
    fit(t, s) {
      if (!s.taught) return [0];
      if (s.writing || (s.exam && s.upcoming && s.days >= 2)) return [45, "Spaced review cards for the facts that need to be instant."];
      return [s.hands ? 10 : 25, "Spaced review cards, in the Review tab."];
    },
    fields(t, s) {
      return [
        { key: "count", label: "Cards", type: "select", options: opts([["10", "10"], ["20", "20"], ["30", "30"], ["50", "50"]]), value: "20" },
        { key: "from", label: "From", type: "multi", options: opts([["mistakes", "My mistakes"], ["checks", "The checks I answered"], ["facts", "Key facts and formulas"], ["definitions", "Definitions"], ["timeline", "Dates and sequences"]]),
          value: s.writing ? ["facts", "timeline", "mistakes"] : ["mistakes", "facts"] },
        { key: "schedule", label: "Schedule", type: "select", options: opts([...(s.exam && s.upcoming ? [["exam", "Every day until the exam"]] : []), ["spaced", "Spaced (1, 3, 7, 14… days)"]]), value: s.exam && s.upcoming ? "exam" : "spaced" },
      ];
    },
    summary: (v) => `${v.count} cards · ${v.schedule === "exam" ? "daily to the exam" : "spaced"}`,
  },
  quickref: {
    glyph: "i-card", generative: true,
    title: (t) => (t.why === "project" ? "Bench card" : "Reference card"),
    fit(t, s) {
      if (!s.taught) return [0];
      if (t.why === "project") return [85, "One printable card to keep at the bench: pin map, values, the steps in order."];
      if (t.why === "skill") return [70, "The shortcuts and recipes from this session on one card to keep beside the app."];
      if (s.interview) return [60, "Your talking points on one card."];
      return [0];
    },
    fields(t) {
      const proj = t.why === "project";
      return [
        { key: "what", label: "Include", type: "multi", options: opts([["steps", "The steps, in order"], ["values", "Values and settings"], ["wiring", "Pin map and wiring"], ["commands", "Commands and code snippets"], ["shortcuts", "Shortcuts"], ["troubleshooting", "If it goes wrong"], ["formulas", "Formulas"]]),
          value: proj ? ["steps", "values", "wiring", "troubleshooting"] : ["steps", "shortcuts", "values"] },
        { key: "paper", label: "Size", type: "select", options: opts([["index-4x6", "Index card (4 × 6)"], ["half-letter", "Half letter"], ["letter", "Letter"]]), value: "half-letter" },
        { key: "sides", label: "Sides", type: "select", options: opts([["1", "One side"], ["2", "Front and back"]]), value: "1" },
      ];
    },
    summary: (v) => `${PAPERS[v.paper]?.label.replace(/ \(.*/, "")} · ${v.sides === "2" ? "both sides" : "one side"}`,
  },
  assignment: {
    glyph: "i-task", generative: true,
    title: () => "Practice on your own",
    fit(t, s) {
      if (!s.taught) return [0];
      if (t.why === "skill") return [80, "A few exercises to do in the app before next time; the next session starts by going over them."];
      if (t.why === "project") return [60, "The next build steps to try yourself, with what 'done' looks like."];
      if (t.why === "curiosity" || t.why === "class") return [20, "A few things to try on your own."];
      return [0];
    },
    fields(t) {
      return [
        { key: "count", label: "Exercises", type: "number", min: 1, max: 10, value: 4 },
        { key: "minutes", label: "Time", type: "select", options: opts([["15", "15 min"], ["30", "30 min"], ["60", "1 hour"], ["90", "1.5 hours"]]), value: "30" },
        { key: "where", label: "Where", type: "select", options: opts([["app", "In the app or tool"], ["bench", "At the bench"], ["paper", "On paper"]]), value: t.why === "skill" ? "app" : t.why === "project" ? "bench" : "paper" },
        { key: "level", label: "Level", type: "select", options: opts([["same", "What we did, on my own"], ["stretch", "A bit past it"]]), value: "stretch" },
      ];
    },
    summary: (v) => `${v.count} exercise${v.count === 1 ? "" : "s"} · ${v.minutes} min`,
  },
  notes: {
    glyph: "i-notes", generative: true,
    title: () => "Lesson notes",
    fit(t, s) {
      if (!s.taught) return [0];
      if (t.why === "class" || t.why === "curiosity") return [60, "A clean write-up of what we covered, with the figures, to reread."];
      if (s.hands) return [40, "A clean write-up of what we covered and why, to reread."];
      return [30, "A clean write-up of what we covered, to reread."];
    },
    fields() {
      return [
        { key: "length", label: "Length", type: "select", options: opts([["short", "Short (1–2 pages)"], ["medium", "Medium (3–5 pages)"], ["full", "Everything"]]), value: "short" },
        { key: "include", label: "Include", type: "multi", options: opts([["examples", "Worked examples"], ["figures", "Figures"], ["mistakes", "My mistakes"], ["sources", "Sources"], ["next", "What's next"]]), value: ["examples", "figures", "mistakes"] },
      ];
    },
    summary: (v) => ({ short: "1–2 pages", medium: "3–5 pages", full: "everything" }[v.length]),
  },
};
export const KINDS = Object.keys(ACTIONS);

export function allowanceText(a) {
  if (!a) return "";
  if (a.kind === "none") return "no notes";
  if (a.kind === "open") return "open notes";
  if (a.kind !== "sheet") return "";
  const card = a.paper?.startsWith("index");
  const what = card ? `${a.sheets === 1 ? "one" : a.sheets} index card${a.sheets > 1 ? "s" : ""}` : `${a.sheets === 1 ? "one" : a.sheets} ${PAPERS[a.paper]?.label.replace(/ \(.*/, "") === "Letter" ? "8.5×11" : PAPERS[a.paper]?.label} sheet${a.sheets > 1 ? "s" : ""}`;
  return `${what}, ${a.sides === 2 ? "front and back" : "one side"}`;
}

export function whenText(stamp) {
  const d = new Date(stamp);
  if (isNaN(d)) return "";
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---------- the grid ----------

// The actions that fit this topic, best first: the tutor's picks (topic.suggest, from the close) lead in its order,
// then the rest by fit. Each comes with its settings (saved ones over the defaults) and where it stands.
export function tiles(t, { now = Date.now(), deck = 0, calendar = false } = {}) {
  const s = situation(t, { now, deck });
  const picks = (Array.isArray(t.suggest) ? t.suggest : []).filter((x) => ACTIONS[x?.kind]);
  const out = [];
  for (const kind of KINDS) {
    const A = ACTIONS[kind], o = t.outputs?.[kind];
    let [score, why = ""] = A.fit(t, s);
    const pick = picks.findIndex((x) => x.kind === kind);
    if (pick >= 0) { score = 2000 - pick * 10; why = str(picks[pick].why) || why; }   // (in the tutor's order, ahead of the rest)
    if (score <= 0 && !(o && o.state !== "idle")) continue;   // (one made before stays, whatever the situation now)
    const fields = A.fields(t, s, { now, calendar }).map((f) => ({ ...f, value: o?.settings?.[f.key] !== undefined ? o.settings[f.key] : f.value }));
    const values = Object.fromEntries(fields.map((f) => [f.key, f.value]));
    out.push({ kind, title: A.title(t, s), why, score, glyph: A.glyph, generative: A.generative, fields, summary: A.summary(values),
      state: o?.state || "idle", files: o?.files || [], made: o?.summary || "", at: o?.at || null, error: o?.error || "", progress: o?.progress || "",
      ...(kind === "session" && o?.session ? { session: o.session } : {}) });
  }
  out.sort((a, b) => b.score - a.score);
  return { tiles: out.slice(0, 8), situation: { exam: s.exam, days: s.days, allowance: s.allowance, taught: s.taught, left: s.left } };
}

// Settings from the page → clean values for one action (unknown keys dropped, numbers clamped, choices checked).
export function normalizeSettings(kind, t, inp = {}, ctx = {}) {
  const A = ACTIONS[kind];
  if (!A) throw new Error(`no action "${kind}" (one of ${KINDS.join(", ")})`);
  const s = situation(t, ctx);
  const out = {};
  for (const f of A.fields(t, s, ctx)) {
    const v = inp[f.key];
    if (v === undefined) { out[f.key] = f.value; continue; }
    if (f.type === "number") out[f.key] = Math.min(f.max, Math.max(f.min, Math.round(Number(v)) || f.min));
    else if (f.type === "select") out[f.key] = f.options.some((o) => o.value === String(v)) ? String(v) : f.value;
    else if (f.type === "multi") out[f.key] = (Array.isArray(v) ? v : []).map(String).filter((x) => f.options.some((o) => o.value === x));
    else if (f.type === "check") out[f.key] = !!v;
    else if (f.type === "datetime") out[f.key] = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(v)) ? String(v) : f.value;
    else out[f.key] = str(String(v), 300);
  }
  return out;
}

// The layout a printable action renders with (lib/doc.mjs), from its settings. The `document` tool holds the tutor to it.
export function layoutFor(kind, v, t) {
  if (kind === "sheet") return { style: "sheet", paper: v.paper, pages: v.sheets * Number(v.sides), columns: Number(v.columns), font: v.font === "auto" ? "auto" : Number(v.font), title: t.title };
  if (kind === "quickref") return { style: "sheet", paper: v.paper, pages: Number(v.sides), columns: v.paper === "letter" ? 3 : 2, font: "auto", maxFont: v.paper === "letter" ? 10 : 9, title: t.title };
  if (kind === "worksheet") return { style: "doc", paper: "letter", pages: Math.min(20, Math.ceil(v.count / (v.space === "lots" ? 2 : v.space === "some" ? 3 : 6)) + 1), columns: 1, font: 11, title: `${t.title}: worksheet` };
  if (kind === "worksheet-key") return { style: "doc", paper: "letter", pages: 20, columns: 1, font: 10.5, title: `${t.title}: answer key` };
  if (kind === "assignment") return { style: "doc", paper: "letter", pages: 3, columns: 1, font: 11, title: `${t.title}: practice` };
  if (kind === "notes") return { style: "doc", paper: "letter", pages: { short: 2, medium: 5, full: 14 }[v.length] || 4, columns: 1, font: "auto", minFont: 10, maxFont: 11.5, title: `${t.title}: notes` };
  return null;
}

// Where each made file goes, inside the topic folder.
export const outFiles = (kind) => (kind === "worksheet" ? [["worksheet", "out/worksheet.md"], ["worksheet-key", "out/worksheet-key.md"]]
  : ["sheet", "quickref", "assignment", "notes"].includes(kind) ? [[kind, `out/${kind}.md`]] : []);

// ---------- the tutor's brief ----------

const list = (xs, labels) => xs.map((x) => labels.find((o) => o.value === x)?.label || x).join(", ");

// What the tutor is told to make. It works in this one turn, no background agents (a pause stops the turn, and
// anything left running would keep spending), renders with `document`, and finishes with `deliver`.
export function brief(kind, t, v, { dir, learner = "the learner", resume = false } = {}) {
  const A = ACTIONS[kind], s = situation(t);
  const f = Object.fromEntries(A.fields(t, s, {}).map((x) => [x.key, x]));
  const title = A.title(t, s);
  const head = resume
    ? `[Teach app] action ${kind} (resume)\n${learner} resumed making the ${title}. Pick up where you stopped (what you already wrote is still in ${dir}/out/); don't start over unless it's unusable.`
    : `[Teach app] action ${kind}\n${learner} clicked "${title}" in the end-of-session actions. Make it now, in this turn.`;
  const rules = [
    "Make it here in Teach, not on their screen: don't use say, watch or the screen tools for it, even if the lesson was on their screen.",
    "Work in this turn only: no background agents or anything that keeps running after the turn ends (the learner can pause it, which stops this turn). A quick blocking fact-check subagent is fine when a claim needs one.",
    "out/ holds only the files named here (it syncs): delete any scratch file you made to try something.",
    "Build it from this topic: log.md, topic.json (plan, knowledge map, facts), PROFILE.md and the files the learner attached, and keep the topic's notation.",
    t.integrity ? `Academic integrity applies: ${t.integrity} Use parallel problems, never a graded one.` : "",
    `Don't add review cards or write anything not asked for${kind === "cards" ? " beyond these cards" : ""}. When it's done, call deliver with kind "${kind}" and a one-line summary, then reply with one short line.`,
  ].filter(Boolean);
  const doc = (src, layoutKind = kind) => `Write it as Markdown (math as LaTeX) to ${dir}/${src}, then call document with source "${src}" and for "${layoutKind}": it renders the PDF at the size and page budget the learner chose, and shows you every page. Fix what the pages show (doesn't fit, a math error, something cut or too wide, a heading stranded at a column's foot) and render again until it's right.`;
  let what;
  if (kind === "sheet") {
    const a = s.allowance;
    what = [
      `Make a ${v.purpose === "bring" ? "note sheet to bring into the exam" : "study sheet to read before the exam (not to bring)"}: ${v.sheets} ${v.paper.startsWith("index") ? "card" : "sheet"}${v.sheets > 1 ? "s" : ""} of ${PAPERS[v.paper].label}, ${v.sides === "2" ? "front and back" : "one side"} (${v.sheets * Number(v.sides)} page${v.sheets * Number(v.sides) > 1 ? "s" : ""}), ${v.columns} columns, ${v.font === "auto" ? "font as big as fits" : `${v.font} pt`}.`,
      `Include: ${list(v.include, f.include.options)}.${v.extra ? ` Also: ${v.extra}.` : ""}`,
      a?.kind === "sheet" ? `The course allows ${allowanceText(a)}${a.source ? ` (${a.source})` : ""}; the budget above ${v.sheets * Number(v.sides) > a.sheets * a.sides ? "is MORE than that: say so in your reply" : "respects it"}.`
        : v.purpose === "bring" ? "The topic has no recorded note-sheet rule: look for it where this install keeps course material (the skill's local notes say where, if anywhere) and record what you find with update allowance (kind, paper, sheets, sides, text, source). If you can't find it, say so in your reply." : "",
      "Dense and scannable: what they'd look up mid-exam, not prose. Group by the kind of problem; put the procedure next to its formula; their own past mistakes as one-line traps. Everything checked against the fact-check notes.",
      doc("out/sheet.md"),
    ];
  } else if (kind === "worksheet") {
    what = [
      `Make a printable worksheet of ${v.count} problems on: ${list(v.steps, f.steps.options) || "everything taught"}. Difficulty: ${list([v.difficulty], f.difficulty.options)}. Kinds: ${list(v.formats, f.formats.options)}.${v.minutes ? ` Put a ${v.minutes}-minute time limit at the top.` : ""}`,
      `Two files. out/worksheet.md: a name/date line, then the numbered problems with every given on the problem itself (draw a figure when there is one: an SVG in figures/, checked with render, included as an image), ${v.space === "none" ? "no work space" : `then work space after each (a line "::: space ${v.space === "lots" ? "2.6in" : "1.4in"}")`}. out/worksheet-key.md: ${v.key === "worked" ? "each problem fully worked, step by step, with the final answer boxed in bold" : "the final answer to each, with units"}. Solve every problem yourself first and check the numbers (a quick python check when it's arithmetic): a wrong key is worse than none.`,
      "Directives the renderer understands, one per line: `::: space 1.5in` (blank space), `::: lines 6` (ruled lines), `::: box 1in` (an answer box), `::: break` (new page).",
      doc("out/worksheet.md", "worksheet"), `Then the same for the key: source "out/worksheet-key.md", for "worksheet-key".`,
    ];
  } else if (kind === "practice") {
    what = [
      `Run a timed practice ${v.format === "essay" ? "essay prompt" : "test"} on the board now: ${v.count} question${v.count === 1 ? "" : "s"}, ${v.minutes} minutes, ${list([v.format], f.format.options).toLowerCase()}, on ${list(v.steps, f.steps.options) || "everything taught"}.`,
      `One ask set (purpose practice) with keys and why lines${v.format === "essay" ? ", a text question with minutes and a word target" : ", minutes on each text/number question so the timer shows"}; put any figure or given on the question card. Then end your turn and wait for the answers.`,
      `When the answers come back: react to what they reveal (the misconception behind each miss), log the score in log.md, and only then call deliver with kind "practice" and the score as the summary.`,
    ];
    rules[rules.length - 1] = "Don't add review cards or write anything not asked for. Deliver comes after the answers, in the turn that grades them.";
  } else if (kind === "cards") {
    what = [
      `Add ${v.count} review items to the deck with the cards tool, from: ${list(v.from, f.from.options)}. Their real mistakes become traps; checks they answered become mcq; facts and formulas become cards or recall items${v.from.includes("timeline") ? "; dates and sequences become order items" : ""}. Don't duplicate what the deck already has.`,
    ];
  } else if (kind === "quickref") {
    what = [
      `Make a ${t.why === "project" ? "bench card to keep beside the hardware" : "reference card to keep beside the app"}: ${PAPERS[v.paper].label}, ${v.sides === "2" ? "front and back" : "one side"}. Include: ${list(v.what, f.what.options)}.`,
      "Only what they'd glance at mid-task, exact values and names as on the real part or in the real app (check them against the docs the facts cite). Steps as a numbered checklist (`- [ ]` items).",
      doc("out/quickref.md"),
    ];
  } else if (kind === "assignment") {
    what = [
      `Make ${v.count} exercise${v.count === 1 ? "" : "s"} for them to do on their own ${{ app: "in the app or tool this topic is about", bench: "at the bench, on their hardware", paper: "on paper" }[v.where]}, about ${v.minutes} minutes in all, ${v.level === "stretch" ? "each a bit past what the session did" : "repeating what the session did, without help"}.`,
      "Each: what to do, the goal, a hint they can choose to read (in a short 'Hint:' line), and how they'll know it worked. As a checklist (`- [ ]`).",
      `Also call update with next set to say the next session starts by going over these (keep the rest of the resume note).`,
      doc("out/assignment.md"),
    ];
  } else if (kind === "notes") {
    what = [
      `Write clean lesson notes of what this topic covered, ${list([v.length], f.length.options).toLowerCase()}, in teaching order: each step's idea, why it's true, ${v.include.includes("examples") ? "a worked example, " : ""}${v.include.includes("mistakes") ? "the mistake they made and the fix, " : ""}${v.include.includes("figures") ? "the figures from figures/ as images, " : ""}${v.include.includes("sources") ? "sources at the end, " : ""}${v.include.includes("next") ? "and what's next, " : ""}written for them to reread in a month.`,
      doc("out/notes.md"),
    ];
  }
  return [head, ...what.filter(Boolean), ...rules].join("\n");
}

// A paused or resumed action and the turn that's making it: what the next turn says when a pause cut it short.
export const pausedNote = (kind, learner) => `[Teach app] action ${kind} paused\n${learner} paused it: stop work on it here. Don't reply beyond one short line.`;

// ---------- calendar ----------

const icsEsc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsTime = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// One event as an .ics file (UTC times), with an alarm when asked.
export function ics({ uid, title, start, minutes, note = "", url = "", remind = 0, now = new Date() }) {
  const s = new Date(start), e = new Date(s.getTime() + minutes * 60e3);
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Teach//End-of-session actions//EN", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
    `UID:${uid}`, `DTSTAMP:${icsTime(now)}`, `DTSTART:${icsTime(s)}`, `DTEND:${icsTime(e)}`, `SUMMARY:${icsEsc(title)}`,
    ...(note ? [`DESCRIPTION:${icsEsc(note)}`] : []), ...(url ? [`URL:${url}`] : []),
    ...(remind > 0 ? ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEsc(title)}`, `TRIGGER:-PT${remind}M`, "END:VALARM"] : []),
    "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
}

// The arguments TEACH_CALENDAR_CMD gets: TITLE "YYYY-MM-DD HH:MM" --for <N>m --note TEXT [--remind <N>m]
// (local time, the page's; the shape calendar CLIs commonly take).
export const calendarArgs = ({ title, local, minutes, note, remind }) =>
  [title, local.replace("T", " "), "--for", `${minutes}m`, ...(note ? ["--note", note] : []), ...(remind > 0 ? ["--remind", `${remind}m`] : [])];

export function sessionTitle(t, v) {
  return `${{ review: "Review", continue: "Teach", warmup: "Exam warm-up" }[v.mode] || "Teach"}: ${t.title}`;
}

export const outPath = (dir, rel) => path.join(dir, rel);
