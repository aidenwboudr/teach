// `teach setup` (and ./install.sh, which hands over to it): install or refresh Teach for this user, on Linux, macOS
// or Windows. Safe to re-run.
//   - the `teach` command (a git checkout only; `npm i -g` puts it on PATH already)
//   - the learning folder (with --demo, the two example topics) and a PROFILE.md to fill in
//   - which AI tutors run on (--provider claude|codex|gemini|local, or a question when run in a terminal), saved as
//     TEACH_PROVIDER in ~/.config/teach/env, and a check that its CLI is installed and logged in
//   - the teach skill for Claude Code: ~/.claude/skills/teach -> this app's skill/
//   - something that keeps the server running: a systemd user service (Linux), a launchd agent (macOS), or a
//     Startup-folder entry plus a start right now (Windows). --no-service skips it; then run `teach serve`.
// Everything outside the filesystem goes through `run`, so the tests can check what it would do on each platform.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { APP, LEARNING, STATE, URL_PUBLIC, HOME, ACCESS } from "./paths.mjs";
import { which, processCommandLine } from "./platform.mjs";
import { PROVIDERS } from "./providers/index.mjs";

export const LAUNCHD_LABEL = "local.teach";

export function systemdUnit({ node, app }) {
  return `[Unit]
Description=Teach - a one-to-one tutor on your own AI agent CLI (${app})
After=network-online.target

[Service]
ExecStart=${node} ${app}/server.mjs
EnvironmentFile=-%h/.config/teach/env
Environment=PATH=%h/.local/bin:${path.dirname(node)}:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function launchdPlist({ node, app, home, state }) {
  const args = [node, path.join(app, "cli.mjs"), "serve"];
  const PATH = [path.join(home, ".local/bin"), path.dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(PATH)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(state, "server.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(state, "server.log"))}</string>
</dict>
</plist>
`;
}

// The Startup-folder shortcut runs the server with no window: conhost --headless hosts Node's console invisibly.
export function windowsShortcut({ node, app, appdata, systemRoot = "C:\\Windows" }) {
  const lnk = path.win32.join(appdata, "Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Teach.lnk");
  const target = path.win32.join(systemRoot, "System32\\conhost.exe");
  const args = `--headless "${node}" "${path.win32.join(app, "cli.mjs")}" serve --log`;
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  const ps = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(lnk)}); $s.TargetPath = ${q(target)}; $s.Arguments = ${q(args)}; ` +
    `$s.WorkingDirectory = ${q(app)}; $s.WindowStyle = 7; $s.Description = 'Teach server'; $s.Save()`;
  return { lnk, ps };
}

const defaultRun = (file, args, opts = {}) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...opts });

// Set KEY=value in a settings file (KEY=VALUE lines), replacing an earlier line for it.
export function setSetting(file, key, value) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { /* new */ }
  const line = `${key}=${value}`, re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, "m");
  text = re.test(text) ? text.replace(re, line) : text + (text && !text.endsWith("\n") ? "\n" : "") + line + "\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const CHOICES = ["claude", "codex", "gemini", "local"];
async function ask(question, { input = process.stdin, output = process.stdout } = {}) {
  const rl = (await import("node:readline/promises")).createInterface({ input, output });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

// Which AI the tutors run on, and whether its CLI is ready. Never fails setup: a missing CLI is a warning.
export async function provider(o, { env, log, warn, conf, check, prompt }) {
  let id = o.provider;
  if (!id && !env.TEACH_PROVIDER && prompt) {
    const a = await prompt(["Which AI should the tutors run on? Each runs as that service's own CLI, on your own login.",
      ...CHOICES.map((c, i) => `  ${i + 1}. ${PROVIDERS[c].label}${c === "claude" ? " (default)" : ""}`), "Pick 1-4 [1]: "].join("\n"));
    id = CHOICES[Number(a) - 1] || (CHOICES.includes(a) ? a : "claude");
  }
  id = (id || env.TEACH_PROVIDER || "claude").toLowerCase();
  if (!PROVIDERS[id]) throw new Error(`setup: --provider must be one of ${CHOICES.join(", ")}`);
  const P = PROVIDERS[id];
  if (conf !== "/dev/null" && (o.provider || !env.TEACH_PROVIDER)) { setSetting(conf, "TEACH_PROVIDER", id); env.TEACH_PROVIDER = id; }
  if (o.model && conf !== "/dev/null") { setSetting(conf, "TEACH_MODEL", o.model); env.TEACH_MODEL = o.model; }
  log(`teach: tutors run on ${P.label} (TEACH_PROVIDER=${id})`);
  const access = /^full$/i.test(env.TEACH_ACCESS || "") ? "full" : ACCESS;
  log(`teach: what a tutor may do (TEACH_ACCESS=${access}): ${P.safety[access]}`);
  if (!o.check) return P;
  if (id === "gemini") log("teach: checking Gemini CLI with one short test prompt…");
  const c = await check(P, { env, model: o.model || env.TEACH_MODEL });
  if (!c.installed) warn(`teach: warning: ${P.label} isn't installed (${P.install}; ${P.docs}); tutors need it`);
  else if (c.loggedIn === false) warn(`teach: warning: ${P.label} is installed (${c.version}) but not ready: ${c.detail}. To fix: ${P.login}`);
  else log(`teach: ${P.label} ${c.version}: ${c.detail}`);
  return P;
}

