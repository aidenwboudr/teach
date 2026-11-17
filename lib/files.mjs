// The teach tools file_read, file_list, file_search, file_write and file_edit: how a restricted tutor on a CLI
// without Claude Code's permission checks (Codex, Gemini, a local model) reads and writes. The app turns that CLI's
// own shell and writes off and hands mcp.mjs a policy in TEACH_FILES ({ tools, write, reads, base }): writes only
// under `write` (the learning folder), reads only under `reads` (null: anywhere), paths relative to `base` (the work
// folder). Every path is checked with symlinks resolved (lib/platform.mjs `inside`).
import fs from "node:fs";
import path from "node:path";
import { inside } from "./platform.mjs";

const MAX_READ = 2000, MAX_LIST = 500, MAX_HITS = 200, MAX_FILE = 2 << 20;
const IMAGE = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const SKIP = new Set(["node_modules", ".git", ".venv", "__pycache__"]);
const file = { type: "string", description: "Absolute path, or relative to the work folder" };

export const FILE_TOOLS = [
  { name: "file_read", description: "Read a file in the learning or work folder: a text file comes back with line numbers (offset/limit for long ones); an image (png, jpg, gif, webp) comes back to look at.",
    inputSchema: { type: "object", required: ["file_path"], properties: { file_path: file, offset: { type: "number", description: "1-based line to start at" }, limit: { type: "number", description: `Lines to read (default ${MAX_READ})` } } } },
  { name: "file_list", description: "List files under a folder (the learning or work folder), optionally only those matching a glob such as **/*.md or figures/*.svg.",
    inputSchema: { type: "object", properties: { path: { ...file, description: "Folder to list (default: the work folder)" }, pattern: { type: "string", description: "Glob relative to that folder" } } } },
  { name: "file_search", description: "Search the text files under a folder for a regular expression; returns file:line: text for each match.",
    inputSchema: { type: "object", required: ["pattern"], properties: { pattern: { type: "string", description: "JavaScript regular expression" }, path: { ...file, description: "Folder (default: the work folder)" }, glob: { type: "string", description: "Only files matching this glob, e.g. **/*.md" }, ignore_case: { type: "boolean" } } } },
  { name: "file_write", description: "Write a whole file (creating its folders), only inside the learning folder: the log, review sheets, SVG figures, notes.",
    inputSchema: { type: "object", required: ["file_path", "content"], properties: { file_path: file, content: { type: "string" } } } },
  { name: "file_edit", description: "Replace exact text in a file inside the learning folder. old_string must occur exactly once (or set replace_all).",
    inputSchema: { type: "object", required: ["file_path", "old_string", "new_string"], properties: { file_path: file, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } } } },
];

export function fileTools(policy) {
  if (!policy) return [];
  return policy.tools === "write" ? FILE_TOOLS.filter((t) => t.name === "file_write" || t.name === "file_edit") : FILE_TOOLS;
}

