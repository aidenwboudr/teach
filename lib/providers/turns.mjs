// A tutor on a CLI that runs one turn per process (Codex's `codex exec`, Gemini CLI's `gemini -p`), made to look like
// the one long-lived `claude -p --input-format stream-json` process the engine drives: messages written to its stdin
// as stream-json lines queue up turns, each turn starts the CLI (resuming the same session after the first), and the
// CLI's own events come out of its stdout translated into Claude Code's stream-json shapes (system init, assistant
// text and tool_use blocks, user tool_result blocks, result). The engine reads those like any other tutor's.
//
// Claude Code keeps a transcript the app rebuilds lessons from; these CLIs keep theirs in their own formats, so this
// writes one in Claude Code's (the same translated messages, each with a uuid and timestamp) at `transcript(id)`.
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { spawnCommand } from "../platform.mjs";

const TAIL = 4000;   // bytes of the CLI's stderr kept, for the error a failed turn shows

export class TurnSession extends EventEmitter {
  // run({ sessionId, text, images }) → { cmd, args, cwd, env, input? }: how to start one turn (input goes to its stdin).
  // translator() → (event) => messages[]: a fresh one per turn; it may also return { end: true } via its `.flush()`.
  constructor({ run, translator, transcript, sessionId = null, log = null, onPid = () => {}, uploads, spawn = spawnCommand }) {
    super();
    Object.assign(this, { run, translator, transcriptFor: transcript, sessionId, logFile: log, onPid, uploads, spawnFn: spawn });
    this.pid = undefined;
    this.exitCode = null;
    this.queue = [];
    this.child = null;
    this.ending = false;
    this.pending = [];      // transcript entries written before the session id is known
    this.stdout = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _enc, done) => {
        this.inbuf = (this.inbuf || "") + chunk;
        let i;
        while ((i = this.inbuf.indexOf("\n")) >= 0) {
          const line = this.inbuf.slice(0, i); this.inbuf = this.inbuf.slice(i + 1);
          if (line.trim()) try { this.input(JSON.parse(line)); } catch (e) { console.error("teach: bad tutor input", e); }
        }
        done();
      },
      final: (done) => { this.ending = true; if (!this.child && !this.starting) this.finish(0); done(); },
    });
  }

  input(m) {
    if (m.type === "user") {
      this.queue.push(m.message?.content ?? "");
      if (!this.child && !this.starting) this.next();
    } else if (m.type === "control_request" && m.request?.subtype === "interrupt") {
      this.queue = [];
      if (this.child) {
        this.interrupted = true;
        const c = this.child;
        try { c.kill("SIGINT"); } catch { /* gone */ }
        setTimeout(() => { if (c.exitCode === null && c.signalCode === null) try { c.kill("SIGKILL"); } catch { /* gone */ } }, 5000).unref();
      }
    }
    // initialize (and anything else Claude Code would answer) needs no reply here: there are no permission prompts.
  }

  // Everything queued since the last turn goes as one turn: its text blocks joined, its images saved to files.
  // (`run` may return a promise: the local provider's relay has to be listening first.)
  next() {
    if (!this.queue.length) { if (this.ending) this.finish(0); return; }
    if (this.exitCode !== null) return;
    const blocks = this.queue.splice(0).flatMap((c) => (Array.isArray(c) ? c : [{ type: "text", text: String(c) }]));
    const texts = [], images = [];
    for (const b of blocks) {
      if (b.type === "text" && b.text) texts.push(b.text);
      else if (b.type === "image" && b.source?.type === "base64" && this.uploads) {
        const dir = path.join(this.uploads, `turn-${Date.now()}`);
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, `image-${images.length + 1}.${(b.source.media_type || "image/png").split("/")[1].replace("jpeg", "jpg")}`);
        fs.writeFileSync(f, Buffer.from(b.source.data, "base64"));
        images.push(f);
      }
    }
    this.record({ type: "user", message: { role: "user", content: blocks } });
    const spec = this.run({ sessionId: this.sessionId, text: texts.join("\n\n"), images });
    if (spec && typeof spec.then === "function") {
      this.starting = true;
      spec.then((s) => { this.starting = false; if (this.exitCode === null) this.launch(s); },
        (e) => { this.starting = false; this.endTurn({ is_error: true, result: `couldn't start the tutor: ${e.message}` }); });
      return;
    }
    this.launch(spec);
  }

  launch(spec) {
    const translate = this.translator();
    let child, buf = "", tail = "";
    this.interrupted = false;
    this.result = null;
    this.output = false;
    const log = this.logFile ? fs.openSync(this.logFile, "a") : null;
    try {
      child = this.spawnFn(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      if (log !== null) fs.closeSync(log);
      return this.endTurn({ is_error: true, result: `couldn't start ${spec.cmd}: ${e.message}` });
    }
    this.child = child;
    this.pid = child.pid;
    if (child.pid) this.onPid(child.pid);
    child.stdin.on("error", () => {});
    child.stdin.end(spec.input ?? "");
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        for (const m of translate(ev)) this.out(m);
      }
    });
    child.stderr.on("data", (d) => {
      tail = (tail + d).slice(-TAIL);
      if (log !== null) try { fs.writeSync(log, d); } catch { /* full disk */ }
    });
    const done = (code, signal) => {
      if (this.child !== child) return;
      if (log !== null) try { fs.closeSync(log); } catch { /* closed */ }
      for (const m of translate.flush?.() || []) this.out(m);
      this.child = null;
      if (this.interrupted) {
        this.record({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
        return this.endTurn({ is_error: true, subtype: "error_during_execution", result: "" });
      }
      if (this.result) return this.endTurn(this.result);
      const why = errorLine(tail) || (signal ? `stopped by ${signal}` : `exit ${code}`);
      this.endTurn({ is_error: true, result: `${spec.label || spec.cmd} failed: ${why}` });
    };
    child.on("error", (e) => { tail += `\n${e.message}`; done(1); });
    child.on("close", done);
  }

  // The turn's result goes out only once nothing more is queued: a message sent mid-turn starts the next turn at
  // once, and to the engine that's still the same busy turn (as with Claude Code, which reads it mid-turn).
  endTurn(result) {
    if (this.queue.length && !this.interrupted && !this.ending) { this.next(); return; }
    this.out({ type: "result", subtype: result.subtype || (result.is_error ? "error" : "success"), is_error: !!result.is_error, result: result.result ?? "", session_id: this.sessionId });
    if (this.queue.length) this.next();
    else if (this.ending) this.finish(0);
  }

  out(m) {
    if (m.type === "result" && this.child) { this.result = m; return; }   // held until the process ends
    if (m.type === "system" && m.subtype === "init" && m.session_id) {
      const first = !this.sessionId;
      this.sessionId = m.session_id;
      if (first || this.pending.length) for (const e of this.pending.splice(0)) this.append(e);
    }
    if (m.type === "assistant" || m.type === "stream_event") this.output = true;
    if (m.type === "assistant" || (m.type === "user" && m.message)) this.record(m);
    this.stdout.write(JSON.stringify(m) + "\n");
  }

  record(m) {
    const e = { type: m.type, uuid: randomUUID(), timestamp: new Date().toISOString(), message: m.message };
    if (!this.sessionId) this.pending.push(e);
    else this.append(e);
  }

  append(e) {
    const f = this.transcriptFor(this.sessionId);
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, JSON.stringify({ ...e, sessionId: this.sessionId }) + "\n");
    } catch (err) { console.error("teach: couldn't write the transcript", err.message); }
  }

  kill(sig = "SIGTERM") {
    this.queue = [];
    if (this.child) try { this.child.kill(sig); } catch { /* gone */ }
    this.finish(sig === "SIGKILL" ? 137 : 143);
    return true;
  }

  finish(code) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stdout.end();
    setImmediate(() => this.emit("exit", code, null));
  }
}

// The line of a CLI's stderr worth showing when a turn fails: the last one that reads like an error.
export function errorLine(text) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^(WARNING: proceeding|Warning: 256-color|Ripgrep is not available|at |Reading additional input)/.test(l));
  const err = lines.findLast((l) => /error|not logged in|unauthori[sz]ed|forbidden|expired|quota|denied|not found|no longer supported|please|failed/i.test(l));
  return (err || lines.at(-1) || "").replace(/^An unexpected critical error occurred:\s*/, "").slice(0, 400);
}
