// Linux, macOS and Windows: starting commands, reading a process's command line, opening URLs, finding a browser to
// render with, and `teach setup` on each platform, all with fakes, so every platform's path runs on any machine.
// Plus the restricted tutor's permission rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teach-platform-test-"));
const HOME = path.join(tmp, "home");
fs.mkdirSync(HOME, { recursive: true });
Object.assign(process.env, { HOME, USERPROFILE: HOME, TEACH_CONFIG: "/dev/null", TEACH_DATA: path.join(tmp, "learning"), TEACH_STATE: path.join(tmp, "state"),
  TEACH_WORK: path.join(tmp, "work"), TEACH_PROJECTS: path.join(tmp, "projects"), TEACH_ACCESS: "", TEACH_SAFE: "" });
for (const d of ["learning", "work", "state"]) fs.mkdirSync(path.join(tmp, d), { recursive: true });
const pf = await import("../lib/platform.mjs");
const { svgSize, findChrome } = await import("../skill/render-svg.mjs");
const { permit, policyFor } = await import("../lib/engine.mjs");
const setupMod = await import("../lib/setup.mjs");
const { APP, LEARNING, WORK } = await import("../lib/paths.mjs");

const files = (list) => (f) => list.includes(f);

test("command: JS runs under this Node everywhere; other commands start as they are off Windows", () => {
  assert.deepEqual(pf.command("/x/fake-claude.cjs", ["-p"], { platform: "linux", node: "/n" }), { file: "/n", args: ["/x/fake-claude.cjs", "-p"] });
  assert.deepEqual(pf.command("claude", ["-p"], { platform: "darwin" }), { file: "claude", args: ["-p"] });
  assert.deepEqual(pf.command("C:\\t\\claude.mjs", [], { platform: "win32", node: "N" }), { file: "N", args: ["C:\\t\\claude.mjs"] });
});

test("command on Windows: finds claude.exe on PATH, and reads npm's .cmd shim for what it wraps", () => {
  const env = { PATH: "C:\\Users\\a\\.local\\bin;C:\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.deepEqual(pf.command("claude", ["-p"], { platform: "win32", env, exists: files(["C:\\Users\\a\\.local\\bin\\claude.EXE"]) }),
    { file: "C:\\Users\\a\\.local\\bin\\claude.EXE", args: ["-p"] });
  const jsShim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
  const exeShim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
  const at = (text) => ({ platform: "win32", env, node: "N", exists: files(["C:\\npm\\claude.CMD"]), read: () => text });
  assert.deepEqual(pf.command("claude", ["-p"], at(jsShim)), { file: "N", args: ["C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js", "-p"] });
  assert.deepEqual(pf.command("claude", ["-p"], at(exeShim)), { file: "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe", args: ["-p"] });
  assert.throws(() => pf.command("claude", [], at("@echo hi\r\n")), /TEACH_CLAUDE/);
  // a #! node script (a test's fake claude) runs under Node
  assert.deepEqual(pf.command("C:\\t\\claude", ["x"], { platform: "win32", env, node: "N", exists: files(["C:\\t\\claude"]), read: () => "#!/usr/bin/env node\n" }), { file: "N", args: ["C:\\t\\claude", "x"] });
});

test("processCommandLine: /proc on Linux, ps on macOS, CIM on Windows (its \\\" unescaped)", () => {
  assert.equal(pf.processCommandLine(42, { platform: "linux", read: (f) => (assert.equal(f, "/proc/42/cmdline"), "claude\0--mcp-config\0{\"TEACH_TOPIC\":\"nn\"}\0") }), 'claude --mcp-config {"TEACH_TOPIC":"nn"}');
  let ran;
  assert.equal(pf.processCommandLine(42, { platform: "darwin", run: (f, a) => ((ran = [f, ...a]), "claude -p {\"TEACH_TOPIC\":\"nn\"}\n") }), 'claude -p {"TEACH_TOPIC":"nn"}');
  assert.deepEqual(ran, ["ps", "-ww", "-o", "command=", "-p", "42"]);
  const win = pf.processCommandLine(42, { platform: "win32", run: (f, a) => ((ran = [f, ...a]), 'C:\\claude.exe -p "{\\"TEACH_TOPIC\\":\\"nn\\"}"\r\n') });
  assert.ok(win.includes('"TEACH_TOPIC":"nn"'));
  assert.equal(ran[0], "powershell.exe");
  assert.match(ran.at(-1), /ProcessId=42/);
  assert.equal(pf.processCommandLine(42, { platform: "darwin", run: () => { throw new Error("no such process"); } }), null);
  assert.equal(pf.processCommandLine(42, { platform: "win32", run: () => "\r\n" }), null);
  assert.equal(pf.processCommandLine("x"), null);
});

