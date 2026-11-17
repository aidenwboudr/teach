// Codex's and Gemini CLI's JSONL events → Claude Code's stream-json messages, which is what the engine and the
// lesson history read (lib/engine.mjs, lib/transcript.mjs). Tool calls keep Claude Code's names where there's one
// for the same thing (Read, Bash, WebSearch…), so the quiet activity lines read the same whichever AI is teaching;
// MCP tools become mcp__<server>__<tool>.
import { randomBytes } from "node:crypto";

const tag = () => Date.now().toString(36) + randomBytes(3).toString("hex");
const asst = (id, content) => ({ type: "assistant", message: { id, role: "assistant", content } });
const result = (tool_use_id, content, is_error) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id, content, is_error: !!is_error }] } });
const thinking = () => ({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } });

// MCP result content (text and image blocks) → a tool_result's content: the text, with images left out (the lesson
// never shows a tool's screenshots).
const mcpText = (r) => (Array.isArray(r?.content) ? r.content : []).map((c) => (c.type === "text" ? c.text : "")).filter(Boolean).join("\n");

// ---------- Codex (`codex exec --json`): thread.started, turn.*, item.started/updated/completed ----------

export function codexTranslator() {
  const t = tag(), started = new Set();
  let lastError = "", ended = false;
  const tid = (item) => `cx-${t}-${item.id}`;
  const use = (item) => {
    switch (item.type) {
      case "mcp_tool_call": return { name: `mcp__${item.server}__${item.tool}`, input: item.arguments && typeof item.arguments === "object" ? item.arguments : {} };
      case "command_execution": return { name: "Bash", input: { command: String(item.command || "").replace(/^(?:\/bin\/)?(?:ba|z)?sh -l?c\s+/, "") } };
      case "web_search": return { name: "WebSearch", input: { query: item.query || item.action?.query || item.action?.url || "" } };
      case "file_change": return { name: "Edit", input: { file_path: item.changes?.[0]?.path || "" } };
      case "collab_tool_call": return { name: "Agent", input: { description: "Working with a helper agent", run_in_background: false } };
      default: return null;
    }
  };
  const open = (item) => {
    const u = use(item);
    if (!u || started.has(item.id)) return [];
    started.add(item.id);
    return [asst(`msg-${t}-${item.id}`, [{ type: "tool_use", id: tid(item), ...u }])];
  };
  const close = (item) => {
    switch (item.type) {
      case "mcp_tool_call": return [result(tid(item), item.error?.message ? `Error: ${item.error.message}` : mcpText(item.result), item.status === "failed" || !!item.error)];
      case "command_execution": return [result(tid(item), String(item.aggregated_output || "").slice(-4000), item.status !== "completed" || (item.exit_code ?? 0) !== 0)];
      case "web_search": case "file_change": case "collab_tool_call": return [result(tid(item), "", item.status === "failed")];
      default: return [];
    }
  };
  const fn = (ev) => {
    switch (ev.type) {
      case "thread.started": return [{ type: "system", subtype: "init", session_id: ev.thread_id }];
      case "item.started": return ev.item ? open(ev.item) : [];
      case "item.completed": {
        const item = ev.item || {};
        if (item.type === "agent_message") return item.text ? [asst(`msg-${t}-${item.id}`, [{ type: "text", text: item.text }])] : [];
        if (item.type === "reasoning") return [thinking()];
        if (item.type === "error") return [];   // a warning (unknown model metadata, a deprecated setting): it's in the log
        return [...open(item), ...close(item)];
      }
      case "turn.completed": ended = true; return [{ type: "result", subtype: "success", is_error: false, result: "", usage: ev.usage }];
      case "turn.failed": ended = true; return [{ type: "result", subtype: "error", is_error: true, result: ev.error?.message || lastError || "the turn failed" }];
      case "error": lastError = ev.message || lastError; return [];
      default: return [];
    }
  };
  fn.flush = () => (ended || !lastError ? [] : [{ type: "result", subtype: "error", is_error: true, result: lastError }]);
  return fn;
}

// ---------- Gemini CLI (`gemini -o stream-json`): init, message, tool_use, tool_result, error, result ----------

const GEMINI_TOOLS = {
  read_file: (p) => ["Read", { file_path: p.file_path || p.absolute_path || p.path }],
  read_many_files: (p) => ["Read", { file_path: [].concat(p.include || p.paths || []).join(", ") }],
  write_file: (p) => ["Write", { file_path: p.file_path }],
  replace: (p) => ["Edit", { file_path: p.file_path }],
  glob: (p) => ["Glob", { pattern: p.pattern }],
  list_directory: (p) => ["Glob", { pattern: p.dir_path || p.path }],
  grep_search: (p) => ["Grep", { pattern: p.pattern }],
  search_file_content: (p) => ["Grep", { pattern: p.pattern }],
  run_shell_command: (p) => ["Bash", { command: p.command, description: p.description }],
  google_web_search: (p) => ["WebSearch", { query: p.query }],
  web_fetch: (p) => ["WebFetch", { url: (String(p.prompt || p.url || "").match(/https?:\/\/\S+/) || [])[0] || "" }],
  write_todos: () => ["TodoWrite", {}],
};

export function geminiName(name, params = {}) {
  const m = String(name).match(/^mcp_([^_]+)_(.+)$/);
  if (m) return [`mcp__${m[1]}__${m[2]}`, params];
  const f = GEMINI_TOOLS[name];
  return f ? f(params || {}) : [name, params];
}

export function geminiTranslator() {
  const t = tag();
  let n = 0, text = null, lastError = "", ended = false;
  const endText = () => {
    if (!text) return [];
    const out = text.body ? [asst(text.id, [{ type: "text", text: text.body }])] : [];
    text = null;
    return out;
  };
  const fn = (ev) => {
    switch (ev.type) {
      case "init": return [{ type: "system", subtype: "init", session_id: ev.session_id }];
      case "message": {
        if (ev.role !== "assistant" || !ev.content) return [];
        const out = [];
        if (!text) {
          text = { id: `gm-${t}-${++n}`, body: "" };
          out.push({ type: "stream_event", event: { type: "message_start", message: { id: text.id } } },
            { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
        }
        if (!ev.delta) text.body = "";      // (a whole message, not a chunk of one)
        text.body += ev.content;
        out.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ev.content } } });
        return out;
      }
      case "tool_use": {
        const [name, input] = geminiName(ev.tool_name, ev.parameters);
        return [...endText(), asst(`gm-${t}-${++n}`, [{ type: "tool_use", id: `gm-${t}-${ev.tool_id}`, name, input: input || {} }])];
      }
      case "tool_result":
        return [...endText(), result(`gm-${t}-${ev.tool_id}`, ev.status === "error" ? `Error: ${ev.error?.message || "failed"}` : String(ev.output || ""), ev.status === "error")];
      case "error": if (ev.severity === "error") lastError = ev.message || lastError; return [];
      case "result": {
        ended = true;
        const err = ev.status === "error";
        return [...endText(), { type: "result", subtype: err ? "error" : "success", is_error: err, result: err ? ev.error?.message || lastError || "the turn failed" : "", usage: ev.stats }];
      }
      default: return [];
    }
  };
  fn.flush = () => [...endText(), ...(ended || !lastError ? [] : [{ type: "result", subtype: "error", is_error: true, result: lastError }])];
  return fn;
}
