// What the tutor can do to a topic. The MCP server (mcp.mjs, inside the app) and the `teach` CLI (a chat
// outside the app) both call these, so a session anywhere leaves the same state behind.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  getTopic, mutateTopic, getDeck, saveDeck, topicDir, STATUSES, PHASES, STEP_STATUSES, WHYS,
} from "./store.mjs";

const str = (v, max = 4000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const fail = (msg) => { throw new Error(msg); };

// ---------- update: the topic's frame, knowledge map, fact-check notes, sources, resume note ----------

export function update(slug, inp) {
  return mutateTopic(slug, (t) => {
    for (const k of ["title", "goal", "course", "next", "integrity"]) if (typeof inp[k] === "string") t[k] = str(inp[k]);
    if (typeof inp.why === "string") t.why = WHYS.includes(inp.why) ? inp.why : fail(`why must be one of ${WHYS.join(", ")}`);
    if (typeof inp.deadline === "string") {
      if (inp.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(inp.deadline)) fail("deadline must be YYYY-MM-DD or empty");
      t.deadline = inp.deadline;
    }
    if (inp.status) t.status = STATUSES.includes(inp.status) ? inp.status : fail(`status must be one of ${STATUSES.join(", ")}`);
    if (inp.phase) t.phase = PHASES.includes(inp.phase) ? inp.phase : fail(`phase must be one of ${PHASES.join(", ")}`);
    if (Array.isArray(inp.map)) {
      t.map = inp.map.map((s) => ({
        strand: str(s.strand, 120) || fail("each map entry needs a strand"),
        has: str(s.has, 600), missing: str(s.missing, 600), misconception: str(s.misconception, 600),
      }));
    }
    if (Array.isArray(inp.facts_add)) t.facts.push(...inp.facts_add.map((f) => str(f, 800)).filter(Boolean));
    if (Array.isArray(inp.sources_add)) {
      for (const s of inp.sources_add) {
        const src = { label: str(s.label, 200) || str(s.path, 200) || str(s.url, 200), path: str(s.path, 500), url: str(s.url, 500) };
        if (src.label && !t.sources.some((x) => x.label === src.label)) t.sources.push(src);
      }
    }
  });
}

// ---------- plan: the dependency path, one node per reasoning step ----------

export function plan(slug, inp) {
  if (!Array.isArray(inp.nodes) || !inp.nodes.length) fail("plan needs nodes");
  return mutateTopic(slug, (t) => {
    const old = new Map(t.plan.map((n) => [n.id, n]));
    const ids = new Set();
    t.plan = inp.nodes.map((n, i) => {
      const id = str(String(n.id ?? i + 1), 40) || String(i + 1);
      if (ids.has(id)) fail(`duplicate step id ${id}`);
      ids.add(id);
      const prev = old.get(id) || {};
      return {
        id, title: str(n.title, 200) || fail(`step ${id} needs a title`), detail: str(n.detail, 1500),
        deps: Array.isArray(n.deps) ? n.deps.map(String) : [],
        status: STEP_STATUSES.includes(n.status) ? n.status : prev.status || "todo",
        result: str(n.result, 40) || prev.result || "", note: str(n.note, 800) || prev.note || "",
      };
    });
    for (const n of t.plan) n.deps = n.deps.filter((d) => ids.has(d) && d !== n.id);
    if (t.phase === "frame" || t.phase === "probe") t.phase = "plan";
  });
}

// ---------- step: mark progress on one plan node ----------

export function step(slug, inp) {
  return mutateTopic(slug, (t) => {
    const id = String(inp.id ?? "");
    const n = t.plan.find((x) => x.id === id) || fail(`no step "${id}" in the plan (ids: ${t.plan.map((x) => x.id).join(", ")})`);
    if (inp.status) {
      if (!STEP_STATUSES.includes(inp.status)) fail(`status must be one of ${STEP_STATUSES.join(", ")}`);
      if (inp.status === "current") for (const x of t.plan) if (x.status === "current") x.status = "todo";
      n.status = inp.status;
    }
    if (typeof inp.result === "string") n.result = str(inp.result, 40);
    if (typeof inp.note === "string") n.note = str(inp.note, 800);
    if (t.phase !== "review" && t.phase !== "close") t.phase = "teach";
  });
}

// ---------- cards: review items ----------

const ITEM_TYPES = {
  card: (x) => ({ front: str(x.front) || fail("card needs front"), back: str(x.back) || fail("card needs back") }),
  mcq: (x) => {
    const options = (x.options || []).map((o) => str(o, 600)).filter(Boolean);
    if (options.length < 2) fail("mcq needs 2+ options");
    const answer = Number.isInteger(x.answer) && x.answer >= 0 && x.answer < options.length ? x.answer : fail("mcq answer must be an option index");
    return { prompt: str(x.prompt) || fail("mcq needs prompt"), options, answer, why: str(x.why, 800) };
  },
  recall: (x) => {
    const accept = str(x.accept, 300);
    if (accept) try { new RegExp(accept, "i"); } catch { fail(`bad accept regex: ${accept}`); }
    return { prompt: str(x.prompt) || fail("recall needs prompt"), answer: str(x.answer, 300) || fail("recall needs answer"), accept };
  },
  trap: (x) => ({ wrong: str(x.wrong) || fail("trap needs wrong"), right: str(x.right) || fail("trap needs right") }),
  order: (x) => ({
    title: str(x.title, 200) || "Put these in order",
    items: (x.items || []).map((i) => ({ label: str(i.label, 60), text: str(i.text, 300) || fail("order items need text") })),
  }),
  outline: (x) => ({
    title: str(x.title, 200) || "Outline", minutes: Number(x.minutes) || 5,
    sections: (x.sections || []).map((s) => ({
      title: str(s.title, 200) || fail("outline sections need a title"), minutes: Number(s.minutes) || 10,
      keywords: (s.keywords || []).map((k) => (typeof k === "string" ? { label: str(k, 120), pattern: "" }
        : { label: str(k.label, 120), pattern: str(k.pattern, 300) })),
    })),
  }),
};

export const itemId = (item) => crypto.createHash("sha1")
  .update(JSON.stringify([item.type, item.front || item.prompt || item.wrong || item.title || ""])).digest("hex").slice(0, 10);

export function cards(slug, inp) {
  if (!getTopic(slug)) fail(`no topic "${slug}"`);
  const deck = getDeck(slug);
  const have = new Set(deck.items.map((i) => i.id));
  let added = 0;
  for (const raw of inp.items || []) {
    const make = ITEM_TYPES[raw.type] || fail(`item type must be one of ${Object.keys(ITEM_TYPES).join(", ")}`);
    const item = { type: raw.type, group: str(raw.group, 60), node: str(String(raw.node ?? ""), 40), ...make(raw) };
    item.id = str(raw.id, 40) || itemId(item);
    if (have.has(item.id)) continue;
    have.add(item.id);
    deck.items.push(item);
    added++;
  }
  if (inp.groups && typeof inp.groups === "object") Object.assign(deck.groups, inp.groups);
  for (const c of inp.checks || []) {
    try { new RegExp(c.pattern, "i"); } catch { fail(`bad check pattern: ${c.pattern}`); }
    if (!deck.checks.some((x) => x.pattern === c.pattern)) deck.checks.push({ pattern: c.pattern, message: str(c.message, 300), unless: str(c.unless, 200) });
  }
  saveDeck(slug, deck);
  return { added, total: deck.items.length };
}

// ---------- ask: validate a question set (the app shows it; answers come back as the next message) ----------

const KINDS = ["choice", "multi", "text", "number", "order", "task"];
const PURPOSES = ["probe", "check", "review", "setup", "approve", "practice"];

export function normalizeAsk(inp) {
  const qs = Array.isArray(inp.questions) ? inp.questions : fail("ask needs questions");
  if (!qs.length || qs.length > 8) fail("ask takes 1 to 8 questions");
  const box = Array.isArray(inp.box) && inp.box.length === 4 && inp.box.every((v) => Number.isFinite(Number(v))) ? inp.box.map(Number) : undefined;
  return {
    purpose: PURPOSES.includes(inp.purpose) ? inp.purpose : "check",
    node: str(String(inp.node ?? ""), 40), intro: str(inp.intro, 2000), ...(box ? { box } : {}),
    questions: qs.map((q, i) => {
      const kind = KINDS.includes(q.kind) ? q.kind : "choice";
      const out = { n: i + 1, kind, prompt: str(q.prompt) || fail(`question ${i + 1} needs a prompt`) };
      if (["choice", "multi", "order"].includes(kind)) {
        out.options = (q.options || []).map((o) => str(String(o), 800)).filter(Boolean);
        // The card has its own "I don't know"; drop a written-in one and keep the key pointing at the same option.
        const idk = kind !== "order" ? out.options.findIndex((o) => /^(i )?don['’]?t know\.?$|^not sure\.?$/i.test(o)) : -1;
        if (idk >= 0) {
          out.options.splice(idk, 1);
          if (Number.isInteger(q.answer) && q.answer > idk) q = { ...q, answer: q.answer - 1 };
          else if (q.answer === idk) q = { ...q, answer: undefined };
          if (Array.isArray(q.answer)) q = { ...q, answer: q.answer.filter((a) => a !== idk).map((a) => (a > idk ? a - 1 : a)) };
        }
        if (out.options.length < 2) fail(`question ${i + 1} needs at least 2 options`);
      }
      if (kind === "choice" && q.answer !== undefined) {
        if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= out.options.length) fail(`question ${i + 1}: answer must be an option index (0-based)`);
        out.answer = q.answer;
      }
      if (kind === "multi" && Array.isArray(q.answer)) out.answer = q.answer.filter((a) => Number.isInteger(a) && a >= 0 && a < out.options.length);
      if (kind === "number" && q.answer !== undefined) {
        out.answer = Number(q.answer);
        if (!Number.isFinite(out.answer)) fail(`question ${i + 1}: answer must be a number`);
        out.tolerance = Number(q.tolerance) > 0 ? Number(q.tolerance) : Math.abs(out.answer) * 0.01 || 1e-9;
      }
      for (const k of ["why", "unit", "placeholder", "image"]) if (str(q[k])) out[k] = str(q[k], 1500);
      if (Number(q.minutes) > 0) out.minutes = Math.min(Number(q.minutes), 180);
      if (Number(q.words) > 0) out.words = Number(q.words);
      out.idk = q.idk !== undefined ? !!q.idk : ["choice", "multi", "number"].includes(kind) && inp.purpose !== "setup" && inp.purpose !== "approve";
      out.own = q.own !== undefined ? !!q.own : kind === "choice";
      return out;
    }),
  };
}

// Graded choice questions are shuffled so the right answer isn't always first; `order` items always are.
// The shuffle is seeded by the question set's id, so a reload shows the same order.
export function shuffleAsk(ask, seed) {
  let h = crypto.createHash("sha1").update(String(seed)).digest().readUInt32LE(0);
  const rand = () => { h = (h + 0x6d2b79f5) >>> 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (const q of ask.questions) {
    const graded = q.kind === "choice" && q.answer !== undefined;
    if (!(graded || q.kind === "order")) continue;
    const idx = q.options.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    if (q.kind === "order" && idx.every((v, i) => v === i) && idx.length > 1) [idx[0], idx[1]] = [idx[1], idx[0]];
    if (q.kind === "order") { q.correct = q.options.slice(); q.options = idx.map((i) => q.correct[i]); continue; }
    q.options = idx.map((i) => q.options[i]);
    q.answer = idx.indexOf(q.answer);
  }
  return ask;
}

// Grade one answer. Returns { ok: true|false|null, text } — text is how the tutor reads it.
export function grade(q, a = {}) {
  if (a.skip) return { ok: null, text: "(skipped)" };
  if (a.idk) return { ok: false, text: "I don't know" };
  if (a.own) return { ok: null, text: `in my own words: "${a.own}"` };
  switch (q.kind) {
    case "choice": {
      const pick = q.options[a.choice];
      if (pick === undefined) return { ok: null, text: "(no answer)" };
      const ok = q.answer === undefined ? null : a.choice === q.answer;
      return { ok, text: `"${pick}"${ok === null ? "" : ok ? " (correct)" : ` (wrong; correct: "${q.options[q.answer]}")`}` };
    }
    case "multi": {
      const picks = (a.choices || []).filter((i) => q.options[i] !== undefined).sort();
      const ok = q.answer === undefined ? null : JSON.stringify(picks) === JSON.stringify([...q.answer].sort());
      const text = picks.length ? picks.map((i) => `"${q.options[i]}"`).join(", ") : "(none)";
      return { ok, text: text + (ok === null ? "" : ok ? " (correct)" : ` (wrong; correct: ${q.answer.map((i) => `"${q.options[i]}"`).join(", ") || "none"})`) };
    }
    case "number": {
      const v = Number(String(a.value ?? "").replace(/,/g, ""));
      if (!Number.isFinite(v) || a.value === "" || a.value === undefined) return { ok: null, text: "(no answer)" };
      const ok = q.answer === undefined ? null : Math.abs(v - q.answer) <= q.tolerance;
      return { ok, text: `${v}${q.unit ? " " + q.unit : ""}${ok === null ? "" : ok ? " (correct)" : ` (wrong; expected ${q.answer}${q.unit ? " " + q.unit : ""})`}` };
    }
    case "order": {
      const seq = (a.order || []).map((i) => q.options[i]).filter((x) => x !== undefined);
      const ok = q.correct ? JSON.stringify(seq) === JSON.stringify(q.correct) : null;
      return { ok, text: seq.map((s, i) => `${i + 1}) ${s}`).join("  ") + (ok === null ? "" : ok ? " (correct order)" : " (not the right order)") };
    }
    case "task":
      return { ok: a.task === "done" ? true : a.task === "stuck" ? false : null, text: a.task === "done" ? "Done" : a.task === "stuck" ? `Stuck${a.text ? `: "${a.text}"` : ""}` : a.text ? `"${a.text}"` : "(no answer)" };
    default:
      return { ok: null, text: a.text ? `"${a.text}"` : "(no answer)" };
  }
}

// The message the tutor receives when the learner submits a question set.
export function answersMessage(id, ask, answers) {
  const lines = [`[Answers to question set ${id}]`];
  let right = 0, graded = 0;
  ask.questions.forEach((q, i) => {
    const g = grade(q, answers[i]);
    if (g.ok !== null) { graded++; if (g.ok) right++; }
    lines.push(`${q.n}. ${q.prompt.split("\n")[0].slice(0, 160)}\n   → ${g.text}`);
  });
  if (graded) lines.push(`Score: ${right}/${graded}. The app already showed which were right and your "why" lines; don't repeat them, react to what the answers reveal.`);
  return { text: lines.join("\n"), right, graded };
}

// ---------- show: a figure, image or interactive page in the lesson ----------

export function normalizeShow(slug, inp) {
  const out = { title: str(inp.title, 200), caption: str(inp.caption, 600), height: Math.min(Math.max(Number(inp.height) || 420, 120), 1600) };
  if (str(inp.html)) {
    const dir = path.join(topicDir(slug), "figures");
    fs.mkdirSync(dir, { recursive: true });
    const name = (str(inp.name, 60).replace(/[^a-z0-9-]/gi, "-") || `widget-${Date.now().toString(36)}`) + ".html";
    out.path = path.join(dir, name);
    fs.writeFileSync(out.path, inp.html);
  } else if (str(inp.path)) {
    out.path = path.resolve(str(inp.path, 500));
    if (!fs.existsSync(out.path)) fail(`no file at ${out.path}`);
  } else fail("show needs path or html");
  out.kind = /\.html?$/i.test(out.path) ? "html" : "image";
  return out;
}

// A scene for a block on the board (chalk's scene format; chalk validates the objects when it draws). Prediction
// gates become graded questions the stage asks before the step they reveal.
export function normalizeScene(inp) {
  const scene = inp.scene && typeof inp.scene === "object" ? (inp.scene.scene && typeof inp.scene.scene === "object" ? inp.scene.scene : inp.scene) : null;
  if (!scene || !Array.isArray(scene.objects) || !scene.objects.length) fail("scene needs a spec with objects (see chalk's scene.md)");
  const steps = Array.isArray(scene.steps) ? scene.steps.length : 1;
  const predict = (Array.isArray(inp.predict) ? inp.predict : []).map((p) => {
    const step = Math.trunc(Number(p.step));
    if (!(step >= 1 && step < steps)) fail(`predict.step ${p.step}: a reveal is a later step, 1 to ${steps - 1} (0-based)`);
    const kind = p.kind === "number" ? "number" : "choice";
    const q = { step, kind, prompt: str(p.prompt, 600) || fail("predict needs a prompt"), why: str(p.why, 600) };
    if (kind === "choice") {
      q.options = (Array.isArray(p.options) ? p.options : []).map((o) => str(String(o), 200)).filter(Boolean);
      if (q.options.length < 2) fail("a choice prediction needs 2+ options");
      if (Number.isInteger(p.answer) && q.options[p.answer] !== undefined) q.answer = p.answer;
    } else {
      if (Number.isFinite(Number(p.answer))) q.answer = Number(p.answer);
      q.unit = str(p.unit, 20);
      if (q.answer !== undefined) q.tolerance = Number(p.tolerance) > 0 ? Number(p.tolerance) : Math.abs(q.answer) * 0.05 || 1e-9;
    }
    return q;
  }).sort((a, b) => a.step - b.step);
  return { scene, predict, replaces: str(inp.replaces, 80) || undefined, title: str(scene.title, 120) };
}
