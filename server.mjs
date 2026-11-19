#!/usr/bin/env node
// Teach: the interface for the /teach skill. A small server (Node built-ins only) that keeps the topic files,
// runs one tutor process per topic being taught (lib/engine.mjs; Claude Code, or another AI's CLI: lib/providers/), and serves the page. It listens on
// localhost, or (TEACH_SOCKET) on a Unix socket only its own user can open, for a proxy such as Tailscale Serve
// to publish; Tailscale stamps each request with the user's login, which TEACH_TS_USER must match.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { APP, LEARNING, TOPICS, PROFILE, STATE, WORK, PORT, HOST, SOCKET, HOME, PROJECTS, SYNC, CAPTURE_CMD, OPEN_CMD, CALENDAR_CMD,
  LEARNER, Learner, splitCmd, projectDir, URL_PUBLIC } from "./lib/paths.mjs";
import * as store from "./lib/store.mjs";
import * as ops from "./lib/ops.mjs";
import * as review from "./lib/review.mjs";
import { Engine, focusBlock } from "./lib/engine.mjs";
import { PROVIDER } from "./lib/providers/index.mjs";
import { history, findSessions, pendingAsk, digest, sessionFile } from "./lib/transcript.mjs";
import { sync, lastSync } from "./lib/sync.mjs";
import * as screen from "./lib/screen.mjs";
import * as stage from "./lib/stage.mjs";
import * as board from "./lib/board.mjs";
import * as actions from "./lib/actions.mjs";
import { command } from "./lib/platform.mjs";
import { withFigureKit, checkHtml } from "./lib/figures.mjs";
import * as visualize from "./lib/visualize.mjs";
import { renderFigure } from "./lib/figure-render.mjs";
import { createCourses } from "./lib/courseapp.mjs";

process.removeAllListeners("warning");            // node:sqlite's ExperimentalWarning, once per process

const PUBLIC = path.join(APP, "public");
const TS_USER = process.env.TEACH_TS_USER || "";  // Tailscale login allowed through `tailscale serve`
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".pdf": "application/pdf",
  ".json": "application/json", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".mp4": "video/mp4" };

// ---------- live events (SSE) ----------

const clients = new Set();     // { res, topic }
function broadcast(topic, ev) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) if (c.topic === topic || (topic === null && c.home)) c.res.write(data);
}
const emit = (slug, ev) => {
  broadcast(slug, ev);
  if (["state", "idle", "topic"].includes(ev.t)) homeChanged();
  if (BOARD_EVENTS.has(ev.t)) boardApply(slug, ev);   // first: what follows looks the block up
  if (ev.t === "ask" && ev.status === "pending" && ev.ask) toScreen(slug, ev);
  if (ev.t === "scene") {
    // a scene that updates one already up (replaces, however far down a chain of updates) morphs the block's scene
    const root = boardOf(slug).blocks.find((x) => x.kind === "scene" && x.calls?.includes(ev.id));
    if (root) showScene(slug, root.id, { ...ev.scene, replaces: root.id }, root.predictions || {});
    else showScene(slug, ev.id, ev.scene, {});
  }
};
let homeTimer = null;
function homeChanged() {
  clearTimeout(homeTimer);
  homeTimer = setTimeout(() => broadcast(null, { t: "home" }), 400);
}

const engine = new Engine(emit);
// Is the lesson on the learner's screen right now: their "On my screen" switch, or a stretch the tutor started (`screen`).
const onScreenNow = (t) => screen.isLive(t, t && store.getRuntime(t.slug));
engine.isLive = (slug) => onScreenNow(store.getTopic(slug));
const TUTOR = { provider: PROVIDER.id, label: PROVIDER.label, models: PROVIDER.can.models, effort: PROVIDER.can.effort };   // what the page says about who teaches
const closeAfter = new Set();
const afterRestart = new Map();   // slug → note to start the next process with (screen mode switched)
const afterTurn = new Map();      // slug → note for a new turn once this one ends (the mode changed mid-turn)
const stopAfter = new Map();      // slug → the plan step whose end ends the session (the break card's "Do step N and then stop")
engine.onTurnEnd = (slug, l) => {
  if (l.quiet && store.getTopic(slug)?.settings.voice !== false) noteFor(slug, store.getRuntime(slug).live ? QUIET_STRETCH : QUIET_NOTE);
  if (jobs.has(slug)) jobEnded(slug);
  courses.onTurnEnd(slug);
  if (!jobs.has(slug) && jobQueue.get(slug)?.length) return pump(slug);   // the next action the learner asked for (a close waits for them)
  if (closeAfter.delete(slug)) { afterTurn.delete(slug); return engine.close(slug); }
  // "Do step N and then stop" on the break card: once step N is through, the session ends as the Pause button ends it
  const waitFor = stopAfter.get(slug);
  if (waitFor && STOP_DONE.includes(store.getTopic(slug)?.plan?.find((x) => x.id === waitFor)?.status ?? "done")) {
    afterTurn.delete(slug);
    return endSession(slug, "pause", `[Teach app] break\nStep ${waitFor} is through: this is the stop ${LEARNER} picked on your break card.`);
  }
  if (afterTurn.has(slug)) { const note = afterTurn.get(slug); afterTurn.delete(slug); return turn(slug, [{ type: "text", text: note }]); }
  // words that reached the inbox just as a watch ended: nobody picked them up, so they start the next turn
  const said = screen.takeInbox(slug);
  if (said.length) turn(slug, [{ type: "text", text: said.join("\n\n") }], { user: { text: said.filter((x) => !x.startsWith("[")).join("\n\n") },
    answers: said.map((x) => (x.match(/^\[Answers to question set ([^\]\n]+)\]/) || [])[1]).filter(Boolean) });
};
engine.onExit = (slug) => {
  scheduleSync("session ended");
  afterTurn.delete(slug);   // a mode note for a turn that never came: the next process starts with the mode as it is
  if (!afterRestart.has(slug)) stopAfter.delete(slug);   // the session it was for is over (a restart for screen mode carries on)
  if (store.getRuntime(slug).live) endLive(slug, "ended");   // a stretch on the screen ends with its tutor
  else if (store.getTopic(slug)?.settings.screen) screen.chalk(["clear", "--marks"]);   // their switch was on: the session's cards come down with it
  if (!afterRestart.has(slug)) return;
  const note = afterRestart.get(slug);
  afterRestart.delete(slug);
  if (note) turn(slug, [{ type: "text", text: note }]);
};

// Notes for the tutor's next message (screen lessons): kept until a turn takes them.
const notes = new Map();   // slug → [text]
const noteFor = (slug, text) => { const n = notes.get(slug) || []; if (!n.includes(text)) n.push(text); notes.set(slug, n); };
const QUIET_NOTE = `[Teach app] voice\nScreen mode is on and ${LEARNER} is at the computer, but your last reply reached only the Teach window: nothing was said out loud. Keep the lesson on their screen: answer with say (and a mark when it helps), then carry on with the screen guide's loop. Only ${LEARNER} turns the voice or screen mode off; don't go quiet on your own, even if something about the voice looked wrong.`;
// (a stretch the tutor started itself: it may end it, so the note says how instead of "only they switch it off")
const QUIET_STRETCH = `[Teach app] voice\nThe lesson is on ${LEARNER}'s screen (you moved it there), but your last reply reached only the Teach window: nothing was said out loud. While it's on their screen, answer with say (and a mark when it helps). If the screen part is done, say one wrap-up line, screen_clear, then call screen with to: "board".`;
const BACK_NOTE = "[Teach app] voice\nThe learner's screen is reachable again (Super+/ reaches you). If you had moved to text because say, watch or screen_look failed, go back to their screen now.";

// The learner switched screen mode. A tutor that has the screen tools (chalk is installed) only needs telling: now
// if it's idle, when its turn ends if it's busy (a watch that no longer matters stops at once). One started without
// them (chalk arrived since) restarts (same Claude session, resumed) with the note, since tools are fixed at start.
function switchMode(slug, note) {
  if (!engine.isAlive(slug) || !engine.get(slug).screen) return restartWith(slug, note);
  if (!note) return;
  const st = engine.status(slug);
  if (!st.busy) return turn(slug, [{ type: "text", text: note }]);
  afterTurn.set(slug, note);
  if (st.watching !== null) engine.interrupt(slug);
}

function restartWith(slug, note) {
  if (!engine.isAlive(slug)) return note && store.getTopic(slug).sessions.length ? turn(slug, [{ type: "text", text: note }]) : undefined;
  afterRestart.set(slug, note);
  const st = engine.status(slug);
  if (!st.busy) return engine.close(slug);
  closeAfter.add(slug);
  if (st.watching !== null) engine.interrupt(slug);   // don't sit out a watch that no longer matters
}

// ---------- end-of-session actions (lib/actions.mjs) ----------

// The learner clicks an action in the grid; nothing is made before that. A made-by-the-tutor action is a turn of the
// topic's tutor with the action's brief, one at a time per topic: queued while a lesson turn runs, then started. Pause
// interrupts that turn (the model really stops; a later resume continues the same session from what it had written),
// and a queued one just leaves the queue. A turn that ends without the tutor delivering marks it failed, except a
// practice test waiting on the learner's answers. A scheduled session is the app's alone: a calendar entry (when
// TEACH_CALENDAR_CMD is set) and an .ics, no model.
const jobs = new Map();       // slug → { kind, resume } running now (or a practice test waiting on answers)
const jobQueue = new Map();   // slug → [{ kind, resume }]
const ctxOf = (slug) => ({ deck: store.getDeck(slug).items.length, calendar: !!CALENDAR_CMD });
const actionsView = (slug) => ({ ...actions.tiles(store.getTopic(slug), ctxOf(slug)), running: jobs.get(slug)?.kind || null, calendar: !!CALENDAR_CMD, open: !!OPEN_CMD });
const pendingAskOn = (slug) => boardOf(slug).blocks.some((x) => x.kind === "ask" && x.status === "pending");

