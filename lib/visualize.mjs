// "Visualize it": a note on the board gets a picture of its own, made only when the learner asks (the button at the
// bottom right of every note card). One model call writes it, the app checks it, and it's kept with the topic
// (topic.json `visuals`, keyed by the note's id), so it stays across reloads, pins and the tutor replacing the note.
//
// The picture is a chalk scene when the app has chalk's scene engine (the same renderer, prompt and second look chalk
// uses for its own visuals: animated, a knob to drag, steps), else an SVG drawn to the figure contract (skill/figures.md)
// and themed by the figure kit. Either way it has to pass the figure checks (lib/figures.mjs) before it's shown:
// a problem goes back to the model once to fix; a picture that still fails isn't kept.
//
// A job runs one model process at a time; cancel kills it (and its children), so a cancelled visual costs nothing more.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { APP, CLAUDE, CODEX, GEMINI, MODEL, LOCAL_URL, LOCAL_KEY_ENV, STATE, LEARNER, splitCmd } from "./paths.mjs";
import { command } from "./platform.mjs";
import { checkScene, checkSvg, checkPng } from "./figures.mjs";
import * as store from "./store.mjs";
import { topicDir } from "./store.mjs";

export const NOTE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
// (and not a name every object has: a note called "constructor" or "__proto__" has no visual of its own)
export const noteIdOk = (id) => NOTE_ID.test(String(id)) && !(String(id) in Object.prototype);
export const visualOf = (topic, id) => (topic?.visuals && Object.hasOwn(topic.visuals, id) ? topic.visuals[id] : null);
const jobs = new Map();   // `${slug}\n${note}` -> { state, sub, error, proc, cancelled, started }
let onChange = () => {};
export function listen(fn) { onChange = fn; }

const key = (slug, note) => `${slug}\n${note}`;
export const job = (slug, note) => { const j = jobs.get(key(slug, note)); return j ? { state: j.state, sub: j.sub, error: j.error, started: j.started } : null; };
export const jobsFor = (slug) => Object.fromEntries([...jobs].filter(([k]) => k.startsWith(slug + "\n")).map(([k, j]) => [k.slice(slug.length + 1), { state: j.state, sub: j.sub, error: j.error, started: j.started }]));
export const hashBody = (s) => crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 12);

// ---------- the model ----------

// One prompt in, one answer out, on the topic's provider (or TEACH_VISUALIZE_CMD: a command that reads the prompt on
// stdin and prints the answer, with the image paths in TEACH_VISUALIZE_IMAGES). No tools, no session kept.
export function modelCommand({ provider = "claude", prompt, images = [], model = "opus", effort = "high", tmp }) {
  const custom = process.env.TEACH_VISUALIZE_CMD;
  if (custom) {
    const [cmd, ...args] = splitCmd(custom);
    return { cmd, args, input: prompt, env: { TEACH_VISUALIZE_IMAGES: images.join("\n") }, read: (out) => out };
  }
  if (provider === "claude") {
    const content = [...images.map((f) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: fs.readFileSync(f).toString("base64") } })), { type: "text", text: prompt }];
    // --bare (no CLAUDE.md, hooks or plugins: a clean, quick call) needs a key or token in the environment; a plain
    // `claude login` doesn't have one, so it goes without.
    const bare = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    return {
      cmd: CLAUDE, args: ["-p", ...(bare ? ["--bare"] : []), "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
        "--tools", "", "--strict-mcp-config", "--model", MODEL || model, "--effort", effort],
      input: JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n",
      read(out) {
        let res = null;
        for (const line of out.split("\n")) { try { const m = JSON.parse(line); if (m.type === "result") res = m; } catch { /* partial */ } }
        if (!res) throw new Error("the model gave no answer");
        if (res.is_error) throw new Error(String(res.result || res.subtype || "the model failed").slice(0, 300));
        return String(res.result || "");
      },
    };
  }
  if (provider === "codex" || provider === "local") {
    const last = path.join(tmp, "answer.txt");
    const args = ["exec", "--skip-git-repo-check", "-s", "read-only", "--output-last-message", last, ...images.flatMap((f) => ["-i", f])];
    if (provider === "local") args.push("-c", 'model_provider="teach_local"', "-c", `model_providers.teach_local={ name = "Local model (Teach)", base_url = ${JSON.stringify(LOCAL_URL)}, wire_api = "responses"${LOCAL_KEY_ENV ? `, env_key = ${JSON.stringify(LOCAL_KEY_ENV)}` : ""} }`);
    if (MODEL) args.push("-m", MODEL);
    args.push("-");
    return { cmd: CODEX, args, input: prompt, read: () => fs.readFileSync(last, "utf8") };
  }
  if (provider === "gemini") return { cmd: GEMINI, args: ["-o", "text", ...(MODEL ? ["-m", MODEL] : []), "-p", "Follow the instructions above."], input: prompt, read: (out) => out };
  throw new Error(`no visualize for provider ${provider}`);
}

