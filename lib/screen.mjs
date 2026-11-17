// Screen mode: the lesson happens on the learner's screen. The tutor sees it and marks it through chalk
// (screen-chalk, github.com/aidenwboudr/screen-chalk: screen_look/screen_draw/screen_clear), speaks through
// `chalk say`, and waits for them to do each step with `chalk watch`. While it waits, what they say (the app's
// composer, or chalk's Super+/ hotkey, which `chalk route` points at this topic) goes to the waiting tool through
// an inbox file instead of a new turn, so the tutor answers at once.
//
// The app's own interactions come to the screen too, as chalk panels (cards they click or type into, next to
// the code they're about): question sets (`ask`), review cards (the `review` tool) and progress toasts. Their
// answers come back here and go through the same grading, logging and review schedule as the app's own cards.
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOME, STATE } from "./paths.mjs";

// chalk's commands: TEACH_CHALK / TEACH_CHALK_MCP, else the first on PATH, else ~/.local/bin (where chalk installs).
const onPath = (name) => {
  for (const d of [...String(process.env.PATH || "").split(path.delimiter), path.join(HOME, ".local/bin")]) {
    const f = path.join(d || ".", name);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ }
  }
  return path.join(HOME, ".local/bin", name);
};
export const CHALK = process.env.TEACH_CHALK || onPath("chalk");
export const CHALK_MCP = process.env.TEACH_CHALK_MCP || onPath("chalk-mcp");
export const installed = () => fs.existsSync(CHALK);
const DIR = path.join(STATE, "screen");
export const ROUTE_TTL = 1800;   // seconds Super+/ keeps going to the tutor after its last watch

export const inboxFile = (slug) => path.join(DIR, `${slug}.inbox`);

// Something the learner said while the tutor was watching their screen: queued for the watch tool to pick up.
export function toInbox(slug, text) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(inboxFile(slug), JSON.stringify({ text, at: new Date().toISOString() }) + "\n");
}

// Take everything queued (oldest first) and empty the inbox.
export function takeInbox(slug) {
  const f = inboxFile(slug), tmp = `${f}.${process.pid}`;
  try { fs.renameSync(f, tmp); } catch { return []; }
  const lines = fs.readFileSync(tmp, "utf8").split("\n").filter(Boolean);
  fs.rmSync(tmp, { force: true });
  return lines.map((l) => { try { return JSON.parse(l).text; } catch { return null; } }).filter(Boolean);
}

// Fire-and-forget chalk commands (speech, hush, route): never block the caller, never throw.
export function chalk(args, { detached = true } = {}) {
  try {
    const p = spawn(CHALK, args, { detached, stdio: "ignore" });
    p.on("error", () => {});
    if (detached) p.unref();
    return p;
  } catch { return null; }
}

export const hush = () => chalk(["hush"]);
export const toast = (text, color = "green") => chalk(["toast", text, "--color", color]);

// ---------- the Super+/ link ----------

// Super+/ on the learner's computer asks the tutor while chalk's route file names a lesson; chalk lets it lapse ROUTE_TTL
// after it was last set. It used to be set only by `watch`, so a stretch of question cards, a reply in text, a
// computer that slept through the call or a server restart dropped Super+/ back to plain chalk without a word.
// Now the server owns it: it re-sets the route on every turn of a screen lesson and every LINK_BEAT while the
// lesson is live, takes it down only when the lesson stops, and says so on their screen when it changes.
export const LINK_BEAT = 10 * 60e3;
export const link = { slug: null, title: "", ok: null, at: 0, error: "" };
let linking = Promise.resolve();

function run(args, timeout = 25e3) {
  return new Promise((resolve) => {
    execFile(CHALK, args, { timeout }, (err, stdout, stderr) => resolve({ err, out: String(stdout || ""), errText: String(stderr || err?.message || "") }));
  });
}

// Point Super+/ at this lesson. Resolves to the link; onChange runs when what the hotkey does changed.
export function linkTo(slug, title, onChange = () => {}) {
  linking = linking.then(async () => {
    const r = await run(["route", "teach", slug, title]);
    let now = null;
    try { now = JSON.parse(r.out.trim().split("\n").at(-1)); } catch { /* chalk couldn't reach the laptop */ }
    const ok = now?.slug === slug;
    const changed = link.slug !== slug || link.ok !== ok;
    Object.assign(link, { slug, title, ok, at: Date.now(), error: ok ? "" : (r.errText.trim().split("\n").at(-1) || "chalk didn't answer").slice(0, 160) });
    if (changed && ok) toast(`Super+/ asks your tutor · ${shortTitle(title)}`, "blue");
    if (changed) onChange({ ...link });
    return { ...link };
  });
  return linking;
}

