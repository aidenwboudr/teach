// One Claude Code process per topic being taught: `claude -p` speaking stream-json, with the `teach` MCP
// server attached. Its stdout becomes lesson events (streamed text, question cards, figures, progress chips,
// quiet activity lines); the learner's messages and answers go to its stdin. A process that sits idle is closed,
// and the next message resumes the same Claude session, so nothing is lost.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { APP, CLAUDE, WORK, LEARNING, PROFILE, FOCUS_STATE, STATE, PROJECTS, SAFE, SYNC, LEARNER, SOCKET, PORT, transcriptPath } from "./paths.mjs";
import { getTopic, mutateTopic, topicDir, readJSON, now } from "./store.mjs";
import { normalizeAsk, normalizeShow, normalizeScene, shuffleAsk } from "./ops.mjs";
import { activityLabel, chipFor, clean } from "./transcript.mjs";
import { CHALK_MCP } from "./screen.mjs";
import { available as stageReady } from "./stage.mjs";

const IDLE_MS = 20 * 60e3;
const RESUME_WINDOW_MS = 36 * 3600e3;      // continue the same Claude session within this; after it, start fresh
const FORK_WINDOW_MS = 7 * 86400e3;        // a session from T3/focus is forked (full context) if it's this recent
const FOCUS_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Agent", "Skill", "TodoWrite", "Edit", "Write", "mcp__teach", "mcp__chalk"];

// A focus block: reported by a focus tool with `teach focus` (from any machine), or read from its state file
// on this one (TEACH_FOCUS_STATE).
export function focusBlock() {
  const r = readJSON(path.join(STATE, "focus.json"), null);
  if (r && r.until * 1000 > Date.now()) return r;
  const s = FOCUS_STATE ? readJSON(FOCUS_STATE, null) : null;
  return s && ["active", "verifying"].includes(s.phase) ? s : null;
}