function setOut(slug, kind, patch) { ops.setOutput(slug, kind, patch); emit(slug, { t: "actions" }); emit(slug, { t: "topic" }); }

function enqueue(slug, job) {
  const q = (jobQueue.get(slug) || []).filter((x) => x.kind !== job.kind);
  jobQueue.set(slug, [...q, job]);
  pump(slug);
}

function pump(slug) {
  if (jobs.has(slug) || engine.status(slug).busy) return;   // (a turn running now: its end pumps)
  const q = jobQueue.get(slug) || [];
  const job = q.shift();
  if (!job) return;
  const t = store.getTopic(slug), o = t.outputs?.[job.kind];
  if (!o || o.state !== "queued") return pump(slug);
  jobs.set(slug, job);
  setOut(slug, job.kind, { state: "working", progress: job.resume ? "Picking up where it stopped" : "Starting", error: "" });
  turn(slug, [{ type: "text", text: actions.brief(job.kind, t, o.settings, { dir: store.topicDir(slug), learner: Learner, resume: job.resume }) }], { action: job.kind });
}

function jobEnded(slug) {
  const job = jobs.get(slug), o = store.getTopic(slug).outputs?.[job.kind];
  if (o?.state === "working" && job.kind === "practice" && pendingAskOn(slug)) { setOut(slug, job.kind, { progress: "Waiting on your answers" }); return; }
  jobs.delete(slug);
  if (o?.state === "working") setOut(slug, job.kind, { state: "failed", error: "The tutor stopped before it was done.", progress: "" });
}

function pauseAction(slug, kind) {
  const q = jobQueue.get(slug) || [];
  jobQueue.set(slug, q.filter((x) => x.kind !== kind));
  if (jobs.get(slug)?.kind === kind) {
    jobs.delete(slug);
    if (engine.status(slug).busy) engine.interrupt(slug);   // stops the model's turn; its end finds it paused
  }
  setOut(slug, kind, { state: "paused", progress: "" });
  pump(slug);
}

// (through platform.mjs's command(): a node script or an npm shim runs on Windows too)
const run = (cmd, args) => new Promise((resolve) => { const c = command(cmd, args); execFile(c.file, c.args, { timeout: 60e3, windowsHide: true }, (err, stdout, stderr) =>
  resolve({ ok: !err, out: String(stdout || "").trim(), err: String(stderr || (err && err.message) || "").trim() })); });

// A review (or next) session: on their calendar, and on the topic, where the lesson and home show it.
async function scheduleSession(slug, v, at) {
  const t = store.getTopic(slug);
  const start = Date.parse(at) || Date.parse(v.when);
  if (!Number.isFinite(start)) throw Object.assign(new Error("when?"), { code: 400 });
  const title = actions.sessionTitle(t, v), link = `${URL_PUBLIC}/t/${slug}`;
  const note = `${{ review: "A review of what this topic covered", continue: "The next session: carry on with the plan", warmup: "Mixed practice before the exam" }[v.mode]}, about ${v.minutes} minutes. Open it in Teach: ${link}`;
  let calendar = null;
  if (v.calendar && CALENDAR_CMD) {
    const [cmd, ...pre] = splitCmd(CALENDAR_CMD);
    const r = await run(cmd, [...pre, ...actions.calendarArgs({ title, local: v.when, minutes: Number(v.minutes), note, remind: Number(v.remind) })]);
    calendar = { ok: r.ok, text: (r.ok ? r.out : r.err).split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 240) };
  }
  const session = { at: new Date(start).toISOString(), local: v.when, minutes: Number(v.minutes), mode: v.mode, remind: Number(v.remind), title, calendar };
  setOut(slug, "session", { state: calendar && !calendar.ok ? "failed" : "ready", settings: v, session, files: [], summary: actions.whenText(v.when),
    error: calendar && !calendar.ok ? `Couldn't add it to your calendar: ${calendar.text || "the calendar command failed"}` : "", at: store.now() });
}

const SESSION_KICKOFF = {
  review: "a review of what this topic covered: start with 3-4 questions on the shakiest steps, re-teach what slipped, and log how it went",
  continue: "the next session: say in one line where we are, a short review of the last step, then the next step of the plan",
  warmup: "an exam warm-up: a short timed mixed set like the exam's, then go over what it shows",
};

async function actionOp(slug, b) {
  const t = store.getTopic(slug), kind = String(b.kind || "");
  if (!actions.ACTIONS[kind]) throw Object.assign(new Error(`kind must be one of ${actions.KINDS.join(", ")}`), { code: 400 });
  const o = t.outputs?.[kind];
  const settings = () => actions.normalizeSettings(kind, t, { ...(o?.settings || {}), ...(b.settings || {}) }, ctxOf(slug));
  switch (b.op) {
    case "save": setOut(slug, kind, { settings: settings() }); return;
    case "start": {
      if (jobs.get(slug)?.kind === kind || o?.state === "queued") return;
      const v = settings();
      if (kind === "session") return scheduleSession(slug, v, b.at);
      setOut(slug, kind, { settings: v, state: "queued", files: [], summary: "", error: "", progress: engine.status(slug).busy ? "Waiting for the tutor to finish its turn" : "" });
      return enqueue(slug, { kind, resume: false });
    }
    case "pause": if (["working", "queued"].includes(o?.state)) pauseAction(slug, kind); return;
    case "resume":
      if (o?.state !== "paused") return;
      setOut(slug, kind, { state: "queued", progress: "" });
      return enqueue(slug, { kind, resume: true });
    case "reset":
      pauseAction(slug, kind);
      setOut(slug, kind, { state: "idle", files: [], summary: "", error: "", progress: "", session: undefined });
      return;
    case "begin": {   // start a scheduled session now
      const s = o?.session;
      if (!s) throw Object.assign(new Error("no session scheduled"), { code: 409 });
      turn(slug, [{ type: "text", text: `[Teach app] scheduled session\n${Learner} is starting the session they scheduled (${s.minutes} min): ${SESSION_KICKOFF[s.mode] || SESSION_KICKOFF.review}. Keep it to about ${s.minutes} minutes.` }], {});
      setOut(slug, "session", { state: "idle", session: undefined, summary: "" });
      return;
    }
    default: throw Object.assign(new Error("op must be save, start, pause, resume, reset or begin"), { code: 400 });
  }
}

// A restart stops every tutor: what was being made is paused (a click resumes it from what it had written).
for (const slug of store.listSlugs()) {
  const outs = store.getTopic(slug)?.outputs || {};
  for (const [kind, o] of Object.entries(outs)) if (["working", "queued"].includes(o.state)) ops.setOutput(slug, kind, { state: "paused", progress: "Teach restarted" });
}

// ---------- the lesson board ----------

// Each lesson page is a board (lib/board.mjs), not a chat: rebuilt from the lesson's history the first time it's
// needed, then kept current from the live events. The learner's own board actions are kept with the topic's
// runtime state, so a rebuild has them too.
const BOARD_EVENTS = new Set(["turn", "user", "text", "ask", "scene", "show", "remove", "step", "board-op", "predicted", "learner"]);
const boards = new Map();   // slug → board
const boardInst = Date.now().toString(36);
function boardOf(slug) {
  let b = boards.get(slug);
  if (!b) {
    const t = store.getTopic(slug);
    b = board.fold(t ? topicHistory(t) : [], store.getRuntime(slug).boardOps || []);
    boards.set(slug, b);
  }
  return b;
}
// A note's own visual ("Visualize it", kept in topic.json `visuals`) and the job making one ride on its block; its rev
// changes with them, so the page repaints just that card.
function boardView(slug) {
  const v = { ...board.view(boardOf(slug)), inst: boardInst };
  const t = store.getTopic(slug), jobs = visualize.jobsFor(slug);
  v.blocks = v.blocks.map((x) => {
    if (x.kind !== "note") return x;
    const saved = visualize.visualOf(t, x.id), job = Object.hasOwn(jobs, x.id) ? jobs[x.id] : null;
    // a note id the tutor reused for a different note (another title, other words) doesn't inherit the old picture;
    // the same note edited keeps it, marked as drawn for an earlier version
    const changed = saved && saved.noteHash !== visualize.hashBody(x.body);
    const visual = saved && !(changed && (saved.noteTitle || "") !== (x.title || "")) ? visualSummary(slug, x.id, saved, changed) : null;
    if (!visual && !job) return x;
    return { ...x, visual, vjob: job, rev: `${x.rev}:${visual ? `${visual.at}:${visual.hidden ? 1 : 0}:${visual.stale ? 1 : 0}` : ""}:${job ? `${job.state}:${job.sub}` : ""}` };
  });
  return v;
}
const visualStage = (slug, noteId) => `vis:${slug}:${noteId}`;
const visualSummary = (slug, id, v, stale) => ({ kind: v.kind, title: v.title, at: v.at, hidden: !!v.hidden, path: v.path, stage: visualStage(slug, id), stale: !!stale });
const boardNow = (slug) => {
  if (boardTimers.has(slug)) return;
  boardTimers.set(slug, setTimeout(() => { boardTimers.delete(slug); broadcast(slug, { t: "board", board: boardView(slug) }); }, 40));
};
// A visual changed (made, failed, cancelled, hidden): the page repaints the card; a new one is the tutor's to know.
visualize.listen((slug, noteId, made) => {
  if (made) {
    stage.close(visualStage(slug, noteId));   // (another view replaces the scene that was up)
    const lines = boardNotes.get(slug) || [];
    boardNotes.set(slug, [...lines, `${Learner} pressed "Visualize it" on note \`${noteId}\`: it now shows a ${made.kind === "scene" ? "live scene" : "figure"} under its text${made.title ? ` ("${made.title}")` : ""}. You don't need to describe it; refer to it if it helps.`]);
  }
  boardNow(slug);
});
const boardTimers = new Map();
function boardApply(slug, item) {
  const r = board.apply(boardOf(slug), { at: store.now(), ...item });
  for (const x of r.removed) {
    if (x.kind === "scene") stage.close(x.id);
    if (x.kind === "note") stage.close(visualStage(slug, x.id));
    if (x.kind === "ask" && x.status === "pending") {
      offScreen(x.id);
      store.mutateRuntime(slug, (rt) => { rt.dropped = { ...(rt.dropped || {}), [x.id]: store.now() }; });
    }
  }
  if (r.changed && !boardTimers.has(slug)) {
    boardTimers.set(slug, setTimeout(() => { boardTimers.delete(slug); broadcast(slug, { t: "board", board: boardView(slug) }); }, 40));
  }
  return r;
}

