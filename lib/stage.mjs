// The workspace stage: chalk's scene boards (screen-chalk's scene.py, the same renderer the overlay draws them
// with) shown in the Teach app, for topics that have no app of their own to work in (a physics idea, a circuit
// on paper). One chalk scenehost.py process renders every open scene; this module starts it, sends it their
// pointer, and hands its frames to the server, which streams them to the lesson page.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CHALK } from "./screen.mjs";

// scenehost.py sits next to chalk's own script (the `chalk` on PATH links into the chalk checkout).
const HOST = process.env.TEACH_SCENEHOST || (() => { try { return path.join(path.dirname(fs.realpathSync(CHALK)), "scenehost.py"); } catch { return ""; } })();
const PYTHON = process.env.TEACH_SCENE_PYTHON || "/usr/bin/python3";   // the system python: gi + cairo + Pango

export const available = () => !!HOST && fs.existsSync(HOST);

let proc = null, buf = "";
const open = new Map();     // scene id → { slug, spec, gates }
let onEvent = () => {};

export function listen(fn) { onEvent = fn; }

function host() {
  if (proc && proc.exitCode === null) return proc;
  if (!available()) throw new Error(`chalk's scenehost.py isn't installed (${HOST || "no chalk"})`);
  proc = spawn(PYTHON, [HOST], { stdio: ["pipe", "pipe", "inherit"] });
  buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      const s = open.get(m.id);
      if (s) onEvent(s.slug, m);
    }
  });
  proc.stdin.on("error", () => {});
  proc.on("exit", () => {
    proc = null;
    // it crashed: the scenes open in it come back from their specs the next time they're touched
    for (const s of open.values()) s.live = false;
  });
  return proc;
}

const send = (m) => { try { host().stdin.write(JSON.stringify(m) + "\n"); return true; } catch (e) { console.error("teach: stage:", e.message); return false; } };

// Open (or re-open after a restart) a scene. gates = steps that wait for their prediction before they show.
export function show(slug, id, spec, gates = []) {
  const prev = open.get(id);
  if (prev?.live) return true;
  open.set(id, { slug, spec, gates, live: true });
  return send({ op: "open", id, spec, gates });
}

export function replace(id, spec) {
  const s = open.get(id);
  if (!s) return false;
  s.spec = spec;
  return send({ op: "replace", id, spec });
}

// Their pointer, keys and buttons. Re-opens the scene first if the host restarted under it.
export function input(id, m) {
  const s = open.get(id);
  if (!s) return false;
  if (!s.live) show(s.slug, id, s.spec, s.gates.filter((g) => !s.released?.has(g)));
  return send({ ...m, id });
}

export function release(id, step) {
  const s = open.get(id);
  if (!s) return false;
  (s.released ||= new Set()).add(step);
  return send({ op: "release", id, step });
}

export function close(id) {
  if (!open.delete(id)) return;
  send({ op: "close", id });
}

export const isOpen = (id) => open.has(id);
// A page just connected: send it the current frame and state of this topic's scenes.
export function refreshTopic(slug) { for (const [id, s] of open) if (s.slug === slug && s.live) send({ op: "refresh", id }); }
export function closeTopic(slug) { for (const [id, s] of open) if (s.slug === slug) close(id); }
export function stop() { try { proc?.kill(); } catch { /* gone */ } }
