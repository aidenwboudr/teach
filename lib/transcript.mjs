// Claude Code transcripts (~/.claude/projects/<cwd>/<session>.jsonl) → what the lesson view shows, plus the
// search for /teach sessions that ran somewhere else (T3 threads, the focus tutor, a terminal) so they can be
// brought into the app.
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { PROJECTS, LEARNING, T3_DB, WORK, STATE } from "./paths.mjs";
import { normalizeAsk, normalizeScene, shuffleAsk } from "./ops.mjs";

// ---------- reading ----------

const cache = new Map();      // path → { ino, size, rest, entries }

// A transcript is read as it grows: only the bytes appended since the last read, in 1 MB chunks, and each entry
// is slimmed as it's parsed. Screen-mode lessons fill transcripts with screenshots (one lesson passed 100 MB on
// 2026-11-03); re-reading that whole on every change ran the server out of heap in a crash loop, and each
// crash left its tutor running, so two or three tutors narrated the same lesson.
export function entries(file) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  let c = cache.get(file);
  if (!c || c.ino !== st.ino || st.size < c.size) c = { ino: st.ino, size: 0, rest: "", entries: [] };
  cache.delete(file);
  cache.set(file, c);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  if (st.size === c.size) return c.entries;
  const buf = Buffer.alloc(1 << 20), dec = new StringDecoder("utf8");
  let fd;
  try {
    fd = fs.openSync(file, "r");
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, c.size)) > 0;) {
      c.size += n;
      const lines = (c.rest + dec.write(buf.subarray(0, n))).split("\n");
      c.rest = lines.pop();
      for (const line of lines) if (line) try { c.entries.push(slim(JSON.parse(line))); } catch { /* not JSON */ }
    }
  } catch { /* gone mid-read: keep what was read */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  if (c.rest) try { c.entries.push(slim(JSON.parse(c.rest))); c.rest = ""; } catch { /* a line still being written */ }
  return c.entries;
}

// Nothing here shows screenshots a tool returned or Claude Code's toolUseResult copy of each result.
function slim(e) {
  delete e.toolUseResult;
  for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
    if (b.type === "tool_result" && Array.isArray(b.content)) b.content = b.content.filter((x) => x.type !== "image");
  }
  return e;
}