function run(j, spec) {
  return new Promise((resolve, reject) => {
    if (j.cancelled) return reject(cancelled());
    const c = command(spec.cmd, spec.args);
    const env = { ...process.env, ...(spec.env || {}) };
    for (const k of Object.keys(env)) if (/^CLAUDE_CODE_(SESSION|ENTRYPOINT|CHILD)|^CLAUDECODE$/.test(k)) delete env[k];
    const p = spawn(c.file, c.args, { cwd: j.tmp, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    j.proc = p;
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    p.stdin.on("error", () => {});
    p.stdin.end(spec.input);
    const timer = setTimeout(() => kill(p), spec.timeout || 6 * 60e3);
    p.on("error", (e) => { clearTimeout(timer); reject(new Error(`couldn't start ${spec.cmd}: ${e.message}`)); });
    p.on("close", (code) => {
      clearTimeout(timer);
      j.proc = null;
      if (j.cancelled) return reject(cancelled());
      if (code !== 0 && !out.trim()) return reject(new Error((err.trim().split("\n").pop() || `exit ${code}`).slice(0, 300)));
      try { resolve(spec.read(out)); } catch (e) { reject(e); }
    });
  });
}

// The whole process group (claude starts its own children), or the tree on Windows.
function kill(p) {
  if (!p || p.exitCode !== null) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-p.pid, "SIGTERM");
  } catch { try { p.kill("SIGTERM"); } catch { /* gone */ } }
  setTimeout(() => { try { if (p.exitCode === null) process.platform === "win32" ? p.kill() : process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } }, 3000).unref();
}
const cancelled = () => Object.assign(new Error("cancelled"), { cancelled: true });

// One prompt, one answer, for the other features that need a single model call (lib/coursework.mjs: loading a course,
// a pre-test, a grade). Returns { promise, cancel }; cancel kills the process, so a cancelled call costs nothing more.
export function askModel({ provider = "claude", prompt, images = [], model = "opus", effort = "high", timeout = 10 * 60e3 }) {
  const j = { cancelled: false, proc: null, tmp: fs.mkdtempSync(path.join(os.tmpdir(), "teach-ask-")) };
  const promise = run(j, { ...modelCommand({ provider, prompt, images, model, effort, tmp: j.tmp }), timeout })
    .finally(() => fs.rm(j.tmp, { recursive: true, force: true }, () => {}));
  return { promise, cancel() { j.cancelled = true; kill(j.proc); } };
}

// The JSON object in a model's answer (it may wrap it in a fence or a sentence).
export function answerJSON(text) {
  const s = String(text || "").replace(/^```(?:json)?\s*|```\s*$/gm, "");
  const i = s.indexOf("{"), k = s.lastIndexOf("}");
  if (i < 0 || k < i) throw new Error("the answer had no JSON");
  return JSON.parse(s.slice(i, k + 1));
}

// ---------- prompts ----------

