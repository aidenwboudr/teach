// Topic files. A topic is a folder under learning/topics/<slug>/:
//   topic.json   structured state the app shows (goal, map, plan with step statuses, facts, sources, sessions)
//   log.md       the narrative log the tutor writes (what was taught, how checks went, recaps)
//   deck.json    review items (flashcards, MCQ, recall, traps, timelines, outlines)
//   sheet.md     a printable review sheet (optional)
//   figures/     diagrams the tutor drew (in git)
//   files/       what the learner attached (not in git: PDFs and photos stay on this machine)
// Machine-local state (pending questions, review schedule, the live session) lives under STATE, never in git.
import fs from "node:fs";
import path from "node:path";
import { TOPICS, STATE, LEARNING } from "./paths.mjs";

export const STATUSES = ["active", "paused", "done", "archived"];
export const PHASES = ["frame", "probe", "plan", "teach", "review", "close"];
export const STEP_STATUSES = ["todo", "current", "done", "shaky", "skipped"];
export const WHYS = ["class", "exam", "homework", "project", "skill", "curiosity", "writing"];

export const now = () => new Date().toISOString();

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

export function slugify(text) {
  const words = String(text).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ")
    .filter((w) => w && !["i", "a", "an", "the", "to", "how", "want", "learn", "me", "teach", "about", "my", "and", "of", "for", "in"].includes(w));
  let slug = words.slice(0, 5).join("-").slice(0, 48).replace(/-+$/, "");
  return slug || "topic";
}

export const validSlug = (s) => typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);
export const topicDir = (slug) => path.join(TOPICS, slug);
export const topicFile = (slug) => path.join(topicDir(slug), "topic.json");

export function uniqueSlug(base) {
  let slug = validSlug(base) ? base : slugify(base);
  for (let i = 2; fs.existsSync(topicDir(slug)); i++) slug = `${slugify(base)}-${i}`;
  return slug;
}

export function blankTopic(slug, fields = {}) {
  return {
    v: 1, slug, title: fields.title || slug, goal: "", why: "", course: "", deadline: "",
    status: "active", phase: "frame", next: "", integrity: "",
    created: now(), updated: now(),
    map: [], plan: [], facts: [], sources: [], sessions: [],
    // screen: the lesson happens on their computer screen (chalk marks, spoken narration, the tutor watching them
    // do each step); voice: speak the narration out loud.
    settings: { model: "opus", effort: "high", review: true, screen: false, voice: true },
    ...fields,
  };
}

export function listSlugs() {
  try {
    return fs.readdirSync(TOPICS).filter((s) => validSlug(s) && fs.existsSync(topicFile(s)));
  } catch { return []; }
}

export function getTopic(slug) {
  if (!validSlug(slug)) return null;
  const t = readJSON(topicFile(slug), null);
  if (!t) return null;
  return { ...blankTopic(slug), ...t, settings: { ...blankTopic(slug).settings, ...(t.settings || {}) } };
}

export function saveTopic(topic) {
  topic.updated = now();
  writeJSON(topicFile(topic.slug), topic);
  return topic;
}

export function createTopic(fields) {
  const slug = uniqueSlug(fields.slug || fields.title || "topic");
  fs.mkdirSync(path.join(topicDir(slug), "files"), { recursive: true });
  const topic = blankTopic(slug, { ...fields, slug });
  saveTopic(topic);
  return topic;
}

export function mutateTopic(slug, fn) {
  const t = getTopic(slug);
  if (!t) throw new Error(`no topic "${slug}"`);
  fn(t);
  return saveTopic(t);
}

// ---------- deck ----------

export const deckFile = (slug) => path.join(topicDir(slug), "deck.json");

export function getDeck(slug) {
  const d = readJSON(deckFile(slug), null) || {};
  return { groups: d.groups || {}, checks: d.checks || [], items: d.items || [] };
}

export function saveDeck(slug, deck) {
  writeJSON(deckFile(slug), deck);
}

// ---------- machine-local runtime state per topic ----------

const runtimeFile = (slug) => path.join(STATE, "topics", `${slug}.json`);

export function getRuntime(slug) {
  return { asks: {}, lastSync: null, ...readJSON(runtimeFile(slug), {}) };
}

export function mutateRuntime(slug, fn) {
  const r = getRuntime(slug);
  fn(r);
  writeJSON(runtimeFile(slug), r);
  return r;
}

export const globalFile = (name) => path.join(STATE, `${name}.json`);

// ---------- files a topic can show ----------

export function topicFiles(slug) {
  const out = [];
  for (const sub of ["files", "figures"]) {
    const dir = path.join(topicDir(slug), sub);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names.sort()) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) out.push({ name, path: p, kind: sub, size: st.size, mtime: st.mtimeMs });
      } catch { /* vanished */ }
    }
  }
  return out;
}

export const relLearning = (p) => path.relative(LEARNING, p);
