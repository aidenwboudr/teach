// The AI services a tutor can run on. Each topic is a session of one agent CLI, on the learner's own login for it:
// Teach starts the CLI and reads its output, and never sees or stores a key.
//   claude  Claude Code (`claude -p`, stream-json both ways; the default)
//   codex   OpenAI's Codex CLI (`codex exec --json`, one process per turn), on a ChatGPT login or an API key
//   gemini  Google's Gemini CLI (`gemini -o stream-json`, one process per turn), on a Gemini API key or Vertex AI
//   local   a local model through Codex CLI: Ollama, LM Studio, vLLM or any server with an OpenAI-style Responses API
// TEACH_PROVIDER picks one (`teach setup` asks). Each one keeps the same method and tools: the teach MCP server
// (mcp.mjs) drives the board whichever CLI calls it. What a tutor may touch is enforced per provider; see `safety`.
import fs from "node:fs";
import path from "node:path";
import { APP, CLAUDE, CODEX, GEMINI, MODEL, LOCAL_URL, LOCAL_KEY_ENV, LEARNING, STATE, WORK } from "../paths.mjs";
import { spawnCommand, execCommand } from "../platform.mjs";
import { TurnSession, errorLine } from "./turns.mjs";
import { codexTranslator, geminiTranslator } from "./translate.mjs";
import { relay } from "./relay.mjs";

// A restricted Claude Code tutor's tools: no shell. It checks its figures with the teach tool `render` instead of a script.
export const SAFE_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Agent", "Skill", "TodoWrite", "Edit", "Write", "mcp__teach", "mcp__chalk"];

export const TRANSCRIPTS = path.join(STATE, "transcripts");   // what Teach records of Codex and Gemini sessions
export const transcriptFile = (id) => path.join(TRANSCRIPTS, `${String(id).replace(/[^\w.-]/g, "_")}.jsonl`);

// The environment a tutor CLI starts with: none of the variables that would make it think it runs inside another
// Claude Code session; and for the other CLIs none of Anthropic's either (they don't use them, and a key or a proxy
// address meant for Claude Code has no business in another vendor's process).
export function cleanEnv(id = "claude", base = process.env) {
  const env = { ...base, FOCUS_ALLOWED_CLAUDE: "1" };
  for (const k of Object.keys(env)) {
    if (/^CLAUDE_CODE_(SESSION|ENTRYPOINT|CHILD|MESSAGING|EXECPATH)|^CLAUDECODE$|^CLAUDE_AGENT_SDK|^CLAUDE_PID$|^CLAUDE_EFFORT$/.test(k)) delete env[k];
    if (id !== "claude" && /^ANTHROPIC_/.test(k)) delete env[k];
  }
  return env;
}

// A TOML value from JSON (Codex's `-c key=value` reads TOML): a JSON string is a valid TOML basic string.
export function toml(v) {
  if (Array.isArray(v)) return `[${v.map(toml).join(", ")}]`;
  if (v && typeof v === "object") return `{ ${Object.entries(v).map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${toml(x)}`).join(", ")} }`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(String(v));
}

// The teach skill as text, for CLIs that have no Skill tool: SKILL.md without its front matter, after this install's
// local.md (which wins where they differ).
export function skillText(dir = path.join(APP, "skill")) {
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; } };
  const local = read("local.md").trim(), skill = read("SKILL.md").replace(/^---\n[\s\S]*?\n---\n+/, "").trim();
  return [local && `## This install's additions (local.md; they win over the skill where they differ)\n\n${local}`, skill].filter(Boolean).join("\n\n");
}

// What the tutor is told on a CLI that isn't Claude Code: the skill is in the message, and where it names Claude Code's
// tools, what to use instead.
function notes(p, ctx) {
  const restricted = !!ctx.policy;
  const files = !restricted ? `You have a shell${p.id === "gemini" ? "" : " (Codex's own)"} and your own file tools; keep your writes in the learning folder (${LEARNING}) unless ${ctx.learner} asks otherwise.`
    : p.id === "gemini"
      ? `There is no shell. Read with your own read_file, glob, grep_search and list_directory (they work in the learning and work folders). Write and edit only with the teach tools file_write and file_edit, which work only in the learning folder (${LEARNING}).`
      : `There is no shell. Read files only with the teach tools file_read, file_list and file_search (the learning and work folders), and write and edit only with the teach tools file_write and file_edit, which work only in the learning folder (${LEARNING}). ` +
        `(MCP resources hold nothing here: list_mcp_resources and read_mcp_resource can't read files.)`;
  return [
    `This tutor runs on ${p.label}, not Claude Code. The teach skill is included below, so there is nothing to load: follow it. ` +
      `"The teach tools" are the tools of the MCP server named teach${p.id === "gemini" ? " (in your tool list as mcp_teach_<name>, e.g. mcp_teach_ask)" : p.id === "codex" ? " (the mcp__teach tools: ask, update, board…)" : " (in your tool list by their own names: ask, update, plan, board…)"}. Where the skill names Claude Code tools, use these instead:`,
    `- Subagents (fact-checking the plan, drawing a figure): do that work yourself, here. Before teaching a plan, check every definition, sign convention and formula it relies on with web search, and record corrections with the teach tool update (facts_add).`,
    `- AskUserQuestion, Skill, Agent, TodoWrite and render-svg.sh don't exist here. Every question goes through the teach tool ask; check a drawn SVG with the teach tool render, which shows you the PNG.`,
    `- ${files}`,
  ].join("\n");
}