// Take Super+/ back to plain chalk, but only if it still points at this lesson (quiet: no toast, the caller says it).
export function unlink(slug, onChange = () => {}, { quiet = false } = {}) {
  linking = linking.then(async () => {
    if (link.slug !== slug) return { ...link };
    const r = await run(["route", "off"]);
    Object.assign(link, { slug: null, title: "", ok: r.err ? false : null, at: Date.now(), error: "" });
    if (!r.err && !quiet) toast("Super+/ is plain chalk again", "yellow");
    onChange({ ...link });
    return { ...link };
  });
  return linking;
}

const shortTitle = (t) => String(t || "").split(/[(:]/)[0].trim().slice(0, 40);

// Roughly how long a line takes to say: Kokoro at speed 1.05 runs ~2.7 words a second, plus ~1 s to the first sound.
export const speakSeconds = (text) => Math.round(1 + String(text).split(/\s+/).filter(Boolean).length / 2.7);

// ---------- panels ----------

// Put a panel up (spec: projects/chalk/panel.py) and wait for them: resolves to chalk's result
// ({status: "answered", answers | button} / "dismissed" / "gone"), or {status: "error"} when chalk can't reach
// the learner's computer. cancel() stops waiting and takes the panel down (it was answered in the app instead).
export function panel(spec) {
  const child = spawn(CHALK, ["panel", JSON.stringify(spec), "--wait"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "", cancelled = false;
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const done = new Promise((resolve) => {
    child.on("error", (e) => resolve({ status: "error", error: e.message }));
    child.on("close", (code) => {
      if (cancelled) return resolve({ status: "cancelled" });
      try { resolve(JSON.parse(out.trim().split("\n").at(-1))); }
      catch { resolve({ status: "error", error: `chalk exit ${code}: ${(err || out).trim().slice(-200)}` }); }
    });
  });
  const cancel = () => {
    cancelled = true;
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
    chalk(["remove", spec.tag]);
  };
  return { done, cancel, tag: spec.tag };
}

// Question kinds a panel can take; `order` (drag to reorder) and pictures stay in the app.
const PANEL_KINDS = new Set(["choice", "multi", "text", "number", "task"]);
export const screenable = (ask) => ask.questions.every((q) => PANEL_KINDS.has(q.kind) && !q.image);

const PURPOSE = { probe: "Where are you?", check: "Quick check", review: "Review", setup: "Before we start", approve: "Your call", practice: "Practice" };

// "Neural network · step 10 of 21": the topic and where the plan stands, in every panel's header.
export function progressLine(topic) {
  const plan = topic?.plan || [];
  const cur = plan.findIndex((n) => n.status === "current");
  const title = String(topic?.title || "").split(/[(:]/)[0].trim();
  if (!plan.length) return title;
  return `${title} · ${cur >= 0 ? `step ${cur + 1} of ${plan.length}` : `${plan.filter((n) => n.status === "done").length} of ${plan.length} done`}`;
}

// A question set (as the app shows it: shuffled, with answer keys) -> a chalk panel spec.
export function askPanel(topic, id, ask) {
  const node = ask.node && topic.plan.find((n) => n.id === ask.node);
  return {
    tag: `teach-ask-${id}`, sub: progressLine(topic),
    title: `${PURPOSE[ask.purpose] || "Questions"}${node ? `: ${node.title}` : ""}`,
    intro: ask.intro || undefined, box: ask.box || undefined,
    questions: ask.questions.map((q) => ({
      kind: q.kind, prompt: q.prompt, options: q.options, answer: q.answer, tolerance: q.tolerance, unit: q.unit,
      why: q.why, idk: q.idk, placeholder: q.placeholder,
    })),
  };
}

// One review item (lib/review.mjs) -> a panel: flashcards, recall and traps reveal the answer and they grade
// himself (Again / Good); multiple choice grades itself and waits for Next.
export function reviewPanel(item, i, n, tag) {
  const head = { tag, sub: `${item.topic ? `${String(item.topic).split(/[(:]/)[0].trim()} · ` : ""}review ${i + 1} of ${n}` };
  const grade = [{ label: "Again", value: "again", key: "a", color: "red" }, { label: "Good", value: "good", key: "g", color: "green" }];
  switch (item.type) {
    case "mcq":
      return { ...head, hold: true, next_label: i < n - 1 ? "Next card ›   Enter" : "Done   Enter",
        questions: [{ kind: "choice", prompt: item.prompt, options: item.options, answer: item.answer, why: item.why, idk: true }] };
    case "recall":
      return { ...head, title: "Say it, then check", text: item.prompt, reveal: item.answer, buttons: grade };
    case "trap":
      return { ...head, title: "Spot the trap", text: `“${item.wrong}”\n\nWhat's wrong with it?`, reveal: item.right, buttons: grade };
    default:
      return { ...head, title: "Recall", text: item.front, reveal: item.back, buttons: grade };
  }
}

// Did they get a review panel right? null when they walked away from it.
export function reviewGood(item, r) {
  if (r.status !== "answered") return null;
  if (item.type === "mcq") return r.answers?.[0]?.choice === item.answer;
  return r.button === "good";
}

// ---------- the tutor takes a step onto the screen ----------

// With chalk installed, the tutor decides by itself when a step works better live on the learner's screen (the app they
// are using, a datasheet, their editor) and moves there with the `screen` tool, then back to the board when it's done:
// the same way it lays out the board. The tools are attached from the start either way; "live" only says whether
// they work right now, so a switch costs no restart. The learner's "On my screen" switch is the other way on, and
// theirs alone to turn off.

export const TYPING_MS = 12e3;   // a key in the Teach window this recently: they're typing, don't move the lesson away
export const DRAFT_MS = 90e3;    // an unsent draft (or a half-answered card) touched this recently counts too

// What a screen tool answers while the lesson is on the board (chalk's tools through the engine's hook, say/watch/review here).
export const OFF_SCREEN = `The lesson is on the Teach board right now, not on their screen, so the screen tools are off. To teach this step on their screen, call the teach tool "screen" with to: "screen" first; otherwise keep it on the board.`;

// Is the lesson on the learner's screen right now: their switch, or a stretch the tutor started.
export const isLive = (topic, rt) => !!topic?.settings?.screen || !!rt?.live;

// Should a `screen` request go through? Pure: everything it weighs comes in. `to` is "screen" or "board"; `by` is
// "tutor" or "learner"; `probe` is what `chalk ready` said (left out: everything else allows it, so ask the screen).
// Returns { ok, change: "live" | "board" | null, probe?, reason } (reason is for the tutor, in plain words). "Stay on
// the board" (settings.autoScreen = false) is the caller's to record; from then on this refuses every move to the screen.
export function liveDecision({ to, by = "tutor", installed: has = true, settings = {}, live = null, typing = null, probe, now = Date.now(), who = "the learner" }) {
  const no = (reason) => ({ ok: false, change: null, reason });
  if (to === "board") {
    if (settings.screen && by !== "learner") return no(`${who} turned "On my screen" on themselves, so the lesson stays on their screen; only they switch it off.`);
    if (live) return { ok: true, change: "board", reason: "Back on the board." };
    return { ok: true, change: null, reason: "The lesson is on the board already." };
  }
  if (to !== "screen") return no(`to must be "screen" or "board"`);
  if (!has) return no("There's no chalk on this machine, so the lesson can't go onto their screen. Teach it on the board.");
  if (settings.screen || live) return { ok: true, change: null, reason: "The lesson is on their screen already." };
  if (settings.autoScreen === false) return no(`${who} asked to stay on the board for this topic. Teach it here (they can turn "On my screen" on themselves); don't ask again.`);
  if (typing && (now - typing.at < TYPING_MS || (typing.draft && now - typing.at < DRAFT_MS))) {
    return no(`${who} is typing in the Teach window right now. Don't pull them away mid-sentence: carry on here, and try again once they've sent it.`);
  }
  if (probe === undefined) return { ok: false, change: null, probe: true, reason: "" };
  if (probe.unreachable) return no(`Their screen isn't reachable (the computer is asleep or offline${probe.error ? `: ${probe.error}` : ""}). Teach it on the board.`);
  if (probe.locked) return no("Their screen is locked. Teach it on the board; try again later only if they say they're back at the computer.");
  if (probe.awake === false) return no("Their screen is asleep (the display is off). Teach it on the board.");
  return { ok: true, change: "live", reason: "" };
}

// Is the learner's screen there right now? `chalk ready` (forwarded over ssh like every chalk command) says whether
// it's locked and whether a display is on. Resolves to { ready, locked, awake }, { unreachable, error } when chalk
// couldn't reach it, or { ready: null } from a chalk too old to know `ready` (then the screen only has to answer).
export async function ready() {
  const r = await run(["ready"], 15e3);
  try {
    const v = JSON.parse(r.out.trim().split("\n").at(-1));
    if (typeof v?.ready === "boolean") return { ready: v.ready, locked: !!v.locked, awake: v.awake !== false };
  } catch { /* not JSON */ }
  if (/^chalk: let an agent/.test(r.out)) return { ready: null };   // an older chalk printed its help: it doesn't know `ready`
  return { unreachable: true, error: (r.errText.trim().split("\n").at(-1) || "no answer").replace(/^chalk: /, "").slice(0, 120) };
}
