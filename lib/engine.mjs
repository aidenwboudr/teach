// One tutor process per topic being taught, on the AI service this install uses (lib/providers/: Claude Code by
// default, or Codex, Gemini CLI or a local model), with the `teach` MCP server attached. It speaks Claude Code's
// stream-json (the other CLIs are translated into it): its stdout becomes lesson events (streamed text, question
// cards, figures, progress chips, quiet activity lines); the learner's messages and answers go to its stdin. A process
// that sits idle is closed, and the next message resumes the same session, so nothing is lost.
import fs from "node:fs";
import path from "node:path";
import { APP, WORK, LEARNING, PROFILE, FOCUS_STATE, STATE, PROJECTS, ACCESS, SYNC, LEARNER, SOCKET, PORT, HOME, transcriptPath, projectDir } from "./paths.mjs";
import { processCommandLine, inside as insidePath } from "./platform.mjs";
import { PROVIDER, PROVIDERS, SAFE_TOOLS, transcriptFile } from "./providers/index.mjs";
import { getTopic, mutateTopic, topicDir, readJSON, now } from "./store.mjs";
import { normalizeAsk, normalizeShow, normalizeScene, shuffleAsk } from "./ops.mjs";
import { activityLabel, chipFor, clean } from "./transcript.mjs";
import { CHALK_MCP, installed as chalkInstalled, OFF_SCREEN } from "./screen.mjs";
import { available as stageReady } from "./stage.mjs";

const IDLE_MS = 20 * 60e3;
const RESUME_WINDOW_MS = 36 * 3600e3;      // continue the same Claude session within this; after it, start fresh
const FORK_WINDOW_MS = 7 * 86400e3;        // a session from T3/focus is forked (full context) if it's this recent
const WRITES = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

// What a restricted tutor may touch. Writes: only the learning folder. Reads: the learning and work folders, the app
// (its skill), this machine's Teach state (uploads), the work folder's Claude Code project (where Claude Code keeps
// long tool output) and Claude Code's skills and plugins; `reads: null` means anywhere (a focus block on a full-access
// install keeps that: there it's a guard against wandering off, not a security boundary).
export function policyFor({ access = ACCESS, focus = false } = {}) {
  if (access === "full" && !focus) return null;
  const reads = access === "full" ? null
    : [LEARNING, WORK, APP, STATE, projectDir(WORK), path.join(HOME, ".claude", "skills"), path.join(HOME, ".claude", "plugins")];
  return { write: LEARNING, reads };
}

const inside = (file, root) => insidePath(file, root, WORK);

// The answer to one of Claude Code's permission requests under a policy: { behavior: "allow" } or a denial.
export function permit(policy, name, inp = {}) {
  const deny = (message) => ({ behavior: "deny", message });
  if (!SAFE_TOOLS.some((t) => name === t || name.startsWith(t + "__")) && !WRITES.includes(name)) return deny(`${name} isn't available to the tutor here (no shell; TEACH_ACCESS=full gives one).`);
  if (WRITES.includes(name)) {
    const f = inp.file_path || inp.notebook_path;
    return f && inside(f, policy.write) ? { behavior: "allow" } : deny(`The tutor can only write in ${policy.write} here.`);
  }
  const target = name === "Read" ? inp.file_path : ["Glob", "Grep"].includes(name) ? inp.path : null;
  if (target && policy.reads && !policy.reads.some((r) => inside(target, r))) return deny(`The tutor can only read the learning and work folders here (${LEARNING}, ${WORK}).`);
  return { behavior: "allow" };
}

// A focus block: reported by a focus tool with `teach focus` (from any machine), or read from its state file
// on this one (TEACH_FOCUS_STATE).
export function focusBlock() {
  const r = readJSON(path.join(STATE, "focus.json"), null);
  if (r && r.until * 1000 > Date.now()) return r;
  const s = FOCUS_STATE ? readJSON(FOCUS_STATE, null) : null;
  return s && ["active", "verifying"].includes(s.phase) ? s : null;
}