// The text a turn-based CLI gets: on a process's first turn the app's instructions come first (and on a new session
// the skill too); after that only the learner's message. The transcript records only the message.
function framed(p, ctx) {
  let first = true;
  return (text, images) => {
    const att = images.length ? `\n\n[Attached image${images.length > 1 ? "s" : ""}: ${images.join(", ")}${p.id === "gemini" ? " (read them with read_file)" : ""}]` : "";
    if (!first) return text + att;
    first = false;
    const intro = [`[Teach app] instructions (from the app, not from ${ctx.learner}; they hold for this whole session)`, ctx.prompt, notes(p, ctx)];
    if (ctx.how.mode !== "resume") intro.push(`# The teach skill\n\n${skillText()}`);
    else intro.push("(These refresh the instructions from when this session started; where they differ, these win.)");
    return `${intro.join("\n\n")}\n\n[Teach app] the session starts here\n\n${text}${att}`;
  };
}

const EFFORT = { medium: "medium", high: "high", xhigh: "xhigh" };
const teachServer = (ctx) => ({ command: process.execPath, args: [path.join(APP, "mcp.mjs")], env: ctx.mcpEnv });

// ---------- Claude Code ----------

const CLAUDE_MODELS = { opus: "opus", sonnet: "sonnet", fable: "fable", haiku: "haiku" };

// Claude Code 2.1.3xx records a session's system prompt and tool list on its first request and reuses them on every
// resume (--system-prompt-snapshot, on by default), so a tutor resumed after the lesson switched to screen mode kept
// the old prompt (no screen guide) and got its new tools only as deferred ones. Resumes turn the snapshot off when
// the installed Claude Code has the flag (an older one would refuse the unknown option).
let snapshotFlag = null;
function hasSnapshotFlag() {
  if (snapshotFlag === null) {
    try { snapshotFlag = execCommand(CLAUDE, ["--help"], { encoding: "utf8", timeout: 20e3, env: cleanEnv() }).includes("--system-prompt-snapshot"); }
    catch { snapshotFlag = false; }
  }
  return snapshotFlag;
}

export function claudeArgs(ctx, { snapshot = hasSnapshotFlag } = {}) {
  const mcp = { mcpServers: { teach: teachServer(ctx), ...(ctx.chalk ? { chalk: ctx.chalk } : {}) } };
  const argv = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--model", MODEL || CLAUDE_MODELS[ctx.model] || "opus", "--effort", ctx.effort || "high",
    "--mcp-config", JSON.stringify(mcp), "--disallowedTools", "AskUserQuestion",
    "--append-system-prompt", ctx.prompt, "--add-dir", LEARNING];
  if (ctx.policy) argv.push("--permission-mode", "default", "--permission-prompt-tool", "stdio", "--tools", SAFE_TOOLS.filter((t) => !t.startsWith("mcp__")).join(","));
  else argv.push("--permission-mode", "bypassPermissions");
  if (ctx.how.mode === "resume") argv.push("--resume", ctx.how.id);
  if (ctx.how.mode === "fork") argv.push("--resume", ctx.how.id, "--fork-session");
  if ((ctx.how.mode === "resume" || ctx.how.mode === "fork") && snapshot()) argv.push("--system-prompt-snapshot", "off");
  return argv;
}