// chalk's own scene prompt and check (its checkout's scene.md and scene-check.md), minus the parts about a screenshot
// of the user's screen: the format, what makes a good scene, the checks and the layout rules stay word for word.
function chalkText(dir, file) { try { return fs.readFileSync(path.join(dir, file), "utf8"); } catch { return ""; } }
export function scenePrompt(chalkDir, { topic, note, previous, hasFigure }) {
  const md = chalkText(chalkDir, "scene.md");
  const good = md.slice(md.indexOf("What makes a good scene:"), md.indexOf("Reply JSON:")).replace(/from the screen/g, "from the note").trim();
  const format = md.slice(md.indexOf("params:")).trim();
  return [
    `You are a 3Blue1Brown-style animator inside the Teach app, a one-to-one tutor. ${LEARNER === "the learner" ? "The learner" : LEARNER} is reading a note on the lesson board and pressed "Visualize it": your only job is ONE small animated, interactive scene that makes the note's idea click. It shows under the note's text, in the same card, drawn by chalk's scene engine on the app's dark ground.`,
    `Topic: ${topic.title || topic.slug}${topic.course ? ` (${topic.course})` : ""}.${topic.goal ? ` Goal: ${topic.goal}` : ""}`,
    `The note${note.title ? ` "${note.title}"` : ""}:\n"""\n${note.body}\n"""`,
    previous ? `It already has this visual: "${previous.title || "a scene"}"${previous.says?.length ? ` (its steps say: ${previous.says.map((s) => `"${s}"`).join(", ")})` : ""}. Make another view of the same idea: a different angle, quantity or mechanism, not the same picture again.` : "",
    hasFigure ? "The note already shows a still figure. Don't redraw it: show what a still can't (the change over time, a knob, the steps)." : "",
    "Use the note's own notation, symbols, values and example (the learner's course uses them). Picture the note's example itself when it has one. Get the physics/math right: recompute every number you print, and keep directions and signs consistent with the note.",
    good,
    format,
    "Teach's rules on top of those: no \"theme\" key (the app picks it); colours only from the palette names; size about 520x300 (it shows at its own size in a card about 600 px wide); every label and formula inside the canvas with 16 units of margin, none on top of a line, an arrow or another label; no filled rect behind everything.",
    'Reply with only the JSON object {"scene": {"title": ..., "size": ..., "params": ..., "let": ..., "objects": ..., "steps": ...}}: no prose, no code fence.',
  ].filter(Boolean).join("\n\n");
}

export function checkPrompt(chalkDir, { note, scene }) {
  const md = chalkText(chalkDir, "scene-check.md");
  const fmt = chalkText(chalkDir, "scene.md");
  const body = md.slice(md.indexOf("Find what's wrong")).replace(/Reply JSON:[^\n]*/, "").replace(/the screen/g, "the note").trim();
  return [
    "You check an animated, interactive board that was just made to illustrate a note in a lesson. The image is a storyboard of the board, numbered in order: frames while it comes in, each step after the learner clicks Next, then each slider or toggle moved to its ends. Below are the note and the board's scene as JSON (the format is described after it).",
    `The note:\n"""\n${note.body}\n"""`,
    body,
    "Also: every label and formula inside the canvas (none cut off at an edge), none on a line, arrow or other label; no \"theme\" key; colours only from the palette names.",
    `The scene:\n${JSON.stringify(scene)}`,
    `The scene format:\n${fmt.slice(fmt.indexOf("params:")).trim()}`,
    'Reply with only JSON: {"issues": ["...", ...], "fixed": true|false, "scene": {the whole corrected scene}}.',
  ].join("\n\n");
}