const NOISE = /\[Image[^\]]*\]|<t3_context[\s\S]*?<\/t3_context>|<system-reminder>[\s\S]*?<\/system-reminder>|<command-message>[\s\S]*?<\/command-message>|<local-command-std(out|err)>[\s\S]*?<\/local-command-std(out|err)>/g;
// Machinery turns that never show as the learner's words. "Resume <name>'s /teach session" and the focus block
// line are the openers a focus tool sends; any name.
const HIDDEN_RE = /^(Base directory for this skill|Resume [^\n]{1,60}? \/teach session|We're in a focus block now|Caveat: The messages below were generated|<task-notification>|This session is being continued from a previous conversation)/;
const hidden = (t) => HIDDEN_RE.test(t);

export function clean(t) {
  return String(t || "").replace(NOISE, "")
    .replace(/<command-name>\/?([\w:-]+)<\/command-name>\s*<command-args>([\s\S]*?)<\/command-args>/g, "/$1 $2")
    .replace(/\n{3,}/g, "\n\n").trim();
}

const blocksOf = (e) => {
  const c = e.message?.content;
  return Array.isArray(c) ? c : [{ type: "text", text: c || "" }];
};
const resultText = (b) => (typeof b.content === "string" ? b.content
  : (b.content || []).map((x) => x.text || "").join(" "));

// One-line description of a tool call, for the quiet activity line.
export function activityLabel(name, inp = {}) {
  const base = (p) => path.basename(String(p || ""));
  switch (name) {
    case "Read": return `Reading ${base(inp.file_path)}`;
    case "Grep": return `Searching for “${String(inp.pattern || "").slice(0, 40)}”`;
    case "Glob": return `Looking for ${inp.pattern || "files"}`;
    case "Edit": case "Write": case "MultiEdit":
      return String(inp.file_path || "").includes("/learning/") ? (/PROFILE\.md$/.test(inp.file_path) ? "Updating your learner profile" : `Updating the ${base(inp.file_path)}`) : `Writing ${base(inp.file_path)}`;
    case "Bash": return inp.description ? String(inp.description).slice(0, 80) : `Running ${String(inp.command || "").split("\n")[0].slice(0, 60)}`;
    case "WebSearch": return `Searching the web: ${String(inp.query || "").slice(0, 60)}`;
    case "WebFetch": try { return `Reading ${new URL(inp.url).host}`; } catch { return "Reading a web page"; }
    case "Agent": case "Task": return `${inp.description || "Working in the background"}${inp.model ? ` · ${inp.model}` : ""}`;
    case "Skill": return `Loading the ${inp.skill} skill`;
    case "mcp__teach__watch": return inp.expect ? `Watching your screen: ${String(inp.expect).slice(0, 80)}` : "Watching your screen";
    case "mcp__chalk__screen_look": return "Looking at your screen";
    case "mcp__chalk__screen_draw": return "Drawing on your screen";
    case "mcp__chalk__screen_clear": return "Clearing your screen";
    default: return name.startsWith("mcp__") ? name.split("__").pop().replace(/_/g, " ") : name;
  }
}
const QUIET = new Set(["TodoWrite", "ToolSearch", "TaskOutput", "ScheduleWakeup"]);

export function chipFor(name, inp = {}, plan = []) {
  switch (name) {
    case "mcp__teach__plan": return `Plan · ${(inp.nodes || []).length} steps`;
    case "mcp__teach__step": {
      const title = plan.find((n) => n.id === String(inp.id))?.title;
      const lead = `Step ${inp.id}${title ? ` · ${title}` : ""}`;
      return inp.status === "current" ? `${lead} · started` : inp.status === "done" ? `${lead} · done${inp.result ? ` · ${inp.result}` : ""}`
        : inp.status === "shaky" ? `${lead} · shaky${inp.result ? ` · ${inp.result}` : ""}` : `${lead} · ${inp.status || "updated"}`;
    }
    case "mcp__teach__cards": return `+${(inp.items || []).length} review item${(inp.items || []).length === 1 ? "" : "s"}`;
    case "mcp__teach__update": {
      const parts = [];
      if (inp.goal) parts.push("goal set");
      if (inp.map) parts.push("knowledge map");
      if (inp.facts_add) parts.push(`${inp.facts_add.length} fact-check note${inp.facts_add.length === 1 ? "" : "s"}`);
      if (inp.sources_add) parts.push("sources");
      if (inp.deadline) parts.push(`deadline ${inp.deadline}`);
      if (inp.status === "done") parts.push("marked done");
      return parts.length ? parts.join(" · ") : null;
    }
    default: return null;
  }
}

// AskUserQuestion (chat sessions) → the app's question format. Its options carry no answer key.
export function fromAskUserQuestion(inp) {
  const qs = (inp.questions || []).map((q) => ({
    kind: q.multiSelect ? "multi" : "choice",
    prompt: (q.header ? `**${q.header}.** ` : "") + (q.question || ""),
    options: (q.options || []).map((o) => o.label + (o.description ? ` — ${o.description}` : "")),
    idk: false, own: true,
  }));
  try { return { ...normalizeAsk({ purpose: "check", questions: qs }), legacy: true, raw: inp.questions }; }
  catch { return null; }
}

// Answers to an AskUserQuestion come back as `"question"="answer"` pairs; an answer that matches an option's label
// becomes that pick, anything else was typed in ("Other").
function legacyAnswers(ask, text) {
  const pairs = [...String(text).matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], m[2]]);
  return ask.raw.map((q, i) => {
    const said = pairs.find(([k]) => k === q.question)?.[1] ?? "";
    const labels = (q.options || []).map((o) => o.label);
    if (!said) return { text: "" };
    const one = labels.indexOf(said);
    if (one >= 0 && !q.multiSelect) return { choice: one, text: said };
    const many = said.split(/,\s*/).map((x) => labels.indexOf(x));
    if (q.multiSelect && many.every((x) => x >= 0)) return { choices: many, text: said };
    return { own: said, text: said };
  });
}

