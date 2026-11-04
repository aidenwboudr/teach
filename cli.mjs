#!/usr/bin/env node
// `teach`: the Teach app from a shell, on the machine it runs on (talks to the server's socket, if it has one)
// or any other (over TEACH_URL). Chat sessions outside the app use it too. Settings: ~/.config/teach/env.
//   teach                         open the app
//   teach open [slug]             open the app (at a topic)
//   teach url                     print the app's address
//   teach new "what" [--why exam] [--deadline 2026-10-20] [--file PATH]...   start a topic in the app and open it
//   teach list                    topics and where each stands
//   teach tell <slug> "words"     say something to a topic's tutor (Super+/ during an on-screen lesson uses this)
//   teach update|plan|step|cards <slug> '<json>'   change a topic the way the app's teach tools do
//   teach bring [--all]           send /teach sessions that ran on this machine (T3 Code, a focus tool, a terminal) to the app
//   teach focus on "<goal>" <until-epoch> | off      tell the app a focus block started or ended
//   teach sync                    ship the learning folder now (TEACH_SYNC=git-pr: PR + squash-merge)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import "./lib/config.mjs";   // first: ~/.config/teach/env fills in the settings lib/paths.mjs reads
import { URL_PUBLIC, DEFAULT_SOCKET, LEARNING, STATE, BROWSER, splitCmd } from "./lib/paths.mjs";

process.removeAllListeners("warning");     // node:sqlite (T3 Code's thread titles) is still "experimental"
const SOCK = process.env.TEACH_SOCKET || DEFAULT_SOCKET;
const LOCAL = fs.existsSync(SOCK);
const [cmd = "open", ...args] = process.argv.slice(2);

function api(p, body) {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers = { "X-Teach": "1", ...(data ? { "Content-Type": "application/json" } : {}) };
  if (!LOCAL) {
    return fetch(URL_PUBLIC + p, { method: data ? "POST" : "GET", headers, body: data }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
      return j;
    });
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCK, path: p, method: data ? "POST" : "GET", headers: { ...headers, Host: "localhost" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let j = {};
        try { j = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { /* not json */ }
        res.statusCode < 400 ? resolve(j) : reject(new Error(j.error || `HTTP ${res.statusCode}`));
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// TEACH_BROWSER is a command with {url} (the page) or {app} (the page in app mode: it hands clicked links to the
// server's TEACH_OPEN_CMD instead of opening them itself), e.g. `chromium --app={app}`. Default: xdg-open.
function open(p = "/") {
  const url = URL_PUBLIC + p;
  const app = url + (p.includes("?") ? "&" : "?") + "app=desktop";
  console.log(url);
  if (!process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) return;
  const argv = BROWSER ? splitCmd(BROWSER).map((a) => a.replaceAll("{url}", url).replaceAll("{app}", app)) : ["xdg-open", url];
  try { spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch { /* no browser: the URL is printed */ }
}

const flag = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const positional = () => args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const json = (s) => { try { return JSON.parse(s); } catch { throw new Error("the last argument must be JSON"); } };

async function bring() {
  // Reads this machine's transcripts; the server keeps the copies in its WORK folder's project.
  const { findSessions } = await import("./lib/transcript.mjs");
  const known = await api("/api/sessions/known");
  const skip = new Set(known.present);      // anything the server lacks, including sessions a topic already names
  const groups = findSessions({ linked: skip, days: args.includes("--all") ? 365 : 30 });
  if (!groups.length) { console.log("nothing to bring: every /teach session here is already in the app"); return; }
  const from = (await import("node:os")).hostname();
  for (const g of groups) {
    for (const s of g.sessions) {
      const log = g.log && fs.existsSync(g.log) && !g.log.includes("/topics/")
        ? { name: path.basename(g.log), text: fs.readFileSync(g.log, "utf8") } : undefined;
      await api("/api/bring", { id: s.id, via: s.via, thread: s.thread, threadTitle: s.threadTitle, from, jsonl: fs.readFileSync(s.path, "utf8"), log });
    }
    console.log(`sent: ${g.title}  (${g.sessions.length} session${g.sessions.length > 1 ? "s" : ""}${g.log ? ", with its log" : ""})`);
  }
  console.log(`They're on the Teach home page under "From other chats": ${URL_PUBLIC}`);
}

try {
  switch (cmd) {
    case "open": open(args[0] ? `/t/${args[0]}` : "/"); break;
    case "url": console.log(URL_PUBLIC); break;
    case "new": {
      const files = [];
      for (const f of flag("file")) {
        const body = fs.readFileSync(f);
        const name = encodeURIComponent(path.basename(f));
        if (LOCAL) {              // same machine and user as the server: drop it straight into the upload area
          const dir = path.join(STATE, "uploads", String(Date.now()));
          fs.mkdirSync(dir, { recursive: true });
          fs.copyFileSync(f, path.join(dir, path.basename(f)));
          files.push(path.join(dir, path.basename(f)));
        } else {
          const r = await fetch(`${URL_PUBLIC}/api/upload?name=${name}`, { method: "POST", headers: { "X-Teach": "1" }, body });
          files.push((await r.json()).path);
        }
      }
      const r = await api("/api/topics", { text: positional().join(" "), why: flag("why")[0], deadline: flag("deadline")[0], files });
      open(`/t/${r.slug}`);
      break;
    }
    case "list": {
      const { topics } = await api("/api/topics");
      for (const t of topics) console.log(`${t.status.padEnd(8)} ${t.slug.padEnd(30)} ${t.total ? `${t.done}/${t.total}`.padEnd(6) : t.phase.padEnd(6)} ${t.title}${t.deadline ? `  (due ${t.deadline})` : ""}`);
      break;
    }
    case "tell": {
      const [slug, ...words] = args;
      if (!slug || !words.join(" ").trim()) throw new Error('usage: teach tell <slug> "words"');
      await api(`/api/topics/${slug}/message`, { text: words.join(" "), via: "screen" });
      break;
    }
    case "update": case "plan": case "step": case "cards": {
      const [slug, body] = args;
      const r = await api(`/api/topics/${slug}/op`, { op: cmd, args: json(body) });
      console.log(cmd === "cards" ? `added ${r.result.added}, deck has ${r.result.total}` : "ok");
      break;
    }
    case "bring": await bring(); break;
    case "focus":
      await api("/api/focus", args[0] === "on" ? { goal: args[1], until: Number(args[2]) } : {});
      break;
    case "sync": console.log(JSON.stringify((await api("/api/sync", {})).sync)); break;
    default:
      console.error(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
      process.exit(cmd === "help" || cmd === "--help" ? 0 : 2);
  }
} catch (e) {
  console.error(`teach: ${e.message}${/ECONNREFUSED|ENOENT|fetch failed/.test(String(e.cause?.code || e.message)) ? ` (is the app running? where it runs: systemctl --user status teach; data folder ${LEARNING})` : ""}`);
  process.exit(1);
}