// A glob (*, **, ?) as a regular expression over a /-separated relative path.
export function globRe(glob) {
  let re = "";
  const g = String(glob).replace(/\\/g, "/");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { re += g[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += g[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function callFile(policy, name, args = {}) {
  if (!policy || !fileTools(policy).some((t) => t.name === name)) throw new Error(`${name} isn't available here`);
  const base = policy.base || process.cwd();
  const at = (p, fallback) => path.resolve(base, String(p || fallback || base));
  const readable = (p) => {
    if (policy.reads && !policy.reads.some((r) => inside(p, r, base))) throw new Error(`the tutor can only read in ${policy.reads.slice(0, 2).join(" and ")} here`);
    return p;
  };
  const writable = (p) => {
    if (!inside(p, policy.write, base)) throw new Error(`the tutor can only write in ${policy.write} here`);
    return p;
  };
  switch (name) {
    case "file_read": {
      const f = readable(at(args.file_path));
      const st = fs.statSync(f);
      if (st.isDirectory()) throw new Error(`${f} is a folder; use file_list`);
      const mime = IMAGE[path.extname(f).toLowerCase()];
      if (mime) return [{ type: "text", text: f }, { type: "image", data: fs.readFileSync(f).toString("base64"), mimeType: mime }];
      if (st.size > 20 * MAX_FILE) throw new Error(`${f} is ${Math.round(st.size / 2 ** 20)} MB; too big to read`);
      const lines = fs.readFileSync(f, "utf8").split("\n");
      const from = Math.max(1, Math.floor(args.offset || 1)), n = Math.max(1, Math.min(Math.floor(args.limit || MAX_READ), 5000));
      const part = lines.slice(from - 1, from - 1 + n).map((l, i) => `${String(from + i).padStart(6)}\t${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`);
      const more = from - 1 + n < lines.length ? `\n(${lines.length - (from - 1 + n)} more lines: read on with offset ${from + n})` : "";
      return part.join("\n") + more;
    }
    case "file_list": case "file_search": {
      const dir = readable(at(args.path));
      const want = args.pattern && name === "file_list" ? globRe(args.pattern) : args.glob ? globRe(args.glob) : null;
      const files = walk(dir, policy, base).filter((r) => !want || want.test(r));
      if (name === "file_list") return files.length ? files.slice(0, MAX_LIST).join("\n") + (files.length > MAX_LIST ? `\n(and ${files.length - MAX_LIST} more)` : "") : "(no files)";
      let re;
      try { re = new RegExp(String(args.pattern), args.ignore_case ? "i" : ""); } catch (e) { throw new Error(`bad pattern: ${e.message}`); }
      const hits = [];
      for (const r of files) {
        const f = path.join(dir, r);
        let text;
        try { if (fs.statSync(f).size > MAX_FILE) continue; text = fs.readFileSync(f, "utf8"); } catch { continue; }
        if (text.includes("\0")) continue;   // binary
        text.split("\n").forEach((l, i) => { if (hits.length < MAX_HITS && re.test(l)) hits.push(`${r}:${i + 1}: ${l.slice(0, 300)}`); });
        if (hits.length >= MAX_HITS) break;
      }
      return hits.length ? hits.join("\n") + (hits.length >= MAX_HITS ? `\n(stopped at ${MAX_HITS} matches)` : "") : "(no matches)";
    }
    case "file_write": {
      const f = writable(at(args.file_path));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, String(args.content ?? ""));
      return `Wrote ${f}.`;
    }
    case "file_edit": {
      const f = writable(at(args.file_path));
      const text = fs.readFileSync(f, "utf8"), old = String(args.old_string ?? "");
      if (!old) throw new Error("old_string is empty");
      const count = text.split(old).length - 1;
      if (!count) throw new Error(`old_string isn't in ${f}`);
      if (count > 1 && !args.replace_all) throw new Error(`old_string occurs ${count} times in ${f}; give more context or set replace_all`);
      fs.writeFileSync(f, args.replace_all ? text.split(old).join(String(args.new_string ?? "")) : text.replace(old, () => String(args.new_string ?? "")));
      return `Edited ${f}${count > 1 ? ` (${count} places)` : ""}.`;
    }
    default: throw new Error(`unknown tool ${name}`);
  }
}

// Files under `dir` (relative, /-separated), dot folders and dependency folders left out, and nothing a link would
// take outside what the policy lets the tutor read.
function walk(dir, policy, base) {
  const out = [];
  const go = (d, rel, depth = 0) => {
    if (depth > 20) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= 20000) return;
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink() && policy.reads && !policy.reads.some((x) => inside(p, x, base))) continue;
      let dirLike = e.isDirectory();
      if (e.isSymbolicLink()) { try { dirLike = fs.statSync(p).isDirectory(); } catch { continue; } }
      if (dirLike) go(p, r, depth + 1); else out.push(r);
    }
  };
  go(dir, "");
  return out.sort();
}
