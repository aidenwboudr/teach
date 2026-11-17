// The provider layer (lib/providers/): how each CLI is started, Codex's and Gemini CLI's event streams translated
// into the Claude Code stream-json the engine reads, the one-process-per-turn session that makes those CLIs look like
// one long-lived tutor, the teach file tools a restricted tutor on them uses, and `teach setup` picking a provider.
// The streams below are shaped like the CLIs' real output: Codex's from a recorded run of codex-cli 0.169 (and its
// exec_events.rs), Gemini's from gemini-cli 0.68's output types (packages/core/src/output/types.ts). No model, network
// or real CLI is needed; fake CLIs are small Node scripts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teach-providers-test-"));
const LEARNING = path.join(tmp, "learning"), WORK = path.join(tmp, "school"), STATE = path.join(tmp, "state");
Object.assign(process.env, { TEACH_DATA: LEARNING, TEACH_STATE: STATE, TEACH_WORK: WORK, TEACH_PROJECTS: path.join(tmp, "projects"), TEACH_T3_DB: path.join(tmp, "no.sqlite") });
delete process.env.TEACH_MODEL; delete process.env.TEACH_PROVIDER; delete process.env.TEACH_LEARNER;
for (const d of [path.join(LEARNING, "topics"), WORK, STATE]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const pv = await import("../lib/providers/index.mjs");
const { codexTranslator, geminiTranslator, geminiName } = await import("../lib/providers/translate.mjs");
const { TurnSession, errorLine } = await import("../lib/providers/turns.mjs");
const files = await import("../lib/files.mjs");
const store = await import("../lib/store.mjs");
const tr = await import("../lib/transcript.mjs");

const ctx = (over = {}) => ({ slug: "rc", how: { mode: "new" }, policy: { write: LEARNING, reads: [LEARNING, WORK] }, prompt: "PROMPT", learner: "Sam",
  mcpEnv: { TEACH_TOPIC: "rc", TEACH_DATA: LEARNING }, effort: "high", model: "opus", log: path.join(STATE, "x.log"), onPid: () => {}, ...over });
const after2 = (a, x, y) => a.indexOf(y) > a.indexOf(x);

test("toml: Codex's -c values from JSON", () => {
  assert.equal(pv.toml({ command: "/n/node", args: ["/a b/mcp.mjs"], env: { TEACH_TOPIC: "rc", "a.b": 'q"' }, n: 30, on: true }),
    '{ command = "/n/node", args = ["/a b/mcp.mjs"], env = { TEACH_TOPIC = "rc", "a.b" = "q\\"" }, n = 30, on = true }');
  assert.equal(pv.toml("line\nnext"), '"line\\nnext"');
});

test("Claude Code: the same argv as before the provider layer", () => {
  const r = pv.claudeArgs(ctx(), { snapshot: () => true });
  assert.deepEqual(r.slice(0, 7), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
  assert.equal(r[r.indexOf("--model") + 1], "opus");
  assert.equal(r[r.indexOf("--append-system-prompt") + 1], "PROMPT");
  assert.deepEqual(JSON.parse(r[r.indexOf("--mcp-config") + 1]).mcpServers.teach.env, { TEACH_TOPIC: "rc", TEACH_DATA: LEARNING });
  assert.equal(r[r.indexOf("--permission-mode") + 1], "default");
  assert.equal(r[r.indexOf("--tools") + 1], "Read,Glob,Grep,WebSearch,WebFetch,Agent,Skill,TodoWrite,Edit,Write");
  assert.ok(!r.includes("--resume"));
  const full = pv.claudeArgs(ctx({ policy: null, how: { mode: "resume", id: "S1" } }), { snapshot: () => true });
  assert.equal(full[full.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.deepEqual(full.slice(-4), ["--resume", "S1", "--system-prompt-snapshot", "off"]);
  assert.ok(pv.PROVIDERS.claude.marker("rc") && r[r.indexOf("--mcp-config") + 1].includes(pv.PROVIDERS.claude.marker("rc")), "a crashed server can find its tutor by this");
});

test("Codex: restricted turns its shell, exec and image tools off and the sandbox read-only; full bypasses; resume goes after the root options", () => {
  const P = pv.PROVIDERS.codex;
  const a = pv.codexArgs(P, ctx());
  assert.equal(a[0], "exec");
  assert.ok(a.includes("--json") && a.includes("--skip-git-repo-check"));
  assert.equal(a[a.indexOf("-C") + 1], WORK);
  for (const f of ["shell_tool", "unified_exec", "view_image"]) assert.ok(a.join(" ").includes(`--disable ${f}`), f);
  assert.equal(a[a.indexOf("-s") + 1], "read-only");
  assert.ok(!a.includes("--dangerously-bypass-approvals-and-sandbox"));
  const mcp = a.find((x) => x.startsWith("mcp_servers.teach="));
  assert.match(mcp, /default_tools_approval_mode = "approve"/, "exec never asks, so the teach tools must be pre-approved");
  assert.ok(mcp.includes(P.marker("rc")));
  assert.ok(a.includes('web_search="live"'));
  assert.ok(a.includes('model_reasoning_effort="high"'));
  assert.equal(a.at(-1), "-", "the prompt comes on stdin");
  const full = pv.codexArgs(P, ctx({ policy: null }), { sessionId: "T1", images: ["/u/a.png"] });
  assert.ok(full.includes("--dangerously-bypass-approvals-and-sandbox") && !full.includes("--disable"));
  assert.deepEqual(full.slice(full.indexOf("resume")), ["resume", "-i", "/u/a.png", "T1", "-"]);
  assert.ok(after2(full, "-C", "resume"), "-C, -s and --disable are root options: `codex exec resume` refuses them");
  const first = pv.codexArgs(P, ctx(), { images: ["/u/a.png"] });
  assert.deepEqual(first.slice(1, 3), ["-i", "/u/a.png"], "-i takes several values, so a flag must follow it");
});

test("local models go through Codex with an OpenAI-style provider at TEACH_LOCAL_URL, no reasoning effort", () => {
  const a = pv.codexArgs(pv.PROVIDERS.local, ctx());
  assert.ok(a.includes('model_provider="teach_local"'));
  assert.match(a.find((x) => x.startsWith("model_providers.teach_local=")), /base_url = "http:\/\/127\.0\.0\.1:11434\/v1", wire_api = "responses"/);
  assert.ok(!a.some((x) => x.startsWith("model_reasoning_effort")));
  assert.ok(a.join(" ").includes("--disable shell_tool"));
});

test("Gemini: its own project folder whose settings add the teach server (trusted), a policy file denying its shell and writes; full is yolo", () => {
  const f = pv.geminiFiles(ctx());
  assert.equal(f.dir, path.join(STATE, "providers", "gemini", "rc"));
  const s = JSON.parse(fs.readFileSync(path.join(f.dir, ".gemini", "settings.json"), "utf8"));
  assert.equal(s.mcpServers.teach.trust, true);
  assert.deepEqual(s.mcpServers.teach.env, { TEACH_TOPIC: "rc", TEACH_DATA: LEARNING });
  assert.ok(fs.existsSync(path.join(STATE, "uploads")), "an --include-directories that doesn't exist stops Gemini CLI");
  const pol = fs.readFileSync(f.policy, "utf8");
  assert.match(pol, /toolName = \["run_shell_command", "write_file", "replace", "activate_skill"\]\ndecision = "deny"\npriority = 999/);
  assert.match(pol, /toolName = "web_fetch"\ndecision = "allow"/);
  const a = pv.geminiArgs(ctx(), f);
  assert.deepEqual(a.slice(0, 4), ["-o", "stream-json", "--approval-mode", "default"]);
  assert.equal(a[a.indexOf("--policy") + 1], f.policy);
  assert.deepEqual(a.filter((_, i) => a[i - 1] === "--include-directories"), [WORK, LEARNING, path.join(STATE, "uploads")]);
  assert.ok(a.join(" ").includes(pv.PROVIDERS.gemini.marker("rc")));
  const full = pv.geminiArgs(ctx({ policy: null }), pv.geminiFiles(ctx({ policy: null })), { sessionId: "G1" });
  assert.equal(full[full.indexOf("--approval-mode") + 1], "yolo");
  assert.deepEqual(full.slice(-2), ["--resume", "G1"]);
  assert.doesNotMatch(fs.readFileSync(f.policy, "utf8"), /deny/, "full access: no deny rules");
});

test("the other CLIs get none of Anthropic's variables; Claude Code keeps them", () => {
  const base = { ANTHROPIC_BASE_URL: "http://proxy", ANTHROPIC_AUTH_TOKEN: "t", CLAUDECODE: "1", PATH: "/bin" };
  assert.deepEqual(pv.cleanEnv("codex", base), { PATH: "/bin", FOCUS_ALLOWED_CLAUDE: "1" });
  assert.deepEqual(pv.cleanEnv("claude", base), { ANTHROPIC_BASE_URL: "http://proxy", ANTHROPIC_AUTH_TOKEN: "t", PATH: "/bin", FOCUS_ALLOWED_CLAUDE: "1" });
});

test("the skill as text for CLIs without a Skill tool: no front matter, local.md first", () => {
  const dir = path.join(tmp, "skill");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: teach\n---\n\n# Teach\nProbe first.\n");
  assert.equal(pv.skillText(dir), "# Teach\nProbe first.");
  fs.writeFileSync(path.join(dir, "local.md"), "Sam takes Physics 101.");
  assert.match(pv.skillText(dir), /^## This install's additions[^\n]*\n\nSam takes Physics 101\.\n\n# Teach/);
});

// ---------- translation ----------

const run = (tx, events) => events.flatMap((e) => tx(e)).concat(tx.flush?.() || []);

test("Codex events → stream-json: init, text, teach tool calls with their arguments, results, the turn's end", () => {
  const out = run(codexTranslator(), [
    { type: "thread.started", thread_id: "01a1e69f-9306-7241-be61-1814be25dd4d" },
    { type: "item.completed", item: { id: "item_0", type: "error", message: "Model metadata for `ornith:9b` not found." } },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_1", type: "reasoning", text: "The learner wants…" } },
    { type: "item.started", item: { id: "item_2", type: "mcp_tool_call", server: "teach", tool: "ask", arguments: { purpose: "probe", questions: [{ prompt: "Q?", options: ["a", "b"], answer: 0 }] }, result: null, error: null, status: "in_progress" } },
    { type: "item.completed", item: { id: "item_2", type: "mcp_tool_call", server: "teach", tool: "ask", arguments: { purpose: "probe" }, result: { content: [{ type: "text", text: "Shown to the learner." }] }, error: null, status: "completed" } },
    { type: "item.started", item: { id: "item_3", type: "command_execution", command: "bash -lc ls", aggregated_output: "", exit_code: null, status: "in_progress" } },
    { type: "item.completed", item: { id: "item_3", type: "command_execution", command: "bash -lc ls", aggregated_output: "x\n", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "item_4", type: "web_search", query: "pull-down resistor value" } },
    { type: "item.completed", item: { id: "item_5", type: "agent_message", text: "Let's see where you are." } },
    { type: "turn.completed", usage: { input_tokens: 13705, output_tokens: 1090 } },
  ]);
  assert.deepEqual(out[0], { type: "system", subtype: "init", session_id: "01a1e69f-9306-7241-be61-1814be25dd4d" });
  assert.equal(out[1].event.content_block.type, "thinking");
  const uses = out.filter((m) => m.type === "assistant").flatMap((m) => m.message.content);
  assert.deepEqual(uses.map((b) => b.name || b.type), ["mcp__teach__ask", "Bash", "WebSearch", "text"]);
  assert.deepEqual(uses[0].input.questions[0].options, ["a", "b"], "the arguments from item.started (the card shows at once)");
  assert.equal(uses[1].input.command, "ls");
  assert.equal(uses[2].input.query, "pull-down resistor value");
  const results = out.filter((m) => m.type === "user").map((m) => m.message.content[0]);
  assert.equal(results[0].tool_use_id, uses[0].id);
  assert.equal(results[0].content, "Shown to the learner.");
  assert.equal(results.length, 3);
  assert.deepEqual(out.at(-1).type, "result");
  assert.equal(out.at(-1).is_error, false);
  // a failed MCP call and a failed turn
  const bad = run(codexTranslator(), [
    { type: "item.completed", item: { id: "item_1", type: "mcp_tool_call", server: "teach", tool: "plan", arguments: {}, result: null, error: { message: "nodes is required" }, status: "failed" } },
    { type: "error", message: "Reconnecting... 1/5" },
    { type: "turn.failed", error: { message: "stream disconnected" } },
  ]);
  assert.deepEqual(bad.find((m) => m.type === "user").message.content[0], { type: "tool_result", tool_use_id: bad[0].message.content[0].id, content: "Error: nodes is required", is_error: true });
  assert.deepEqual(bad.at(-1), { type: "result", subtype: "error", is_error: true, result: "stream disconnected" });
  // a stream that just stops after an error: the error is the turn's result
  assert.equal(run(codexTranslator(), [{ type: "error", message: "unexpected status 401 Unauthorized" }]).at(-1).result, "unexpected status 401 Unauthorized");
});

test("Gemini events → stream-json: streamed text, MCP and built-in tools by their Claude Code names, the result", () => {
  const ts = "2026-11-16T23:04:11.227Z";
  const out = run(geminiTranslator(), [
    { type: "init", timestamp: ts, session_id: "1541db13-1ae6-4821-9ef4-9fe7d2ed9e62", model: "auto" },
    { type: "message", timestamp: ts, role: "user", content: "hi" },
    { type: "message", timestamp: ts, role: "assistant", content: "Let me ", delta: true },
    { type: "message", timestamp: ts, role: "assistant", content: "check.", delta: true },
    { type: "tool_use", timestamp: ts, tool_name: "read_file", tool_id: "read_file-1", parameters: { file_path: "/w/PROFILE.md" } },
    { type: "tool_result", timestamp: ts, tool_id: "read_file-1", status: "success", output: "" },
    { type: "tool_use", timestamp: ts, tool_name: "mcp_teach_board", tool_id: "c2", parameters: { put: [{ id: "idea", body: "x" }] } },
    { type: "tool_result", timestamp: ts, tool_id: "c2", status: "error", error: { type: "TOOL_EXECUTION_ERROR", message: "bad op" } },
    { type: "message", timestamp: ts, role: "assistant", content: "Here's the idea.", delta: true },
    { type: "result", timestamp: ts, status: "success", stats: { total_tokens: 10 } },
  ]);
  assert.equal(out[0].session_id, "1541db13-1ae6-4821-9ef4-9fe7d2ed9e62");
  const deltas = out.filter((m) => m.event?.type === "content_block_delta").map((m) => m.event.delta.text);
  assert.deepEqual(deltas, ["Let me ", "check.", "Here's the idea."]);
  const blocks = out.filter((m) => m.type === "assistant").map((m) => m.message.content[0]);
  assert.deepEqual(blocks.map((b) => b.text || b.name), ["Let me check.", "Read", "mcp__teach__board", "Here's the idea."]);
  assert.equal(blocks[1].input.file_path, "/w/PROFILE.md");
  const starts = out.filter((m) => m.event?.type === "message_start").map((m) => m.event.message.id);
  assert.equal(starts.length, 2, "one streamed text before the tools, one after");
  assert.equal(out.find((m) => m.type === "assistant" && m.message.content[0].text === "Let me check.").message.id, starts[0], "the final text replaces the one it streamed");
  const res = out.filter((m) => m.type === "user").map((m) => m.message.content[0]);
  assert.equal(res[1].tool_use_id, blocks[2].id);
  assert.equal(res[1].is_error, true);
  assert.equal(out.at(-1).is_error, false);
  assert.deepEqual(geminiName("mcp_chalk_screen_look"), ["mcp__chalk__screen_look", {}]);
  assert.deepEqual(geminiName("google_web_search", { query: "q" }), ["WebSearch", { query: "q" }]);
  assert.equal(run(geminiTranslator(), [{ type: "result", status: "error", error: { type: "unknown", message: "[API Error: API key not valid]" } }]).at(-1).result, "[API Error: API key not valid]");
});

test("errorLine picks the line worth showing from a CLI's stderr", () => {
  assert.equal(errorLine("Ripgrep is not available. Falling back to GrepTool.\nAn unexpected critical error occurred:IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.\n    at x (y.js:1:1)"),
    "IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.");
  assert.equal(errorLine("WARNING: proceeding, even though…\nNot logged in"), "Not logged in");
});

// ---------- the turn-by-turn session ----------

// A fake Codex: logs its argv and stdin, then prints a turn's events. TURN_MODE picks: ok, slow (waits for a signal),
// fail (stderr and exit 1).
const FAKE = path.join(tmp, "fake-codex.cjs"), FAKELOG = path.join(tmp, "fake.log");
fs.writeFileSync(FAKE, `
const fs = require("fs");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  fs.appendFileSync(${JSON.stringify(FAKELOG)}, JSON.stringify({ argv: process.argv.slice(2), input }) + "\\n");
  const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
  const mode = process.env.TURN_MODE || "ok";
  if (mode === "fail") { process.stderr.write("WARNING: proceeding\\nError: Not logged in\\n"); process.exit(1); }
  const id = process.argv.includes("resume") ? process.argv[process.argv.indexOf("resume") + 1] : "T-1";
  out({ type: "thread.started", thread_id: id });
  out({ type: "turn.started" });
  const n = fs.readFileSync(${JSON.stringify(FAKELOG)}, "utf8").trim().split("\\n").length;
  const finish = () => { out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Reply " + n } }); out({ type: "turn.completed", usage: {} }); };
  if (mode === "slow") { process.on("SIGINT", () => process.exit(130)); setTimeout(finish, Number(process.env.SLOW_MS || 400)); } else finish();
});
`);

function session(over = {}) {
  const transcripts = path.join(tmp, "tx");
  const s = new TurnSession({
    sessionId: over.sessionId || null, transcript: (id) => path.join(transcripts, `${id}.jsonl`), uploads: path.join(tmp, "uploads"),
    translator: codexTranslator, log: path.join(tmp, "turns.log"),
    run: ({ sessionId, text, images }) => ({ cmd: process.execPath, args: [FAKE, ...(sessionId ? ["resume", sessionId] : []), ...images.flatMap((i) => ["-i", i])], cwd: tmp, env: { ...process.env, ...over.env }, input: text, label: "Fake" }),
  });
  const msgs = [];
  let buf = "";
  s.stdout.setEncoding("utf8");
  s.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { msgs.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (text) => s.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
  return { s, msgs, send, transcripts };
}
const wait = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return fn(); };
const calls = () => fs.readFileSync(FAKELOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("a turn-based CLI looks like one tutor process: a turn per message, resumed by id, recorded as a transcript", async () => {
  fs.rmSync(FAKELOG, { force: true });
  const { s, msgs, send, transcripts } = session();
  s.stdin.write(JSON.stringify({ type: "control_request", request_id: "init-1", request: { subtype: "initialize", hooks: null } }) + "\n");
  send("hello");
  await wait(() => msgs.some((m) => m.type === "result"));
  assert.equal(msgs[0].type, "system");
  assert.equal(msgs.find((m) => m.type === "assistant").message.content[0].text, "Reply 1");
  send("[Answers to question set Q1]\n1. right");
  await wait(() => msgs.filter((m) => m.type === "result").length === 2);
  assert.deepEqual(calls().map((c) => c.argv), [[], ["resume", "T-1"]], "the second turn resumes the first's session");
  assert.equal(calls()[1].input, "[Answers to question set Q1]\n1. right");
  const t = tr.entries(path.join(transcripts, "T-1.jsonl"));
  assert.deepEqual(t.map((e) => e.type), ["user", "assistant", "user", "assistant"]);
  assert.ok(t.every((e) => e.uuid && e.timestamp && e.sessionId === "T-1"));
  const h = tr.history([{ path: path.join(transcripts, "T-1.jsonl") }]);
  assert.deepEqual(h.filter((i) => i.t === "text").map((i) => i.text), ["Reply 1", "Reply 2"]);
  assert.equal(h.filter((i) => i.t === "user")[0].text, "hello");
  const exited = new Promise((r) => s.on("exit", r));
  s.stdin.end();
  assert.equal(await exited, 0);
});

test("a message sent mid-turn runs right after it, as the same busy turn (one result); interrupt stops the turn", async () => {
  fs.rmSync(FAKELOG, { force: true });
  const { s, msgs, send } = session({ env: { TURN_MODE: "slow" } });
  send("first");
  await wait(() => fs.existsSync(FAKELOG));
  send("second"); send("third");
  await wait(() => msgs.some((m) => m.type === "result"));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(msgs.filter((m) => m.type === "result").length, 1, "the engine sees one turn");
  assert.deepEqual(calls().map((c) => c.input), ["first", "second\n\nthird"]);
  send("long one");
  await wait(() => calls().length === 3);
  s.stdin.write(JSON.stringify({ type: "control_request", request_id: "stop-1", request: { subtype: "interrupt" } }) + "\n");
  await wait(() => msgs.filter((m) => m.type === "result").length === 2);
  assert.deepEqual(msgs.at(-1), { type: "result", subtype: "error_during_execution", is_error: true, result: "", session_id: "T-1" });
  s.kill();
});

test("a CLI that fails (not logged in) ends the turn with its error line, and the next message tries again", async () => {
  fs.rmSync(FAKELOG, { force: true });
  const { s, msgs, send } = session({ env: { TURN_MODE: "fail" } });
  send("hi");
  await wait(() => msgs.some((m) => m.type === "result"));
  assert.deepEqual(msgs.at(-1), { type: "result", subtype: "error", is_error: true, result: "Fake failed: Error: Not logged in", session_id: null });
  s.kill();
});

test("images in a message are saved as files and handed to the CLI", async () => {
  fs.rmSync(FAKELOG, { force: true });
  const { s, msgs } = session();
  s.stdin.write(JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("PNG").toString("base64") } }] } }) + "\n");
  await wait(() => msgs.some((m) => m.type === "result"));
  const argv = calls()[0].argv, f = argv[argv.indexOf("-i") + 1];
  assert.equal(fs.readFileSync(f, "utf8"), "PNG");
  assert.match(f, /image-1\.png$/);
  s.kill();
});