const BOARD_INTRO = `The lesson page is a board now, not a chat: your reply text shows only until ${Learner}'s next move, and anything they need for longer goes on the board (the "board" tool for notes; ask, show and scene make their own blocks). From this turn on, put the current step's explanation on the board as a note, keep replies short, and tidy what no longer helps.`;

// What the learner did on the board since the tutor's last turn: one note at the start of its next turn.
const boardNotes = new Map();   // slug → [line]

// ---------- question sets on the learner's screen ----------

// In screen mode a question set also pops up on the screen as a chalk panel beside what it's about, so the learner
// answers without leaving their editor. Whichever they answer first (panel or app) wins; the other goes away.
const onScreen = new Map();   // ask id → { slug, cancel }
const dismissed = new Set();  // ask ids closed on the screen: they stay in Teach only
const shown = new Map();      // tag → timer: answered cards still up on the screen, showing how it went
const ANSWERED_UP_MS = 45e3;

function toScreen(slug, ev) {
  const t = store.getTopic(slug);
  if (!onScreenNow(t) || onScreen.has(ev.id) || !screen.screenable(ev.ask)) return;
  for (const [tag, timer] of shown) { clearTimeout(timer); screen.chalk(["remove", tag]); shown.delete(tag); }   // the last card's done
  const p = screen.panel(screen.askPanel(t, ev.id, ev.ask));
  onScreen.set(ev.id, { slug, cancel: p.cancel });
  emit(slug, { t: "ask", id: ev.id, onScreen: true });
  p.done.then((r) => {
    if (onScreen.get(ev.id)?.cancel !== p.cancel) return;
    onScreen.delete(ev.id);
    emit(slug, { t: "ask", id: ev.id, onScreen: false });
    if (r.status === "answered") {
      try { answerSet(slug, ev.id, r.answers || [], "screen"); } catch (e) { console.error("teach: screen answer:", e.message); }
      // it stays up showing right/wrong and the why lines; it goes when the next card comes, or after a while
      shown.set(p.tag, setTimeout(() => { shown.delete(p.tag); screen.chalk(["remove", p.tag]); }, ANSWERED_UP_MS));
    } else if (r.status === "dismissed") { dismissed.add(ev.id); screen.toast("Still in Teach when you want it", "yellow"); }
    else if (r.status === "error") console.error("teach: screen panel:", r.error);
  });
}

function offScreen(id) {
  const s = onScreen.get(id);
  if (!s) return;
  onScreen.delete(id);
  s.cancel();
}

// ---------- scenes on the board ----------

// Scenes the tutor put up (the `scene` tool) run in chalk's scene host; their frames go to the lesson page.
stage.listen((slug, m) => broadcast(slug, { ...m, t: "stage", kind: m.t }));

// (Re)open a scene: when the tutor calls `scene`, or when a page opens on a lesson whose stage is showing one.
// A gate stays only on steps not predicted yet. `replaces` updates the scene already up instead.
function showScene(slug, id, sc, predictions) {
  if (!stage.available()) return;
  if (sc.replaces && stage.isOpen(sc.replaces)) { stage.replace(sc.replaces, sc.scene); return; }
  stage.show(slug, id, sc.scene, sc.predict.map((p) => p.step).filter((s) => !predictions[s]));
}

// The learner committed a prediction on the stage: graded like a card, kept with the topic's runtime state, the gated
// step plays, and the tutor hears it (inside a watch, or as the next turn).
function predictOnStage(slug, id, step, answer) {
  const item = boardOf(slug).blocks.find((x) => x.kind === "scene" && x.id === id);
  const q = item?.scene.predict.find((p) => p.step === step);
  if (!q) throw Object.assign(new Error("no such prediction"), { code: 404 });
  if (item.predictions?.[step]) throw Object.assign(new Error("already predicted"), { code: 409 });
  const result = ops.grade(q, answer);
  store.mutateRuntime(slug, (r) => { r.predictions = { ...(r.predictions || {}), [id]: { ...(r.predictions?.[id] || {}), [step]: { answer, result, at: store.now() } } }; });
  stage.release(id, step);
  emit(slug, { t: "predicted", id, step, answer, result, why: q.why });
  const text = `[Stage] Prediction on scene ${id}, before step ${step + 1}${item.scene.title ? ` of "${item.scene.title}"` : ""}\n` +
    `Q: ${q.prompt}\n${Learner}'s answer: ${result.text}.${q.why ? " The stage showed your why line." : ""} The step is playing on the stage now. Talk to ${LEARNER} directly: react to the guess, then go on.`;
  if (engine.status(slug).watching !== null) screen.toInbox(slug, text);
  else turn(slug, [{ type: "text", text }], {});
  return result;
}

// ---------- the Super+/ link ----------

// A screen lesson touched this recently is live: Super+/ keeps reaching its tutor (lib/screen.mjs, "link").
const LIVE_MS = 2 * 3600e3;
const screenLive = (t) => onScreenNow(t) && t.status === "active" && Date.now() - lastActive(t) < LIVE_MS;

// (every turn and page refresh asks; a screen that can't be reached is retried at most once a minute, one at a time)
let linkInFlight = false;
function touchLink(slug) {
  const l = screen.link;
  if (linkInFlight || (l.slug === slug && Date.now() - l.at < (l.ok ? 5 * 60e3 : 60e3))) return;
  linkInFlight = true;
  screen.linkTo(slug, store.getTopic(slug).title, onLink).finally(() => { linkInFlight = false; });
}

// What Super+/ does changed: every open page shows it, and once the screen answers again a question set that
// isn't on it (the server restarted, or the computer was away when it was asked) goes back up.
let linkWasOk = null;
function onLink(l) {
  if (l.ok && l.slug && linkWasOk === false && onScreenNow(store.getTopic(l.slug))) noteFor(l.slug, BACK_NOTE);
  linkWasOk = l.ok;
  const data = `data: ${JSON.stringify({ t: "link", link: l })}\n\n`;
  for (const c of clients) c.res.write(data);
  if (!l.ok || !l.slug) return;
  const t = store.getTopic(l.slug);
  const last = t && topicHistory(t).findLast((i) => i.t === "ask");
  if (last?.status === "pending" && !onScreen.has(last.id) && !dismissed.has(last.id)) toScreen(l.slug, last);
}

function linkBeat() {
  const cur = screen.link.slug && store.getTopic(screen.link.slug);
  if (cur && screenLive(cur)) return screen.linkTo(cur.slug, cur.title, onLink);
  if (screen.link.slug) screen.unlink(screen.link.slug, onLink);
  const next = store.listSlugs().map((s) => store.getTopic(s)).filter(screenLive).sort((a, b) => lastActive(b) - lastActive(a))[0];
  if (next) screen.linkTo(next.slug, next.title, onLink);
}
// A stretch on the screen belongs to the tutor that started it; a server that just started has none running.
for (const slug of store.listSlugs()) if (store.getRuntime(slug).live) store.mutateRuntime(slug, (r) => { delete r.live; });
setInterval(linkBeat, screen.LINK_BEAT).unref();
setTimeout(linkBeat, 3000).unref();   // after a restart: pick the live lesson back up

// The answers to a question set, from the app's card or a panel on the screen: graded, kept with the topic's
// runtime state (the app's record of what was asked and answered), shown in the lesson and sent to the tutor.
const askItem = (slug, id) => boardOf(slug).blocks.find((x) => x.kind === "ask" && x.id === id) || topicHistory(store.getTopic(slug)).find((i) => i.t === "ask" && i.id === id);

// The end of a session, one path for all of it: the Pause button (P), Mark done, and a stop picked on the tutor's
// break card (at once, or when the step it names is through: engine.onTurnEnd). The tutor runs Phase 4 (recap,
// profile, `next`, the actions it suggests) and sets the status; the page opens the end-of-session grid.
// `lead`: what to put before the app's note (the break card's answers); `opts`: the turn's (which answers it carries).
const STOP_DONE = ["done", "shaky", "skipped"];
const stopStep = (slug, id) => {   // the step a break card's "Do step N and then stop" waits for (the current one if N isn't in the plan)
  const plan = store.getTopic(slug).plan || [];
  const n = plan.find((x) => x.id === String(id)) || plan.find((x) => x.status === "current");
  return n && !STOP_DONE.includes(n.status) ? n : null;
};
const nextStepAfter = (slug, id) => { const plan = store.getTopic(slug).plan || []; return plan[plan.findIndex((x) => x.id === id) + 1]?.id || ""; };