const claude = {
  id: "claude", label: "Claude Code", cli: () => CLAUDE, env: "TEACH_CLAUDE",
  install: "npm install -g @anthropic-ai/claude-code", login: "run `claude` once and log in (or set ANTHROPIC_API_KEY for it)",
  docs: "https://docs.claude.com/en/docs/claude-code/setup",
  can: { screen: true, models: true, effort: true, fork: true },
  safety: {
    restricted: "No shell. Teach answers each of Claude Code's permission checks itself: reads only in the learning and work folders, writes only in the learning folder.",
    full: "A full shell that runs anything as you, without asking (--permission-mode bypassPermissions).",
  },
  marker: (slug) => `"TEACH_TOPIC":${JSON.stringify(slug)}`,
  spawn(ctx) {
    fs.mkdirSync(path.dirname(ctx.log), { recursive: true });
    const err = fs.openSync(ctx.log, "a");
    try { return spawnCommand(CLAUDE, claudeArgs(ctx), { cwd: WORK, env: cleanEnv("claude"), stdio: ["pipe", "pipe", err] }); }
    finally { fs.closeSync(err); }
  },
  check({ exec = run, env: base = process.env } = {}) {
    const env = cleanEnv("claude", base);
    const version = exec(CLAUDE, ["--version"], { env });
    if (!version.ok) return { installed: false, detail: `${CLAUDE} isn't installed or doesn't run` };
    const st = exec(CLAUDE, ["auth", "status"], { env });
    let j = null; try { j = JSON.parse(st.out); } catch { /* an older Claude Code: no `auth status` */ }
    if (!j) return { installed: true, version: version.out.trim(), loggedIn: null, detail: "couldn't tell whether it's logged in (`claude auth status` didn't answer); run `claude` once to make sure" };
    return { installed: true, version: version.out.trim(), loggedIn: !!j.loggedIn, detail: j.loggedIn ? `logged in (${j.authMethod || "yes"})` : "not logged in" };
  },
};

// ---------- Codex CLI (and local models through it) ----------

export function codexArgs(p, ctx, { sessionId = null, images = [] } = {}) {
  const imgs = images.flatMap((f) => ["-i", f]);
  const a = ["exec", ...(sessionId ? [] : imgs), "--json", "--skip-git-repo-check", "-C", WORK,
    "-c", `mcp_servers.teach=${toml({ ...teachServer(ctx), default_tools_approval_mode: "approve", startup_timeout_sec: 30, tool_timeout_sec: 900 })}`,
    "-c", 'web_search="live"'];
  // Restricted: Codex's shell, its exec tool and its image viewer off (they read anywhere), its sandbox read-only (so
  // apply_patch can't write either); the tutor reads and writes through the teach tools, which check every path.
  if (ctx.policy) a.push("--disable", "shell_tool", "--disable", "unified_exec", "--disable", "view_image", "-s", "read-only");
  else a.push("--dangerously-bypass-approvals-and-sandbox");
  if (p.id === "local") {
    a.push("-c", 'model_provider="teach_local"',
      "-c", `model_providers.teach_local=${toml({ name: "Local model (Teach)", base_url: ctx.localUrl || LOCAL_URL, wire_api: "responses", ...(LOCAL_KEY_ENV ? { env_key: LOCAL_KEY_ENV } : {}) })}`);
    if (MODEL) a.push("-m", MODEL);
  } else {
    if (MODEL) a.push("-m", MODEL);
    if (EFFORT[ctx.effort]) a.push("-c", `model_reasoning_effort=${toml(EFFORT[ctx.effort])}`);
  }
  if (sessionId) a.push("resume", ...imgs, sessionId);
  a.push("-");   // the prompt comes on stdin (no length limit, unlike a command line on Windows)
  return a;
}

function turnSession(p, ctx, how) {
  const frame = framed(p, ctx);
  return new TurnSession({
    sessionId: ctx.how.mode === "resume" ? ctx.how.id : null,
    transcript: transcriptFile, log: ctx.log, onPid: ctx.onPid, uploads: path.join(STATE, "uploads"),
    translator: how.translator,
    run: ({ sessionId, text, images }) => {
      const input = frame(text, images), spec = how.run({ sessionId, images });
      return typeof spec.then === "function" ? spec.then((s) => ({ ...s, input, label: p.label })) : { ...spec, input, label: p.label };
    },
  });
}

const codexBase = {
  cli: () => CODEX, env: "TEACH_CODEX", install: "npm install -g @openai/codex", docs: "https://developers.openai.com/codex/cli",
  can: { screen: false, models: false, effort: true, fork: false },
  marker: (slug) => `TEACH_TOPIC = ${JSON.stringify(slug)}`,
  spawn(ctx) {
    const start = ({ sessionId, images }, c = ctx) => ({ cmd: CODEX, args: codexArgs(this, c, { sessionId, images }), cwd: WORK, env: cleanEnv(this.id) });
    // A local server gets Codex's requests through the relay (lib/providers/relay.mjs), so the teach tools work.
    const run = this.id === "local" ? (t) => relay(LOCAL_URL).then((url) => start(t, { ...ctx, localUrl: url })) : start;
    return turnSession(this, ctx, { translator: codexTranslator, run });
  },
};