const MODELS = { opus: "opus", sonnet: "sonnet", fable: "fable", haiku: "haiku" };
// The screen-mode playbook ships with the tools it describes, so a tutor never runs one without the other.
const SCREEN_GUIDE = fs.readFileSync(path.join(APP, "screen.md"), "utf8").replace(/^# .*\n+/, "");

function appPrompt(topic, focus) {
  const dir = topicDir(topic.slug);
  return [
    `You are the tutor in the Teach app (a local web interface, not a chat window), teaching the topic "${topic.title}" to ${LEARNER}.`,
    `Every session here is a /teach session: load the teach skill (Skill tool, skill "teach") before anything else and follow it, including its "In the Teach app" section.`,
    `Topic folder: ${dir} (topic.json is the app's structured state — change it only through the teach tools; log.md is your narrative log; deck.json and sheet.md are review material; figures/ is for diagrams; files/ holds what the learner attached).`,
    `Learner profile: ${PROFILE}. Working directory: ${WORK} (the learner's files).`,
    `The app renders Markdown with LaTeX math ($…$ inline, $$…$$ display) and images (![caption](/abs/path.png)). Write math as LaTeX here; the show-math skill and html_render don't exist in this interface.`,
    `Questions go through the teach tool "ask" (never AskUserQuestion), and after calling it you end your turn.`,
    `The lesson page is a board, not a chat. A card on top shows the current plan step; your latest reply shows over the learner's composer, and only until their next move: each turn replaces it, and nothing scrolls back. ` +
      `Everything they need for longer goes on the board as a block: explanations, worked examples, tables, formulas, a diagram's key, their pin map so far as a note (the "board" tool: add or replace notes by id, pin, remove), question sets ("ask"), figures ("show")` +
      (stageReady() ? `, live scenes ("scene")` : "") + `. Keep reply text short and conversational (a reaction, a nudge, what to look at), and put the substance in notes. ` +
      `You tidy the board: replace a note instead of adding a near-copy, remove what no longer helps, pin what should stay across steps. Two things happen by themselves: when a step becomes current, blocks from earlier turns leave unless pinned; an answered question set leaves once the learner moves on after your reaction.`,
    stageReady() && `When the topic has no app of its own to work in (a physics idea, a circuit, a proof), make a scene the learner's workspace: an interactive scene with the "scene" tool (sliders, steps, live plots), with "predict" gates so they commit a guess before each reveal. Prefer a scene over a static figure whenever moving something would show the idea.`,
    `Messages that start with "[Teach app]" come from the app, not from the learner; "[Answers to question set …]" messages are the learner's submitted answers.`,
    SYNC === "git-pr" ? `Don't run git or open PRs; the app syncs the learning folder itself.` : "",
    focus ? `The learner is in a focus block right now (goal: "${focus.goal}"). There is no shell; stay on the material.`
      : SAFE ? `This app runs tutors without a shell: you can read, search the web, and write only in the learning folder.` : "",
    topic.settings.screen ? `Screen mode is ON: the learner is at their computer and the lesson happens on their actual screen. You see it (screen_look), mark it (screen_draw, screen_clear), speak to them out loud (say) and wait for them to do each step (watch). How:\n\n${SCREEN_GUIDE}` : "",
  ].filter(Boolean).join("\n");
}

function cleanEnv() {
  const env = { ...process.env, FOCUS_ALLOWED_CLAUDE: "1" };
  for (const k of Object.keys(env)) if (/^CLAUDE_CODE_(SESSION|ENTRYPOINT|CHILD|MESSAGING|EXECPATH)|^CLAUDECODE$|^CLAUDE_AGENT_SDK|^CLAUDE_PID$|^CLAUDE_EFFORT$/.test(k)) delete env[k];
  return env;
}

// Each tutor's pid, so a server that died without closing them (a crash) can stop them when it comes back. They
// outlive it: a TEACH_CLAUDE wrapper may run each in its own systemd scope, and a screen-mode tutor busy watching and
// speaking never reads the stdin that closed, so it went on narrating next to the new server's tutor.
const PIDS = path.join(STATE, "tutors");
const pidFile = (slug) => path.join(PIDS, `${slug}.pid`);

function reap(slug) {
  let pid;
  try { pid = Number(fs.readFileSync(pidFile(slug), "utf8")); } catch { return; }
  try {   // only if that pid is still this topic's tutor, not a pid reused since
    if (pid && fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(`"TEACH_TOPIC":${JSON.stringify(slug)}`)) process.kill(pid, "SIGTERM");
  } catch { /* already gone */ }
  fs.rmSync(pidFile(slug), { force: true });
}

export class Engine {
  constructor(emit) {
    this.emit = emit;                // (slug, event) → void
    this.live = new Map();           // slug → Live
    let left = [];
    try { left = fs.readdirSync(PIDS).filter((n) => n.endsWith(".pid")); } catch { /* none yet */ }
    for (const n of left) reap(n.slice(0, -4));
  }

  get(slug) { return this.live.get(slug); }
  isAlive(slug) { const l = this.live.get(slug); return !!(l && l.proc && l.proc.exitCode === null); }
  status(slug) {
    const l = this.live.get(slug);
    return { alive: this.isAlive(slug), busy: !!l?.busy, streaming: l?.streaming || null, agents: l ? [...l.agents.values()] : [],
      watching: l?.watching ? l.watching.expect || "" : null, screen: !!l?.screen };
  }

  // How the next process for this topic should start.
  plan(slug, { fresh = false } = {}) {
    const topic = getTopic(slug);
    const last = topic.sessions.at(-1);
    if (fresh || !last) return { mode: "new" };
    const file = last.project ? path.join(PROJECTS, last.project, `${last.id}.jsonl`) : transcriptPath(last.cwd || WORK, last.id);
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return { mode: "new", reason: "transcript missing" }; }
    const age = Date.now() - mtime;
    if (last.via === "app") return age < RESUME_WINDOW_MS && (last.cwd || WORK) === WORK && !last.fresh ? { mode: "resume", id: last.id } : { mode: "new", reason: "old" };
    if ((last.cwd || "") === WORK && age < FORK_WINDOW_MS) return { mode: "fork", id: last.id };
    return { mode: "new", reason: "elsewhere" };
  }

  start(slug, how) {
    const topic = getTopic(slug);
    const focus = focusBlock();
    const restricted = !!focus || SAFE;
    const screen = !!topic.settings.screen;
    const mcp = { mcpServers: { teach: { command: process.execPath, args: [path.join(APP, "mcp.mjs")],
      env: { TEACH_TOPIC: slug, TEACH_DATA: LEARNING, TEACH_STATE: STATE, TEACH_SCREEN: screen ? "1" : "0", TEACH_LEARNER: LEARNER,
        TEACH_SERVER: SOCKET || `http://127.0.0.1:${PORT}`,   // the tools read the board back from the server
        ...(process.env.TEACH_CHALK ? { TEACH_CHALK: process.env.TEACH_CHALK } : {}),
        ...(process.env.TEACH_SCENEHOST ? { TEACH_SCENEHOST: process.env.TEACH_SCENEHOST } : {}) } } } };
    if (screen) mcp.mcpServers.chalk = { command: CHALK_MCP, args: [], env: process.env.CHALK_REMOTE_BIN ? { CHALK_REMOTE_BIN: process.env.CHALK_REMOTE_BIN } : {} };
    const argv = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--model", process.env.TEACH_MODEL || MODELS[topic.settings.model] || "opus", "--effort", topic.settings.effort || "high",
      "--mcp-config", JSON.stringify(mcp), "--disallowedTools", "AskUserQuestion",
      "--append-system-prompt", appPrompt(topic, focus), "--add-dir", LEARNING];
    if (restricted) argv.push("--permission-mode", "default", "--permission-prompt-tool", "stdio", "--tools", FOCUS_TOOLS.filter((t) => !t.startsWith("mcp__")).join(","));
    else argv.push("--permission-mode", "bypassPermissions");
    if (how.mode === "resume") argv.push("--resume", how.id);
    if (how.mode === "fork") argv.push("--resume", how.id, "--fork-session");
    fs.mkdirSync(STATE, { recursive: true });
    const err = fs.openSync(path.join(STATE, "claude.log"), "a");
    reap(slug);
    const proc = spawn(CLAUDE, argv, { cwd: WORK, env: cleanEnv(), stdio: ["pipe", "pipe", err] });
    fs.closeSync(err);
    if (proc.pid) { fs.mkdirSync(PIDS, { recursive: true }); fs.writeFileSync(pidFile(slug), String(proc.pid)); }
    const l = { slug, proc, busy: false, buf: "", streaming: null, textCount: new Map(), tools: new Map(), agents: new Map(), focus: restricted, screen, watching: null, sessionId: null, idle: null, how };
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
      try { if (fs.readFileSync(pidFile(slug), "utf8") === String(proc.pid)) fs.rmSync(pidFile(slug)); } catch { /* none */ }
      clearTimeout(l.idle);
      if (l.busy) this.emit(slug, { t: "error", text: `The tutor stopped unexpectedly (exit ${code}). Send a message to pick up again.` });
      this.emit(slug, { t: "state", ...this.status(slug) });
      this.onExit?.(slug, l);
    });
    proc.stdin.on("error", () => {});
    this.write(l, { type: "control_request", request_id: `init-${Date.now()}`, request: { subtype: "initialize", hooks: null } });
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
    if (!l.busy) l.turn = { said: 0, replied: 0 };   // (a message sent mid-turn joins the turn it lands in)
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
    if (msg.type === "control_request") return this.permission(l, msg);
    if (msg.type === "system" && msg.subtype === "init") {
      l.sessionId = msg.session_id;
      mutateTopic(slug, (t) => {
        if (!t.sessions.some((s) => s.id === msg.session_id)) t.sessions.push({ id: msg.session_id, cwd: WORK, via: "app", started: now(), from: l.how.mode === "fork" ? l.how.id : undefined });
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
      l.quiet = l.screen && !!l.turn?.replied && !l.turn.said;
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

  // Only used without bypass (a focus block, or TEACH_SAFE): read freely, write only the learning folder.
  permission(l, msg) {
    const req = msg.request || {}, rid = msg.request_id;
    const respond = (response) => this.write(l, { type: "control_response", response: { subtype: "success", request_id: rid, response } });
    if (req.subtype !== "can_use_tool") return this.write(l, { type: "control_response", response: { subtype: "error", request_id: rid, error: "not supported" } });
    const name = req.tool_name, inp = req.input || {};
    const writes = ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name);
    const okWrite = writes && path.resolve(String(inp.file_path || inp.notebook_path || "")).startsWith(LEARNING + path.sep);
    if ((!writes && FOCUS_TOOLS.some((t) => name === t || name.startsWith(t + "__"))) || okWrite) return respond({ behavior: "allow", updatedInput: inp });
    respond({ behavior: "deny", message: writes ? `The tutor can only write in ${LEARNING} here.` : `${name} isn't available to the tutor here.` });
  }
}