function endSession(slug, action, lead = "", opts = {}) {
  const t = store.getTopic(slug);
  stopAfter.delete(slug);
  if (onScreenNow(t)) screen.unlink(slug, onLink);
  const pick = `call update with \`suggest\`: the end-of-session actions that fit this topic best, best first, each with a one-line why${t.why === "exam" ? ", and with \`allowance\` if you know what the exam lets them bring" : ""}. Don't make any of them: ${LEARNER} sees them as buttons and nothing is made until they click one.`;
  const note = action === "pause"
    ? `[Teach app] pause\n${Learner} is stopping here for today. Don't start anything new. Run Phase 4: a short recap in log.md (what was covered, where we stopped, any pending check, what was shaky), update PROFILE.md, ${pick} Then call update with \`next\` set to the exact resume point and status "paused", and reply with a short recap.`
    : `[Teach app] close\n${Learner} marked this topic done. Run Phase 4: recap in log.md, update PROFILE.md, ${pick} Then call update with status "done" and a \`next\` that says what to come back to.${SYNC === "git-pr" ? " The app handles git." : ""} Reply with a short recap.`;
  emit(slug, { t: "ending", action });   // the page: the same end-of-session grid either way
  if (engine.isAlive(slug) || t.sessions.length) {
    closeAfter.add(slug);
    const content = [...(lead ? [{ type: "text", text: lead }] : []), { type: "text", text: note }];
    if (engine.status(slug).watching !== null) { screen.toInbox(slug, content.map((c) => c.text).join("\n\n")); return; }   // a watch is waiting: it takes it
    turn(slug, content, opts);
  } else store.mutateTopic(slug, (x) => { x.status = action === "pause" ? "paused" : "done"; });
}

function answerSet(slug, id, answers, via) {
  const item = askItem(slug, id);
  if (!item) throw Object.assign(new Error("no such question set"), { code: 404 });
  if (item.status !== "pending") throw Object.assign(new Error("already answered"), { code: 409 });
  if (via !== "screen") offScreen(id);
  const results = item.ask.questions.map((q, i) => ops.grade(q, answers[i]));
  let text = ops.answersMessage(id, item.ask, answers).text;
  if (item.legacy) text += "\n(These answer the question set you asked before the session moved into the app.)";
  if (via === "screen") text += "\n(Answered on screen; the panel already showed right/wrong and your why lines.)";
  store.mutateRuntime(slug, (r) => { r.answers = { ...(r.answers || {}), [id]: { answers, results, at: store.now(), via } }; });
  emit(slug, { t: "ask", id, status: "answered", answers, results, ask: item.ask, via });
  // a break card's stop: "now" is the Pause button; "after" is the Pause button once that step is through
  const stop = ops.breakStop(item.ask, answers);
  if (stop === "now" || (stop === "after" && !stopStep(slug, item.ask.finish))) { endSession(slug, "pause", text, { answers: id }); return results; }
  if (stop === "after") {
    const step = stopStep(slug, item.ask.finish);
    stopAfter.set(slug, step.id);
    text += `\n[Teach app] break\nThe app ends the session once step ${step.id} (${step.title}) is through: teach it and check it as usual, \`step\` it when its check is in, then end your turn without starting step ${nextStepAfter(slug, step.id) || "after it"}. The app then sends you its pause message, the same one as the Pause button.`;
  }
  if (engine.status(slug).watching !== null) screen.toInbox(slug, text);   // a watch is waiting: it takes them
  else turn(slug, [{ type: "text", text }], { answers: id });
  return results;
}

const SCREEN_ON = `[Teach app] screen on\n${Learner} switched this lesson onto their screen. You now have say, watch, screen_look, screen_draw and screen_clear, and the screen-mode guide in your system prompt. Look at the screen, say out loud in one sentence what you'll do there, and carry on from where the lesson is.`;
const SCREEN_OFF = `[Teach app] screen off\n${Learner} switched the lesson back to the Teach window: the screen tools are off. Carry on here in text from where you were.`;
const SCREEN_STAY = `[Teach app] screen off\n${Learner} pressed "Stay on the board": the lesson is back on the Teach board, and stays there for this topic (the screen tool won't move it again). Carry on here from where you were.`;
// A tutor starting up on a lesson whose "On my screen" switch is on (its system prompt says how both modes work).
const SCREEN_STATE = `[Teach app] screen on\n${Learner}'s "On my screen" switch is on: this lesson happens on their screen. Run it with the screen guide's loop.`;

// ---------- the tutor moves a step onto the screen (the `screen` tool) ----------

// The learner typing in the Teach window (the page reports keys in the composer and in a question card): the tutor
// doesn't move the lesson to the screen while they're mid-sentence there (lib/screen.mjs liveDecision).
const typing = new Map();   // slug → { at, draft }

async function moveLesson(slug, { to, why = "", stay = false, by = "tutor" }) {
  const state = () => { const t = store.getTopic(slug); return { to, by, installed: screen.installed(), settings: t.settings, live: store.getRuntime(slug).live || null, typing: typing.get(slug), who: LEARNER }; };
  let d = screen.liveDecision(state());
  if (d.probe) d = screen.liveDecision({ ...state(), probe: await screen.ready() });   // (state again: the probe can take seconds)
  if (stay && to === "board" && d.ok) store.mutateTopic(slug, (x) => { x.settings.autoScreen = false; });   // (not when it was refused)
  if (d.change === "live") startLive(slug, why);
  if (d.change === "board") endLive(slug, by);
  if (stay && d.ok) emit(slug, { t: "topic" });
  let text = d.reason;
  if (d.change === "live") {
    text = `Live on ${LEARNER}'s screen now. say, watch, review, screen_look, screen_draw and screen_clear work, and question sets pop up on their screen. ` +
      `Follow the screen guide's loop: screen_look first, then say what to do with its mark in the same message. ` +
      `When the part that needs their screen is done: one spoken wrap-up line, screen_clear, then screen with to: "board".`;
  } else if (d.change === "board" || (stay && d.ok)) {
    text = `Back on the Teach board: the screen tools are off. Carry on here (the step's note on the board, short replies).` +
      (stay ? ` ${Learner} asked to stay on the board for this topic: don't move it to their screen again.` : "");
  }
  return { ok: d.ok, change: d.change, reason: d.reason, text };
}

function startLive(slug, why) {
  const live = { since: store.now(), why: String(why || "").slice(0, 120), by: "tutor" };
  store.mutateRuntime(slug, (r) => { r.live = live; });
  touchLink(slug);
  screen.toast(`On your screen${live.why ? ` · ${live.why}` : ""}`.slice(0, 80), "blue");
  emit(slug, { t: "live", live });
  emit(slug, { t: "state", ...engine.status(slug) });
}

// Back to the board: what the stretch put on their screen comes down (a waiting question set stays in Teach), and
// Super+/ goes back to plain chalk. When the learner ended it, the voice stops and a watch in progress ends too.
function endLive(slug, by) {
  store.mutateRuntime(slug, (r) => { delete r.live; });
  const t = store.getTopic(slug);
  if (!t.settings.screen) {
    for (const [id, s] of onScreen) if (s.slug === slug) offScreen(id);
    screen.chalk(["clear", "--marks"]);
    screen.unlink(slug, onLink, { quiet: true });
    if (by !== "ended") screen.toast("Back on the Teach board", "yellow");
    if (by === "learner") { screen.hush(); switchMode(slug, SCREEN_STAY); }
  }
  emit(slug, { t: "live", live: null });
  emit(slug, { t: "state", ...engine.status(slug) });
}

// ---------- git sync, debounced ----------

let syncTimer = null;
function scheduleSync(reason, delay = 60e3) {
  if (SYNC !== "git-pr") return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    if ([...store.listSlugs()].some((s) => engine.status(s).busy)) return scheduleSync(reason, 5 * 60e3);
    const r = await sync(reason);
    broadcast(null, { t: "sync", sync: r });
  }, delay);
}
setInterval(() => scheduleSync("periodic", 1000), 3 * 3600e3).unref();

// ---------- topics ----------

// A session brought in from another project folder (a git worktree, say) records that folder as `project`; one
// that ran on another machine has its copy, from `teach bring`, in this machine's WORK folder's project.
const sessionPath = (s) => {
  if (s.transcript) return s.transcript;   // a Codex or Gemini session: the transcript Teach keeps (lib/providers/turns.mjs)
  const p = s.project ? path.join(PROJECTS, s.project, `${s.id}.jsonl`) : sessionFile({ ...s, cwd: s.cwd || WORK });
  return fs.existsSync(p) ? p : path.join(projectDir(WORK), `${s.id}.jsonl`);
};
const sessionsOf = (t) => t.sessions.map((s, i) => ({ ...s, path: sessionPath(s),
  label: s.via === "t3" ? "T3 thread" : s.via === "focus" ? "focus tutor" : s.via === "terminal" ? "terminal" : i === 0 ? "" : "" }))
  .filter((s) => fs.existsSync(s.path));

function topicHistory(t) {
  const rt = store.getRuntime(t.slug);
  return history(sessionsOf(t), { answers: rt.answers || {}, plan: t.plan, predictions: rt.predictions || {}, dropped: rt.dropped || {} });
}

function lastActive(t) {
  let m = Date.parse(t.updated) || 0;
  for (const s of sessionsOf(t)) { try { m = Math.max(m, fs.statSync(s.path).mtimeMs); } catch { /* gone */ } }
  return m;
}

function summary(t, due) {
  const plan = t.plan || [];
  const cur = plan.find((n) => n.status === "current") || plan.find((n) => n.status === "todo");
  const hist = t.status === "active" ? topicHistory(t) : [];
  const pending = hist.findLast((i) => i.t === "ask")?.status === "pending";
  return {
    slug: t.slug, title: t.title, goal: t.goal, why: t.why, course: t.course, deadline: t.deadline, status: t.status, phase: t.phase,
    next: t.next, lastActive: lastActive(t), review: t.settings.review !== false, due: due[t.slug] || 0,
    progress: { total: plan.length, done: plan.filter((n) => n.status === "done").length, shaky: plan.filter((n) => n.status === "shaky").length,
      steps: plan.map((n) => n.status), current: cur ? { id: cur.id, title: cur.title } : null },
    pending, unit: t.unit || null, ...engine.status(t.slug), streaming: undefined,
  };
}