// A watch (screen mode) that ended because the learner said something returns their words ("<name> said: …");
// the lesson shows them as theirs.
export function saidInWatch(text) {
  const m = String(text || "").match(/^[^\n:“]{1,40}? said(?: \(while you were busy\))?: ([\s\S]*?)(?:\n\(Call screen_look|$)/);
  return m ? [...m[1].matchAll(/“([\s\S]*?)”/g)].map((x) => x[1]).join("\n\n") : null;
}

const isAnswers = (t) => t.startsWith("[Answers to question set ");
const appKind = (t) => (t.match(/^\[Teach app\] (\w+)/) || [])[1];

// The lesson stream for a list of transcripts (oldest first). Forks repeat earlier messages with the same
// uuids, so those are skipped. `answers` maps question-set id → structured answers stored by the app.
export function history(sessions, { answers = {}, plan = [], predictions = {} } = {}) {
  const out = [], seen = new Set(), asks = new Map(), tools = new Map(), watches = new Set();
  sessions.forEach((s, si) => {
    const list = entries(s.path);
    let divided = false;
    for (let e of list) {
      // A message that reached the tutor mid-turn (their answers on a screen card while it was still talking) is
      // kept as a queued_command attachment, not a user entry: read it as the user turn it was.
      if (e.type === "attachment" && e.attachment?.type === "queued_command") e = queuedTurn(e);
      if (e.type !== "user" && e.type !== "assistant") continue;
      if (e.isMeta || e.isSidechain || e.isCompactSummary) continue;
      if (e.message?.model === "<synthetic>") continue;   // Claude Code's own filler, e.g. "No response requested."
      if (e.uuid) { if (seen.has(e.uuid)) continue; seen.add(e.uuid); }
      const at = e.timestamp;
      if (!divided) {
        divided = true;
        out.push({ t: "divider", id: `div-${si}`, at, session: si + 1, via: s.via || "", label: s.label || "" });
      }
      const blocks = blocksOf(e);
      if (e.type === "assistant") {
        for (const b of blocks) {
          if (b.type === "text" && clean(b.text)) out.push({ t: "text", id: `${e.uuid}-${out.length}`, text: clean(b.text), at });
          if (b.type !== "tool_use") continue;
          const name = b.name, inp = b.input || {};
          if (name === "mcp__teach__ask") {
            let ask; try { ask = shuffleAsk(normalizeAsk(inp), b.id); } catch { continue; }
            // a set still open from an earlier turn: the tutor has moved past it, so it can't be answered any more
            for (const a of asks.values()) if (a.status === "pending" && !a.legacy && a.turn !== e.message?.id) { a.status = "skipped"; a.moved = true; }
            const item = { t: "ask", id: b.id, ask, status: "pending", at, turn: e.message?.id };
            asks.set(b.id, item); out.push(item);
          } else if (name === "AskUserQuestion") {
            const ask = fromAskUserQuestion(inp);
            if (!ask) continue;
            const item = { t: "ask", id: b.id, ask, status: "pending", legacy: true, at };
            asks.set(b.id, item); out.push(item);
          } else if (name === "mcp__teach__show") {
            out.push({ t: "show", id: b.id, show: inp, at });
          } else if (name === "mcp__teach__scene") {
            let scene; try { scene = normalizeScene(inp); } catch { continue; }
            out.push({ t: "scene", id: b.id, scene, predictions: predictions[b.id] || {}, at });
          } else if (name === "mcp__teach__say") {
            if (inp.text) out.push({ t: "text", id: b.id, text: String(inp.text), said: true, at });
          } else if (name === "mcp__teach__watch") {
            const item = { t: "activity", id: b.id, label: activityLabel(name, inp), state: "done", at };
            tools.set(b.id, item); watches.add(b.id); out.push(item);
          } else if (name.startsWith("mcp__teach__")) {
            const text = chipFor(name, inp, plan);
            if (text) { const item = { t: "chip", id: b.id, text, at }; tools.set(b.id, item); out.push(item); }
          } else if (!QUIET.has(name)) {
            const item = { t: "activity", id: b.id, label: activityLabel(name, inp), state: "done", agent: name === "Agent" || name === "Task", at };
            tools.set(b.id, item); out.push(item);
          }
        }
        continue;
      }
      // user turn: tool results, the learner's words, or hidden machinery
      const texts = [], images = [];
      for (const b of blocks) {
        if (b.type === "tool_result") {
          const a = asks.get(b.tool_use_id);
          if (a) {
            if (b.is_error && a.legacy) { a.status = /interrupted|rejected|denied|skipped/i.test(resultText(b)) ? "skipped" : "skipped"; }
            else if (b.is_error) { out.splice(out.indexOf(a), 1); asks.delete(b.tool_use_id); }
            else if (a.legacy) { a.status = "answered"; a.answers = legacyAnswers(a.ask, resultText(b)); }
          } else if (watches.has(b.tool_use_id) && !b.is_error) {
            const said = saidInWatch(resultText(b));
            if (said) out.push({ t: "user", id: `${b.tool_use_id}-said`, text: said, images: [], at });
          } else if (b.is_error && tools.has(b.tool_use_id)) tools.get(b.tool_use_id).state = "error";
        } else if (b.type === "text") {
          const t = clean(b.text);
          if (!t) continue;
          if (isAnswers(t)) {
            const id = t.slice("[Answers to question set ".length).split("]")[0];
            const a = asks.get(id);
            if (a) { a.status = "answered"; a.answers = answers[id]?.answers; a.results = answers[id]?.results; continue; }
          }
          const kind = appKind(t);
          if (kind) {
            const said = t.match(/\n[^\n]{1,40}? wrote:\n([\s\S]*?)(\n\[end\]|$)/);
            if (said) texts.push(said[1].trim());
            else out.push({ t: "note", id: `${e.uuid}-n`, text: { continue: "Picked up", import: "Brought into Teach", pause: "Pausing", close: "Wrapping up", back: "Back",
              screen: t.startsWith("[Teach app] screen on") ? "On your screen" : "Back in Teach" }[kind] || "", at });
            continue;
          }
          if (t.startsWith("[Request interrupted")) { out.push({ t: "note", id: `${e.uuid}-i`, text: "Stopped", at }); continue; }
          if (hidden(t) || t.includes("<task-notification>")) continue;
          const said = t.replace(/^\/teach\b\s*/, "").replace(/^\[User attached[^\]]*\]\s*/, "")
            .replace(/\[Attached (?:image|file) "([^"]+)" is saved at: [^\]]+\]/g, "(attached: $1)");
          if (said) texts.push(said);
        } else if (b.type === "image" && b.source?.type === "base64") {
          images.push(`data:${b.source.media_type || "image/png"};base64,${b.source.data}`);
        }
      }
      if (texts.length || images.length) out.push({ t: "user", id: e.uuid || `u${out.length}`, text: texts.join("\n\n"), images, at });
    }
  });
  // The app's own record of their answers is the source of truth: a set it holds answers for is answered, however
  // (or whether) the transcript shows them arriving.
  for (const [id, a] of asks) {
    const r = answers[id];
    if (!r || a.legacy) continue;
    Object.assign(a, { status: "answered", answers: r.answers, results: r.results, via: r.via, moved: undefined });
  }
  return out;
}

