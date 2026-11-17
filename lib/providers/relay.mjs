// TEACH_PROVIDER=local: a relay between Codex and the local model server. Codex (0.169) sends every MCP tool to the
// model inside a Responses API "namespace" tool (mcp__teach → ask, board, update…) and routes a call back only when
// it names that namespace. Local servers (Ollama, LM Studio, vLLM) flatten a namespace into plain functions and answer
// with a call to plain `update`, which Codex then refuses ("unsupported call"), so the tutor could never use the
// teach tools. The relay sends the server plain functions and puts the namespace back on the calls that come back.
// Everything else passes through untouched, headers (and so any key Codex sends) included; it listens on 127.0.0.1.
import http from "node:http";

// Codex's request → one for a server without namespaces, and the map back: flat name → { name, namespace }.
export function flattenRequest(body) {
  const names = new Map(), flat = new Map();   // flat → original; "ns\0name" → flat
  const top = new Set((body.tools || []).filter((t) => t.type !== "namespace" && t.name).map((t) => t.name));
  const flatName = (ns, name) => {
    const key = `${ns}\0${name}`;
    if (flat.has(key)) return flat.get(key);
    let f = name;
    if (top.has(f) || names.has(f)) f = `${ns}__${name}`;
    flat.set(key, f); names.set(f, { name, namespace: ns });
    return f;
  };
  const tools = [];
  for (const t of body.tools || []) {
    if (t.type !== "namespace") { tools.push(t); continue; }
    for (const f of t.tools || []) tools.push({ ...f, type: f.type || "function", name: flatName(t.name, f.name), ...(t.description && !f.description ? { description: t.description } : {}) });
  }
  const input = Array.isArray(body.input) ? body.input.map((it) => {
    if (it && it.type === "function_call" && it.namespace) { const { namespace, ...rest } = it; return { ...rest, name: flatName(namespace, it.name) }; }
    return it;
  }) : body.input;
  return { body: { ...body, ...(body.tools ? { tools } : {}), input }, names };
}

// A server's response (or one stream event of it), with the namespace put back on calls to flattened tools.
export function restore(obj, names) {
  if (Array.isArray(obj)) return obj.map((x) => restore(x, names));
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = restore(v, names);
  if (out.type === "function_call" && !out.namespace && names.has(out.name)) Object.assign(out, names.get(out.name));
  return out;
}

const relays = new Map();   // target → Promise<url>

export function relay(target) {
  if (relays.has(target)) return relays.get(target);
  const base = target.replace(/\/$/, "");
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = Buffer.concat(chunks), names = new Map();
    if (/\/responses$/.test(req.url.split("?")[0]) && body.length) {
      try { const f = flattenRequest(JSON.parse(body)); body = Buffer.from(JSON.stringify(f.body)); names = f.names; } catch { /* not JSON: as is */ }
    }
    const headers = { ...req.headers };
    delete headers.host; delete headers["content-length"]; delete headers.connection;
    let up;
    try { up = await fetch(base + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }); }
    catch (e) { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: `no model server answers at ${base} (${e.message})` } })); return; }
    const type = up.headers.get("content-type") || "";
    res.writeHead(up.status, { "Content-Type": type || "application/octet-stream" });
    if (!names.size || !up.body) { if (up.body) for await (const c of up.body) res.write(c); res.end(); return; }
    if (!type.includes("event-stream")) {
      const text = await up.text();
      try { res.end(JSON.stringify(restore(JSON.parse(text), names))); } catch { res.end(text); }
      return;
    }
    const dec = new TextDecoder();
    let buf = "";
    const line = (l) => {
      if (!l.startsWith("data:")) return l;
      const data = l.slice(5).trim();
      try { return `data: ${JSON.stringify(restore(JSON.parse(data), names))}`; } catch { return l; }
    };
    for await (const c of up.body) {
      buf += dec.decode(c, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { res.write(line(buf.slice(0, i).replace(/\r$/, "")) + "\n"); buf = buf.slice(i + 1); }
    }
    if (buf) res.write(line(buf));
    res.end();
  });
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  server.unref();
  relays.set(target, ready);
  return ready;
}