// The tutor's opening line for each way a process can start.
function kickoff(t, how, extra = {}) {
  const dir = store.topicDir(t.slug);
  const hasApp = t.sessions.some((s) => s.via === "app");
  // an end-of-session action: a session that carries on needs nothing; a fresh one reads up first, then does only that
  if (extra.action) {
    if (how.mode === "resume" || (how.mode === "fork" && hasApp)) return null;
    return `[Teach app] context\nThis is a fresh session for this topic (the earlier one ${how.mode === "fork" || !hasApp ? "ran outside the app" : "can't be resumed here"}). Read ${dir}/topic.json, ${dir}/log.md and ${PROFILE} first. ` +
      `Then do only what the next message asks: don't start teaching or reviewing.`;
  }
  if (extra.start) {
    return `[Teach app] start\nNew topic. Folder: ${dir} (topic.json exists; write log.md there).` +
      `${t.why ? ` Why: ${t.why}.` : ""}${t.deadline ? ` Deadline: ${t.deadline}.` : ""}` +
      `${extra.files?.length ? `\nAttached files:\n${extra.files.map((f) => `- ${f}`).join("\n")}` : ""}` +
      `\n${Learner} wrote:\n${extra.start}\n[end]\nLoad the teach skill and begin with Phase 0. Set the title, goal and why with the update tool as soon as you know them.`;
  }
  if (!hasApp && t.sessions.length) {
    const log = fs.existsSync(path.join(dir, "log.md")) ? `${dir}/log.md` : "(no log yet: write one at " + dir + "/log.md)";
    const base = `[Teach app] import\nThis /teach session has moved into the Teach app. Topic folder: ${dir}; log: ${log}.` +
      ` From now on use the teach tools (see "In the Teach app" in the teach skill; load the skill again if it isn't fresh in context).` +
      ` First fill the app's sidebar from what has happened so far: update (title, goal, why, deadline, map, facts_add, next) and plan (with statuses for steps already taught).` +
      (extra.backfill ? ` Then stop there: reply with one line on where the topic stands. ${Learner} picks it up later; don't ask anything or start teaching yet.`
        : ` Then continue exactly where it stopped, in one line saying where we are.`);
    if (how.mode === "fork") return base;
    const d = path.join(STATE, "digests", `${t.slug}.md`);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.writeFileSync(d, `# ${t.title}: the conversation so far (newest last)\n\n` + digest(sessionsOf(t).map((s) => s.path)));
    return base + ` The earlier conversation can't be resumed directly; it is in ${d}.`;
  }
  if (how.mode === "new") {
    return `[Teach app] continue\nContinue this topic in a fresh session (the last one ${how.reason === "old" ? "is more than a day old" : how.reason === "provider" ? `ran on another AI service; this one is ${PROVIDER.label}` : "can't be resumed"}).` +
      ` Read ${dir}/topic.json, ${dir}/log.md and ${PROFILE} first, then follow the skill's continuation: one line on where we are, a short review of the shakiest recent steps, then the next step.`;
  }
  return null;
}

// Start (or continue) a turn: the learner's content, prefixed by an app note when a process has to start.
let turnSeq = 0;
function turn(slug, content = [], opts = {}) {
  const t = store.getTopic(slug);
  const live = onScreenNow(t);
  if (live) touchLink(slug);
  boardApply(slug, { t: "turn", id: `live-${boardInst}-${++turnSeq}`, user: opts.user, answers: opts.answers });
  // A lesson that ran as a chat before the board: its tutor hears once that the page changed (the system prompt says how).
  if (!store.getRuntime(slug).boardIntro) {
    store.mutateRuntime(slug, (r) => { r.boardIntro = store.now(); });
    if (t.sessions.length) boardNotes.set(slug, [BOARD_INTRO, ...(boardNotes.get(slug) || [])]);
  }
  const done = boardNotes.get(slug);
  const prof = courseNotes.get(slug) || []; courseNotes.delete(slug);
  const said = content.map((c) => c.text || "").join("\n");
  // (an end-of-session action is made in Teach, not on their screen: no "run it with the screen guide's loop")
  const starting = !engine.isAlive(slug) && t.settings.screen && !opts.action && !said.startsWith("[Teach app] screen") ? [SCREEN_STATE] : [];
  const pre = [...starting, ...(live ? notes.get(slug) || [] : []), ...(done?.length ? [`[Teach app] board\n${done.join("\n")}`] : []), ...prof].map((text) => ({ type: "text", text }));
  notes.delete(slug); boardNotes.delete(slug);
  if (engine.isAlive(slug)) return engine.send(slug, [...pre, ...(content.length ? content : [{ type: "text", text: `[Teach app] back\n${Learner} is here. Continue.` }])]);
  const how = engine.plan(slug, opts);
  const note = kickoff(t, how, opts) || (content.length ? null : `[Teach app] back\n${Learner} is back${t.next ? ` (resume note: ${t.next})` : ""}. Say where we are in one line, then continue.`);
  if (t.status === "paused" && !opts.action) store.mutateTopic(slug, (x) => { x.status = "active"; });   // (making something isn't resuming the lesson)
  return engine.send(slug, [...(note ? [{ type: "text", text: note }] : []), ...pre, ...content], { how });
}

// ---------- courses and programs (lib/courseapp.mjs) ----------

// A course's units are topics; the professor's changes reach a unit's tutor as a note on its next turn.
const courseNotes = new Map();   // topic slug → [text]
const courses = createCourses({
  turn, emit, broadcast: (ev) => broadcast(null, ev), calendarCmd: CALENDAR_CMD, provider: PROVIDER.id,
  noteFor: (slug, text) => { const n = courseNotes.get(slug) || []; if (!n.includes(text)) n.push(text); courseNotes.set(slug, n); },
});
const courseTick = () => courses.tick().catch((e) => console.error("teach: courses:", e.message));
setTimeout(courseTick, 60e3).unref();
setInterval(courseTick, 10 * 60e3).unref();

// ---------- importing a session that ran elsewhere ----------

let foundCache = { at: 0, list: [] };
function found(force = false) {
  if (!force && Date.now() - foundCache.at < 60e3) return foundCache.list;
  const linked = new Set(store.listSlugs().flatMap((s) => store.getTopic(s).sessions.map((x) => x.id)));
  const dismissed = new Set(store.readJSON(store.globalFile("dismissed"), []));
  foundCache = { at: Date.now(), list: findSessions({ linked }).filter((g) => !dismissed.has(g.key)) };
  return foundCache.list;
}

function importSession(key) {
  const g = found(true).find((x) => x.key === key);
  if (!g) throw new Error("that session is gone or already brought in");
  const oldLog = g.log && !g.log.includes("/topics/") ? g.log : null;
  const base = oldLog ? path.basename(oldLog, ".md") : store.slugify(g.title);
  const t = store.createTopic({
    slug: base, title: g.title, status: "active", phase: g.summary.hasLog ? "teach" : g.summary.questionSets ? "probe" : "frame",
    sessions: g.sessions.map((s) => ({ id: s.id, cwd: path.dirname(s.path) === projectDir(WORK) ? WORK : s.cwd || WORK, project: path.basename(path.dirname(s.path)), via: s.via,
      started: new Date(s.mtime).toISOString(), thread: s.thread, title: s.threadTitle })),
    next: g.summary.pending ? "Waiting on the answers to the last question set (asked before the move)." : "",
  });
  const dir = store.topicDir(t.slug);
  if (oldLog) {
    fs.renameSync(oldLog, path.join(dir, "log.md"));
    const figs = oldLog.slice(0, -3);
    if (fs.existsSync(figs) && fs.statSync(figs).isDirectory()) fs.renameSync(figs, path.join(dir, "figures"));
  }
  foundCache.at = 0;
  return t;
}

// ---------- HTTP ----------

const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };

function readBody(req, limit = 40 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Over the socket, a request either came through Tailscale Serve (it carries the tailnet login, which must be
// TEACH_TS_USER) or from this user's own shell (the `teach` command). Nobody else can open the socket. A dev server
// on TCP only answers to localhost names, and to TEACH_URL's host (a published container port, say), so a DNS-rebinding
// page can't reach it.
const OWN_HOST = (() => { try { return new URL(URL_PUBLIC).host.toLowerCase(); } catch { return ""; } })();
function allowed(req) {
  const host = String(req.headers.host || "").toLowerCase();
  const login = req.headers["tailscale-user-login"];
  if (SOCKET) {
    if (login !== undefined && (!TS_USER || login !== TS_USER)) return false;
  } else if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`, `teach.localhost:${PORT}`, OWN_HOST].filter(Boolean).includes(host)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (req.headers["x-teach"] !== "1") return false;                      // blocks cross-site form posts
    // Tailscale Serve hands a socket backend "Host: localhost" and puts the page's real host in X-Forwarded-Host.
    const pageHost = SOCKET && login !== undefined ? String(req.headers["x-forwarded-host"] || "").toLowerCase() : host;
    const origin = req.headers.origin;
    if (origin && new URL(origin).host.toLowerCase() !== pageHost) return false;
  }
  return true;
}

// Files the page may show: anything under the learning folder, the work folder, and ~/Videos, ~/Pictures,
// ~/Downloads and ~/Documents. Never dotfiles.
function readableFile(p) {
  const real = (() => { try { return fs.realpathSync(path.resolve(String(p || ""))); } catch { return null; } })();
  if (!real || real.split(path.sep).some((s) => s.startsWith(".") && s !== ".")) {
    return real && real.startsWith(STATE + path.sep) ? real : null;
  }
  const home = HOME;
  const roots = [LEARNING, WORK, path.join(home, "Videos"), path.join(home, "Pictures"), path.join(home, "Downloads"), path.join(home, "Documents")];
  if (roots.some((r) => real === r || real.startsWith(r + path.sep))) return real;
  return null;
}

function serveFile(res, file, extraHeaders = {}) {
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const st = fs.statSync(file);
  // fonts: interactive figures run in a sandbox (an opaque origin), and a font from there is a CORS request
  const cors = /\.(woff2?|ttf|otf)$/i.test(file) ? { "Access-Control-Allow-Origin": "*" } : {};
  res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Cache-Control": "no-cache", ...cors, ...extraHeaders });
  fs.createReadStream(file).pipe(res);
}

// ---------- the figure theme, for interactive figures ----------

// The app's fonts and tokens (style.css up to its base rules), for pages that aren't the app: an interactive figure
// gets these and nothing of the app's own layout.
const tokensCss = () => { const css = fs.readFileSync(path.join(PUBLIC, "style.css"), "utf8"); const i = css.search(/\/\*[─\s]*3\. Base/); return i > 0 ? css.slice(0, i) : css; };

const ok = (res, extra = {}) => json(res, 200, { ok: true, ...extra });

async function route(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname, m = req.method;
  let mm;

  if (m === "GET" && (p === "/" || /^\/(t\/[a-z0-9-]+(\/(review|notes|files|transcript))?|review|profile|new|courses(\/[a-z0-9/-]*)?)\/?$/.test(p))) return serveFile(res, path.join(PUBLIC, "index.html"));
  if (m === "GET" && p === "/style-tokens.css") { res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" }); return res.end(tokensCss()); }
  if (m === "GET" && !p.startsWith("/api/")) {
    const f = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (f.startsWith(PUBLIC) && fs.existsSync(f) && fs.statSync(f).isFile()) return serveFile(res, f);
    return json(res, 404, { error: "not found" });
  }

  if (m === "GET" && p === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    const c = { res, topic: url.searchParams.get("topic") || undefined, home: !url.searchParams.get("topic") };
    clients.add(c);
    res.write(`data: ${JSON.stringify({ t: "hello" })}\n\n`);
    if (c.topic) {
      const st = engine.status(c.topic);
      res.write(`data: ${JSON.stringify({ t: "state", ...st })}\n\n`);
      if (store.getTopic(c.topic)) res.write(`data: ${JSON.stringify({ t: "board", board: boardView(c.topic) })}\n\n`);
      if (st.streaming) res.write(`data: ${JSON.stringify({ t: "text", id: st.streaming.id, text: st.streaming.text, streaming: true })}\n\n`);
      stage.refreshTopic(c.topic);
    }
    const ping = setInterval(() => res.write(": ping\n\n"), 25e3);
    req.on("close", () => { clearInterval(ping); clients.delete(c); });
    return;
  }

  if (await courses.route(req, res, url, readBody)) return;

  if (m === "GET" && p === "/api/home") {
    const due = review.counts();
    const topics = store.listSlugs().map((s) => summary(store.getTopic(s), due.by)).sort((a, b) => b.lastActive - a.lastActive);
    const list = found().map((g) => ({ key: g.key, title: g.title, mtime: g.mtime, live: g.live, summary: g.summary,
      sessions: g.sessions.map((s) => ({ via: s.via, thread: s.threadTitle, mtime: s.mtime })) }));
    return json(res, 200, { topics, found: list, due, sync: SYNC === "git-pr" ? lastSync() : null, focus: focusBlock() ? { goal: focusBlock().goal } : null,
      features: { sync: SYNC === "git-pr", capture: !!CAPTURE_CMD, open: !!OPEN_CMD, screen: screen.installed() && PROVIDER.can.screen }, tutor: TUTOR });
  }

  if (m === "POST" && p === "/api/upload") {
    const name = (url.searchParams.get("name") || "file").replace(/[^\w.\- ]+/g, "_").slice(-80);
    const dir = path.join(STATE, "uploads", String(Date.now()));
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, name);
    fs.writeFileSync(f, await readBody(req));
    return ok(res, { path: f, name });
  }

  if (m === "POST" && p === "/api/topics") {
    const b = JSON.parse(await readBody(req) || "{}");
    const text = String(b.text || "").trim();
    if (!text) return json(res, 400, { error: "say what you want to learn" });
    const t = store.createTopic({ slug: store.slugify(text), title: text.split("\n")[0].slice(0, 70), why: store.WHYS.includes(b.why) ? b.why : "",
      deadline: /^\d{4}-\d{2}-\d{2}$/.test(b.deadline || "") ? b.deadline : "", phase: "frame" });
    if (b.screen === true) store.mutateTopic(t.slug, (x) => { x.settings.screen = true; });
    const files = [];
    for (const up of b.files || []) {
      const src = readableFile(up);
      if (!src || !src.startsWith(path.join(STATE, "uploads"))) continue;
      const dst = path.join(store.topicDir(t.slug), "files", path.basename(src));
      fs.renameSync(src, dst);
      files.push(dst);
    }
    turn(t.slug, [], { start: text, files });
    homeChanged();
    return ok(res, { slug: t.slug });
  }

  if (m === "POST" && p === "/api/import") {
    const b = JSON.parse(await readBody(req) || "{}");
    try { const t = importSession(b.key); homeChanged(); return ok(res, { slug: t.slug }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (m === "POST" && p === "/api/dismiss") {
    const b = JSON.parse(await readBody(req) || "{}");
    const list = store.readJSON(store.globalFile("dismissed"), []);
    if (b.key && !list.includes(b.key)) list.push(b.key);
    store.writeJSON(store.globalFile("dismissed"), list);
    foundCache.at = 0;
    return ok(res);
  }

  if (m === "GET" && p === "/api/review") {
    return json(res, 200, { items: review.queue({ slug: url.searchParams.get("topic") || undefined, cram: url.searchParams.get("cram") === "1" }), due: review.counts() });
  }
  if (m === "POST" && p === "/api/review/grade") {
    const b = JSON.parse(await readBody(req) || "{}");
    gradedHere.add(`${b.slug}/${b.id}`);
    review.gradeItem(b.slug, b.id, !!b.good);
    homeChanged();
    return ok(res);
  }

  if (p === "/api/profile") {
    if (m === "GET") return json(res, 200, { text: store.readText(PROFILE) || "" });
    if (m === "PUT") { const b = JSON.parse(await readBody(req) || "{}"); fs.writeFileSync(PROFILE, String(b.text || "")); scheduleSync("profile edited", 5 * 60e3); return ok(res); }
  }

  if (m === "POST" && p === "/api/sync") { if (SYNC !== "git-pr") return json(res, 400, { error: "sync is off (TEACH_SYNC)" }); const r = await sync("by hand"); broadcast(null, { t: "sync", sync: r }); return ok(res, { sync: r }); }

  if (m === "GET" && p === "/api/file") {
    const f = readableFile(url.searchParams.get("path"));
    if (!f || !fs.statSync(f).isFile()) return json(res, 404, { error: "not available" });
    // Widgets the tutor wrote run sandboxed (opaque origin, no network but the app's own theme kit, fonts and KaTeX).
    if (/\.html?$/i.test(f)) {
      const csp = "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' data:; style-src 'self' 'unsafe-inline' data:; img-src 'self' data: blob:; font-src 'self' data:";
      // the kit goes into a page that follows the contract (skill/figures.md); one made before it keeps its own look
      const page = fs.readFileSync(f, "utf8");
      const body = Buffer.from(url.searchParams.has("fig") && !checkHtml(page).length ? withFigureKit(page, url.searchParams.get("theme")) : page);
      res.writeHead(200, { "Content-Type": MIME[".html"], "Content-Length": body.length, "Cache-Control": "no-cache", "Content-Security-Policy": csp });
      return res.end(body);
    }
    // an SVG opened on its own (the tab a figure's link opens) can't run anything
    return serveFile(res, f, /\.svg$/i.test(f) ? { "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:" } : {});
  }

  if (m === "POST" && p === "/api/capture") {
    const b = JSON.parse(await readBody(req) || "{}");
    const dir = path.join(STATE, "uploads", String(Date.now()));
    fs.mkdirSync(dir, { recursive: true });
    if (b.kind === "phone") {
      // TEACH_CAPTURE_CMD prints the newest photo (JPEG) taken since --since EPOCH, e.g. from a phone over adb.
      if (!CAPTURE_CMD) return json(res, 400, { error: "no capture command set up (TEACH_CAPTURE_CMD)" });
      const out = path.join(dir, `phone-${Date.now()}.jpg`);
      const since = Math.floor(Date.now() / 1000) - 6 * 3600;
      const [cmd, ...args] = splitCmd(CAPTURE_CMD);
      const r = await new Promise((resolve) => execFile(cmd, [...args, "--since", String(since)], { encoding: "buffer", maxBuffer: 40 << 20, timeout: 120e3 },
        (err, stdout, stderr) => resolve({ err, stdout, stderr })));
      if (r.err || r.stdout.length < 1000) return json(res, 502, { error: (String(r.stderr || "").trim() || "no new photo").slice(-200) });
      fs.writeFileSync(out, r.stdout);
      return ok(res, { path: out, name: path.basename(out) });
    }
    return json(res, 400, { error: "unknown capture" });
  }

  if (m === "GET" && p === "/api/topics") {
    return json(res, 200, { topics: store.listSlugs().map((s) => { const t = store.getTopic(s); return { slug: s, title: t.title, status: t.status, phase: t.phase, deadline: t.deadline,
      done: t.plan.filter((n) => n.status === "done").length, total: t.plan.length }; }) });
  }

  // A link clicked in an app-mode window (`teach open` with ?app=desktop): TEACH_OPEN_CMD opens it in the
  // learner's own browser, instead of a tab of the browser that frames the app.
  if (m === "POST" && p === "/api/open") {
    const b = JSON.parse(await readBody(req) || "{}");
    if (!/^https?:\/\/\S+$/.test(b.url || "")) return json(res, 400, { error: "only web links" });
    if (!OPEN_CMD) return json(res, 200, { ok: false, why: "no open command (TEACH_OPEN_CMD)" });
    const [cmd, ...args] = splitCmd(OPEN_CMD);
    const r = await new Promise((resolve) => execFile(cmd, [...args, b.url], { timeout: 20e3 },
      (err, stdout, stderr) => resolve({ err, stderr: String(stderr || "") })));
    return r.err ? json(res, 200, { ok: false, why: r.stderr.trim().slice(-160) || r.err.message }) : ok(res);
  }

  // A focus tool reports a block (goal + hard cap) when it starts, and clears it when it ends.
  if (m === "POST" && p === "/api/focus") {
    const b = JSON.parse(await readBody(req) || "{}");
    const f = path.join(STATE, "focus.json");
    if (b.goal && Number(b.until) > Date.now() / 1000) store.writeJSON(f, { goal: String(b.goal).slice(0, 400), until: Number(b.until) });
    else fs.rmSync(f, { force: true });
    homeChanged();
    return ok(res);
  }

  // `teach bring` on another machine: /teach transcripts (and an old-style log) from a machine the app doesn't run on.
  if (m === "GET" && p === "/api/sessions/known") {
    const linked = store.listSlugs().flatMap((s) => store.getTopic(s).sessions.map((x) => x.id));
    let here = [];
    try { here = fs.readdirSync(projectDir(WORK)).filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -6)); } catch { /* none yet */ }
    return json(res, 200, { linked, present: here });
  }
  if (m === "POST" && p === "/api/bring") {
    const b = JSON.parse((await readBody(req, 200 << 20)).toString() || "{}");
    if (!/^[0-9a-f-]{36}$/.test(b.id || "") || typeof b.jsonl !== "string") return json(res, 400, { error: "bad session" });
    const dst = path.join(projectDir(WORK), `${b.id}.jsonl`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (!fs.existsSync(dst) || fs.statSync(dst).size < Buffer.byteLength(b.jsonl)) fs.writeFileSync(dst, b.jsonl);
    const meta = store.readJSON(path.join(STATE, "brought.json"), {});
    meta[b.id] = { via: ["t3", "focus", "terminal"].includes(b.via) ? b.via : "terminal", thread: b.thread || "", threadTitle: String(b.threadTitle || "").slice(0, 200), from: String(b.from || "").slice(0, 60), at: store.now() };
    store.writeJSON(path.join(STATE, "brought.json"), meta);
    if (b.log && /^[a-z0-9][a-z0-9-]*\.md$/.test(b.log.name || "") && typeof b.log.text === "string") {
      const f = path.join(LEARNING, b.log.name);
      if (!fs.existsSync(f)) fs.writeFileSync(f, b.log.text);
    }
    foundCache.at = 0;
    homeChanged();
    return ok(res);
  }

  if ((mm = p.match(/^\/api\/topics\/([a-z0-9-]+)(?:\/([a-z-]+))?$/))) {
    const [, slug, action = ""] = mm;
    const t = store.getTopic(slug);
    if (!t) return json(res, 404, { error: "no such topic" });
    if (m === "GET" && action === "") {
      if (onScreenNow(t)) touchLink(slug);   // the lesson is open: Super+/ should reach it
      const deck = store.getDeck(slug);
      const byType = {}; for (const i of deck.items) byType[i.type] = (byType[i.type] || 0) + 1;
      return json(res, 200, { topic: t, status: { ...engine.status(slug), streaming: undefined }, link: { ...screen.link }, live: store.getRuntime(slug).live || null, deck: { byType, groups: deck.groups, total: deck.items.length },
        files: store.topicFiles(slug), hasLog: fs.existsSync(path.join(store.topicDir(slug), "log.md")), hasSheet: fs.existsSync(path.join(store.topicDir(slug), "sheet.md")),
        due: review.counts().by[slug] || 0, next: engine.isAlive(slug) ? null : engine.plan(slug), focus: !!focusBlock(),
        features: { sync: SYNC === "git-pr", capture: !!CAPTURE_CMD, open: !!OPEN_CMD, screen: screen.installed() && PROVIDER.can.screen }, tutor: TUTOR });
    }
    if (m === "GET" && action === "history") return json(res, 200, { items: topicHistory(t) });
    if (m === "GET" && action === "board") return json(res, 200, { board: boardView(slug) });
    if (m === "GET" && (action === "log" || action === "sheet")) return json(res, 200, { text: store.readText(path.join(store.topicDir(slug), `${action}.md`)) || "" });
    if (m === "GET" && action === "deck") return json(res, 200, store.getDeck(slug));
    if (m === "GET" && action === "actions") return json(res, 200, actionsView(slug));
    if (m === "GET" && action === "session-ics") {
      const s = t.outputs?.session?.session;
      if (!s) return json(res, 404, { error: "no session scheduled" });
      res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="${slug}-session.ics"`, "Cache-Control": "no-store" });
      return res.end(actions.ics({ uid: `${slug}-${Date.parse(s.at)}@teach`, title: s.title, start: s.at, minutes: s.minutes, remind: s.remind, url: `${URL_PUBLIC}/t/${slug}`,
        note: `Open it in Teach: ${URL_PUBLIC}/t/${slug}` }));
    }

    const b = m === "POST" ? JSON.parse((await readBody(req)).toString() || "{}") : {};
    if (m !== "POST") return json(res, 405, { error: "method" });
    switch (action) {
      case "message": {
        const content = [];
        for (const img of b.images || []) if (/^image\/(png|jpeg|gif|webp)$/.test(img.media_type) && img.data) content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
        const files = [];
        for (const up of b.files || []) {
          const src = readableFile(up);
          if (!src) continue;
          let dst = src;
          if (src.startsWith(path.join(STATE, "uploads"))) { dst = path.join(store.topicDir(slug), "files", path.basename(src)); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.renameSync(src, dst); }
          files.push(dst);
          if (/\.(png|jpe?g|gif|webp)$/i.test(dst) && fs.statSync(dst).size < 4.5e6) content.push({ type: "image", source: { type: "base64", media_type: MIME[path.extname(dst).toLowerCase()], data: fs.readFileSync(dst).toString("base64") } });
        }
        const text = String(b.text || "").trim();
        if (text || files.length) content.push({ type: "text", text: text + (files.length ? `${text ? "\n\n" : ""}Attached: ${files.join(", ")}` : "") });
        if (!content.length) return json(res, 400, { error: "empty" });
        // Super+/ on the screen (`teach tell`): the page didn't echo it, so show it there
        if (b.via === "screen") emit(slug, { t: "user", id: `screen-${Date.now()}`, text, images: [], at: store.now(), via: "screen" });
        const user = { text, images: content.filter((c) => c.type === "image").length };
        typing.delete(slug);   // it's sent: the tutor answering it may take the lesson to the screen
        // the tutor is waiting on the screen: hand the words to that watch, which answers within the same turn
        if (engine.status(slug).watching !== null && content.length === 1 && text) {
          boardApply(slug, { t: "turn", id: `live-${boardInst}-${++turnSeq}`, user });
          screen.toInbox(slug, text);
          return ok(res, { to: "watch" });
        }
        turn(slug, content, { user });
        return ok(res);
      }
      case "answer": {
        typing.delete(slug);
        try { return ok(res, { results: answerSet(slug, b.id, Array.isArray(b.answers) ? b.answers : [], "app") }); }
        catch (e) { return json(res, e.code || 400, { error: e.message }); }
      }
      case "skip": {
        const item = askItem(slug, b.id);
        if (!item) return json(res, 404, { error: "no such question set" });
        if (item.status !== "pending") return json(res, 409, { error: "already answered" });
        offScreen(b.id);
        emit(slug, { t: "ask", id: b.id, status: "skipped", ask: item.ask });
        turn(slug, [{ type: "text", text: `[Answers to question set ${b.id}]\n(${Learner} skipped these: they'll answer in their own words or want to move on.)` }], { answers: b.id });
        return ok(res);
      }
      case "continue":
        // backfill: a session just brought in from chat fills the sidebar and stops, ready for when it's opened.
        if (b.backfill) closeAfter.add(slug);
        turn(slug, [], { fresh: !!b.fresh, backfill: !!b.backfill });
        return ok(res);
      case "live": {   // the tutor's screen tool (by "tutor"), or the page's "Stay on the board" (by "learner")
        if (!["screen", "board"].includes(b.to)) return json(res, 400, { error: 'to must be "screen" or "board"' });
        return json(res, 200, await moveLesson(slug, { to: b.to, why: b.why, stay: !!b.stay, by: b.by === "learner" ? "learner" : "tutor" }));
      }
      case "typing":   // the page: a key in the composer or a question card (draft: unsent text there), or sent (it went)
        if (b.sent) typing.delete(slug); else typing.set(slug, { at: Date.now(), draft: !!b.draft });
        return ok(res);
      case "actions": {
        try { await actionOp(slug, b); return ok(res, { view: actionsView(slug) }); }
        catch (e) { return json(res, e.code || 400, { error: e.message }); }
      }
      case "stop": if (jobs.has(slug) && store.getTopic(slug).outputs?.[jobs.get(slug).kind]?.state === "working") { pauseAction(slug, jobs.get(slug).kind); return ok(res); }   // Esc while making something: a pause
        engine.interrupt(slug); if (onScreenNow(t)) screen.hush(); return ok(res);
      case "pause": case "done": endSession(slug, action); return ok(res);
      case "fresh": {
        engine.close(slug);
        store.mutateTopic(slug, (x) => { const last = x.sessions.at(-1); if (last) last.fresh = true; });
        return ok(res);
      }
      case "settings": {
        const wasScreen = !!t.settings.screen;
        store.mutateTopic(slug, (x) => {
          if (["opus", "sonnet", "fable"].includes(b.model)) x.settings.model = b.model;
          if (["medium", "high", "xhigh"].includes(b.effort)) x.settings.effort = b.effort;
          if (typeof b.review === "boolean") x.settings.review = b.review;
          if (typeof b.screen === "boolean" && (PROVIDER.can.screen || !b.screen)) x.settings.screen = b.screen;   // (screen mode: Claude Code only)
          if (typeof b.voice === "boolean") x.settings.voice = b.voice;
          if (typeof b.autoScreen === "boolean") x.settings.autoScreen = b.autoScreen;
          if (typeof b.title === "string" && b.title.trim()) x.title = b.title.trim().slice(0, 90);
          if (typeof b.deadline === "string" && (!b.deadline || /^\d{4}-\d{2}-\d{2}$/.test(b.deadline))) x.deadline = b.deadline;
          if (store.STATUSES.includes(b.status)) x.status = b.status;
        });
        if (typeof b.screen === "boolean" && b.screen !== wasScreen && !!store.getTopic(slug).settings.screen === b.screen) {   // (refused on a provider without screen mode)
          const wasLive = !!store.getRuntime(slug).live;
          if (wasLive) store.mutateRuntime(slug, (r) => { delete r.live; });   // their switch takes over the tutor's stretch
          if (!b.screen) {
            screen.hush(); screen.unlink(slug, onLink); screen.chalk(["clear"]);
            for (const [id, s] of onScreen) if (s.slug === slug) offScreen(id);
          }
          // (switched on during a stretch the tutor started: it's on their screen already, and now stays there)
          if (!(b.screen && wasLive)) switchMode(slug, b.screen ? SCREEN_ON : engine.isAlive(slug) ? SCREEN_OFF : null);
          if (wasLive) emit(slug, { t: "live", live: null });
        }
        if (b.voice === false) screen.hush();
        emit(slug, { t: "topic" });
        return ok(res);
      }
      case "board": {
        // the learner's own board actions: close a block, pin or unpin one, fold it onto the shelf or open it, keep the tutor's reply as a note
        if (!["dismiss", "pin", "unpin", "shelve", "show", "keep"].includes(b.op)) return json(res, 400, { error: "op must be dismiss, pin, unpin, shelve, show or keep" });
        const bd = boardOf(slug), target = bd.blocks.find((x) => x.id === String(b.target || ""));
        if (b.op !== "keep" && !target) return json(res, 404, { error: "that block isn't on the board" });
        if ((b.op === "dismiss" || b.op === "shelve") && target.kind === "ask" && target.status === "pending") return json(res, 409, { error: "answer or skip it" });
        const op = { t: "learner", id: `l-${Date.now().toString(36)}`, op: b.op, target: target?.id, at: store.now() };
        if (b.op === "keep") {
          op.text = bd.reply.parts.map((x) => x.text).join("\n\n");
          if (!op.text.trim()) return json(res, 409, { error: "nothing to keep" });
          op.title = String(b.title || "").slice(0, 120);
        }
        store.mutateRuntime(slug, (r) => { r.boardOps = [...(r.boardOps || []), op].slice(-400); });
        boardApply(slug, op);
        const what = target ? `"${board.titleOf(target)}" (\`${target.id}\`)` : "";
        const note = { dismiss: `${Learner} closed ${what} on the board.`, pin: `${Learner} pinned ${what} on the board.`, unpin: `${Learner} unpinned ${what}.`,
          shelve: `${Learner} folded ${what} onto the shelf.`, show: `${Learner} opened ${what} from the shelf: it stays in view until they fold it.`,
          keep: `${Learner} kept your last reply on the board as a pinned note (\`${op.id}\`).` }[b.op];
        const lines = boardNotes.get(slug) || [];
        if (!lines.includes(note)) boardNotes.set(slug, [...lines, note]);
        return ok(res, { id: op.id });
      }
      case "visualize": {
        // "Visualize it" on a note: start (or another view), cancel, hide, show
        const noteId = String(b.note || "");
        const note = boardOf(slug).blocks.find((x) => x.kind === "note" && x.id === noteId);
        if (!visualize.noteIdOk(noteId)) return json(res, 400, { error: "note is a note's id" });
        if (b.op === "cancel") { visualize.cancel(slug, noteId); return ok(res); }
        if (b.op === "hide" || b.op === "show") {
          if (!visualize.visualOf(t, noteId)) return json(res, 404, { error: "that note has no visual" });
          store.mutateTopic(slug, (x) => { x.visuals[noteId].hidden = b.op === "hide"; });
          if (b.op === "hide") stage.close(visualStage(slug, noteId));
          boardNow(slug);
          return ok(res);
        }
        if (b.op !== "start") return json(res, 400, { error: "op must be start, cancel, hide or show" });
        if (!note) return json(res, 404, { error: "that note isn't on the board" });
        const job = visualize.start(slug, { id: note.id, title: note.title || "", body: note.body || "" }, {
          topic: t, provider: PROVIDER.id, model: ["opus", "sonnet", "fable"].includes(t.settings.model) ? t.settings.model : "opus", effort: process.env.TEACH_VISUALIZE_EFFORT || "medium",
          stage: stage.available() ? { available: true, dir: stage.dir(), storyboard: stage.storyboard } : null,
          render: (file) => renderFigure(file),
        });
        return ok(res, { job });
      }
      case "stage": {
        const id = String(b.id || "");
        if (b.op === "predict") {
          try { return ok(res, { result: predictOnStage(slug, id, Math.trunc(Number(b.step)), b.answer || {}) }); }
          catch (e) { return json(res, e.code || 400, { error: e.message }); }
        }
        if (b.op === "open" && id.startsWith("vis:")) {   // a note's own visual: vis:<topic>:<note id>
          const [, of, ...rest] = id.split(":");
          const v = of === slug ? visualize.visualOf(t, rest.join(":")) : null;
          if (!v || v.kind !== "scene") return json(res, 404, { error: "that note has no scene" });
          if (!stage.available()) return json(res, 503, { error: "chalk's scene host isn't installed on this machine" });
          stage.show(slug, id, v.scene, []);
          stage.input(id, { op: "refresh" });
          return ok(res);
        }
        if (b.op === "open") {
          const item = boardOf(slug).blocks.find((x) => x.kind === "scene" && x.id === id);
          if (!item) return json(res, 404, { error: "that scene isn't on the board" });
          if (!stage.available()) return json(res, 503, { error: "chalk's scene host isn't installed on this machine" });
          showScene(slug, id, { ...item.scene, replaces: undefined }, item.predictions || {});
          stage.input(id, { op: "refresh" });
          return ok(res);
        }
        if (!["pointer", "key", "act"].includes(b.op)) return json(res, 400, { error: "op must be open, pointer, key, act or predict" });
        const m = { op: b.op, seq: Number(b.seq) || 0 };
        for (const k of ["t", "x", "y", "name", "char", "action"]) if (b[k] !== undefined) m[k] = b[k];
        return stage.input(id, m) ? ok(res) : json(res, 404, { error: "that scene isn't open" });
      }
      case "op": {
        // The teach tools for a session outside the app (the `teach` command): same code path as the MCP server.
        const fn = { update: ops.update, plan: ops.plan, step: ops.step, cards: ops.cards }[b.op];
        if (!fn) return json(res, 400, { error: "op must be update, plan, step or cards" });
        try { const r = fn(slug, b.args || {}); emit(slug, { t: "topic" }); return ok(res, { result: b.op === "cards" ? r : undefined, summary: b.op === "plan" ? ops.scopeSummary(r) : undefined }); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      default: return json(res, 404, { error: "unknown action" });
    }
  }
  return json(res, 404, { error: "not found" });
}

