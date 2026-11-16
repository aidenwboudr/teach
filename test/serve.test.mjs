// The way a new user runs it, on whatever OS this is: `teach setup --demo --no-service` into an empty home, then
// `teach serve` (which reads the settings file, as launchd, the Windows Startup entry and Docker do), then the
// `teach` command against it. No model: nothing here starts a tutor.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(APP, "cli.mjs");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "teach-serve-test-"));
const PORT = 7600 + Math.floor(Math.random() * 90);
const CONF = path.join(HOME, ".config", "teach", "env");
fs.mkdirSync(path.dirname(CONF), { recursive: true });
fs.writeFileSync(CONF, `# a fresh install's settings\r\nTEACH_PORT=${PORT}\r\nTEACH_LEARNER="Sam"\r\n`);   // CRLF, as Notepad saves it
// Only what a fresh account has: no TEACH_* from the environment running the tests.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TEACH_")));
Object.assign(env, { HOME, USERPROFILE: HOME, XDG_DATA_HOME: "", XDG_STATE_HOME: "", XDG_RUNTIME_DIR: path.join(HOME, "run") });
delete env.XDG_DATA_HOME; delete env.XDG_STATE_HOME;
const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", timeout: 30e3 });

let server = null;
after(async () => { if (server && server.exitCode === null) { server.kill(); await new Promise((r) => server.once("exit", r)); } });

test("setup, then serve, then the teach command, in a fresh home", async () => {
  const out = cli("setup", "--demo", "--no-service", "--no-skill");
  assert.match(out, /demo topics copied/);
  const data = path.join(HOME, ".local", "share", "teach");
  assert.ok(fs.existsSync(path.join(data, "topics", "bayes-theorem", "topic.json")));
  assert.match(out, new RegExp(`open http://127\\.0\\.0\\.1:${PORT}`));

  server = spawn(process.execPath, [CLI, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  let topics = null;
  for (let i = 0; i < 100 && !topics; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { topics = await (await fetch(`http://127.0.0.1:${PORT}/api/topics`)).json(); } catch { /* not up yet */ }
  }
  assert.ok(topics, `server didn't come up:\n${log}`);
  assert.deepEqual(topics.topics.map((t) => t.slug).sort(), ["bayes-theorem", "rc-circuit-transients"]);
  assert.match(log, new RegExp(`data ${data.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
  assert.ok(fs.existsSync(path.join(HOME, ".local", "state", "teach", "server.pid")));

  const list = cli("list");
  assert.match(list, /bayes-theorem/);
  assert.equal(cli("url").trim(), `http://127.0.0.1:${PORT}`);
  // the page itself, and a host that isn't this one is turned away (DNS rebinding)
  const page = await fetch(`http://127.0.0.1:${PORT}/`);
  assert.equal(page.status, 200);
  const evil = await new Promise((resolve) => {
    import("node:http").then(({ default: http }) => http.get({ host: "127.0.0.1", port: PORT, path: "/api/topics", headers: { Host: `evil.example:${PORT}` } }, (r) => { r.resume(); resolve(r.statusCode); }));
  });
  assert.equal(evil, 403);
});