export function svgPrompt({ topic, note, previous, hasFigure }) {
  const contract = chalkText(path.join(APP, "skill"), "figures.md");
  return [
    `You draw ONE figure for a note in a lesson in the Teach app, a one-to-one tutor. ${LEARNER === "the learner" ? "The learner" : LEARNER} pressed "Visualize it" on the note: the figure shows under the note's text, in the same card, and should make its idea click, picture first.`,
    `Topic: ${topic.title || topic.slug}${topic.course ? ` (${topic.course})` : ""}.`,
    `The note${note.title ? ` "${note.title}"` : ""}:\n"""\n${note.body}\n"""`,
    previous ? "It already has a figure: draw another view of the same idea (a different angle or quantity), not the same picture." : "",
    hasFigure ? "The note already shows a figure; add what it leaves out instead of redrawing it." : "",
    "Use the note's own notation and example; get directions, signs and numbers right.",
    "The figure contract (follow it exactly; the app refuses a figure that breaks it):\n\n" + contract,
    'Reply with only the JSON object {"title": "3-6 words", "svg": "<svg …>…</svg>"}: no prose, no code fence.',
  ].filter(Boolean).join("\n\n");
}

// ---------- a job ----------

// Start making a visual for note `note` (a note block: { id, title, body }). `ctx`: { topic, provider, model, effort,
// stage: { available, storyboard(spec, dir) -> [png…] } | null, render(svgPath) -> { png, problems } }.
export function start(slug, note, ctx) {
  const k = key(slug, note.id);
  if (jobs.get(k)?.state === "working") return job(slug, note.id);
  const j = { state: "working", sub: "Reading the note", error: null, proc: null, cancelled: false, started: Date.now(), tmp: fs.mkdtempSync(path.join(os.tmpdir(), "teach-visual-")), file: null };
  jobs.set(k, j);
  const mine = () => jobs.get(k) === j;   // a cancelled job finishing late must not touch the one started after it
  const tell = (visual) => { try { onChange(slug, note.id, visual); } catch (e) { console.error("teach: visualize:", e.message); } };
  tell();
  const step = (sub) => { if (!mine()) return; j.sub = sub; tell(); };
  make(slug, note, ctx, j, step).then((visual) => {
    if (j.cancelled || !mine()) { if (visual?.path) fs.rmSync(visual.path, { force: true }); return; }
    const prev = visualOf(store.getTopic(slug), note.id);
    store.mutateTopic(slug, (t) => { t.visuals = { ...(t.visuals || {}), [note.id]: visual }; });
    // another view replaces the last one: its SVG goes (a scene lives in topic.json only)
    if (prev?.path && prev.path !== visual.path && path.dirname(prev.path) === path.join(topicDir(slug), "figures")) fs.rmSync(prev.path, { force: true });
    jobs.delete(k);
    tell(visual);
  }).catch((e) => {
    if (j.file) for (const f of [j.file, j.file.replace(/\.svg$/, ".png")]) fs.rmSync(f, { force: true });
    if (!mine()) return;
    if (e.cancelled || j.cancelled) { jobs.delete(k); tell(); return; }
    j.state = "failed"; j.error = String(e.message || e).slice(0, 300); j.sub = "";
    tell();
  }).finally(() => fs.rm(j.tmp, { recursive: true, force: true }, () => {}));
  return job(slug, note.id);
}

export function cancel(slug, noteId) {
  const j = jobs.get(key(slug, noteId));
  if (!j) return false;
  j.cancelled = true;
  kill(j.proc);
  jobs.delete(key(slug, noteId));
  onChange(slug, noteId);
  return true;
}