const codex = {
  ...codexBase, id: "codex", label: "Codex (OpenAI)",
  login: "run `codex login` (ChatGPT account) or `codex login --with-api-key` (OpenAI API key)",
  safety: {
    restricted: "No shell. Codex's shell, exec and image tools are turned off and its sandbox is read-only; the tutor reads (learning and work folders) and writes (learning folder only) through the teach tools, which check every path.",
    full: "Codex's full shell with its sandbox off (--dangerously-bypass-approvals-and-sandbox): it runs anything as you, without asking.",
  },
  check({ exec = run, env: base = process.env } = {}) {
    const env = cleanEnv("codex", base);
    const version = exec(CODEX, ["--version"], { env });
    if (!version.ok) return { installed: false, detail: `${CODEX} isn't installed or doesn't run` };
    const st = exec(CODEX, ["login", "status"], { env });
    const said = (st.out + st.err).trim().split("\n").filter((l) => !/^WARNING/.test(l)).join(" ");
    if (st.ok) return { installed: true, version: version.out.trim(), loggedIn: true, detail: said || "logged in" };
    if (base.CODEX_API_KEY) return { installed: true, version: version.out.trim(), loggedIn: true, detail: "CODEX_API_KEY is set (codex exec uses it)" };
    return { installed: true, version: version.out.trim(), loggedIn: false, detail: said || "not logged in" };
  },
};

const local = {
  ...codexBase, id: "local", label: "a local model (through Codex CLI)",
  login: `start your model server (e.g. \`ollama serve\`, then \`ollama pull <model>\`) and set TEACH_MODEL to the model's name`,
  can: { ...codexBase.can, effort: false },
  safety: {
    restricted: codex.safety.restricted + " The model runs on your machine (or the server at TEACH_LOCAL_URL); web search goes through that server only if it supports it.",
    full: codex.safety.full,
  },
  async check({ exec = run, get = fetchJSON, env = process.env, model = MODEL } = {}) {
    const version = exec(CODEX, ["--version"], { env: cleanEnv("local", env) });
    if (!version.ok) return { installed: false, detail: `${CODEX} isn't installed or doesn't run (local models run through Codex CLI)` };
    let models;
    try { models = ((await get(`${LOCAL_URL.replace(/\/$/, "")}/models`)).data || []).map((m) => m.id); }
    catch (e) { return { installed: true, version: version.out.trim(), loggedIn: false, detail: `no model server answers at ${LOCAL_URL} (${e.message})` }; }
    if (!model) return { installed: true, version: version.out.trim(), loggedIn: false, detail: `set TEACH_MODEL to one of: ${models.join(", ") || "(the server lists none)"}` };
    if (models.length && !models.includes(model)) return { installed: true, version: version.out.trim(), loggedIn: false, detail: `${model} isn't on the server at ${LOCAL_URL} (it has: ${models.join(", ")})` };
    return { installed: true, version: version.out.trim(), loggedIn: true, detail: `${model} at ${LOCAL_URL}` };
  },
};

// ---------- Gemini CLI ----------

// Gemini CLI reads its MCP servers from settings files only (and takes a system settings file only from a root-owned
// folder), so each tutor runs in a project folder of its own under Teach's state, whose .gemini/settings.json adds the
// teach server (your own ~/.gemini settings still apply), with a policy file for what it may do. Gemini keeps its
// sessions per project folder, so this one stays the same for the topic.
export function geminiFiles(ctx) {
  const dir = path.join(STATE, "providers", "gemini", ctx.slug);
  fs.mkdirSync(path.join(dir, ".gemini"), { recursive: true });
  fs.mkdirSync(path.join(STATE, "uploads"), { recursive: true });   // (an --include-directories that doesn't exist stops it)
  const settings = path.join(dir, ".gemini", "settings.json"), policy = path.join(dir, "teach-policy.toml");
  fs.writeFileSync(settings, JSON.stringify({ mcpServers: { teach: { ...teachServer(ctx), trust: true, timeout: 900e3 } } }, null, 2));
  // Restricted: no shell and none of Gemini's own writes (the teach tools write, in the learning folder only); its
  // reads stay, and Gemini keeps them inside the workspace (the work folder plus the --include-directories).
  fs.writeFileSync(policy, ctx.policy ? [
    "# Written by Teach for one tutor; rewritten each time it starts.",
    "[[rule]]", 'toolName = ["run_shell_command", "write_file", "replace", "activate_skill"]', 'decision = "deny"', "priority = 999",
    `denyMessage = "Not here: the tutor has no shell, and writes only with the teach tools file_write and file_edit (learning folder only)."`,
    "", "[[rule]]", 'toolName = "web_fetch"', 'decision = "allow"', "priority = 500", "",
  ].join("\n") : "# Written by Teach: full access (yolo), no extra rules.\n");
  return { dir, settings, policy };
}

