// Spaced review across topics: a Leitner schedule over each topic's deck. Flashcards, multiple choice,
// recall and traps are scheduled; timelines and outlines are drills you run on demand. The schedule is
// machine-local (STATE/review.json): reviewing never creates a git change.
import { listSlugs, getTopic, getDeck, readJSON, writeJSON, globalFile } from "./store.mjs";

const DAYS = [0, 1, 3, 7, 14, 30, 60, 120];
export const SCHEDULED = new Set(["card", "mcq", "recall", "trap"]);
const NEW_PER_DAY = 20;
const file = () => globalFile("review");
const today = () => new Date().toLocaleDateString("en-CA");

function load() {
  const s = readJSON(file(), {});
  return { items: s.items || {}, daily: s.daily?.date === today() ? s.daily : { date: today(), fresh: 0 } };
}

const key = (slug, id) => `${slug}/${id}`;

function pool(slug) {
  const slugs = slug ? [slug] : listSlugs();
  const out = [];
  for (const s of slugs) {
    const t = getTopic(s);
    if (!t || t.status === "archived" || (!slug && t.settings.review === false)) continue;
    for (const item of getDeck(s).items) if (SCHEDULED.has(item.type)) out.push({ slug: s, topic: t.title, item });
  }
  return out;
}

// What's due now. Cram (exam week) ignores the schedule: everything in the topic, missed items first, then unseen, then weakest.
export function queue({ slug, cram = false, limit = 60 } = {}) {
  const st = load(), nowMs = Date.now();
  const all = pool(slug).map((x) => ({ ...x, s: st.items[key(x.slug, x.item.id)] }));
  if (cram) {
    return all.sort((a, b) => (b.s?.lapses || 0) - (a.s?.lapses || 0) || (a.s?.box ?? -1) - (b.s?.box ?? -1) || Math.random() - 0.5)
      .slice(0, limit).map(view);
  }
  const due = all.filter((x) => x.s && x.s.due <= nowMs).sort((a, b) => a.s.due - b.s.due);
  const fresh = all.filter((x) => !x.s).slice(0, Math.max(0, NEW_PER_DAY - st.daily.fresh));
  return [...due, ...fresh].slice(0, limit).map(view);
}

const view = (x) => ({ slug: x.slug, topic: x.topic, ...x.item, box: x.s?.box ?? null, isNew: !x.s });

export function counts() {
  const st = load(), nowMs = Date.now(), by = {};
  let freshLeft = Math.max(0, NEW_PER_DAY - st.daily.fresh), total = 0;
  for (const x of pool()) {
    const s = st.items[key(x.slug, x.item.id)];
    let n = 0;
    if (s && s.due <= nowMs) n = 1;
    else if (!s && freshLeft > 0) { n = 1; freshLeft--; }
    if (n) { by[x.slug] = (by[x.slug] || 0) + 1; total++; }
  }
  return { total, by };
}

// When each item was last graded ("slug/id" → ms): how the app and the screen see each other's grades.
export function lastSeen() {
  const out = {};
  for (const [k, s] of Object.entries(load().items)) out[k] = s.last || 0;
  return out;
}

export function gradeItem(slug, id, good) {
  const st = load();
  const k = key(slug, id), s = st.items[k] || { box: 0, lapses: 0, seen: 0 };
  if (!st.items[k]) st.daily.fresh++;
  s.seen++;
  s.last = Date.now();
  if (good) s.box = Math.min(s.box + 1, DAYS.length - 1);
  else { s.lapses++; s.box = 0; }
  s.due = Date.now() + (s.box === 0 ? 10 * 60e3 : DAYS[s.box] * 86400e3);
  st.items[k] = s;
  writeJSON(file(), st);
  return s;
}