const SCREEN_GATE = "screen-gate";

// The screen-mode playbook ships with the tools it describes, so a tutor never runs one without the other.
const SCREEN_GUIDE = fs.readFileSync(path.join(APP, "screen.md"), "utf8").replace(/^# .*\n+/, "");

// What a tutor with the screen tools is told, the same whether the lesson is on the screen or the board right now (the
// system prompt stays the same across a switch, so a switch costs no restart and keeps the prompt cache).
const SCREEN_PROMPT = `Screen tools: chalk is installed, so a lesson can happen on ${LEARNER}'s actual screen: you see it (screen_look), mark it (screen_draw, screen_clear), speak out loud (say) and wait for them to do each step (watch). ` +
  `They work only while the lesson is on their screen: when ${LEARNER} turned "On my screen" on, or after you moved it there yourself with the teach tool "screen" (see "Moving a step onto their screen" in the guide). ` +
  `Otherwise the lesson is on the Teach board and those tools refuse. The app tells you when the mode changes ("[Teach app] screen" notes and the screen tool's result). How:\n\n${SCREEN_GUIDE}`;

export function appPrompt(topic, focus, screenTools, P = PROVIDER) {
  const dir = topicDir(topic.slug);
  return [
    `You are the tutor in the Teach app (a local web interface, not a chat window), teaching the topic "${topic.title}" to ${LEARNER}.`,
    P.id === "claude" ? `Every session here is a /teach session: load the teach skill (Skill tool, skill "teach") before anything else and follow it, including its "In the Teach app" section.`
      : `Every session here is a /teach session: follow the teach skill (included below), including its "In the Teach app" section.`,
    `Topic folder: ${dir} (topic.json is the app's structured state — change it only through the teach tools; log.md is your narrative log; deck.json and sheet.md are review material; figures/ is for diagrams; files/ holds what the learner attached).`,
    `Learner profile: ${PROFILE}. Working directory: ${WORK} (the learner's files).`,
    `The app renders Markdown with LaTeX math ($…$ inline, $$…$$ display) and images (![caption](/abs/path.png)). Write math as LaTeX here; the show-math skill and html_render don't exist in this interface.`,
    `Questions go through the teach tool "ask" (never AskUserQuestion), and after calling it you end your turn.`,
    `The lesson page is a board, not a chat. A card on top shows the current plan step; your latest reply shows over the learner's composer, and only until their next move: each turn replaces it, and nothing scrolls back. ` +
      `Everything they need for longer goes on the board as a block: explanations, worked examples, tables, formulas, a diagram's key, their pin map so far as a note (the "board" tool: add or replace notes by id, pin, remove), question sets ("ask"), figures ("show")` +
      (stageReady() ? `, live scenes ("scene")` : "") + `. Keep reply text short and conversational (a reaction, a nudge, what to look at), and put the substance in notes. ` +
      `You tidy the board: replace a note instead of adding a near-copy, remove what no longer helps, pin what should stay across steps. Two things happen by themselves: when a step becomes current, blocks from earlier turns leave unless pinned; an answered question set leaves once the learner moves on after your reaction. ` +
      `You also decide what's in view and how it's arranged: by default what you put up or changed in your latest turn is in view (the newest scene or figure gets the room, the rest beside it) and older blocks fold onto a shelf of one-line chips. ` +
      `When that isn't right, set the board tool's layout: one block given the room (focus), a main block with what it needs beside it (focus-aside), two things side by side (compare), a stack, or your own rows; anything you don't show folds onto the shelf. ` +
      `Show only what helps right now: usually the one thing they're working on, plus a reference only if they'll use it for this. The learner may be in focus mode (just the board, full screen).`,
    stageReady() && `When the topic has no app of its own to work in (a physics idea, a circuit, a proof), make a scene the learner's workspace: an interactive scene with the "scene" tool (sliders, steps, live plots), with "predict" gates so they commit a guess before each reveal. Prefer a scene over a static figure whenever moving something would show the idea.`,
    `Messages that start with "[Teach app]" come from the app, not from the learner; "[Answers to question set …]" messages are the learner's submitted answers.`,
    SYNC === "git-pr" ? `Don't run git or open PRs; the app syncs the learning folder itself.` : "",
    focus ? `The learner is in a focus block right now (goal: "${focus.goal}"). There is no shell; stay on the material.`
      : ACCESS !== "full" ? `This app runs tutors without a shell: you read the learning and work folders, search the web, write only in the learning folder, and check a drawn SVG with the teach tool "render" (not render-svg.sh).` : "",
    screenTools && P.can.screen ? SCREEN_PROMPT : "",
  ].filter(Boolean).join("\n");
}

// Each tutor's pid, so a server that died without closing them (a crash) can stop them when it comes back. They
// outlive it: a TEACH_CLAUDE wrapper may run each in its own systemd scope, and a screen-mode tutor busy watching and
// speaking never reads the stdin that closed, so it went on narrating next to the new server's tutor.
// A pid file holds the pid and a piece of that process's command line that names the topic (each provider's own:
// Claude Code's MCP config JSON, Codex's TOML one, Gemini's policy file); an older one holds just a Claude Code pid.
// A turn-based CLI (Codex, Gemini) rewrites it for each turn's process.
const PIDS = path.join(STATE, "tutors");
const pidFile = (slug) => path.join(PIDS, `${slug}.pid`);

function reap(slug) {
  let rec;
  try {
    const text = fs.readFileSync(pidFile(slug), "utf8");
    rec = /^\d+$/.test(text.trim()) ? { pid: Number(text), mark: PROVIDERS.claude.marker(slug) } : JSON.parse(text);
  } catch { fs.rmSync(pidFile(slug), { force: true }); return; }
  try {   // only if that pid is still this topic's tutor, not a pid reused since
    if (rec.pid && rec.mark && processCommandLine(rec.pid)?.includes(rec.mark)) process.kill(rec.pid, "SIGTERM");
  } catch { /* already gone */ }
  fs.rmSync(pidFile(slug), { force: true });
}

function track(slug, pid, P) {
  fs.mkdirSync(PIDS, { recursive: true });
  fs.writeFileSync(pidFile(slug), JSON.stringify({ pid, mark: P.marker(slug), provider: P.id }));
}

export class Engine {
  constructor(emit, P = PROVIDER) {
    this.emit = emit;                // (slug, event) → void
    this.P = P;                      // the AI service tutors run on (lib/providers/)
    this.live = new Map();           // slug → Live
    let left = [];
    try { left = fs.readdirSync(PIDS).filter((n) => n.endsWith(".pid")); } catch { /* none yet */ }
    for (const n of left) reap(n.slice(0, -4));
  }

  get(slug) { return this.live.get(slug); }
  // Is the lesson on the learner's screen right now (their switch, or a stretch the tutor started)? The server says.
  onScreen(slug) { return this.isLive ? this.isLive(slug) : !!getTopic(slug)?.settings.screen; }
  isAlive(slug) { const l = this.live.get(slug); return !!(l && l.proc && l.proc.exitCode === null); }
  status(slug) {
    const l = this.live.get(slug);
    return { alive: this.isAlive(slug), busy: !!l?.busy, streaming: l?.streaming || null, agents: l ? [...l.agents.values()] : [],
      watching: l?.watching ? l.watching.expect || "" : null, screen: this.onScreen(slug) };
  }

  // How the next process for this topic should start. A session only resumes on the provider it ran on; one from
  // another provider (the install switched) or from a chat elsewhere that only Claude Code can fork starts fresh.
  plan(slug, { fresh = false } = {}) {
    const topic = getTopic(slug);
    const last = topic.sessions.at(-1);
    if (fresh || !last) return { mode: "new" };
    if ((last.provider || "claude") !== this.P.id) return { mode: "new", reason: "provider" };
    const file = last.transcript || (last.project ? path.join(PROJECTS, last.project, `${last.id}.jsonl`) : transcriptPath(last.cwd || WORK, last.id));
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return { mode: "new", reason: "transcript missing" }; }
    const age = Date.now() - mtime;
    if (last.via === "app") return age < RESUME_WINDOW_MS && (last.cwd || WORK) === WORK && !last.fresh ? { mode: "resume", id: last.id } : { mode: "new", reason: "old" };
    if ((last.cwd || "") === WORK && age < FORK_WINDOW_MS && this.P.can.fork) return { mode: "fork", id: last.id };
    return { mode: "new", reason: "elsewhere" };
  }

  start(slug, how) {
    const P = this.P, topic = getTopic(slug);
    const focus = focusBlock();
    const policy = policyFor({ focus: !!focus }), restricted = !!policy;
    // the screen tools come whenever chalk is here (Claude Code only): whether they work right now is the screen gate's call (below)
    const screen = (chalkInstalled() || !!topic.settings.screen) && P.can.screen;
    const mcpEnv = { TEACH_TOPIC: slug, TEACH_DATA: LEARNING, TEACH_STATE: STATE, TEACH_SCREEN: screen ? "1" : "0", TEACH_LEARNER: LEARNER,
      TEACH_SERVER: SOCKET || `http://127.0.0.1:${PORT}`,   // the tools read the board back from the server
      ...(process.env.TEACH_CHALK ? { TEACH_CHALK: process.env.TEACH_CHALK } : {}),
      ...(process.env.TEACH_SCENEHOST ? { TEACH_SCENEHOST: process.env.TEACH_SCENEHOST } : {}),
      // A restricted tutor on a CLI without Claude Code's permission checks reads and writes through the teach tools,
      // which apply the same policy (Gemini keeps its own reads, which it limits to the workspace itself).
      ...(restricted && P.id !== "claude" ? { TEACH_FILES: JSON.stringify({ tools: P.id === "gemini" ? "write" : "all", write: policy.write, reads: policy.reads, base: WORK }) } : {}) };
    const chalk = screen ? { command: CHALK_MCP, args: [], env: process.env.CHALK_REMOTE_BIN ? { CHALK_REMOTE_BIN: process.env.CHALK_REMOTE_BIN } : {} } : null;
    fs.mkdirSync(STATE, { recursive: true });
    reap(slug);
    const proc = P.spawn({ slug, topic, how, policy, focus, screen, chalk, mcpEnv, learner: LEARNER,
      prompt: appPrompt(topic, focus, screen, P), model: topic.settings.model, effort: topic.settings.effort || "high",
      log: path.join(STATE, `${P.id === "local" ? "codex" : P.id}.log`), onPid: (pid) => track(slug, pid, P) });
    if (proc.pid) track(slug, proc.pid, P);
    const l = { slug, proc, busy: false, buf: "", streaming: null, textCount: new Map(), tools: new Map(), agents: new Map(), focus: restricted, policy, screen, watching: null, sessionId: null, idle: null, how };
    this.live.set(slug, l);
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d) => {
      l.buf += d;
      let i;
      while ((i = l.buf.indexOf("\n")) >= 0) {
        const line = l.buf.slice(0, i); l.buf = l.buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        try { this.onMessage(l, msg); } catch (e) { console.error("teach: bad event", e); }
      }
    });
    proc.on("exit", (code) => {
      if (this.live.get(slug) === l) this.live.delete(slug);
      try { if (JSON.parse(fs.readFileSync(pidFile(slug), "utf8")).pid === proc.pid) fs.rmSync(pidFile(slug)); } catch { /* none */ }
      clearTimeout(l.idle);
      if (l.busy) this.emit(slug, { t: "error", text: `The tutor stopped unexpectedly (exit ${code}). Send a message to pick up again.` });
      this.emit(slug, { t: "state", ...this.status(slug) });
      this.onExit?.(slug, l);
    });
    proc.stdin.on("error", () => {});
    // chalk's own tools (screen_look/draw/clear) come from chalk's MCP server, so the screen gate runs here, as a
    // PreToolUse hook: while the lesson is on the board they're refused with a word on how to move it to the screen
    const hooks = screen ? { PreToolUse: [{ matcher: "mcp__chalk__.*", hookCallbackIds: [SCREEN_GATE] }] } : null;
    this.write(l, { type: "control_request", request_id: `init-${Date.now()}`, request: { subtype: "initialize", hooks } });
    this.emit(slug, { t: "state", ...this.status(slug) });
    return l;
  }

  write(l, obj) {
    try { l.proc.stdin.write(JSON.stringify(obj) + "\n"); return true; } catch { return false; }
  }

  // Send a user turn. `content` is Anthropic content blocks; `opts.how` starts the process if needed.
  send(slug, content, opts = {}) {
    let l = this.live.get(slug);
    if (!l || l.proc.exitCode !== null) l = this.start(slug, opts.how || this.plan(slug));
    // (a message sent mid-turn joins the turn it lands in; screen: whether the turn started on the learner's screen)
    if (!l.busy) l.turn = { said: 0, replied: 0, screen: this.onScreen(slug) };
    l.busy = true;
    l.output = false;
    clearTimeout(l.idle);
    this.emit(slug, { t: "state", ...this.status(slug) });
    return this.write(l, { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "default" });
  }

  interrupt(slug) {
    const l = this.live.get(slug);
    if (l) this.write(l, { type: "control_request", request_id: `stop-${Date.now()}`, request: { subtype: "interrupt" } });
  }

  close(slug) {
    const l = this.live.get(slug);
    if (!l) return;
    try { l.proc.stdin.end(); } catch { /* gone */ }
    setTimeout(() => { if (l.proc.exitCode === null) l.proc.kill("SIGTERM"); }, 8000).unref();
  }

  closeAll() { for (const slug of this.live.keys()) this.close(slug); }

  armIdle(l) {
    clearTimeout(l.idle);
    l.idle = setTimeout(() => { if (!l.busy && ![...l.agents.values()].some((a) => a.state === "running")) this.close(l.slug); else this.armIdle(l); }, IDLE_MS);
    l.idle.unref();
  }

  // ---------- stream-json → lesson events ----------

  onMessage(l, msg) {
    const slug = l.slug, emit = (ev) => this.emit(slug, { at: now(), ...ev });
    if (msg.type === "control_request") return msg.request?.subtype === "hook_callback" ? this.hook(l, msg) : this.permission(l, msg);
    if (msg.type === "system" && msg.subtype === "init") {
      l.sessionId = msg.session_id;
      mutateTopic(slug, (t) => {
        if (!t.sessions.some((s) => s.id === msg.session_id)) t.sessions.push({ id: msg.session_id, cwd: WORK, via: "app", started: now(), from: l.how.mode === "fork" ? l.how.id : undefined,
          ...(this.P.id !== "claude" ? { provider: this.P.id, transcript: transcriptFile(msg.session_id) } : {}) });
      });
      return;
    }
    if (msg.type === "stream_event" || msg.type === "assistant") l.output = true;
    if (msg.type === "stream_event") {
      const e = msg.event, mid = l.currentMsg;
      if (e.type === "message_start") { l.currentMsg = e.message.id; return; }
      if (e.type === "content_block_start" && e.content_block?.type === "text") {
        const k = (l.textCount.get(mid) || 0);
        l.streaming = { id: `${mid}:${k}`, text: "" };
        emit({ t: "text", id: l.streaming.id, text: "", streaming: true });
      } else if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && l.streaming) {
        l.streaming.text += e.delta.text;
        emit({ t: "delta", id: l.streaming.id, text: e.delta.text });
      } else if (e.type === "content_block_start" && e.content_block?.type === "thinking") {
        emit({ t: "thinking" });
      }
      return;
    }
    if (msg.type === "assistant") {
      const mid = msg.message.id;
      for (const b of msg.message.content || []) {
        if (b.type === "text") {
          const k = l.textCount.get(mid) || 0;
          l.textCount.set(mid, k + 1);
          l.streaming = null;
          if (clean(b.text) && l.turn) l.turn.replied++;
          emit({ t: "text", id: `${mid}:${k}`, text: clean(b.text), final: true });
        } else if (b.type === "tool_use") this.onToolUse(l, b, emit);
      }
      return;
    }
    if (msg.type === "user") {
      for (const b of Array.isArray(msg.message?.content) ? msg.message.content : []) {
        if (b.type === "tool_result") this.onToolResult(l, b, emit);
        if (b.type === "text" && b.text?.includes("<task-notification>")) this.onNotification(l, b.text, emit);
      }
      return;
    }
    if (msg.type === "result") {
      // Resuming a session that stopped mid-turn (say, on an unanswered question) first closes that old turn
      // with an empty result, before our message is even read. That one isn't the end of our turn.
      if (!l.output && !msg.is_error && !msg.result) return;
      l.busy = false;
      l.streaming = null;
      l.watching = null;
      // A screen lesson whose turn answered the learner (text or a card) without a word spoken: it drifted into the Teach
      // window, the way a tutor that saw its narration repeat went quiet for two hours on 2026-11-04.
      // (only for a turn that was on the screen from its start: one that moved there midway may have replied in text first)
      l.quiet = !!l.turn?.screen && this.onScreen(slug) && !!l.turn.replied && !l.turn.said;
      for (const [id, a] of l.tools) if (a.state === "running" && !a.background) { a.state = "done"; emit({ t: "activity", ...a, id }); }
      emit({ t: "idle", cost: msg.total_cost_usd, error: msg.is_error && msg.subtype !== "error_during_execution" ? (msg.result || msg.subtype) : undefined });
      emit({ t: "state", ...this.status(slug) });
      this.armIdle(l);
      this.onTurnEnd?.(slug, l);
    }
  }

  onToolUse(l, b, emit) {
    const name = b.name, inp = b.input || {};
    if (["mcp__teach__ask", "mcp__teach__scene", "mcp__teach__board"].includes(name) && l.turn) l.turn.replied++;
    if (name === "mcp__teach__scene") {   // a scene: a block on the board
      try { emit({ t: "scene", id: b.id, scene: normalizeScene(inp) }); } catch { /* the tool reports the error to the tutor */ }
      return;
    }
    if (name === "mcp__teach__say" && l.turn) l.turn.said++;
    if (name === "mcp__teach__board") { emit({ t: "board-op", id: b.id, op: inp }); return; }   // the server applies it (lib/board.mjs)
    if (name === "mcp__teach__plan") for (const n of inp.nodes || []) (l.planned ||= new Set()).add(String(n.id));   // (it runs after the stream shows it)
    if (name === "mcp__teach__step" && inp.status === "current" && (getTopic(l.slug)?.plan.some((n) => n.id === String(inp.id)) || l.planned?.has(String(inp.id)))) emit({ t: "step", id: b.id, step: String(inp.id) });
    if (name === "mcp__teach__ask") {
      try { emit({ t: "ask", id: b.id, ask: shuffleAsk(normalizeAsk(inp), b.id), status: "pending" }); } catch { /* the tool reports the error to the tutor */ }
      return;
    }
    if (name === "mcp__teach__show") {
      l.tools.set(b.id, { kind: "show", inp });
      return;
    }
    if (name === "mcp__teach__say") {     // the spoken line also reads as the tutor's text in the lesson
      if (inp.text) emit({ t: "text", id: b.id, text: String(inp.text), final: true, said: true });
      return;
    }
    if (name === "mcp__teach__watch") {
      const a = { label: activityLabel(name, inp), state: "running", kind: "watch" };
      l.tools.set(b.id, a);
      l.watching = { id: b.id, expect: String(inp.expect || "") };
      emit({ t: "activity", id: b.id, ...a });
      emit({ t: "state", ...this.status(l.slug) });
      return;
    }
    if (name === "mcp__teach__review") {   // review cards on the screen: a running line until the learner is through them
      const a = { label: "Review cards on your screen", state: "running" };
      l.tools.set(b.id, a);
      emit({ t: "activity", id: b.id, ...a });
      return;
    }
    if (name.startsWith("mcp__teach__")) { l.tools.set(b.id, { kind: "teach", name, inp }); return; }
    if (["TodoWrite", "ToolSearch", "TaskOutput"].includes(name)) return;
    const agent = name === "Agent" || name === "Task";
    const a = { label: activityLabel(name, inp), state: "running", agent, background: agent && inp.run_in_background !== false };
    l.tools.set(b.id, a);
    if (agent) l.agents.set(b.id, { id: b.id, label: a.label, state: "running" });
    emit({ t: "activity", id: b.id, ...a });
  }

  onToolResult(l, b, emit) {
    const a = l.tools.get(b.tool_use_id);
    const text = typeof b.content === "string" ? b.content : (b.content || []).map((x) => x.text || "").join(" ");
    if (!a) {
      if (b.is_error) emit({ t: "remove", id: b.tool_use_id });         // an ask the tool rejected
      return;
    }
    if (a.kind === "show") {
      if (!b.is_error) try { emit({ t: "show", id: b.tool_use_id, show: normalizeShow(l.slug, a.inp) }); } catch { /* reported to the tutor */ }
      return;
    }
    if (a.kind === "watch") {
      if (l.watching?.id === b.tool_use_id) l.watching = null;
      a.state = b.is_error ? "error" : "done";
      emit({ t: "activity", id: b.tool_use_id, ...a });     // (their words already showed when they were sent)
      emit({ t: "state", ...this.status(l.slug) });
      return;
    }
    if (a.kind === "teach") {
      if (b.is_error) return;
      const chip = chipFor(a.name, a.inp, getTopic(l.slug)?.plan || []);
      if (chip) emit({ t: "chip", id: b.tool_use_id, text: chip });
      emit({ t: "topic" });
      return;
    }
    if (a.background && /launched|running in the background|agentId/i.test(text) && !b.is_error) return;   // finishes later
    a.state = b.is_error ? "error" : "done";
    if (a.agent) l.agents.set(b.tool_use_id, { id: b.tool_use_id, label: a.label, state: a.state });
    emit({ t: "activity", id: b.tool_use_id, ...a });
  }

  onNotification(l, text, emit) {
    const id = (text.match(/<tool-use-id>([^<]+)<\/tool-use-id>/) || [])[1];
    const status = (text.match(/<status>([^<]+)<\/status>/) || [])[1] || "completed";
    const a = id && l.tools.get(id);
    if (!a) return;
    a.state = status === "completed" ? "done" : "error";
    l.agents.set(id, { id, label: a.label, state: a.state });
    emit({ t: "activity", id, ...a });
    emit({ t: "state", ...this.status(l.slug) });
  }

  // Claude Code asks before each chalk tool call (the PreToolUse hook set at initialize): allowed while the lesson is on
  // the learner's screen, refused with how to get there while it's on the board.
  hook(l, msg) {
    const req = msg.request || {}, rid = msg.request_id;
    const allow = req.callback_id !== SCREEN_GATE || this.onScreen(l.slug);
    const response = allow ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: OFF_SCREEN } };
    this.write(l, { type: "control_response", response: { subtype: "success", request_id: rid, response } });
  }

  // Only asked without bypass (restricted access, or a focus block): see permit().
  permission(l, msg) {
    const req = msg.request || {}, rid = msg.request_id;
    const respond = (response) => this.write(l, { type: "control_response", response: { subtype: "success", request_id: rid, response } });
    if (req.subtype !== "can_use_tool") return this.write(l, { type: "control_response", response: { subtype: "error", request_id: rid, error: "not supported" } });
    const inp = req.input || {}, r = permit(l.policy || policyFor({ focus: true }), req.tool_name, inp);
    respond(r.behavior === "allow" ? { behavior: "allow", updatedInput: inp } : r);
  }
}