export function geminiArgs(ctx, files, { sessionId = null } = {}) {
  const dirs = [WORK, ...(WORK === LEARNING ? [] : [LEARNING]), path.join(STATE, "uploads")];
  return ["-o", "stream-json", "--approval-mode", ctx.policy ? "default" : "yolo", "--policy", files.policy,
    ...dirs.flatMap((d) => ["--include-directories", d]), ...(MODEL ? ["-m", MODEL] : []), ...(sessionId ? ["--resume", sessionId] : [])];
}

const gemini = {
  id: "gemini", label: "Gemini (Google)", cli: () => GEMINI, env: "TEACH_GEMINI",
  install: "npm install -g @google/gemini-cli", docs: "https://github.com/google-gemini/gemini-cli",
  login: "give Gemini CLI a Gemini API key (GEMINI_API_KEY in ~/.gemini/.env, from aistudio.google.com) or set it up for Vertex AI; Google sign-in for individuals no longer works with Gemini CLI",
  can: { screen: false, models: false, effort: false, fork: false },
  safety: {
    restricted: "No shell. A policy file denies Gemini's shell and its own write tools; its read tools stay, which Gemini CLI limits to its workspace (the work and learning folders, Teach's uploads and the tutor's own folder in Teach's state); the tutor writes through the teach tools (learning folder only).",
    full: "Gemini's yolo mode: its shell and file tools run anything as you, without asking.",
  },
  marker: (slug) => path.join("gemini", slug, "teach-policy.toml"),
  spawn(ctx) {
    const files = geminiFiles(ctx);
    const env = { ...cleanEnv("gemini"), GEMINI_CLI_TRUST_WORKSPACE: "true" };
    return turnSession(this, ctx, { translator: geminiTranslator, run: ({ sessionId }) => ({ cmd: GEMINI, args: geminiArgs(ctx, files, { sessionId }), cwd: files.dir, env }) });
  },
  // Gemini CLI has no "am I logged in" command, so this sends it one tiny prompt.
  check({ exec = run, env: base = process.env } = {}) {
    const env = { ...cleanEnv("gemini", base), GEMINI_CLI_TRUST_WORKSPACE: "true" };
    const version = exec(GEMINI, ["--version"], { env });
    if (!version.ok) return { installed: false, detail: `${GEMINI} isn't installed or doesn't run` };
    const r = exec(GEMINI, ["-p", "Reply with just: OK", "-o", "json"], { timeout: 120e3, env });
    const text = r.out + "\n" + r.err;
    if (r.ok) return { installed: true, version: version.out.trim(), loggedIn: true, detail: "answers (one test prompt sent)" };
    if (/IneligibleTier|no longer supported for Gemini Code Assist/i.test(text)) return { installed: true, version: version.out.trim(), loggedIn: false, detail: "Google sign-in for individuals no longer works with Gemini CLI; give it a Gemini API key instead (GEMINI_API_KEY in ~/.gemini/.env)" };
    if (r.code === 41 || /auth method|authoriz|log in|API key not valid/i.test(text)) return { installed: true, version: version.out.trim(), loggedIn: false, detail: `not logged in: ${errorLine(text)}` };
    return { installed: true, version: version.out.trim(), loggedIn: false, detail: errorLine(text) || `exit ${r.code}` };
  },
};

export const PROVIDERS = { claude, codex, gemini, local };

const want = (process.env.TEACH_PROVIDER || "claude").toLowerCase();
if (!PROVIDERS[want]) console.error(`teach: TEACH_PROVIDER=${process.env.TEACH_PROVIDER} isn't one of ${Object.keys(PROVIDERS).join(", ")}; tutors run on Claude Code`);
export const PROVIDER = PROVIDERS[want] || claude;

// ---------- helpers ----------

function run(file, args, { timeout = 30e3, env = cleanEnv("other") } = {}) {   // (sync: setup runs it, never the server)
  try {
    const out = execCommand(file, args, { encoding: "utf8", timeout, env, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, code: 0, out, err: "" };
  } catch (e) {
    return { ok: false, code: e.status ?? null, out: String(e.stdout || ""), err: String(e.stderr || e.message || "") };
  }
}

async function fetchJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