export async function setup(argv = [], { platform = process.platform, run = defaultRun, start = startDetached, log = console.log, warn = console.error, env = process.env,
  check = (P, opts) => P.check(opts), prompt = process.stdin.isTTY && process.stdout.isTTY ? ask : null } = {}) {
  const o = { service: true, demo: false, skill: true, command: true, check: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], value = () => { const v = argv[++i]; if (!v || v.startsWith("--")) throw new Error(`setup: ${a} needs a value`); return v; };
    if (a === "--no-service") o.service = false;
    else if (a === "--demo") o.demo = true;
    else if (a === "--no-skill") o.skill = false;
    else if (a === "--no-command") o.command = false;
    else if (a === "--no-check") o.check = false;
    else if (a === "--provider") o.provider = value().toLowerCase();
    else if (a.startsWith("--provider=")) o.provider = a.slice(11).toLowerCase();
    else if (a === "--model") o.model = value();
    else if (a.startsWith("--model=")) o.model = a.slice(8);
    else throw new Error(`setup: unknown option ${a} (options: --provider claude|codex|gemini|local, --model NAME, --demo, --no-service, --no-skill, --no-command, --no-check)`);
  }
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) throw new Error(`Node ${process.version} is too old; Teach needs 22.5 or newer`);
  if (/[\\/]_npx[\\/]/.test(APP)) throw new Error(`this copy is in npx's cache (${APP}), which gets cleaned; install it for good with: npm i -g teach-tutor && teach setup`);
  const npmCopy = APP.split(path.sep).includes("node_modules");
  const node = which("node", { platform, env }) || process.execPath;   // the PATH one (a stable symlink), not a versioned real path
  const conf = env.TEACH_CONFIG || path.join(HOME, ".config/teach/env");

  fs.mkdirSync(path.join(LEARNING, "topics"), { recursive: true });
  if (conf !== "/dev/null") fs.mkdirSync(path.dirname(conf), { recursive: true });
  await provider(o, { env, log, warn, conf, check, prompt });

  // the command
  const bin = path.join(HOME, ".local/bin");
  if (o.command && !npmCopy) {
    fs.mkdirSync(bin, { recursive: true });
    if (platform === "win32") {
      fs.writeFileSync(path.join(bin, "teach.cmd"), `@"${node}" "${path.join(APP, "cli.mjs")}" %*\r\n`);
      log(`teach: command -> ${path.join(bin, "teach.cmd")}`);
    } else {
      const link = path.join(bin, "teach");
      fs.rmSync(link, { force: true });
      fs.symlinkSync(path.join(APP, "cli.mjs"), link);
      log(`teach: command -> ${path.join(APP, "cli.mjs")}`);
    }
    const dirs = String(env.PATH || env.Path || "").split(platform === "win32" ? ";" : ":").map((d) => path.resolve(d).toLowerCase());
    if (!dirs.includes(path.resolve(bin).toLowerCase())) warn(`teach: ${bin} isn't on your PATH; add it to run \`teach\``);
  }

  // the learning folder
  const profile = path.join(LEARNING, "PROFILE.md"), topics = path.join(LEARNING, "topics");
  if (o.demo) {
    if (!fs.existsSync(profile)) fs.copyFileSync(path.join(APP, "examples/demo/PROFILE.md"), profile);
    if (!fs.readdirSync(topics).length) { fs.cpSync(path.join(APP, "examples/demo/topics"), topics, { recursive: true }); log(`teach: demo topics copied to ${topics}`); }
    else log(`teach: ${topics} isn't empty; demo topics not copied`);
  }
  if (!fs.existsSync(profile)) { fs.copyFileSync(path.join(APP, "examples/PROFILE.template.md"), profile); log(`teach: fill in your profile: ${profile} (or in the app: Profile)`); }

  // the skill
  if (o.skill) {
    const dst = path.join(HOME, ".claude/skills/teach");
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    let st = null;
    try { st = fs.lstatSync(dst); } catch { /* none */ }
    if (!st || st.isSymbolicLink()) {
      if (st) fs.rmSync(dst, { force: true, recursive: false });
      fs.symlinkSync(path.join(APP, "skill"), dst, platform === "win32" ? "junction" : "dir");   // a junction needs no admin rights
      log(`teach: skill -> ${path.join(APP, "skill")}`);
    } else warn(`teach: ${dst} exists and isn't a link; left it (remove it, or use --no-skill)`);
  }

  // the service
  if (o.service) await service({ platform, run, start, log, warn, env, node });
  log(`teach: open ${URL_PUBLIC}`);
}