async function make(slug, note, ctx, j, step) {
  const t0 = Date.now();
  const prev = visualOf(ctx.topic, note.id);
  const hasFigure = /!\[[^\]]*\]\([^)]+\)|```svg|<svg[\s>]/.test(note.body);
  const previous = prev ? { title: prev.title, says: (prev.scene?.steps || []).map((s) => s.say).filter(Boolean) } : null;
  const ask = (prompt, images = []) => run(j, modelCommand({ provider: ctx.provider, prompt, images, model: ctx.model, effort: ctx.effort, tmp: j.tmp }));
  const base = { at: store.now(), noteHash: hashBody(note.body), noteTitle: note.title || "", hidden: false, by: "visualize" };

  if (ctx.stage?.available) {
    step("Drawing the scene");
    let scene = sceneOf(answerJSON(await ask(scenePrompt(ctx.stage.dir, { topic: ctx.topic, note, previous, hasFigure }))));
    let problems = checkScene(scene);
    if (problems.length) {
      step("Fixing the layout");
      scene = sceneOf(answerJSON(await ask(`${scenePrompt(ctx.stage.dir, { topic: ctx.topic, note, previous, hasFigure })}\n\nYour scene was:\n${JSON.stringify(scene)}\n\nThe app's check found these problems; fix every one and reply with the whole corrected scene in the same JSON shape:\n- ${problems.join("\n- ")}`)));
      problems = checkScene(scene);
      if (problems.length) throw new Error(`the scene still has problems: ${problems[0]}`);
    }
    // the second look chalk gives its own scenes: a storyboard of every step and knob, checked and fixed by the model
    step("Checking the picture");
    let frames = await ctx.stage.storyboard(scene, path.join(j.tmp, "sb"));
    const strip = frames.find((f) => f.endsWith("strip.png"));
    if (strip) {
      try {
        const res = answerJSON(await ask(checkPrompt(ctx.stage.dir, { note, scene }), [strip]));
        const fixed = res.fixed && res.scene ? sceneOf(res) : null;
        if (fixed && !checkScene(fixed).length) { scene = fixed; frames = await ctx.stage.storyboard(scene, path.join(j.tmp, "sb2")); }
      } catch (e) { if (e.cancelled) throw e; /* the first draft passed the checks: keep it */ }
    }
    const still = frames.find((f) => /step\d+\.png$/.test(f)) || frames.find((f) => /t8\.png$/.test(f));
    const px = still ? checkPng(fs.readFileSync(still), { name: "the scene", inset: 0.08 }) : [];
    if (px.length) throw new Error(px[0]);
    return { ...base, kind: "scene", title: String(scene.title || "").slice(0, 120), scene, ms: Date.now() - t0 };
  }

  step("Drawing the figure");
  const dir = path.join(topicDir(slug), "figures");
  fs.mkdirSync(dir, { recursive: true });
  // a name of its own every time (two notes whose ids differ only in punctuation, or a redraw, never share a file)
  const file = path.join(dir, `visual-${note.id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40)}-${crypto.createHash("sha1").update(note.id).digest("hex").slice(0, 6)}-${Date.now().toString(36)}.svg`);
  j.file = file;
  const prompt = svgPrompt({ topic: ctx.topic, note, previous, hasFigure });
  let ans = answerJSON(await ask(prompt));
  for (let round = 0; ; round++) {
    const svg = String(ans.svg || "");
    if (!/<svg[\s>]/.test(svg)) throw new Error("the answer had no SVG");
    fs.writeFileSync(file, svg);
    step("Checking the picture");
    let problems = checkSvg(svg);
    if (!problems.length && ctx.render) { try { problems = (await ctx.render(file)).problems; } catch (e) { if (round) throw e; } }
    if (!problems.length) { j.file = null; fs.rmSync(file.replace(/\.svg$/, ".png"), { force: true }); return { ...base, kind: "svg", title: String(ans.title || "").slice(0, 120), path: file, ms: Date.now() - t0 }; }
    if (round >= 1) { fs.rmSync(file.replace(/\.svg$/, ".png"), { force: true }); throw new Error(`the figure still has problems: ${problems[0]}`); }
    step("Fixing the layout");
    ans = answerJSON(await ask(`${prompt}\n\nYour figure was:\n${svg}\n\nThe app's check found these problems; fix every one and reply with the whole corrected figure in the same JSON shape:\n- ${problems.join("\n- ")}`));
  }
}

// A scene from the model's answer ({"scene": {...}} or the scene itself), with what the app owns taken out.
function sceneOf(ans) {
  const sc = ans && typeof ans === "object" ? (ans.scene && typeof ans.scene === "object" ? ans.scene : ans) : null;
  if (!sc || !Array.isArray(sc.objects) || !sc.objects.length) throw new Error("the answer had no scene");
  delete sc.theme;
  return sc;
}