function queuedTurn(e) {
  let content = e.attachment.prompt;
  if (typeof content === "string") { try { const p = JSON.parse(content); if (Array.isArray(p)) content = p; } catch { /* plain text */ } }
  return { type: "user", uuid: e.uuid || e.attachment.source_uuid, timestamp: e.attachment.timestamp || e.timestamp, message: { role: "user", content } };
}

// The question set a transcript is still waiting on (its last tool call that never got an answer), if any.
export function pendingAsk(file) {
  const list = entries(file);
  const answered = new Set();
  for (const e of list) for (const b of blocksOf(e)) if (b.type === "tool_result") answered.add(b.tool_use_id);
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e.type === "user" && blocksOf(e).some((b) => b.type === "text" && clean(b.text) && !hidden(clean(b.text)))) return null;
    if (e.type !== "assistant") continue;
    for (const b of blocksOf(e)) {
      if (b.type !== "tool_use" || answered.has(b.id)) continue;
      if (b.name === "AskUserQuestion") { const ask = fromAskUserQuestion(b.input); return ask && { id: b.id, ask, legacy: true }; }
    }
  }
  return null;
}

// A plain-text digest, for continuing a conversation that can't be resumed directly (another cwd, too old).
export function digest(files, maxChars = 60000) {
  const parts = [];
  for (const item of history(files.map((p) => ({ path: p })))) {
    if (item.t === "text") parts.push(`TUTOR: ${item.text}`);
    else if (item.t === "user" && item.text) parts.push(`LEARNER: ${item.text}`);
    else if (item.t === "ask") {
      const qs = item.ask.questions.map((q, i) => `  Q: ${q.prompt}${q.options ? `  [${q.options.join(" / ")}]` : ""}${item.answers?.[i]?.text ? `\n  A: ${item.answers[i].text}` : ""}`);
      parts.push(`TUTOR (questions${item.status === "pending" ? ", still unanswered" : ""}):\n${qs.join("\n")}`);
    }
  }
  const text = parts.join("\n\n");
  return text.length > maxChars ? "[…earlier conversation trimmed…]\n\n" + text.slice(-maxChars) : text;
}