async function service({ platform, run, start, log, warn, env, node }) {
  if (platform === "darwin") {
    const dir = path.join(HOME, "Library/LaunchAgents"), plist = path.join(dir, `${LAUNCHD_LABEL}.plist`);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(plist, launchdPlist({ node, app: APP, home: HOME, state: STATE }));
    const domain = `gui/${process.getuid ? process.getuid() : 501}`;
    try { run("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]); } catch { /* wasn't loaded */ }
    run("launchctl", ["bootstrap", domain, plist]);
    log(`teach: launchd agent ${LAUNCHD_LABEL} running (logs: ${path.join(STATE, "server.log")})`);
    return;
  }
  if (platform === "win32") {
    const { lnk, ps } = windowsShortcut({ node, app: APP, appdata: env.APPDATA || path.join(HOME, "AppData/Roaming"), systemRoot: env.SystemRoot || "C:\\Windows" });
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
    stopOld();
    start(node, [path.join(APP, "cli.mjs"), "serve", "--log"]);
    log(`teach: running, and it starts when you sign in (${lnk}); logs: ${path.join(STATE, "server.log")}`);
    return;
  }
  let systemd = false;
  try { run("systemctl", ["--user", "show-environment"]); systemd = true; } catch { /* no user session manager */ }
  if (!systemd) { warn("teach: no systemd user session here; start it with: teach serve"); return; }
  const dir = path.join(HOME, ".config/systemd/user");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "teach.service"), systemdUnit({ node, app: APP }));
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", "teach.service"]);
  run("systemctl", ["--user", "restart", "teach.service"]);
  log("teach: service teach.service running (logs: journalctl --user -u teach -f)");
}

// A server an earlier setup started (Windows has no service manager to restart it): stop it, if that pid still is one.
function stopOld() {
  const f = path.join(STATE, "server.pid");
  let pid;
  try { pid = Number(fs.readFileSync(f, "utf8")); } catch { return; }
  const cl = processCommandLine(pid);
  if (!(cl && cl.includes("cli.mjs") && /\bserve\b/.test(cl))) return;
  try { process.kill(pid); } catch { return; }
  for (let i = 0; i < 20 && processCommandLine(pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);   // let go of the port
}

function startDetached(node, args) {
  const child = spawn(node, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

