// Where everything lives, and the install's settings. Each one comes from an env var only, so tests and a dev
// server never touch real data. The service gets ~/.config/teach/env through systemd's EnvironmentFile; the
// `teach` command loads that file itself (lib/config.mjs) before this module runs.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
// Values may start with ~ or use $HOME, %h and %t (systemd's home and runtime dir), since an EnvironmentFile
// doesn't expand anything.
const RUNTIME = process.env.XDG_RUNTIME_DIR || (process.getuid ? `/run/user/${process.getuid()}` : os.tmpdir());   // (Windows has no uid)
const expand = (v) => v.replace(/^~(?=\/|$)/, HOME).replace(/\$\{?HOME\}?/g, HOME).replace(/%h(?=\/|$)/g, HOME).replace(/%t(?=\/|$)/g, RUNTIME);

const env = (k, d) => (process.env[k] ? expand(process.env[k]) : d);

export const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));     // the app's checkout
export const LEARNING = env("TEACH_DATA", path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local/share"), "teach"));
export const TOPICS = path.join(LEARNING, "topics");
export const PROFILE = path.join(LEARNING, "PROFILE.md");
export const STATE = env("TEACH_STATE", path.join(process.env.XDG_STATE_HOME || path.join(HOME, ".local/state"), "teach"));   // this machine only
export const WORK = env("TEACH_WORK", LEARNING);                                   // tutor sessions' cwd
export const PROJECTS = env("TEACH_PROJECTS", path.join(HOME, ".claude/projects"));
export const CLAUDE = env("TEACH_CLAUDE", "claude");
// The other agent CLIs a tutor can run on (TEACH_PROVIDER, lib/providers/index.mjs), and the model settings they share.
export const CODEX = env("TEACH_CODEX", "codex");
export const GEMINI = env("TEACH_GEMINI", "gemini");
export const MODEL = process.env.TEACH_MODEL || "";                       // force a model for every tutor (the provider's name for it)
export const LOCAL_URL = process.env.TEACH_LOCAL_URL || "http://127.0.0.1:11434/v1";   // TEACH_PROVIDER=local: an OpenAI-style server (Ollama's by default)
export const LOCAL_KEY_ENV = process.env.TEACH_LOCAL_KEY_ENV || "";      // the name of the variable holding that server's key, if it needs one (Codex reads it)
// TCP on localhost by default. With TEACH_SOCKET set it listens only on that Unix socket instead (mode 0600), for
// putting a proxy in front of it (e.g. Tailscale Serve, which also stamps each request with the user's login).
export const SOCKET = env("TEACH_SOCKET", "");
export const PORT = Number(process.env.TEACH_PORT || 7800);
export const HOST = process.env.TEACH_HOST || "127.0.0.1";
export const URL_PUBLIC = (process.env.TEACH_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
export const DEFAULT_SOCKET = path.join(RUNTIME, "teach", "teach.sock");
// A focus tool's state file ({phase: "active"|"verifying", goal}); while it's active, tutors lose the shell.
export const FOCUS_STATE = env("TEACH_FOCUS_STATE", "");
// T3 Code's database: thread titles for /teach sessions that ran there (optional).
export const T3_DB = env("TEACH_T3_DB", path.join(HOME, ".t3/userdata/state.sqlite"));
// Optional integrations: commands, split on spaces (a "~/" prefix works).
export const SYNC = process.env.TEACH_SYNC || "off";                   // "git-pr": ship the data folder through PRs
export const CAPTURE_CMD = env("TEACH_CAPTURE_CMD", "");               // prints a new photo (JPEG) to stdout; gets --since EPOCH
export const OPEN_CMD = env("TEACH_OPEN_CMD", "");                     // opens a clicked link on the learner's desktop; gets the URL
export const CALENDAR_CMD = env("TEACH_CALENDAR_CMD", "");             // adds a session to their calendar: TITLE "YYYY-MM-DD HH:MM" --for 30m --note TEXT [--remind 30m]
export const BROWSER = env("TEACH_BROWSER", "");                       // `teach open`: command with {url}, default the system's opener
// What a tutor may do. "restricted" (the default): Claude Code's permission checks with the app answering them, no
// shell, reads in the learning and work folders, writes only in the learning folder. "full": bypassPermissions, a
// shell that runs anything as you. TEACH_SAFE=1 (the old switch) still forces restricted.
const truthy = (v) => /^(1|true|yes|on)$/i.test(v || "");
export const ACCESS = /^full$/i.test(process.env.TEACH_ACCESS || "") && !truthy(process.env.TEACH_SAFE) ? "full" : "restricted";
if (process.env.TEACH_ACCESS && !/^(full|restricted)$/i.test(process.env.TEACH_ACCESS)) console.error(`teach: TEACH_ACCESS=${process.env.TEACH_ACCESS} isn't "full" or "restricted"; tutors run restricted`);
// What the tutor calls the learner. Default "the learner"; a name reads better ("Sam wrote: …").
export const LEARNER = process.env.TEACH_LEARNER || "the learner";
export const Learner = LEARNER[0].toUpperCase() + LEARNER.slice(1);
export const learnerPossessive = LEARNER === "the learner" ? "the learner's" : `${LEARNER}'s`;
export { HOME };

export const splitCmd = (s) => s.trim().split(/\s+/).filter(Boolean).map(expand);

// Claude Code keeps a session's transcript under a folder named after its cwd, every non-alphanumeric → "-".
export const projectDir = (cwd) => path.join(PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
export const transcriptPath = (cwd, id) => path.join(projectDir(cwd), `${id}.jsonl`);