// ---------- the teach file tools ----------

test("file tools: reads only in the allowed folders, writes only in the learning folder, links can't escape", () => {
  const policy = { tools: "all", write: LEARNING, reads: [LEARNING, WORK], base: WORK };
  fs.writeFileSync(path.join(WORK, "notes.md"), "one\ntwo pull-down\nthree\n");
  fs.mkdirSync(path.join(LEARNING, "topics", "rc", "figures"), { recursive: true });
  assert.match(files.callFile(policy, "file_read", { file_path: "notes.md", offset: 2, limit: 1 }), /^\s+2\ttwo pull-down\n\(2 more lines/);
  assert.throws(() => files.callFile(policy, "file_read", { file_path: "/etc/hostname" }), /only read in/);
  assert.match(files.callFile(policy, "file_search", { pattern: "pull-?down" }), /^notes\.md:2: two pull-down$/);
  assert.equal(files.callFile(policy, "file_write", { file_path: path.join(LEARNING, "topics/rc/figures/a.svg"), content: "<svg/>" }), `Wrote ${path.join(LEARNING, "topics/rc/figures/a.svg")}.`);
  assert.throws(() => files.callFile(policy, "file_write", { file_path: "notes.md", content: "x" }), /only write in/);
  assert.throws(() => files.callFile(policy, "file_write", { file_path: path.join(LEARNING, "../escape.txt"), content: "x" }), /only write in/);
  fs.symlinkSync(tmp, path.join(LEARNING, "out"), "junction");
  assert.throws(() => files.callFile(policy, "file_write", { file_path: path.join(LEARNING, "out/x.txt"), content: "x" }), /only write in/, "a link inside the learning folder pointing out");
  assert.equal(files.callFile(policy, "file_list", { path: LEARNING, pattern: "**/*.svg" }), "topics/rc/figures/a.svg");
  files.callFile(policy, "file_write", { file_path: path.join(LEARNING, "log.md"), content: "a b a" });
  assert.throws(() => files.callFile(policy, "file_edit", { file_path: path.join(LEARNING, "log.md"), old_string: "a", new_string: "c" }), /occurs 2 times/);
  files.callFile(policy, "file_edit", { file_path: path.join(LEARNING, "log.md"), old_string: "a", new_string: "$&c", replace_all: true });
  assert.equal(fs.readFileSync(path.join(LEARNING, "log.md"), "utf8"), "$&c b $&c");
  const img = path.join(WORK, "p.png");
  fs.writeFileSync(img, "PNG");
  assert.deepEqual(files.callFile(policy, "file_read", { file_path: img })[1], { type: "image", data: Buffer.from("PNG").toString("base64"), mimeType: "image/png" });
  // Gemini has its own reads: it gets only the write tools
  assert.deepEqual(files.fileTools({ ...policy, tools: "write" }).map((t) => t.name), ["file_write", "file_edit"]);
  assert.throws(() => files.callFile({ ...policy, tools: "write" }, "file_read", { file_path: "notes.md" }), /isn't available/);
  assert.equal(files.globRe("**/*.md").test("a/b/c.md") && files.globRe("**/*.md").test("c.md") && !files.globRe("*.md").test("a/c.md"), true);
});

// ---------- the engine ----------

test("the engine resumes a session only on the provider it ran on, from Teach's transcript for Codex and Gemini", async () => {
  const { Engine } = await import("../lib/engine.mjs");
  store.createTopic({ slug: "pd", title: "PD" });
  const f = pv.transcriptFile("T-9");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "{}\n");
  store.mutateTopic("pd", (t) => { t.sessions.push({ id: "T-9", cwd: WORK, via: "app", provider: "codex", transcript: f }); });
  assert.deepEqual(new Engine(() => {}, pv.PROVIDERS.codex).plan("pd"), { mode: "resume", id: "T-9" });
  assert.deepEqual(new Engine(() => {}, pv.PROVIDERS.gemini).plan("pd"), { mode: "new", reason: "provider" });
  assert.deepEqual(new Engine(() => {}, pv.PROVIDERS.claude).plan("pd"), { mode: "new", reason: "provider" });
  store.mutateTopic("pd", (t) => { t.sessions = [{ id: "C-1", cwd: WORK, via: "t3" }]; });
  const cf = path.join(tmp, "projects", WORK.replace(/[^a-zA-Z0-9]/g, "-"), "C-1.jsonl");
  fs.mkdirSync(path.dirname(cf), { recursive: true });
  fs.writeFileSync(cf, "{}\n");
  assert.equal(new Engine(() => {}, pv.PROVIDERS.claude).plan("pd").mode, "fork");
  assert.deepEqual(new Engine(() => {}, pv.PROVIDERS.codex).plan("pd"), { mode: "new", reason: "provider" }, "only Claude Code can fork a Claude Code chat");
});

test("the tutor's instructions on a CLI without a Skill tool: the skill inline, Claude Code's tools named for what replaces them", async () => {
  const { appPrompt } = await import("../lib/engine.mjs");
  const t = store.createTopic({ slug: "ip", title: "IP" });
  assert.match(appPrompt(t, null, false, pv.PROVIDERS.claude), /load the teach skill \(Skill tool/);
  assert.doesNotMatch(appPrompt(t, null, false, pv.PROVIDERS.codex), /Skill tool/);
  assert.match(appPrompt(t, null, false, pv.PROVIDERS.codex), /follow the teach skill \(included below\)/);
  assert.match(appPrompt(t, null, true, pv.PROVIDERS.claude), /Screen tools: chalk is installed/);
  assert.doesNotMatch(appPrompt(t, null, true, pv.PROVIDERS.gemini), /Screen tools/, "screen mode: Claude Code only");
});

// ---------- teach setup ----------

test("setup asks which AI, saves it, and says when its CLI isn't ready and what the tutor may do", async () => {
  const { provider } = await import("../lib/setup.mjs");
  const conf = path.join(tmp, "conf", "env");
  fs.mkdirSync(path.dirname(conf), { recursive: true });
  fs.writeFileSync(conf, "TEACH_LEARNER=Sam\nTEACH_PROVIDER=claude\n");
  const logs = [], env = { TEACH_PROVIDER: "claude" };
  const opts = { env, log: (s) => logs.push(s), warn: (s) => logs.push("WARN " + s), conf, prompt: null,
    check: (P) => ({ installed: true, version: "codex-cli 0.169.0", loggedIn: false, detail: "Not logged in" }) };
  await provider({ provider: "codex", check: true }, opts);
  assert.equal(fs.readFileSync(conf, "utf8"), "TEACH_LEARNER=Sam\nTEACH_PROVIDER=codex\n");
  assert.ok(logs.includes("teach: tutors run on Codex (OpenAI) (TEACH_PROVIDER=codex)"));
  assert.ok(logs.some((l) => /^teach: what a tutor may do \(TEACH_ACCESS=restricted\): No shell\. Codex's shell/.test(l)));
  assert.ok(logs.some((l) => /^WARN .*not ready: Not logged in\. To fix: run `codex login`/.test(l)));
  // in a terminal with nothing chosen yet: a question (3 = Gemini)
  const conf2 = path.join(tmp, "conf", "env2");
  await provider({ check: false }, { ...opts, env: {}, conf: conf2, prompt: async (q) => { assert.match(q, /1\. Claude Code \(default\)\n  2\. Codex/); return "3"; } });
  assert.equal(fs.readFileSync(conf2, "utf8"), "TEACH_PROVIDER=gemini\n");
  await assert.rejects(provider({ provider: "llama" }, opts), /--provider must be one of claude, codex, gemini, local/);
  // local with a model: saved too
  await provider({ provider: "local", model: "qwen3:8b", check: false }, opts);
  assert.match(fs.readFileSync(conf, "utf8"), /TEACH_PROVIDER=local\nTEACH_MODEL=qwen3:8b\n$/);
});

test("checks: Codex's login status, a local server's model list, Gemini's answer to one prompt", async () => {
  const ex = (table) => (file, args) => table[args.join(" ")] || { ok: false, code: 1, out: "", err: "" };
  let c = pv.PROVIDERS.codex.check({ exec: ex({ "--version": { ok: true, out: "codex-cli 0.169.0\n" }, "login status": { ok: true, out: "", err: "Logged in using ChatGPT\n" } }) });
  assert.deepEqual(c, { installed: true, version: "codex-cli 0.169.0", loggedIn: true, detail: "Logged in using ChatGPT" });
  c = pv.PROVIDERS.codex.check({ exec: ex({ "--version": { ok: true, out: "codex-cli 0.169.0" }, "login status": { ok: false, code: 1, out: "", err: "Not logged in\n" } }), env: { CODEX_API_KEY: "k" } });
  assert.equal(c.loggedIn, true, "codex exec uses CODEX_API_KEY even though `login status` ignores it");
  assert.equal(pv.PROVIDERS.codex.check({ exec: ex({}) }).installed, false);
  const get = async () => ({ data: [{ id: "qwen3:8b" }, { id: "llama3.2" }] });
  const exv = ex({ "--version": { ok: true, out: "codex-cli 0.169.0" } });
  assert.match((await pv.PROVIDERS.local.check({ exec: exv, get, model: "" })).detail, /set TEACH_MODEL to one of: qwen3:8b, llama3\.2/);
  assert.match((await pv.PROVIDERS.local.check({ exec: exv, get, model: "mistral" })).detail, /mistral isn't on the server/);
  assert.equal((await pv.PROVIDERS.local.check({ exec: exv, get, model: "qwen3:8b" })).loggedIn, true);
  assert.match((await pv.PROVIDERS.local.check({ exec: exv, get: async () => { throw new Error("ECONNREFUSED"); }, model: "x" })).detail, /no model server answers/);
  const gem = (r) => pv.PROVIDERS.gemini.check({ exec: (f, a) => (a[0] === "--version" ? { ok: true, out: "0.68.0" } : r) });
  assert.equal(gem({ ok: true, out: '{"response":"OK"}' }).loggedIn, true);
  assert.match(gem({ ok: false, code: 1, out: "", err: "An unexpected critical error occurred:IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals." }).detail, /Google sign-in for individuals no longer works/);
  assert.match(gem({ ok: false, code: 41, out: "", err: "Please set an Auth method in your /h/.gemini/settings.json" }).detail, /^not logged in/);
});

// ---------- the local provider's relay ----------

test("relay: Codex's namespaced MCP tools go to a local server as plain functions, and its calls come back with the namespace", async () => {
  const { flattenRequest, restore, relay } = await import("../lib/providers/relay.mjs");
  // What codex-cli 0.169 sends (captured through a logging proxy in front of Ollama)
  const req = { model: "m", stream: true, tools: [
    { type: "function", name: "list_mcp_resources", parameters: {} },
    { type: "function", name: "update_goal", parameters: {} },
    { type: "namespace", name: "mcp__teach", description: "Teach tools", tools: [{ type: "function", name: "ask", parameters: {} }, { type: "function", name: "update", parameters: {} }] },
    { type: "namespace", name: "multi_agent_v1", tools: [{ type: "function", name: "list_mcp_resources", parameters: {} }] },
    { type: "web_search" },
  ], input: [{ type: "function_call", namespace: "mcp__teach", name: "ask", call_id: "c1", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "ok" }] };
  const { body, names } = flattenRequest(req);
  assert.deepEqual(body.tools.map((t) => `${t.type}:${t.name || ""}`), ["function:list_mcp_resources", "function:update_goal", "function:ask", "function:update", "function:multi_agent_v1__list_mcp_resources", "web_search:"]);
  assert.equal(body.tools[2].description, "Teach tools");
  assert.deepEqual(body.input[0], { type: "function_call", name: "ask", call_id: "c1", arguments: "{}" }, "history goes back flat too");
  assert.deepEqual(names.get("update"), { name: "update", namespace: "mcp__teach" });
  // What Ollama answers: a plain call, no namespace (seen live)
  assert.deepEqual(restore({ output: [{ type: "function_call", name: "update", call_id: "c2", arguments: '{"goal":"x"}' }] }, names).output[0],
    { type: "function_call", name: "update", namespace: "mcp__teach", call_id: "c2", arguments: '{"goal":"x"}' });
  assert.equal(restore({ type: "function_call", name: "update_goal" }, names).namespace, undefined, "Codex's own tools are left alone");

  // end to end over HTTP: a fake server that streams one call to `update`
  const http = await import("node:http");
  let got = null;
  const fake = http.createServer((q, r) => {
    let b = ""; q.on("data", (d) => (b += d)).on("end", () => {
      got = { url: q.url, auth: q.headers.authorization, body: JSON.parse(b) };
      r.writeHead(200, { "Content-Type": "text/event-stream" });
      r.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", name: "update", call_id: "c3", arguments: "{}" } })}\n\n`);
      r.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const url = await relay(`http://127.0.0.1:${fake.address().port}/v1`);
  const res = await fetch(`${url}/responses`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer k" }, body: JSON.stringify(req) });
  const text = await res.text();
  fake.close();
  assert.equal(got.url, "/v1/responses");
  assert.equal(got.auth, "Bearer k", "headers (a key Codex sends) pass through untouched");
  assert.ok(!got.body.tools.some((t) => t.type === "namespace"));
  assert.match(text, /"name":"update","call_id":"c3","arguments":"\{\}","namespace":"mcp__teach"/);
  assert.match(text, /data: \[DONE\]/);
});