// ---------- finding /teach sessions that ran outside the app ----------

// A log path as the session wrote it; resolved against this machine's learning folder (a session brought from
// another machine names that machine's home folder).
const LOG_RE = /"file_path":\s*"[^"]*\/learning\/((?!PROFILE)(?:topics\/[^"/]+\/log|[^"/]+)\.md)"/g;

// What the search needs from a transcript, found by streaming it in 1 MB chunks and kept per size:mtime. Some
// transcripts are hundreds of MB; reading every one whole on each home load (every minute) ran the server out
// of memory. Only a transcript that is a /teach session outside the app gets read whole, for the logs it wrote.
const MARKERS = {
  teach: ["skills/teach", "/teach<", '"skill":"teach"', "'s /teach session", "focus block now"],
  app: ["[Teach app] "],                                                     // the app's own sessions
  focus: ["We're in a focus block now"],
};
const WANT = Object.entries(MARKERS).flatMap(([k, list]) => list.map((s) => [k, Buffer.from(s)]));
const OVERLAP = Math.max(...WANT.map(([, b]) => b.length)) - 1;
const scanned = new Map();    // path → { key, teach, app, focus, logs }

export function scan(file, st) {
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = scanned.get(file);
  if (hit && hit.key === key) return hit;
  const out = { key, teach: false, app: false, focus: false, logs: [] };
  const buf = Buffer.alloc(1 << 20);
  let fd, carry = 0;
  try {
    fd = fs.openSync(file, "r");
    for (let n; (n = fs.readSync(fd, buf, carry, buf.length - carry, null)) > 0;) {
      const len = carry + n;
      const view = buf.subarray(0, len);
      for (const [k, b] of WANT) if (!out[k] && view.includes(b)) out[k] = true;
      carry = Math.min(OVERLAP, len);
      buf.copyWithin(0, len - carry, len);
    }
  } catch { /* gone or unreadable: counts as not a /teach session */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  if (out.teach && !out.app) {
    try { out.logs = [...fs.readFileSync(file, "utf8").matchAll(LOG_RE)].map((m) => m[1]); } catch { /* gone */ }
  }
  scanned.set(file, out);
  return out;
}

function t3Threads() {
  const map = new Map();
  try {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const db = new DatabaseSync(T3_DB, { readOnly: true });
    const rows = db.prepare("select t.thread_id as id, t.title as title, t.deleted_at as deleted, r.resume_cursor_json as cur from projection_threads t join provider_session_runtime r on r.thread_id = t.thread_id").all();
    for (const r of rows) {
      try { const sid = JSON.parse(r.cur || "{}").resume; if (sid && !r.deleted) map.set(sid, { thread: r.id, title: r.title }); } catch { /* bad cursor */ }
    }
    db.close();
  } catch { /* T3 not installed on this machine, or the schema moved */ }
  return map;
}

function isTeach(list) {
  for (const e of list) {
    for (const b of blocksOf(e)) {
      if (b.type === "tool_use" && b.name === "Skill" && b.input?.skill === "teach") return true;
      if (b.type === "text" && e.type === "user") {
        const t = String(b.text || "");
        if (t.includes("<command-name>/teach</command-name>") || t.startsWith("Base directory for this skill: ") && t.includes("/skills/teach")
          || /^Resume [^\n]{1,60}? \/teach session/.test(t) || t.startsWith("We're in a focus block now")) return true;
      }
    }
  }
  return false;
}

const firstUserText = (list) => {
  for (const e of list) {
    if (e.type !== "user" || e.isMeta) continue;
    for (const b of blocksOf(e)) {
      const t = b.type === "text" ? clean(b.text).replace(/\[(?:Attached (?:image|file) "[^"]*" is saved at: |User attached)[^\]]*\]/g, "").trim() : "";
      if (t && !hidden(t)) return t.replace(/^\/teach\b\s*/, "").split("\n")[0];
    }
  }
  return "";
};

// Every /teach conversation on this machine not yet linked to a topic, grouped by the log it wrote.
export function findSessions({ linked = new Set(), days = 30 } = {}) {
  const cutoff = Date.now() - days * 86400e3;
  const threads = t3Threads();
  const brought = (() => { try { return JSON.parse(fs.readFileSync(path.join(STATE, "brought.json"), "utf8")); } catch { return {}; } })();
  const groups = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS).filter((d) => !d.startsWith("-tmp")); } catch { return []; }
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(PROJECTS, d)).filter((n) => n.endsWith(".jsonl")); } catch { continue; }
    for (const name of names) {
      const file = path.join(PROJECTS, d, name), id = name.slice(0, -6);
      if (linked.has(id)) continue;
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      const mk = scan(file, st);
      if (!mk.teach || mk.app) continue;
      const list = entries(file);
      if (!isTeach(list)) continue;
      const cwd = list.find((e) => e.cwd)?.cwd || "";
      const logs = mk.logs.map((rel) => path.join(LEARNING, rel)).filter((p) => fs.existsSync(p));
      const log = logs.at(-1) || null;
      const meta = brought[id];
      const t3 = threads.get(id) || (meta?.thread ? { thread: meta.thread, title: meta.threadTitle } : null);
      const via = meta?.via || (t3 ? "t3" : d.includes("focus") || mk.focus ? "focus" : "terminal");
      const key = log || file;
      const g = groups.get(key) || { key, log, sessions: [], mtime: 0 };
      g.sessions.push({ id, path: file, cwd, via, mtime: st.mtimeMs, thread: t3?.thread, threadTitle: t3?.title, first: firstUserText(list) });
      g.mtime = Math.max(g.mtime, st.mtimeMs);
      groups.set(key, g);
    }
  }
  const out = [];
  for (const g of groups.values()) {
    g.sessions.sort((a, b) => a.mtime - b.mtime);
    const newest = g.sessions.at(-1);
    const h1 = g.log && (fs.readFileSync(g.log, "utf8").match(/^# (.+)$/m) || [])[1];
    const all = g.sessions.flatMap((s) => entries(s.path));
    // What the tutor was asked to teach (the Skill call's args) names a session better than a chat's first line.
    const args = all.flatMap((e) => blocksOf(e)).find((b) => b.type === "tool_use" && b.name === "Skill" && b.input?.skill === "teach" && b.input.args)?.input.args;
    const fromArgs = args && clean(args).split(/\s\(|\.\s|;|\n/)[0].slice(0, 80);
    const thread = newest.threadTitle?.replace(/^[$/]teach\s*/, "");
    g.title = (h1 || fromArgs || (thread && !thread.endsWith("...") ? thread : "") || g.sessions[0].first || thread || "Untitled /teach session").slice(0, 90);
    let asked = 0, answered = 0;
    const done = new Set(all.flatMap((e) => blocksOf(e).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id)));
    for (const e of all) for (const b of blocksOf(e)) if (b.type === "tool_use" && b.name === "AskUserQuestion") { asked++; if (done.has(b.id)) answered++; }
    g.summary = { questionSets: asked, answered, pending: !!pendingAsk(newest.path), hasLog: !!g.log };
    g.live = Date.now() - g.mtime < 15 * 60e3;
    out.push(g);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export const sessionFile = (s) => s.path || path.join(PROJECTS, (s.cwd || WORK).replace(/[^a-zA-Z0-9]/g, "-"), `${s.id}.jsonl`);
export const learningRel = (p) => path.relative(LEARNING, p);
