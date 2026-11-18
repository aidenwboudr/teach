// What a course needs a model for, each made only when the learner clicks it (one model call, no tools, no session):
// loading a course from its real pages, its pre-test, a real exam turned into question cards, a practice version of an
// exam, and grading. The grader isn't the learner's tutor: a fresh call that never saw the lessons, told to grade the
// way the course's own TA would, against the rubric, without inflating.
//
// Fetching: the server reads the course's own pages (and PDFs, with pdftotext when it's installed) and hands their text
// to the model. Nothing here decides what the course is: the pages do, and what can't be found is left out or marked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { askModel, answerJSON } from "./visualize.mjs";
import { normalizeCourse, normalizeQuestion } from "./courses.mjs";
import { grade as gradeOne } from "./ops.mjs";
import { LEARNER } from "./paths.mjs";

const str = (v, max = 4000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const learner = LEARNER === "the learner" ? "the learner" : LEARNER;

// ---------- fetching a course's pages ----------

// Text from a page. Twice over: course platforms (Open edX, for one) put a problem's HTML inside an attribute, escaped,
// so the tags only appear once the entities are decoded.
const decode = (t) => t.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&#8217;|&#x27;/g, "'")
  .replace(/&(ldquo|rdquo);/g, '"').replace(/&(lsquo|apos);/g, "'").replace(/&hellip;/g, "…").replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&times;/g, "×")
  .replace(/&([aeiouyc])(acute|grave|uml|circ|cedil|tilde);/gi, (m, l, k) => (l + ({ acute: "\u0301", grave: "\u0300", uml: "\u0308", circ: "\u0302", cedil: "\u0327", tilde: "\u0303" })[k.toLowerCase()]).normalize("NFC"))
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, "&");
// (a link keeps its target: an exam's reading, a problem set's PDF)
const strip = (t) => t.replace(/<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, h, x) => (/^(https?:|\/)/.test(h) && !/^javascript:/i.test(h) ? `${x} (${h})` : x)).replace(/<[a-z][^>]*?\s[\w:-]+\s*=\s*"([^"]*&lt;[^"]*)"[^>]*>/gi, (_, v) => ` ${v} `).replace(/<(script|style|noscript|svg|nav|footer)\b[\s\S]*?<\/\1>/gi, " ").replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/label)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ");
export function htmlText(html) {
  let t = String(html || "");
  for (let i = 0; i < 3 && /<[a-z/!]/i.test(t); i++) t = decode(strip(t));
  return t.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

export function links(html, base) {
  const out = [];
  for (const m of String(html || "").matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try { out.push({ url: new URL(m[1], base).href, text: htmlText(m[2]).slice(0, 120) }); } catch { /* not a URL */ }
  }
  return out;
}

const KEY_PAGES = /syllab|calendar|schedule|reading|assignment|exam|lecture|video|session|week|unit|problem|paper|quiz|outline|course-info|overview/i;
const pdfText = (file) => new Promise((resolve) => execFile("pdftotext", ["-layout", file, "-"], { timeout: 60e3, maxBuffer: 40 << 20 }, (err, out) => resolve(err ? "" : String(out))));

export async function fetchText(u, { fetchFn = fetch, timeout = 25e3 } = {}) {
  const r = await fetchFn(u, { headers: { "User-Agent": "Teach course loader (self-study)" }, signal: AbortSignal.timeout(timeout), redirect: "follow" });
  if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
  const type = r.headers.get("content-type") || "";
  if (/pdf/i.test(type) || /\.pdf($|\?)/i.test(u)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teach-pdf-")), f = path.join(dir, "doc.pdf");
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    const text = await pdfText(f);
    fs.rmSync(dir, { recursive: true, force: true });
    return { url: u, text, html: "" };
  }
  const html = await r.text();
  return { url: u, text: htmlText(html) + await edxProblems(u, html, { fetchFn, timeout }), html };
}

// Open edX (MIT Open Learning Library, edX) loads each problem on a page by script: the page has only its id. Its
// public problem_get handler returns the problem's HTML, so the problems come in, in page order.
async function edxProblems(u, html, { fetchFn, timeout }) {
  const base = u.match(/^(https?:\/\/[^/]+\/courses\/course-v1:[^/]+)\//)?.[1];
  if (!base) return "";
  const ids = [...new Set([...html.matchAll(/block-v1:[^"'\s&]+?\+type@problem\+block@[0-9a-f]{32}/g)].map((m) => m[0]))].slice(0, 80);
  const out = [];
  for (const id of ids) {
    try {
      const r = await fetchFn(`${base}/xblock/${id}/handler/xmodule_handler/problem_get`, { headers: { "User-Agent": "Teach course loader (self-study)" }, signal: AbortSignal.timeout(timeout) });
      if (r.ok) out.push(htmlText((await r.json()).html || ""));
    } catch { /* one problem that won't load: the rest still do */ }
  }
  return out.length ? `\n\n${out.map((t) => `--- problem ---\n${t}`).join("\n\n")}` : "";
}

// A course's pages: the ones given, then the same site's pages whose link or address looks like part of the course
// (syllabus, calendar, readings, assignments, exams, lectures), up to `max`. Each page's text is capped.
export async function gather(urls, { max = 14, perPage = 40000, total = 260000, fetchFn } = {}) {
  const seen = new Set(), pages = [], queue = [...urls];
  let size = 0;
  while (queue.length && pages.length < max && size < total) {
    const u = queue.shift();
    if (seen.has(u)) continue;
    seen.add(u);
    try {
      const p = await fetchText(u, { fetchFn });
      const text = p.text.slice(0, perPage);
      pages.push({ url: u, text });
      size += text.length;
      if (p.html && urls.includes(u)) {
        const base = new URL(u), root = base.pathname.split("/").slice(0, 3).join("/");
        for (const l of links(p.html, u)) {
          const lu = new URL(l.url);
          if (lu.host === base.host && lu.pathname.startsWith(root) && (KEY_PAGES.test(l.url) || KEY_PAGES.test(l.text)) && !seen.has(l.url) && !/\.(zip|mp4|mp3|png|jpe?g)$/i.test(l.url)) queue.push(l.url);
        }
      }
    } catch (e) { pages.push({ url: u, text: "", error: String(e.message || e).slice(0, 200) }); }
  }
  return pages;
}

export async function fileText(file) {
  if (/\.pdf$/i.test(file)) return pdfText(file);
  const raw = fs.readFileSync(file, "utf8");
  return /\.html?$/i.test(file) ? htmlText(raw) : raw;
}

// ---------- prompts ----------

const SCHEMA = `{
  "title", "code", "institution", "instructors": [], "edition", "url", "summary",
  "hours": { "kind": "reading" | "math" | "mixed", "lectureMinutes": typical lecture length },
  "sources": [{ "part": "lectures"|"readings"|"assignments"|"exams", "title", "institution", "url", "generated": false }],
  "units": [{ "n", "title", "summary", "lectures": [{ "n", "title", "url" (video), "minutes", "slides" }],
              "readings": [{ "author", "title", "url", "pages", "required": true }] }],
  "assignments": [{ "id", "kind": "argument-analysis"|"paper"|"pset"|"problems"|"memo"|"essay"|"project", "title", "prompt" (the course's words), "length", "unit" (due after this unit), "rubric": [{ "criterion", "points", "detail" }], "rubricSource", "points", "url", "solutions" }],
  "exams": [{ "id", "kind": "midterm"|"final"|"quiz", "title", "covers": [unit numbers], "unit" (taken after this unit), "minutes", "closedBook", "rules", "url" (the real exam), "solutions" (its answers), "source": "real" }],
  "grading": [{ "what", "weight" (percent), "items": [assignment/exam ids] }],
  "passMark"
}`;

export function loadPrompt(pages, { hint = "" } = {}) {
  return [
    `You turn a real university course's own pages into a structured course for ${learner}'s self-study in Teach. Use only what these pages say. Never invent a lecture, reading, assignment or exam; leave out what you can't find, and put what's missing in "missing".`,
    hint ? `What ${learner} said about it: ${hint}` : "",
    "Units: the course's own parts or modules (a few lectures each), in order. Lectures with their video links when the pages give them. Readings with author, title, a free link when there is one, and pages when you can tell (else leave pages out).",
    "Graded work exactly as the course sets it: the prompt in the course's words, the length, when it's due (after which unit). A rubric only when the course publishes one; when it doesn't but its instructions say what's expected, build the rubric from those instructions and say so in rubricSource (\"built from the assignment's instructions; the course publishes none\").",
    "Exams: the real ones with their links (and the links to their answers or solutions). Don't copy the exam questions here.",
    "sources: one entry per part (lectures, readings, assignments, exams) naming the course it comes from. If a part of this course has to come from another edition or another course, name that one; that's fine, but be exact.",
    `Reply with only one JSON object: ${SCHEMA}, plus "missing": [strings].`,
    ...pages.filter((p) => p.text).map((p) => `--- page ${p.url} ---\n${p.text}`),
  ].filter(Boolean).join("\n\n");
}

export function pretestPrompt(c, { perUnit = 3 } = {}) {
  return [
    `Write the pre-test for ${c.code ? `${c.code} ` : ""}${c.title} (${c.institution}), for ${learner}, who is about to start the course on their own. It finds what they already know, so the lessons cover only the gaps; they expect to know little. It's Teach's probe: graded multiple choice, binary-searching the edge.`,
    `For each unit, ${perUnit} questions from easy to hard: the unit's central idea (would someone who's never studied it get it?), then its core argument or method, then a harder one a student who took the course would get right. Ask about understanding, not trivia or who wrote what. Plausible wrong options built from real misconceptions; no "all of the above"; no "I don't know" option (the app adds one).`,
    "Each question: unit (its number), kind \"choice\", prompt, options (3 to 5), answer (0-based index), why (one line: what the right answer shows).",
    'Reply with only {"questions": [...]}.',
    `The course:\n${c.units.map((u) => `Unit ${u.n}: ${u.title}${u.summary ? ` — ${u.summary}` : ""}\n  Lectures: ${u.lectures.map((l) => l.title).join("; ")}\n  Readings: ${u.readings.map((r) => `${r.author}, ${r.title}`).join("; ")}`).join("\n")}`,
  ].join("\n\n");
}

export function realExamPrompt(x, pages) {
  return [
    `This is the real ${x.title} of a university course. Turn it into Teach's question cards, word for word. Don't add, drop, reword or reorder questions. Keep each part's instructions as "part". Quote passages exactly.`,
    "Kinds: choice (one answer), multi (several), number, text (written answers; put the official answer or the grading notes in \"model\"). Points as the exam gives them (1 each when it doesn't say).",
    "The answer key: when there's an answers or solutions page, key EVERY question from it. Match each answer to its question by part and problem number (numbering may restart in each part). \"answer\" is the 0-based index of the right option for choice, a list of indexes for multi, a number for number. Put the answers page's explanation, if any, in \"why\". Leave answer out only for a question the answers page truly doesn't cover.",
    "If the exam depends on a reading (e.g. questions on a paper), put the reading's title and link in the first question's prompt.",
    'Reply with only {"questions": [...], "minutes": the time limit if stated, "rules": "the exam\'s own rules (open/closed book, materials)", "missing": [what you couldn\'t read]}.',
    ...pages.filter((p) => p.text).map((p) => `--- ${p.url} ---\n${p.text}`),
  ].join("\n\n");
}

export function practicePrompt(c, x, { count } = {}) {
  const units = c.units.filter((u) => x.covers.includes(u.n));
  return [
    `Write a PRACTICE version of the ${x.title} for ${c.code ? `${c.code} ` : ""}${c.title}: new questions, not the real exam's, in the same format and at the same difficulty, on the same units. It's labelled practice; the real exam stays a single sitting.`,
    x.rules ? `The real exam's format: ${x.rules}` : "",
    `About ${count || Math.max(8, x.count || 12)} questions, about ${x.minutes} minutes. Kinds: choice, multi, text (with "model": a model answer and what a full-marks answer needs). Points per question. Every choice question has an answer key and a one-line why.`,
    'Reply with only {"questions": [...]}.',
    `Units:\n${units.map((u) => `Unit ${u.n}: ${u.title}\n  Readings: ${u.readings.map((r) => `${r.author}, ${r.title}`).join("; ")}\n  Lectures: ${u.lectures.map((l) => l.title).join("; ")}`).join("\n")}`,
  ].filter(Boolean).join("\n\n");
}

// The grader: not the tutor, not on the learner's side.
const GRADER = (c) => `You are a strict teaching assistant grading for ${c.code ? `${c.code} ` : ""}${c.title} (${c.institution}). You have never met this student and you are not their tutor or advocate: grade the work in front of you the way this course's own graders would, against the rubric, at the course's standard. Don't inflate. Full marks on a criterion means nothing to improve on it. Quote the student's own words when you criticise or praise.`;

export function gradeWorkPrompt(c, a, text) {
  const unit = c.units.find((u) => u.n === a.unit);
  return [
    GRADER(c),
    `The assignment: ${a.title}${a.length ? ` (${a.length})` : ""}\n${a.prompt}`,
    a.rubric.length ? `Rubric (${a.rubricSource || "the course's"}):\n${a.rubric.map((r) => `- ${r.criterion} (${r.points} pts)${r.detail ? `: ${r.detail}` : ""}`).join("\n")}` : "No rubric: grade on accuracy of the reconstruction, the quality of the argument and evaluation, and clarity, out of the assignment's points.",
    unit ? `It's on unit ${unit.n}, ${unit.title}: ${unit.readings.map((r) => `${r.author}, ${r.title}`).join("; ")}.` : "",
    `Out of ${a.rubric.reduce((s, r) => s + r.points, 0) || a.points} points.`,
    'Reply with only {"criteria": [{"criterion", "points", "max", "comment"}], "summary": "two or three sentences", "strengths": [], "problems": [{"quote": "their words", "issue", "fix"}], "letter": "A..F as the course would give"}.',
    `--- the student's submission ---\n${text}`,
  ].filter(Boolean).join("\n\n");
}

export function gradeAnswersPrompt(c, title, items) {
  return [
    GRADER(c),
    `Grade these written answers from the ${title}. For each, the question, the official answer or grading notes when the course has them, the points, and the student's answer.`,
    'Reply with only {"answers": [{"n", "points", "max", "comment"}]}.',
    ...items.map((q) => `--- question ${q.n} (${q.points} pts) ---\n${q.prompt}\n${q.model ? `Official answer / notes: ${q.model}\n` : ""}Student: ${q.answer || "(blank)"}`),
  ].join("\n\n");
}

// ---------- turning answers into results ----------

export function questionsFrom(ans) {
  const qs = Array.isArray(ans?.questions) ? ans.questions : [];
  if (!qs.length) throw new Error("the answer had no questions");
  return qs.map((q, i) => normalizeQuestion(q, i));
}

// The pre-test's result per unit: right, of, and `known` (the share right; "I don't know" and blanks count as not known).
export function pretestResult(questions, answers) {
  const byUnit = {};
  let right = 0;
  questions.forEach((q, i) => {
    const u = q.unit ?? 0, a = answers[i] || {};
    byUnit[u] = byUnit[u] || { right: 0, of: 0, idk: 0 };
    byUnit[u].of++;
    if (a.idk || a.choice === undefined) byUnit[u].idk++;
    else if (a.choice === q.answer) { byUnit[u].right++; right++; }
  });
  for (const r of Object.values(byUnit)) r.known = Math.round((r.right / r.of) * 100) / 100;
  return { right, of: questions.length, byUnit };
}

// Auto-graded part of a test: choice, multi, number. Written answers go to the grader. Returns per-question results.
export function autoGrade(questions, answers) {
  return questions.map((q, i) => {
    const a = answers[i] || {};
    if (q.kind === "text") return { n: q.n, points: null, max: q.points, pending: true, answer: str(a.text, 20000) };
    if (q.answer === undefined) return { n: q.n, points: null, max: q.points, ungraded: true };
    const g = gradeOne({ ...q, unit: q.unit_label }, a);
    return { n: q.n, points: g.ok ? q.points : 0, max: q.points, ok: !!g.ok, text: g.text };
  });
}

export function total(results) {
  const graded = results.filter((r) => Number.isFinite(r.points));
  return { score: graded.reduce((a, r) => a + r.points, 0), max: graded.reduce((a, r) => a + r.max, 0) };
}

// ---------- the jobs ----------

// Each returns { promise, cancel }. `ask` can be replaced in tests (the server passes askModel on its provider).
export function job(kind, args, { provider, model = "opus", effort = "high", ask = askModel } = {}) {
  let cur = null, cancelled = false;
  const call = async (prompt) => {
    if (cancelled) throw Object.assign(new Error("cancelled"), { cancelled: true });
    cur = ask({ provider, prompt, model, effort });
    return answerJSON(await cur.promise);
  };
  const run = async () => {
    if (kind === "load") {
      const pages = [...(args.pages || []), ...(args.urls?.length ? await gather(args.urls, { fetchFn: args.fetchFn }) : [])];
      if (!pages.some((p) => p.text)) throw new Error(`couldn't read the course's pages${pages[0]?.error ? ` (${pages[0].error})` : ""}`);
      const ans = await call(loadPrompt(pages, { hint: args.hint }));
      const course = normalizeCourse({ ...ans, slug: args.slug, program: args.program, slot: args.slot });
      return { course, missing: (ans.missing || []).map((m) => str(String(m), 300)), pages: pages.map((p) => ({ url: p.url, chars: p.text.length, error: p.error })) };
    }
    if (kind === "pretest") return { questions: questionsFrom(await call(pretestPrompt(args.course))).filter((q) => q.kind === "choice" && q.answer !== undefined) };
    if (kind === "exam-real") {
      const x = args.exam;
      const pages = await gather([x.url, x.solutions].filter(Boolean), { max: 2, perPage: 120000, total: 240000, fetchFn: args.fetchFn });
      if (!pages.some((p) => p.text)) throw new Error(`couldn't read the exam (${pages.map((p) => p.error).filter(Boolean).join("; ") || "empty page"})`);
      const ans = await call(realExamPrompt(x, pages));
      return { questions: questionsFrom(ans), minutes: Number(ans.minutes) || null, rules: str(ans.rules, 1000), missing: ans.missing || [] };
    }
    if (kind === "exam-practice") return { questions: questionsFrom(await call(practicePrompt(args.course, args.exam, {}))) };
    if (kind === "grade-work") {
      const a = args.assignment;
      const ans = await call(gradeWorkPrompt(args.course, a, args.text));
      const criteria = (ans.criteria || []).map((x) => ({ criterion: str(x.criterion, 200), points: Math.max(0, Number(x.points) || 0), max: Math.max(0, Number(x.max) || 0), comment: str(x.comment, 2000) }));
      for (const x of criteria) x.points = Math.min(x.points, x.max || x.points);
      const max = criteria.reduce((s, x) => s + x.max, 0) || a.points;
      return { grade: { score: criteria.reduce((s, x) => s + x.points, 0), max, criteria, summary: str(ans.summary, 2000), strengths: (ans.strengths || []).map((x) => str(String(x), 400)),
        problems: (ans.problems || []).map((p) => ({ quote: str(p.quote, 600), issue: str(p.issue, 600), fix: str(p.fix, 600) })), letter: str(ans.letter, 4), by: "grader", at: new Date().toISOString() } };
    }
    if (kind === "grade-answers") {
      const items = args.items;   // [{ n, prompt, model, points, answer }]
      if (!items.length) return { answers: [] };
      const ans = await call(gradeAnswersPrompt(args.course, args.title, items));
      return { answers: items.map((q) => { const g = (ans.answers || []).find((x) => Number(x.n) === q.n) || {}; return { n: q.n, points: Math.min(q.points, Math.max(0, Number(g.points) || 0)), max: q.points, comment: str(g.comment, 2000) }; }) };
    }
    throw new Error(`no job ${kind}`);
  };
  return { promise: run(), cancel() { cancelled = true; cur?.cancel(); } };
}