test("opening a URL on each platform, and when there's a desktop to open it on", () => {
  const u = "http://127.0.0.1:7800/t/a?app=desktop&x=1";
  assert.deepEqual(pf.openArgv(u, "linux"), ["xdg-open", u]);
  assert.deepEqual(pf.openArgv(u, "darwin"), ["open", u]);
  assert.deepEqual(pf.openArgv(u, "win32"), ["rundll32.exe", "url.dll,FileProtocolHandler", u]);
  assert.equal(pf.hasDesktop("linux", {}), false);
  assert.equal(pf.hasDesktop("linux", { WAYLAND_DISPLAY: "wayland-1" }), true);
  assert.equal(pf.hasDesktop("darwin", {}), true);
  assert.equal(pf.hasDesktop("win32", {}), true);
});

test("render: the SVG's size, and a browser to render with on each platform", () => {
  assert.deepEqual(svgSize('<svg xmlns="x" width="320" height="200px">'), [320, 200]);
  assert.deepEqual(svgSize('<svg viewBox="0 0 640.4 480" xmlns="x">'), [640, 480]);
  assert.deepEqual(svgSize("<svg>"), [800, 600]);
  assert.equal(findChrome({ env: { TEACH_CHROME: "/opt/c" } }), "/opt/c");
  assert.equal(findChrome({ platform: "darwin", env: {}, exists: files(["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]) }), "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  assert.equal(findChrome({ platform: "win32", env: { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
    exists: files(["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]) }), "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
  assert.equal(findChrome({ platform: "linux", env: { PATH: "/usr/bin:/snap/bin" }, exists: files(["/snap/bin/chromium"]) }), "/snap/bin/chromium");
  assert.equal(findChrome({ platform: "linux", env: { PATH: "/usr/bin" }, exists: () => false }), null);
});

test("restricted is the default; full access only when asked for, and TEACH_SAFE still wins", async () => {
  const access = async (env) => {
    const { execFileSync } = await import("node:child_process");
    return execFileSync(process.execPath, ["--input-type=module", "-e", 'import("./lib/paths.mjs").then((m) => process.stdout.write(m.ACCESS))'],
      { cwd: APP, env: { ...process.env, TEACH_ACCESS: "", TEACH_SAFE: "", ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  };
  assert.equal(await access({}), "restricted");
  assert.equal(await access({ TEACH_ACCESS: "full" }), "full");
  assert.equal(await access({ TEACH_ACCESS: "everything" }), "restricted");
  assert.equal(await access({ TEACH_ACCESS: "full", TEACH_SAFE: "1" }), "restricted");
});

test("a restricted tutor: no shell, writes only in the learning folder, reads only where it should", () => {
  const p = policyFor({ access: "restricted" });
  const ok = (name, inp) => permit(p, name, inp).behavior === "allow";
  assert.equal(ok("Bash", { command: "ls" }), false);
  assert.equal(ok("mcp__other__thing", {}), false);
  assert.equal(ok("mcp__teach__render", { svg: "figures/a.svg" }), true);
  assert.equal(ok("WebSearch", { query: "x" }), true);
  assert.equal(ok("Write", { file_path: path.join(LEARNING, "topics/a/log.md") }), true);
  assert.equal(ok("Write", { file_path: path.join(LEARNING, "..", "escape.md") }), false);
  assert.equal(ok("Edit", { file_path: path.join(WORK, "notes.md") }), false);
  assert.equal(ok("Read", { file_path: path.join(WORK, "notes.md") }), true);
  assert.equal(ok("Read", { file_path: path.join(APP, "skill", "SKILL.md") }), true);
  assert.equal(ok("Read", { file_path: path.join(HOME, ".ssh", "id_ed25519") }), false);
  assert.equal(ok("Read", { file_path: path.join(HOME, ".claude", ".credentials.json") }), false);
  assert.equal(ok("Grep", { pattern: "x", path: HOME }), false);
  assert.equal(ok("Grep", { pattern: "x" }), true);           // no path: the work folder
  // a link inside the learning folder that points out of it doesn't widen anything
  fs.mkdirSync(path.join(HOME, "secret"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "secret", "k"), "k");
  fs.symlinkSync(path.join(HOME, "secret"), path.join(LEARNING, "sneaky"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(ok("Read", { file_path: path.join(LEARNING, "sneaky", "k") }), false);
  assert.equal(ok("Write", { file_path: path.join(LEARNING, "sneaky", "new.md") }), false);
  // a focus block on a full-access install still reads anywhere, as before; full access outside one has no policy
  assert.equal(policyFor({ access: "full" }), null);
  const focus = policyFor({ access: "full", focus: true });
  assert.equal(permit(focus, "Read", { file_path: path.join(HOME, "anything.txt") }).behavior, "allow");
  assert.equal(permit(focus, "Bash", { command: "ls" }).behavior, "deny");
});

// `teach setup` per platform, with a fake `run` (systemctl, launchctl, powershell) and a fake start.
async function setupOn(platform, argv = ["--demo"], extraEnv = {}, fail = () => false) {
  const calls = [], started = [], logs = [];
  for (const d of ["learning", "state"]) fs.rmSync(path.join(tmp, d), { recursive: true, force: true });
  fs.rmSync(path.join(HOME, ".claude"), { recursive: true, force: true });
  await setupMod.setup(argv, { platform, env: { ...process.env, PATH: "", ...extraEnv }, run: (f, a) => { calls.push([f, ...a].join(" ")); if (fail(f, a)) throw new Error("failed"); return ""; },
    start: (n, a) => started.push(a), log: (s) => logs.push(s), warn: (s) => logs.push(s) });
  return { calls, started, logs };
}

test("setup on Linux: the learning folder with the demo, the skill link, and the systemd service", async () => {
  const { calls, logs } = await setupOn("linux");
  assert.ok(fs.existsSync(path.join(LEARNING, "topics", "bayes-theorem", "topic.json")));
  assert.ok(fs.existsSync(path.join(LEARNING, "PROFILE.md")));
  assert.equal(fs.realpathSync(path.join(HOME, ".claude/skills/teach")), fs.realpathSync(path.join(APP, "skill")));
  const unit = fs.readFileSync(path.join(HOME, ".config/systemd/user/teach.service"), "utf8");
  assert.match(unit, /^ExecStart=.* .*server\.mjs$/m);
  assert.match(unit, /^EnvironmentFile=-%h\/\.config\/teach\/env$/m);
  assert.deepEqual(calls, ["systemctl --user show-environment", "systemctl --user daemon-reload", "systemctl --user enable --now teach.service", "systemctl --user restart teach.service"]);
  assert.ok(logs.some((l) => /Claude Code isn't installed/.test(l)));
  // no systemd user session: no unit, just how to start it
  fs.rmSync(path.join(HOME, ".config/systemd"), { recursive: true, force: true });
  const r = await setupOn("linux", ["--no-skill"], {}, (f, a) => a.includes("show-environment"));
  assert.deepEqual(r.calls, ["systemctl --user show-environment"]);
  assert.ok(r.logs.some((l) => /teach serve/.test(l)));
  assert.equal(fs.existsSync(path.join(HOME, ".config/systemd/user/teach.service")), false);
});

test("setup on macOS: a launchd agent running `teach serve`", async () => {
  const { calls } = await setupOn("darwin");
  const plist = fs.readFileSync(path.join(HOME, "Library/LaunchAgents/local.teach.plist"), "utf8");
  assert.match(plist, /<string>.*cli\.mjs<\/string>\s*<string>serve<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(calls[0], /^launchctl bootout gui\/\d+\/local\.teach$/);
  assert.match(calls[1], /^launchctl bootstrap gui\/\d+ .*local\.teach\.plist$/);
});

test("setup on Windows: a hidden Startup entry, the server started now, teach.cmd, a junction for the skill", async () => {
  const { calls, started } = await setupOn("win32", ["--demo"], { APPDATA: "C:\\Users\\a\\AppData\\Roaming" });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^powershell\.exe -NoProfile -NonInteractive -Command \$s = \(New-Object -ComObject WScript\.Shell\)\.CreateShortcut\('C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Teach\.lnk'\)/);
  assert.match(calls[0], /conhost\.exe'; \$s\.Arguments = '--headless ".*" ".*cli\.mjs" serve --log'/);
  assert.deepEqual(started.map((a) => a.slice(1)), [["serve", "--log"]]);
  assert.match(fs.readFileSync(path.join(HOME, ".local/bin/teach.cmd"), "utf8"), /^@".*" ".*cli\.mjs" %\*\r\n$/);
  // quotes in a path survive PowerShell's single-quoted strings
  assert.match(setupMod.windowsShortcut({ node: "C:\\n\\node.exe", app: "C:\\O'Brien\\teach", appdata: "C:\\A" }).ps, /'C:\\O''Brien\\teach'/);
});

test("setup refuses npx's cache and unknown options", async () => {
  await assert.rejects(setupMod.setup(["--frobnicate"], { run: () => "" }), /unknown option/);
});