// Review grades from the screen: the tutor's `review` tool grades cards in another process (mcp.mjs). Tell the
// open pages which items changed, so the Review tab drops a card already done on screen. Grades the app made
// itself are left out (the page that made them has moved on already).
const gradedHere = new Set();
let reviewLast = review.lastSeen();
try {
  fs.mkdirSync(STATE, { recursive: true });   // a fresh install has no state yet
  let t = null;
  fs.watch(STATE, (_, file) => {
    if (file !== "review.json") return;
    clearTimeout(t);
    t = setTimeout(() => {
      const now = review.lastSeen(), keys = Object.keys(now).filter((k) => now[k] !== reviewLast[k] && !gradedHere.delete(k));
      reviewLast = now;
      if (keys.length) { broadcast(null, { t: "reviewed", keys }); homeChanged(); }
    }, 150);
  });
} catch (e) { console.error("teach: can't watch the review schedule:", e.message); }

// Topic files changed outside a session we run (the CLI, an edit by hand, a git pull): refresh the pages.
try {
  fs.mkdirSync(TOPICS, { recursive: true });
  const pending = new Map();
  fs.watch(TOPICS, { recursive: true }, (_, file) => {
    const slug = String(file || "").split(path.sep)[0];
    if (!store.validSlug(slug)) return;
    clearTimeout(pending.get(slug));
    pending.set(slug, setTimeout(() => { emit(slug, { t: "topic" }); }, 300));
  });
} catch (e) { console.error("teach: can't watch topics:", e.message); }

const server = http.createServer((req, res) => {
  if (!allowed(req)) return json(res, 403, { error: "forbidden" });
  route(req, res).catch((e) => { console.error(e); if (!res.headersSent) json(res, 500, { error: String(e.message || e) }); else res.end(); });
});
if (SOCKET) {
  fs.mkdirSync(path.dirname(SOCKET), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(SOCKET), 0o700);
  fs.rmSync(SOCKET, { force: true });
  server.listen(SOCKET, () => { fs.chmodSync(SOCKET, 0o600); console.log(`teach: listening on ${SOCKET} (data ${LEARNING}, state ${STATE})`); });
} else {
  server.listen(PORT, HOST, () => console.log(`teach: http://teach.localhost:${PORT} (data ${LEARNING}, state ${STATE})`));
}
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { engine.closeAll(); stage.stop(); setTimeout(() => process.exit(0), 1500); });
