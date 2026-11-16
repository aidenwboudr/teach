// What differs between Linux, macOS and Windows, in one place: how to start a command (Windows can't run npm's
// .cmd shims or #! scripts directly), how to read a running process's command line (to tell a tutor left behind by
// a crashed server from a pid reused since), and how to open a URL. Every function takes the platform and its
// helpers as options, so the tests cover all three on any machine.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const JS = /\.(m|c)?js$/i;

// Find `cmd` the way a shell would. On Windows that means trying each PATHEXT extension too.
export function which(cmd, { platform = process.platform, env = process.env, exists = isFile } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const exts = platform === "win32" ? ["", ...String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  const tryAll = (base) => exts.map((e) => base + e).find((f) => exists(f));
  if (cmd.includes("/") || (platform === "win32" && cmd.includes("\\"))) return tryAll(cmd) || null;
  const dirs = String(env.PATH || env.Path || "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  for (const d of dirs) { const f = tryAll(p.join(d, cmd)); if (f) return f; }
  return null;
}

function isFile(f) { try { return fs.statSync(f).isFile(); } catch { return false; } }

// How to start `cmd` with `args`: { file, args } for spawn/execFile, never through a shell (the tutor's system
// prompt and MCP config are long arguments full of quotes). A .js/.mjs/.cjs runs under this Node. On Windows a
// .cmd/.bat shim (what `npm i -g` makes) is read for the program it wraps, since Node refuses to start one without a
// shell; a #! script there runs under its interpreter when that's Node.
export function command(cmd, args = [], { platform = process.platform, env = process.env, exists = isFile, read = (f) => fs.readFileSync(f, "utf8"), node = process.execPath } = {}) {
  if (JS.test(cmd)) return { file: node, args: [cmd, ...args] };
  if (platform !== "win32") return { file: cmd, args };
  const found = which(cmd, { platform, env, exists }) || cmd;
  if (JS.test(found)) return { file: node, args: [found, ...args] };
  if (/\.(cmd|bat)$/i.test(found)) {
    const target = shimTarget(read(found), path.win32.dirname(found));
    if (!target) throw new Error(`can't run ${found} without a shell; set TEACH_CLAUDE to the program it starts (claude.exe)`);
    return JS.test(target) ? { file: node, args: [target, ...args] } : { file: target, args };
  }
  if (!/\.(exe|com)$/i.test(found) && exists(found)) {
    const first = read(found).split("\n")[0];
    if (/^#!.*\bnode\b/.test(first)) return { file: node, args: [found, ...args] };
  }
  return { file: found, args };
}

// npm's cmd-shim: `"%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*` (a JS bin) or `"%dp0%\node_modules\pkg\bin\x.exe"   %*`.
export function shimTarget(text, dir) {
  const m = [...text.matchAll(/"%~?dp0%?\\([^"]+\.(?:m|c)?js|[^"]+\.exe)"/gi)].at(-1);
  return m ? path.win32.join(dir, m[1]) : null;
}

export function spawnCommand(cmd, args, opts = {}) {
  const c = command(cmd, args);
  return spawn(c.file, c.args, { windowsHide: true, ...opts });
}

export function execCommand(cmd, args, opts = {}) {
  const c = command(cmd, args);
  return execFileSync(c.file, c.args, { windowsHide: true, ...opts });
}

// The full command line of a running process, or null when there's none with that pid (or it can't be read).
// Windows quotes arguments with \" inside, so quotes come back unescaped for matching.
export function processCommandLine(pid, { platform = process.platform, read = (f) => fs.readFileSync(f, "utf8"), run = (file, args) => execFileSync(file, args, { encoding: "utf8", timeout: 15e3, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }) } = {}) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "linux") return read(`/proc/${pid}/cmdline`).replaceAll("\0", " ").trim() || null;
    if (platform === "win32") {
      const out = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]);
      return out.trim().replaceAll('\\"', '"') || null;
    }
    return run("ps", ["-ww", "-o", "command=", "-p", String(pid)]).trim() || null;   // macOS, the BSDs
  } catch { return null; }
}

// Whether `file` (relative to `base`) is `root` or under it, with symlinks resolved, so a link inside an allowed
// folder can't point somewhere else. A path that doesn't exist yet (a file about to be written) resolves through its
// nearest existing parent. Case-insensitive where the filesystem usually is (Windows, macOS).
export function inside(file, root, base = process.cwd(), platform = process.platform) {
  const fold = (p) => (platform === "win32" || platform === "darwin" ? p.toLowerCase() : p);
  const f = fold(realish(path.resolve(base, String(file)))), r = fold(realish(path.resolve(root)));
  return f === r || f.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}
function realish(p) {
  try { return fs.realpathSync.native(p); } catch { /* not there (yet) */ }
  const up = path.dirname(p);
  return up === p ? p : path.join(realish(up), path.basename(p));
}

// The argv that opens `url` in the default browser.
export function openArgv(url, platform = process.platform) {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["rundll32.exe", "url.dll,FileProtocolHandler", url];   // no cmd.exe: & in a URL stays a character
  return ["xdg-open", url];
}

// Whether a browser could open here at all: on Linux only with a display; macOS and Windows always have one.
export const hasDesktop = (platform = process.platform, env = process.env) => platform !== "linux" || !!(env.WAYLAND_DISPLAY || env.DISPLAY);
