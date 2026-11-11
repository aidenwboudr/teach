"use strict";
// Teach: the page. One file, no build. The server (server.mjs) owns all state; this renders it and sends
// the learner's actions back. Live lesson events arrive over SSE (/api/events?topic=…).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $("#app");

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (name, cls = "icon") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const html = (strings, ...vals) => strings.reduce((a, s, i) => a + s + (i < vals.length ? vals[i] : ""), "");
function frag(markup) { const t = document.createElement("template"); t.innerHTML = markup.trim(); return t.content.firstElementChild; }

async function api(path, body, method) {
  const opts = { headers: { "X-Teach": "1" } };
  if (body !== undefined) { opts.method = method || "POST"; opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status}`);
  return j;
}
const fileURL = (p) => `/api/file?path=${encodeURIComponent(p)}`;

// ---------- time and dates ----------

function ago(t) {
  const s = (Date.now() - (typeof t === "number" ? t : Date.parse(t))) / 1000;
  if (!isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86400) return "yesterday";
  if (s < 14 * 86400) return `${Math.round(s / 86400)} days ago`;
  return new Date(Date.now() - s * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const shortDate = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function deadlineChip(topic) {
  if (!topic.deadline) return null;
  const due = new Date(topic.deadline + "T23:59:59");
  const days = Math.ceil((due - Date.now()) / 86400e3) - 1;
  const what = topic.why === "exam" ? "Exam" : "Due";
  if (days < 0) return { text: `${what} was ${shortDate(due)}`, cls: "chip chip-sm" };
  if (days === 0) return { text: `${what} today`, cls: "chip chip-sm chip-bad" };
  if (days === 1) return { text: `${what} tomorrow`, cls: "chip chip-sm chip-bad" };
  return { text: `${what} in ${days} days`, cls: `chip chip-sm${days <= 7 ? " chip-warn" : ""}` };
}

// ---------- Markdown + LaTeX ----------

marked.use({
  gfm: true,
  renderer: {
    html({ text }) { return esc(text); },
    image({ href, title, text }) {
      let src = href || "";
      if (src.startsWith("file://")) src = decodeURIComponent(src.slice(7));
      const url = src.startsWith("/") ? fileURL(src) : src;
      return `<figure><img src="${esc(url)}" alt="${esc(text || "")}" loading="lazy">${text ? `<figcaption>${esc(text)}</figcaption>` : ""}</figure>`;
    },
    link({ href, title, tokens }) {
      const local = href && href.startsWith("/") && !href.startsWith("//");
      return `<a href="${esc(local ? fileURL(href) : href)}" target="_blank" rel="noreferrer"${title ? ` title="${esc(title)}"` : ""}>${this.parser.parseInline(tokens)}</a>`;
    },
    code({ text, lang }) {
      if ((lang || "").trim() === "svg" || /^\s*<svg[\s>]/.test(text)) {
        return `<figure><img alt="drawing" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}"></figure>`;
      }
      return false;
    },
  },
});

// Math is lifted out before Markdown sees it (so _ and \ survive), then typeset with KaTeX. Code is left alone.
function md(src, { inline = false, allowHTML = false } = {}) {
  const math = [];
  const slot = (tex, display) => { math.push({ tex, display }); return `@@M${math.length - 1}@@`; };
  const parts = String(src || "").split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]
      .replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, a, b) => slot(a ?? b, true))
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, a) => slot(a, false))
      .replace(/(^|[^\\$\w])\$(?=\S)([^$\n]+?)(?<=\S)\$(?![\w$])/g, (_, pre, a) => pre + slot(a, false));
  }
  const text = parts.join("");
  const out = inline ? marked.parseInline(text) : marked.parse(text);
  return out.replace(/@@M(\d+)@@/g, (_, n) => {
    const m = math[+n];
    try {
      const k = katex.renderToString(m.tex, { displayMode: m.display, throwOnError: true, strict: "ignore" });
      return m.display ? `<div class="math-display">${k}</div>` : k;
    } catch (e) {
      return `<code title="${esc(e.message)}">${esc(m.display ? `$$${m.tex}$$` : `$${m.tex}$`)}</code>`;
    }
  });
}
const mdi = (s) => md(s, { inline: true });

// ---------- shell: theme, nav, due badge ----------

$(".theme-toggle").addEventListener("click", () => {
  const h = document.documentElement;
  const dark = h.dataset.theme !== "light";   // dark unless they chose paper
  h.dataset.theme = dark ? "light" : "dark";
  localStorage.setItem("teach-theme", h.dataset.theme);
  $$("iframe.themed").forEach((f) => f.contentWindow?.postMessage({ theme: h.dataset.theme }, "*"));
});

let home = null;     // last /api/home
// Screen mode needs chalk on the machine Teach runs on; without it the switches don't show.
const features = (f) => { if (f) document.body.classList.toggle("no-screen", f.screen === false); return f; };
function setBadge(n) {
  const b = $("#due-badge");
  b.hidden = !n;
  b.textContent = n || "";
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
  e.preventDefault();
  go(a.getAttribute("href"));
});
window.addEventListener("popstate", () => route());

// In an app-mode window (`teach open` with TEACH_BROWSER using {app}: ?app=desktop, kept for reloads) a clicked
// link would open in the browser that frames the app; the server opens it with TEACH_OPEN_CMD instead (the
// learner's own browser). ?app=computer is the older name.
const laptopApp = ["desktop", "laptop"].includes(new URLSearchParams(location.search).get("app")) || sessionStorage.getItem("laptopApp") === "1";
if (laptopApp) sessionStorage.setItem("laptopApp", "1");
document.addEventListener("click", async (e) => {
  const a = e.target.closest('a[target="_blank"]');
  if (!laptopApp || !a || !/^https?:/.test(a.href) || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
  e.preventDefault();
  const out = await api("/api/open", { url: a.href }).catch((err) => ({ why: err.message }));
  if (!out.ok) window.open(a.href, "_blank", "noreferrer");  // no open command, or it failed: here is better than nowhere
});

function go(path) {
  if (path !== location.pathname + location.search) history.pushState(null, "", path);
  route();
}

// ---------- live events ----------

let source = null, sourceKey = null, onEvent = () => {};
function listen(topic, handler) {
  onEvent = handler;
  const key = topic || "";
  if (source && sourceKey === key) return;
  source?.close();
  sourceKey = key;
  source = new EventSource(`/api/events${topic ? `?topic=${encodeURIComponent(topic)}` : ""}`);
  source.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch (e) { console.error(e); } };
}

// A second, quiet stream keeps the due badge and home fresh whatever page is open.
const homeSource = new EventSource("/api/events");
homeSource.onmessage = (m) => {
  const ev = JSON.parse(m.data);
  if (ev.t === "home" || ev.t === "sync") refreshHome();
  if (ev.t === "reviewed") dropReviewed(new Set(ev.keys));
};

// Cards just graded on screen (the tutor's review panels) leave the Review queue here too.
function dropReviewed(keys) {
  const box = $(".queue");
  if (!box || !R.items) return;
  const k = (it) => `${it.slug}/${it.id}`;
  const current = R.items[R.i];
  const before = R.items.length;
  R.items = [...R.items.slice(0, R.i), ...R.items.slice(R.i).filter((it) => !keys.has(k(it)))];
  if (R.items.length === before) return;
  if (current && keys.has(k(current))) { toast("Graded on your screen"); paintCard(box); }
  else $(".queue-head .num")?.replaceChildren(String(Math.max(0, R.items.length - R.i)));
}
let homeTimer = null;
function refreshHome() {
  clearTimeout(homeTimer);
  homeTimer = setTimeout(async () => {
    try {
      home = await api("/api/home"); features(home.features);
      setBadge(home.due.total);
      $("#shell-note").textContent = home.focus ? "focus block" : "";
      if (page === "home") renderHome();
    } catch { /* server restarting */ }
  }, 150);
}

// ---------- routing ----------

let page = null;
function route() {
  const p = location.pathname;
  let m;
  $$(".nav a").forEach((a) => a.removeAttribute("aria-current"));
  document.body.classList.remove("on-lesson");
  if (p === "/" || p === "/new") { page = "home"; $('[data-nav="home"]').setAttribute("aria-current", "page"); return showHome(); }
  if (p === "/review") { page = "review"; $('[data-nav="review"]').setAttribute("aria-current", "page"); return showReview(); }
  if (p === "/profile") { page = "profile"; $('[data-nav="profile"]').setAttribute("aria-current", "page"); return showProfile(); }
  if ((m = p.match(/^\/t\/([a-z0-9-]+)(?:\/(review|notes|files|transcript))?\/?$/))) { page = "topic"; return showTopic(m[1], m[2] || "lesson"); }
  go("/");
}

// =====================================================================================================
// Home
// =====================================================================================================

const WHYS = [["class", "Class"], ["exam", "Exam"], ["homework", "Homework"], ["project", "Project"], ["skill", "Skill"], ["curiosity", "Curiosity"], ["writing", "Writing"]];
const draft = { text: "", why: "", deadline: "", files: [], screen: false };

async function showHome() {
  listen(null, () => {});
  document.title = "Teach";
  if (!home) home = await api("/api/home").catch(() => null);
  features(home?.features);
  const q = new URLSearchParams(location.search);
  if (q.get("q")) { draft.text = q.get("q"); draft.why = q.get("why") || draft.why; draft.deadline = q.get("deadline") || draft.deadline; }
  renderHome();
  refreshHome();
}

function renderHome() {
  if (!home) { app.innerHTML = `<main class="home"><div class="empty"><b>Teach isn't answering.</b> The server may be restarting.</div></main>`; return; }
  setBadge(home.due.total);
  const focused = document.activeElement?.id === "topic";
  const active = home.topics.filter((t) => t.status === "active" || t.status === "paused");
  const done = home.topics.filter((t) => t.status === "done");
  const main = el("main", "home");

  // a) the new-topic composer
  const form = frag(html`
    <form class="composer-new">
      <label class="ask" for="topic">What do you want to learn?</label>
      <textarea id="topic" placeholder="A topic, or paste the problem you're stuck on. Say what you should be able to do at the end."></textarea>
      <div class="row" role="radiogroup" aria-label="What is this for">
        <span class="row-label">For</span>
        ${WHYS.map(([k, label]) => `<button class="chip" type="button" role="radio" data-why="${k}" aria-pressed="${draft.why === k}">${label}</button>`).join("")}
        <span class="row-sep"></span>
        <span class="row-group"><label class="row-label" for="deadline">by</label><input class="field field-sm" type="date" id="deadline" value="${esc(draft.deadline)}"></span>
      </div>
      <div class="row">
        <button class="btn btn-sm attach" type="button">${icon("clip", "icon icon-sm")}Attach files</button>
        <input type="file" multiple hidden>
        <span class="files"></span>
        <span class="row-sep"></span>
        <button class="chip screen-chip" type="button" aria-pressed="${draft.screen}" title="The tutor teaches on your screen: it talks you through each step, marks where to click and watches you do it">${icon("screen", "icon icon-sm")}On my screen</button>
      </div>
      <div class="actions">
        <span class="muted" style="font-size:13.5px">A short probe comes first, then a plan you can change. Ctrl+Enter starts.</span>
        <button class="btn btn-primary btn-lg" type="submit">Start</button>
      </div>
    </form>`);
  const ta = $("textarea", form);
  ta.value = draft.text;
  ta.addEventListener("input", () => { draft.text = ta.value; });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });
  $$("[data-why]", form).forEach((b) => b.addEventListener("click", () => {
    draft.why = draft.why === b.dataset.why ? "" : b.dataset.why;
    $$("[data-why]", form).forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.why === draft.why)));
  }));
  $("#deadline", form).addEventListener("change", (e) => { draft.deadline = e.target.value; });
  $(".screen-chip", form).addEventListener("click", (e) => { draft.screen = !draft.screen; e.currentTarget.setAttribute("aria-pressed", String(draft.screen)); });
  const files = $(".files", form), picker = $("input[type=file]", form);
  const paintFiles = () => {
    files.innerHTML = draft.files.map((f, i) => `<span class="file-tag">${esc(f.name)} <span class="x" data-i="${i}" role="button" aria-label="Remove">×</span></span>`).join("");
    $$(".x", files).forEach((x) => x.addEventListener("click", () => { draft.files.splice(+x.dataset.i, 1); paintFiles(); }));
  };
  paintFiles();
  $(".attach", form).addEventListener("click", () => picker.click());
  picker.addEventListener("change", async () => {
    for (const f of picker.files) { draft.files.push({ name: f.name, pending: true }); paintFiles(); draft.files[draft.files.length - 1] = await upload(f); paintFiles(); }
    picker.value = "";
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!draft.text.trim()) { ta.focus(); return; }
    const btn = $("[type=submit]", form);
    btn.disabled = true; btn.textContent = "Starting…";
    try {
      const r = await api("/api/topics", { text: draft.text, why: draft.why, deadline: draft.deadline, screen: draft.screen, files: draft.files.map((f) => f.path).filter(Boolean) });
      Object.assign(draft, { text: "", why: "", deadline: "", files: [], screen: false });
      go(`/t/${r.slug}`);
    } catch (err) { btn.disabled = false; btn.textContent = "Start"; alert(err.message); }
  });
  main.append(form);

  // d) reviews due
  if (home.due.total) {
    const by = Object.entries(home.due.by).map(([s, n]) => [home.topics.find((t) => t.slug === s)?.title || s, n]).sort((a, b) => b[1] - a[1]);
    main.append(frag(`<aside class="notice" aria-label="Reviews due"><span class="num">${home.due.total}</span>
      <span class="text"><b>due for review</b> across ${by.length} topic${by.length > 1 ? "s" : ""}${by[0] ? ` · ${by[0][1]} for ${esc(by[0][0])}` : ""}</span>
      <a class="btn btn-sm" href="/review" data-link>Review now</a></aside>`));
  }
  if (home.focus) main.append(frag(`<aside class="notice"><span class="text"><b>Focus block:</b> ${esc(home.focus.goal)} · tutors start without a shell until it ends</span></aside>`));

  // b) continue
  if (active.length) {
    const sec = frag(`<section class="section"><div class="section-head"><h2>Continue</h2><span class="count">${active.length} active</span></div><ul class="topics"></ul></section>`);
    active.forEach((t) => $(".topics", sec).append(topicRow(t)));
    main.append(sec);
  }

  // c) from other chats
  if (home.found.length) {
    const sec = frag(`<section class="section"><div class="section-head"><h2>From other chats</h2><span class="count">${home.found.length} session${home.found.length > 1 ? "s" : ""}</span>
      <span class="hint">/teach sessions that ran in chat; bring one in to continue it here</span></div><ul class="found"></ul></section>`);
    for (const g of home.found) {
      const via = [...new Set(g.sessions.map((s) => ({ t3: "T3 thread", focus: "focus tutor", terminal: "terminal" })[s.via] || s.via))].join(" + ");
      const s = g.summary;
      const what = [s.questionSets ? `${s.answered} of ${s.questionSets} question sets answered` : "no questions yet", s.pending ? "a question waiting" : "", s.hasLog ? "has a log" : "no log yet"].filter(Boolean).join(" · ");
      const li = frag(`<li><div><div class="title">${esc(g.title)}</div><div class="detail">${esc(via)} · ${g.live ? "active " : ""}${ago(g.mtime)} · ${esc(what)}</div></div>
        <div class="acts"><button class="btn btn-sm" type="button" data-act="import">Bring into Teach</button><button class="btn btn-sm btn-quiet" type="button" data-act="dismiss">Dismiss</button></div></li>`);
      $("[data-act=import]", li).addEventListener("click", async (e) => {
        e.target.disabled = true; e.target.textContent = "Bringing in…";
        try { const r = await api("/api/import", { key: g.key }); go(`/t/${r.slug}`); } catch (err) { alert(err.message); e.target.disabled = false; e.target.textContent = "Bring into Teach"; }
      });
      $("[data-act=dismiss]", li).addEventListener("click", async () => { await api("/api/dismiss", { key: g.key }); refreshHome(); });
      $(".found", sec).append(li);
    }
    main.append(sec);
  }

  // e) finished
  if (done.length) {
    const sec = frag(`<section class="section"><details class="fold"><summary>Finished <span class="count mono faint">${done.length} topic${done.length > 1 ? "s" : ""}</span></summary><ul class="topics"></ul></details></section>`);
    done.forEach((t) => $(".topics", sec).append(topicRow(t)));
    main.append(sec);
  }

  // f) empty
  if (!active.length && !home.found.length && !done.length) {
    main.append(frag(`<div class="empty"><b>Nothing in progress.</b> Write what you want to learn above. A short probe comes first, a few multiple-choice questions, so the lessons start exactly where your understanding stops.
      <div class="ui">/teach sessions from your other Claude Code chats show up here too, with a button to bring them in.</div></div>`));
  }

  const sync = home.sync;
  if (sync && sync.state === "error") main.append(frag(`<div class="error-line"><span>Last sync to GitHub failed: ${esc(sync.error || "")}</span><button class="btn btn-sm" type="button">Sync now</button></div>`));
  $(".error-line .btn", main)?.addEventListener("click", async () => { await api("/api/sync", {}); refreshHome(); });

  app.replaceChildren(main);
  if (focused || (draft.text && !active.length)) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

function meter(steps) {
  return `<span class="meter" aria-label="${steps.filter((s) => s === "done").length} of ${steps.length} steps done">${steps.map((s) => `<i${s && s !== "todo" ? ` data-s="${s}"` : ""}></i>`).join("")}</span>`;
}

function phaseText(t) {
  const p = t.progress;
  if (t.status === "done") return `finished${t.lastActive ? ` ${shortDate(t.lastActive)}` : ""}`;
  if (p.total && p.current) return `step ${p.steps.indexOf("current") >= 0 ? p.steps.indexOf("current") + 1 : p.done + 1} of ${p.total}`;
  return { frame: "framing", probe: "probing", plan: "planning", teach: "teaching", review: "reviewing", close: "wrapping up" }[t.phase] || t.phase;
}

function topicRow(t) {
  const dl = t.status === "done" ? null : deadlineChip(t);
  const p = t.progress;
  const live = t.busy ? `<span class="chip chip-sm">tutor working</span>` : t.pending ? `<span class="chip chip-sm">question waiting</span>` : "";
  const action = t.status === "done" ? (t.due ? "Review" : "Open") : t.status === "paused" ? "Resume" : "Continue";
  const href = t.status === "done" && t.due ? `/t/${t.slug}/review` : `/t/${t.slug}`;
  return frag(html`
    <li class="topic"${t.status === "paused" ? ' data-paused="true"' : ""}>
      <div>
        <h3 class="topic-title"><a href="/t/${t.slug}" data-link>${esc(t.title)}</a>${t.goal ? `<span class="goal">${esc(t.goal)}</span>` : ""}</h3>
        <div class="topic-progress">
          ${p.total ? `${meter(p.steps)}<span class="frac">${p.done}/${p.total}</span>` : ""}
          <span class="phase">${esc(phaseText(t))}${t.status === "paused" ? " · paused" : ""}</span>
        </div>
        ${t.next ? `<p class="topic-next">Next: ${mdi(t.next)}</p>` : p.current ? `<p class="topic-next">Next: <b>${mdi(p.current.title)}</b></p>` : ""}
      </div>
      <div class="topic-side">
        <div class="meta">${live}${dl ? `<span class="${dl.cls}">${esc(dl.text)}</span>` : ""}${t.due ? `<span class="chip chip-sm">${t.due} due</span>` : ""}</div>
        <div class="meta"><span>${ago(t.lastActive)}</span><span class="sep">·</span><a class="btn btn-sm${t.status === "active" ? " btn-primary" : ""}" href="${href}" data-link>${action}</a></div>
      </div>
    </li>`);
}

async function upload(file) {
  const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "X-Teach": "1" }, body: file });
  const j = await r.json();
  return { name: file.name, path: j.path };
}

// =====================================================================================================
// Topic: header, tabs, lesson stream, sidebar
// =====================================================================================================

const T = { slug: null, data: null, tab: "lesson", status: {} };

async function showTopic(slug, tab) {
  T.slug = slug; T.tab = tab;
  document.body.classList.toggle("on-lesson", tab === "lesson");
  try { T.data = await api(`/api/topics/${slug}`); T.link = T.data.link; features(T.data.features); } catch { app.innerHTML = `<main class="home"><div class="empty"><b>No topic “${esc(slug)}”.</b> <a href="/" data-link>Back home</a></div></main>`; return; }
  document.title = `${T.data.topic.title} · Teach`;
  const shell = topicShell();
  app.replaceChildren(shell);
  if (tab === "lesson") await mountLesson(shell);
  else if (tab === "transcript") await mountTranscript(shell);
  else if (tab === "review") await mountTopicReview(shell);
  else if (tab === "notes") await mountNotes(shell);
  else if (tab === "files") mountFiles(shell);
  listen(slug, onTopicEvent);
}

function topicShell() {
  const t = T.data.topic, dl = deadlineChip(t);
  const plan = t.plan || [];
  const done = plan.filter((n) => n.status === "done" || n.status === "shaky").length;
  const files = T.data.files.length;
  const wrap = frag(html`
    <div class="lesson${T.tab !== "lesson" ? " lesson-doc" : ""}">
      <header class="lesson-head">
        <div>
          <div class="lesson-title">
            <h1>${esc(t.title)}</h1>
            ${t.goal ? `<span class="goal">${mdi(t.goal)}</span>` : ""}
            ${dl && t.status !== "done" ? `<span class="${dl.cls}">${esc(dl.text)}</span>` : ""}
            ${t.status === "done" ? `<span class="chip chip-sm chip-ok">done</span>` : t.status === "paused" ? `<span class="chip chip-sm">paused</span>` : ""}
          </div>
          <div class="tabs" role="tablist">
            <a class="tab" role="tab" data-link href="/t/${t.slug}" aria-selected="${T.tab === "lesson"}">Lesson</a>
            <a class="tab" role="tab" data-link href="/t/${t.slug}/review" aria-selected="${T.tab === "review"}">Review${T.data.deck.total ? ` <span class="n">${T.data.due || T.data.deck.total}</span>` : ""}</a>
            <a class="tab" role="tab" data-link href="/t/${t.slug}/notes" aria-selected="${T.tab === "notes"}">Notes</a>
            <a class="tab" role="tab" data-link href="/t/${t.slug}/files" aria-selected="${T.tab === "files"}">Files${files ? ` <span class="n">${files}</span>` : ""}</a>
            <a class="tab" role="tab" data-link href="/t/${t.slug}/transcript" aria-selected="${T.tab === "transcript"}">Transcript</a>
          </div>
        </div>
        <div class="acts">
          ${T.tab === "lesson" ? `<button class="btn btn-sm side-toggle" type="button" aria-controls="side" aria-expanded="false">${plan.length ? meter(plan.map((n) => n.status)) : ""} ${plan.length ? `Plan ${done}/${plan.length}` : "Plan"}</button>` : ""}
          <details class="menu">
            <summary class="btn btn-icon" aria-label="Topic menu">${icon("more")}</summary>
            <ul class="menu-list" role="menu">
              <li><button type="button" role="menuitem" data-menu="pause">Pause <kbd>P</kbd></button></li>
              <li><button type="button" role="menuitem" data-menu="fresh">Fresh session</button></li>
              <li><button type="button" role="menuitem" data-menu="done">Mark done</button></li>
              <li class="sep" role="separator"></li>
              <li><button type="button" role="menuitem" data-menu="settings">Settings</button></li>
            </ul>
          </details>
        </div>
      </header>
    </div>`);
  $$("[data-menu]", wrap).forEach((b) => b.addEventListener("click", () => { $(".menu", wrap).open = false; menuAction(b.dataset.menu); }));
  $(".side-toggle", wrap)?.addEventListener("click", () => {
    const l = $(".lesson"), open = !l.classList.contains("side-open");
    l.classList.toggle("side-open", open);
    $(".side-toggle").setAttribute("aria-expanded", String(open));
  });
  return wrap;
}

async function menuAction(what) {
  const slug = T.slug;
  if (what === "pause") { await api(`/api/topics/${slug}/pause`, {}); toast("Pausing: the tutor is noting where you stopped."); }
  if (what === "done") { if (confirm("Mark this topic done? The tutor writes the recap, updates your profile and review material.")) { await api(`/api/topics/${slug}/done`, {}); toast("Wrapping up…"); } }
  if (what === "fresh") { if (confirm("Start a fresh session? The plan and log stay; the tutor starts from them with a clean context.")) { await api(`/api/topics/${slug}/fresh`, {}); toast("The next message starts a fresh session."); } }
  if (what === "settings") settingsDialog();
}

// One small state toast at a time, bottom centre: a new one replaces the text in place. role = the dot's colour.
function toast(text, role = "blue") {
  let t = $("body > .toast");
  if (!t) { t = el("div", "toast"); t.setAttribute("role", "status"); document.body.append(t); }
  t.dataset.role = role;
  t.innerHTML = `<i></i><span>${esc(text)}</span>`;
  t.classList.add("is-on");
  clearTimeout(t.timer);
  t.timer = setTimeout(() => t.classList.remove("is-on"), 2600);
}

function settingsDialog() {
  const t = T.data.topic;
  const d = frag(html`
    <dialog class="dialog">
      <form method="dialog">
        <h2>Settings · ${esc(t.title)}</h2>
        <label class="field-row"><span>Title</span><input class="field" name="title" value="${esc(t.title)}"></label>
        <label class="field-row"><span>Deadline</span><input class="field" type="date" name="deadline" value="${esc(t.deadline)}"></label>
        <label class="field-row"><span>Tutor model</span><select class="field" name="model">${["opus", "sonnet", "fable"].map((m) => `<option${t.settings.model === m ? " selected" : ""}>${m}</option>`).join("")}</select></label>
        <label class="field-row"><span>Effort</span><select class="field" name="effort">${["medium", "high", "xhigh"].map((m) => `<option${t.settings.effort === m ? " selected" : ""}>${m}</option>`).join("")}</select></label>
        <label class="field-row check"><input type="checkbox" name="review"${t.settings.review !== false ? " checked" : ""}> <span>Include in daily review</span></label>
        <label class="field-row check screen-chip"><input type="checkbox" name="screen"${t.settings.screen ? " checked" : ""}> <span>Teach on my screen</span></label>
        <label class="field-row check"><input type="checkbox" name="voice"${t.settings.voice !== false ? " checked" : ""}> <span>Talk out loud on my screen</span></label>
        <label class="field-row"><span>Status</span><select class="field" name="status">${["active", "paused", "done", "archived"].map((m) => `<option${t.status === m ? " selected" : ""}>${m}</option>`).join("")}</select></label>
        <p class="hint">Model and effort apply from the next session. Archived topics leave the home page and review.</p>
        <div class="acts"><button class="btn btn-primary" value="save">Save</button><button class="btn btn-quiet" value="cancel">Cancel</button></div>
      </form>
    </dialog>`);
  document.body.append(d);
  d.addEventListener("close", async () => {
    if (d.returnValue === "save") {
      const f = new FormData($("form", d));
      await api(`/api/topics/${T.slug}/settings`, { title: f.get("title"), deadline: f.get("deadline"), model: f.get("model"), effort: f.get("effort"), review: f.get("review") === "on", screen: f.get("screen") === "on", voice: f.get("voice") === "on", status: f.get("status") });
      showTopic(T.slug, T.tab);
    }
    d.remove();
  });
  d.showModal();
}

// ---------- lesson: a board (board.js), not a chat ----------

async function mountLesson(shell) {
  const main = frag(html`
    <section class="stream" aria-label="Lesson">
      <div class="dock">
        <div class="dock-inner">
          <div class="resume" hidden></div>
          <div class="watching" hidden></div>
          <div class="quick" aria-label="Quick replies">
            <button class="chip screen-chip" type="button" aria-pressed="false" title="Teach on your screen: spoken steps, marks where to click, and the tutor watches you do it">${icon("screen", "icon icon-sm")}On my screen</button>
            <button class="chip" type="button" data-quick="Hint, please.">Hint</button>
            <button class="chip" type="button" data-quick="Can you explain that another way?">Explain another way</button>
            <button class="chip" type="button" data-quick="Can I see a worked example?">Example</button>
            <button class="chip" type="button" data-quick="pause">Pause</button>
          </div>
          <form class="composer">
            <div class="attach-row" hidden></div>
            <textarea placeholder="Answer, ask, or say where you got lost. Paste a screenshot with Ctrl+V." aria-label="Message the tutor" rows="1"></textarea>
            <div class="composer-bar">
              <div class="tools">
                <button class="btn btn-quiet btn-icon" type="button" data-tool="file" aria-label="Attach a file" title="Attach a file">${icon("clip")}</button>
                ${T.data?.features?.capture ? `<button class="btn btn-quiet btn-icon" type="button" data-tool="phone" aria-label="Newest photo from the phone" title="Newest photo from the phone">${icon("phone")}</button>` : ""}
                <input type="file" multiple hidden>
              </div>
              <span class="hint"><kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> new line · <kbd>Esc</kbd> stop</span>
              <button class="btn btn-primary send" type="submit">Send</button>
              <button class="btn btn-bad stop" type="button">${icon("stop", "icon icon-sm")}Stop <kbd>Esc</kbd></button>
            </div>
          </form>
        </div>
      </div>
    </section>`);
  const side = el("aside", "side");
  side.id = "side";
  side.setAttribute("aria-label", "Plan and notes");
  shell.append(main, side);
  boardMount(shell, main);
  renderSide();
  wireComposer(main);
  T.status = T.data.status || {};
  const { board } = await api(`/api/topics/${T.slug}/board`);
  boardRender(board);
  paintDock();
  wsPaint();
}

// ---------- transcript: the whole lesson in order, read-only ----------

async function mountTranscript(shell) {
  const doc = frag(`<div class="doc transcript"><div class="doc-head"><h1>Transcript</h1><span class="meta">everything said and asked in this topic, oldest first</span></div><div class="tx"></div></div>`);
  shell.append(doc);
  const { items } = await api(`/api/topics/${T.slug}/history`);
  const box = $(".tx", doc);
  for (const it of items) { const n = transcriptItem(it); if (n) box.append(n); }
  if (!box.children.length) box.innerHTML = `<p class="muted">Nothing yet.</p>`;
  else requestAnimationFrame(() => scrollTo(0, document.scrollingElement.scrollHeight));
}

const gutter = (who, at) => `<aside class="msg-gutter"><span class="who">${who}</span><time>${clock(at)}</time></aside>`;

function transcriptItem(it) {
  switch (it.t) {
    case "divider": {
      const via = { t3: "from a T3 thread", focus: "in the focus tutor", terminal: "in a terminal", app: "" }[it.via] ?? "";
      return el("div", "divider", [`Session ${it.session}`, it.at ? shortDate(it.at) : "", via].filter(Boolean).join(" · "));
    }
    case "user": {
      const a = frag(`<article class="msg msg-you">${gutter("You", it.at)}<div class="msg-body"></div></article>`);
      $(".msg-body", a).append(document.createTextNode(it.text || ""));
      for (const src of it.images || []) { const img = el("img", "thumb"); img.src = src; img.alt = "attached picture"; $(".msg-body", a).append(img); }
      return a;
    }
    case "text": {
      const a = frag(`<article class="msg msg-tutor">${gutter(it.said ? "Said" : "Tutor", it.at)}<div class="msg-body prose"></div></article>`);
      $(".msg-body", a).innerHTML = md(it.text);
      return a;
    }
    case "ask": {
      const a = frag(`<article class="msg msg-tutor">${gutter("", it.at)}<div class="msg-body prose"></div></article>`);
      if (it.status === "pending") { $(".msg-body", a).innerHTML = `<div class="status-chip">Question set · waiting on the board</div>`; return a; }
      paintAsk({ it, body: $(".msg-body", a), answers: [], focus: 0 });
      return a;
    }
    case "show": {
      const s = it.show || {};
      if (!s.path) return frag(`<div class="status"><span class="status-chip">Figure${s.title ? ` · ${esc(s.title)}` : ""}</span></div>`);
      return frag(`<div class="status"><a class="status-chip" href="${fileURL(s.path)}" target="_blank" rel="noreferrer">${icon("open", "icon icon-sm")}Figure${s.title ? ` · ${esc(s.title)}` : ""}</a></div>`);
    }
    case "scene": return frag(`<div class="status"><span class="status-chip">Scene · ${esc(it.scene?.title || "untitled")}</span></div>`);
    case "chip": return frag(`<div class="status"><span class="status-chip${/ · done/.test(it.text) ? " is-ok" : ""}">${mdi(it.text)}</span></div>`);
    case "note": return it.text ? frag(`<div class="status"><span class="status-chip">${esc(it.text)}</span></div>`) : null;
    default: return null;
  }
}

// ---------- question cards ----------

const PURPOSE = { probe: "Probe", check: "Check", review: "Review", setup: "Setup", approve: "Your call", practice: "Practice" };

function paintAsk(card) {
  const { it } = card, ask = it.ask, open = it.status === "pending";
  const results = it.results || [];
  const answers = open ? card.answers : (it.answers || []);
  const graded = results.filter((r) => r && r.ok !== null && r.ok !== undefined);
  const right = graded.filter((r) => r.ok).length;
  const nodeTitle = ask.node && T.data?.topic.plan.find((n) => n.id === ask.node);
  const head = `${PURPOSE[ask.purpose] || "Questions"}${ask.node ? ` · step ${esc(ask.node)}` : ""}${nodeTitle ? ` · ${mdi(nodeTitle.title)}` : ""}${open && it.onScreen ? ` · <span class="on-screen"><i></i>on your screen</span>` : !open && it.via === "screen" ? ` · <span class="on-screen is-done"><i></i>answered on your screen</span>` : ""}`;
  const answeredCount = card.answers.filter(isAnswered).length;
  const form = frag(html`
    <form class="qcard" data-state="${open ? (answeredCount ? "partial" : "open") : "submitted"}" data-screen="${open && it.onScreen ? "live" : !open && it.via === "screen" ? "done" : ""}">
      <div class="qcard-head"><span>${head}</span>${open ? `<span class="progress">${answeredCount} of ${ask.questions.length} answered</span>`
        : it.status === "skipped" ? `<span class="progress">${it.moved ? "moved on" : "skipped"}</span>` : graded.length ? `<span class="score">${right}/${graded.length} right</span>` : `<span class="progress">answered</span>`}</div>
      <div class="qcard-body">
        ${ask.intro ? `<div class="qcard-intro">${md(ask.intro)}</div>` : ""}
        <ol class="qs"></ol>
      </div>
      <div class="qcard-foot">${open
        ? `<button class="btn btn-primary" type="submit">Submit answers <kbd>Enter</kbd></button><button class="btn btn-quiet" type="button" data-skip>Skip</button>
           <span class="hint">${ask.questions.some((q) => ["choice", "multi"].includes(q.kind)) ? "<kbd>1–9</kbd> pick · <kbd>0</kbd> I don't know · " : ""}${it.legacy ? "asked before the move into Teach" : "unanswered ones go in empty"}</span>`
        : graded.length ? `<span class="summary"><span class="frac">${right}/${graded.length}</span>${right === graded.length ? " · all right" : ""}</span>` : `<span class="summary">${it.status === "skipped" ? (it.moved ? "The lesson moved past this one" : "Skipped") : "Sent to the tutor"}</span>`}</div>
    </form>`);
  const ol = $(".qs", form);
  ask.questions.forEach((q, i) => ol.append(questionEl(card, q, i, answers[i] || {}, results[i], open)));
  if (open) {
    form.addEventListener("submit", (e) => { e.preventDefault(); submitAsk(card); });
    $("[data-skip]", form).addEventListener("click", async () => { await api(`/api/topics/${T.slug}/skip`, { id: it.id }).catch((e) => alert(e.message)); });
    form.addEventListener("focusin", (e) => { const li = e.target.closest(".q"); if (li) card.focus = +li.dataset.i; });
  }
  card.body.replaceChildren(form);
  card.form = form;
  card.painted?.(card);
}

const isAnswered = (a) => a && (a.idk || a.own || a.choice !== undefined || (a.choices && a.choices.length) || (a.text && a.text.trim()) || (a.value !== undefined && a.value !== "") || a.order || a.task);

function questionEl(card, q, i, a, r, open) {
  const li = el("li", "q");
  li.dataset.i = i;
  if (r && r.ok === true) li.dataset.result = "right";
  if (r && r.ok === false) li.dataset.result = "wrong";
  li.innerHTML = `<div class="q-text">${md(q.prompt)}</div>${q.image ? `<figure><img src="${fileURL(q.image)}" alt=""></figure>` : ""}`;
  const set = (patch) => { card.answers[i] = { ...patch }; paintAsk(card); const nx = card.form.querySelector(`.q[data-i="${i}"]`); nx?.scrollIntoView({ block: "nearest" }); };

  if (q.kind === "choice" || q.kind === "multi") {
    const box = el("div", "choices");
    box.setAttribute("role", q.kind === "choice" ? "radiogroup" : "group");
    q.options.forEach((opt, j) => {
      const picked = q.kind === "choice" ? a.choice === j : (a.choices || []).includes(j);
      const b = el("button", "choice");
      b.type = "button";
      let verdict = "";
      if (!open && q.answer !== undefined) {
        const isKey = q.kind === "choice" ? q.answer === j : (q.answer || []).includes(j);
        if (picked && isKey) { b.classList.add("is-right"); verdict = "your pick · right"; }
        else if (picked) { b.classList.add("is-wrong"); verdict = "your pick"; }
        else if (isKey) { b.classList.add("is-missed"); verdict = "right"; }
      } else if (!open && picked) verdict = "your pick";
      b.setAttribute("role", q.kind === "choice" ? "radio" : "checkbox");
      b.setAttribute("aria-checked", String(picked));
      b.innerHTML = `<span class="key">${j + 1}</span><span>${mdi(opt)}</span>${verdict ? `<span class="verdict">${verdict}</span>` : ""}`;
      if (open) b.addEventListener("click", () => {
        if (q.kind === "choice") set({ choice: j, own: a.own && undefined });
        else { const s = new Set(a.choices || []); s.has(j) ? s.delete(j) : s.add(j); set({ choices: [...s] }); }
      });
      else b.disabled = true;
      box.append(b);
    });
    if (q.idk && (open || a.idk)) {
      const b = el("button", "choice choice-idk");
      b.type = "button";
      b.setAttribute("aria-checked", String(!!a.idk));
      b.innerHTML = `<span class="key">0</span><span>I don't know</span>${!open && a.idk ? '<span class="verdict">your pick</span>' : ""}`;
      if (open) b.addEventListener("click", () => set({ idk: true })); else b.disabled = true;
      box.append(b);
    }
    li.append(box);
    if (q.own && open) {
      const d = frag(`<details class="own-words"${a.own ? " open" : ""}><summary>In my own words</summary><textarea class="field" placeholder="Your answer in your words. The tutor reads it."></textarea></details>`);
      const ta = $("textarea", d);
      ta.value = a.own || "";
      ta.addEventListener("input", () => { card.answers[i] = { own: ta.value }; updateProgress(card); });
      li.append(d);
    } else if (!open && a.own) li.append(frag(`<details class="own-words" open><summary>In my own words</summary><div class="q-why">You wrote: <q>${esc(a.own)}</q></div></details>`));
    if (!open && !a.choice && a.choice !== 0 && !a.idk && !a.own && !(a.choices || []).length && a.text) li.append(frag(`<div class="q-why">Your answer: ${esc(a.text)}</div>`));
  } else if (q.kind === "text") {
    if (open) {
      const ta = el("textarea", "field");
      ta.setAttribute("aria-label", "Your answer");
      ta.placeholder = q.placeholder || "Your answer";
      ta.value = a.text || "";
      const meta = el("div", "q-meta");
      const paint = () => {
        const words = (ta.value.match(/\S+/g) || []).length;
        meta.innerHTML = `<span>${words} word${words === 1 ? "" : "s"}${q.words ? ` · aim for about ${q.words}` : ""}</span>${q.minutes ? `<span class="timer" data-min="${q.minutes}"></span>` : ""}`;
        if (q.minutes) startTimer($(".timer", meta), card, i, q.minutes);
      };
      ta.addEventListener("input", () => { card.answers[i] = { text: ta.value }; updateProgress(card); paint(); });
      li.append(ta, meta);
      paint();
    } else li.append(frag(`<div class="q-why">${a.text ? `<b>You wrote:</b> ${esc(a.text)}` : "(no answer)"}</div>`));
  } else if (q.kind === "number") {
    if (open) {
      const box = frag(`<div class="num-field"><input class="field field-mono" type="text" inputmode="decimal" aria-label="Value">${q.unit ? `<span class="unit">${esc(q.unit)}</span>` : ""}</div>`);
      const inp = $("input", box);
      inp.value = a.value ?? "";
      inp.addEventListener("input", () => { card.answers[i] = { value: inp.value }; updateProgress(card); });
      li.append(box);
      if (q.idk) {
        const b = el("button", "btn btn-sm btn-quiet");
        b.type = "button"; b.textContent = "I don't know";
        b.addEventListener("click", () => set({ idk: true }));
        li.append(b);
      }
    } else li.append(frag(`<div class="q-why"><b>You answered:</b> ${a.idk ? "I don't know" : esc(a.value ?? "")} ${esc(q.unit || "")}${r && r.ok === false && q.answer !== undefined ? ` · <b>expected</b> ${esc(q.answer)} ${esc(q.unit || "")}` : ""}</div>`));
  } else if (q.kind === "order") {
    const order = a.order || q.options.map((_, j) => j);
    if (open && !a.order) card.answers[i] = { order, untouched: true };
    const ol = el("ol", "order");
    ol.setAttribute("aria-label", "Drag to reorder");
    order.forEach((j, pos) => {
      const item = el("li");
      item.draggable = open;
      item.tabIndex = open ? 0 : -1;
      if (!open && q.correct) item.classList.add(q.correct[pos] === q.options[j] ? "is-right" : "is-wrong");
      item.innerHTML = `${icon("grip", "icon handle")}<span>${mdi(q.options[j])}</span>`;
      item.dataset.j = j;
      ol.append(item);
    });
    if (open) {
      wireOrder(ol, () => { card.answers[i] = { order: $$("li", ol).map((x) => +x.dataset.j) }; updateProgress(card); });
      li.append(ol, frag(`<p class="order-hint">Drag the handles, or focus a row and press <kbd>Alt+↑</kbd> / <kbd>Alt+↓</kbd>.</p>`));
    } else li.append(ol);
  } else if (q.kind === "task") {
    if (open) {
      const t = frag(`<div class="task"><div class="task-actions"><button class="btn" type="button" data-t="done">Done</button><button class="btn" type="button" data-t="stuck">Stuck</button>
        <span class="hint">${a.task ? `marked ${a.task}` : "Stuck asks for a hint, not the answer"}</span></div><textarea class="field" placeholder="Anything to add? (optional)" rows="1"></textarea></div>`);
      $$("[data-t]", t).forEach((b) => { if (a.task === b.dataset.t) b.classList.add("btn-primary"); b.addEventListener("click", () => set({ task: b.dataset.t, text: $("textarea", t).value })); });
      $("textarea", t).value = a.text || "";
      $("textarea", t).addEventListener("input", (e) => { card.answers[i] = { ...card.answers[i], text: e.target.value }; });
      li.append(t);
    } else li.append(frag(`<div class="q-why"><b>${a.task === "done" ? "Done" : a.task === "stuck" ? "Stuck" : "No answer"}</b>${a.text ? `: ${esc(a.text)}` : ""}</div>`));
  }
  if (!open && q.why && (r || it_hasResult(card))) li.append(frag(`<div class="q-why"><b>Why:</b> ${mdi(q.why)}</div>`));
  return li;
}
const it_hasResult = (card) => !!card.it.results;

function updateProgress(card) {
  const n = card.answers.filter(isAnswered).length;
  const p = $(".qcard-head .progress", card.form);
  if (p) p.textContent = `${n} of ${card.it.ask.questions.length} answered`;
  card.form.dataset.state = n ? "partial" : "open";
}

const timers = new Map();
function startTimer(span, card, i, minutes) {
  const key = `${card.it.id}:${i}`;
  if (!timers.has(key)) timers.set(key, Date.now());
  const tick = () => {
    if (!span.isConnected) return;
    const left = Math.max(0, minutes * 60 - (Date.now() - timers.get(key)) / 1000);
    span.textContent = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")} left`;
    span.classList.toggle("is-low", left < 60);
    if (left > 0) setTimeout(tick, 1000);
  };
  tick();
}

function wireOrder(ol, changed) {
  let drag = null;
  ol.addEventListener("dragstart", (e) => { drag = e.target.closest("li"); drag?.classList.add("is-dragging"); });
  ol.addEventListener("dragend", () => { drag?.classList.remove("is-dragging"); drag = null; changed(); });
  ol.addEventListener("dragover", (e) => {
    e.preventDefault();
    const over = e.target.closest("li");
    if (!drag || !over || over === drag) return;
    const r = over.getBoundingClientRect();
    over.parentNode.insertBefore(drag, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
  });
  ol.addEventListener("keydown", (e) => {
    const li = e.target.closest("li");
    if (!li || !e.altKey || !["ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    if (e.key === "ArrowUp" && li.previousElementSibling) li.parentNode.insertBefore(li, li.previousElementSibling);
    if (e.key === "ArrowDown" && li.nextElementSibling) li.parentNode.insertBefore(li.nextElementSibling, li);
    li.focus();
    changed();
  });
}

async function submitAsk(card) {
  const btn = $("[type=submit]", card.form);
  btn.disabled = true;
  const answers = card.answers.map((a) => { const { untouched, ...rest } = a || {}; return untouched ? {} : rest; });
  try {
    const r = await api(`/api/topics/${T.slug}/answer`, { id: card.it.id, answers });
    card.it = { ...card.it, status: "answered", answers, results: r.results };
    paintAsk(card);
  } catch (e) { btn.disabled = false; alert(e.message); }
}

// Number keys pick in the question being worked on; Enter submits the open card.
document.addEventListener("keydown", (e) => {
  if (page !== "topic" || T.tab !== "lesson") return;
  const typing = e.target.matches("textarea, input, select") || !!e.target.closest(".stage-canvas, .predict");
  if (e.key === "Escape" && T.status.busy) { e.preventDefault(); api(`/api/topics/${T.slug}/stop`, {}); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const card = boardPendingCard();
  if (!card) {
    if (e.key === "p" || e.key === "P") { e.preventDefault(); menuAction("pause"); }
    return;
  }
  const qs = card.it.ask.questions;
  let i = card.focus || 0;
  if (!["choice", "multi"].includes(qs[i]?.kind) || isAnswered(card.answers[i])) {
    const nxt = qs.findIndex((q, k) => ["choice", "multi"].includes(q.kind) && !isAnswered(card.answers[k]));
    if (nxt >= 0) i = nxt;
  }
  const q = qs[i];
  if (/^[0-9]$/.test(e.key) && q && ["choice", "multi"].includes(q.kind)) {
    e.preventDefault();
    const n = +e.key;
    if (n === 0 && q.idk) card.answers[i] = { idk: true };
    else if (n >= 1 && n <= q.options.length) {
      if (q.kind === "choice") card.answers[i] = { choice: n - 1 };
      else { const s = new Set(card.answers[i]?.choices || []); s.has(n - 1) ? s.delete(n - 1) : s.add(n - 1); card.answers[i] = { choices: [...s] }; }
    } else return;
    if (q.kind === "choice") { const nxt = qs.findIndex((qq, k) => k > i && !isAnswered(card.answers[k])); if (nxt >= 0) card.focus = nxt; }
    paintAsk(card);
  } else if (e.key === "Enter") { e.preventDefault(); submitAsk(card); }
});

// ---------- composer ----------

const pending = { images: [], files: [] };

function wireComposer(stream) {
  const form = $(".composer", stream), ta = $("textarea", form), row = $(".attach-row", form), picker = $("input[type=file]", form);
  const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 260) + "px"; };
  ta.addEventListener("input", grow);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  const paint = () => {
    row.hidden = !pending.images.length && !pending.files.length;
    row.innerHTML = pending.images.map((im, i) => `<span class="file-tag"><img src="data:${im.media_type};base64,${im.data}" alt="" class="mini"> picture <span class="x" data-img="${i}">×</span></span>`).join("") +
      pending.files.map((f, i) => `<span class="file-tag">${esc(f.name)}${f.pending ? " …" : ""} <span class="x" data-file="${i}">×</span></span>`).join("");
    $$("[data-img]", row).forEach((x) => x.addEventListener("click", () => { pending.images.splice(+x.dataset.img, 1); paint(); }));
    $$("[data-file]", row).forEach((x) => x.addEventListener("click", () => { pending.files.splice(+x.dataset.file, 1); paint(); }));
  };
  paint();
  ta.addEventListener("paste", (e) => {
    for (const item of e.clipboardData?.items || []) {
      if (!item.type.startsWith("image/")) continue;
      e.preventDefault();
      const f = item.getAsFile();
      const rd = new FileReader();
      rd.onload = () => { pending.images.push({ media_type: f.type, data: String(rd.result).split(",")[1] }); paint(); };
      rd.readAsDataURL(f);
    }
  });
  form.addEventListener("dragover", (e) => e.preventDefault());
  form.addEventListener("drop", async (e) => { e.preventDefault(); for (const f of e.dataTransfer.files) { pending.files.push({ name: f.name, pending: true }); paint(); pending.files[pending.files.length - 1] = await upload(f); paint(); } });
  $("[data-tool=file]", form).addEventListener("click", () => picker.click());
  picker.addEventListener("change", async () => { for (const f of picker.files) { pending.files.push({ name: f.name, pending: true }); paint(); pending.files[pending.files.length - 1] = await upload(f); paint(); } picker.value = ""; });
  $("[data-tool=phone]", form)?.addEventListener("click", async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { const r = await api("/api/capture", { kind: "phone" }); pending.files.push({ name: r.name, path: r.path }); paint(); }
    catch (err) { toast(`Phone photo: ${err.message}`); }
    b.disabled = false;
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text && !pending.images.length && !pending.files.length) return;
    const body = { text, images: pending.images.slice(), files: pending.files.filter((f) => f.path).map((f) => f.path) };
    boardEcho(text + (body.files.length ? `\n\nAttached: ${pending.files.map((f) => f.name).join(", ")}` : ""), body.images.length);
    ta.value = ""; grow();
    pending.images = []; pending.files = []; paint();
    try { await api(`/api/topics/${T.slug}/message`, body); } catch (err) { boardError(`Couldn't send: ${err.message}`); }
  });
  $(".stop", form).addEventListener("click", () => api(`/api/topics/${T.slug}/stop`, {}));
  $(".screen-chip", stream).addEventListener("click", async (e) => {
    const on = !T.data.topic.settings.screen;
    e.currentTarget.setAttribute("aria-pressed", String(on));
    await api(`/api/topics/${T.slug}/settings`, { screen: on });
    toast(on ? "On your screen: the tutor takes it from there. Talk to it here or with Super+/." : "Back in Teach.");
  });
  $$("[data-quick]", stream).forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.quick === "pause") return menuAction("pause");
    ta.value = b.dataset.quick;
    form.requestSubmit();
  }));
}

function paintDock() {
  const dock = $(".dock");
  if (!dock) return;
  dock.classList.toggle("is-streaming", !!T.status.busy);
  const t0 = T.data.topic, w = $(".watching", dock);
  $(".screen-chip", dock)?.setAttribute("aria-pressed", String(!!t0.settings.screen));
  paintLink();
  w.hidden = T.status.watching == null;
  if (!w.hidden) w.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${T.status.watching ? `Your turn on screen: ${mdi(T.status.watching)}.` : "Your turn on screen."} The tutor is watching. Ask here or with <kbd>Super+/</kbd>.</span>`;
  const resume = $(".resume", dock);
  const t = T.data.topic;
  const waiting = !!boardPendingCard();
  const show = !T.status.alive && !waiting && t.sessions.length && t.status !== "done";
  resume.hidden = !show;
  if (show) {
    const imported = !t.sessions.some((s) => s.via === "app");
    resume.innerHTML = `<span>${imported ? "This session ran in chat. Continue it here: the tutor fills in the plan, then picks up where it stopped." : t.next ? `Where it stopped: ${mdi(t.next)}` : "Pick up where you left off."}</span>
      <button class="btn btn-sm btn-primary" type="button">${imported ? "Continue here" : "Continue"}</button>`;
    $("button", resume).addEventListener("click", async (e) => { e.target.disabled = true; await api(`/api/topics/${T.slug}/continue`, {}); });
  }
}

// Where the Super+/ hotkey goes right now: this lesson's tutor, plain chalk, or nowhere (chalk unreachable).
function paintLink() {
  const pill = $(".link-pill");
  if (!pill) return;
  const l = T.link || {}, on = !!T.data.topic.settings.screen;
  pill.hidden = !on;
  if (!on) return;
  const state = l.slug === T.slug ? (l.ok ? "tutor" : l.ok === false ? "offline" : "linking") : "chalk";
  pill.dataset.state = state;
  pill.title = state === "offline" ? `Couldn't reach chalk on your screen: ${l.error || "no answer"}. It retries every few minutes.` : "What chalk's Super+/ hotkey does right now";
  pill.innerHTML = `<kbd>Super+/</kbd> ${{ tutor: "asks this tutor", offline: "screen unreachable", linking: "linking…", chalk: "plain chalk" }[state]}`;
}

function onTopicEvent(ev) {
  if (page !== "topic") return;
  if (ev.t === "link") {
    const was = T.link?.slug === T.slug && T.link?.ok;
    T.link = ev.link; paintLink();
    const now = T.link?.slug === T.slug && T.link?.ok;
    if (now !== was) toast(now ? "Super+/ now asks the tutor" : T.link?.ok === false ? "Laptop offline · the lesson goes on here" : "Super+/ is plain chalk again", now ? "teal" : "gold");
    return;
  }
  if (ev.t === "topic") return refreshTopic();
  if (ev.t === "state") { T.status = ev; paintDock(); renderSide(); wsPaint(); paintReply(); return; }
  if (T.tab !== "lesson") return;
  switch (ev.t) {
    case "board": return boardRender(ev.board);
    case "text": return boardText(ev);
    case "delta": return boardDelta(ev);
    case "activity": return boardActivity(ev);
    case "stage": return wsStageEvent(ev);
    case "predicted": return wsPredicted(ev);
    case "idle": return boardIdle(ev);
    case "error": return boardError(ev.text);
  }
}

let topicTimer = null;
function refreshTopic() {
  clearTimeout(topicTimer);
  topicTimer = setTimeout(async () => {
    const d = await api(`/api/topics/${T.slug}`).catch(() => null);
    if (!d) return;
    T.data = d; T.link = d.link || T.link;
    const head = $(".lesson-head");
    if (head) { const fresh = topicShell(); head.replaceWith($(".lesson-head", fresh)); }
    if (T.tab === "lesson") { renderSide(); paintDock(); wsPlanChanged(); }
  }, 250);
}

// ---------- sidebar ----------

function renderSide() {
  const side = $("#side");
  if (!side || !T.data) return;
  const t = T.data.topic, dl = deadlineChip(t);
  const open = new Set($$(".step details[open]", side).map((d) => d.closest(".step").dataset.id));
  const plan = t.plan || [];
  const doneN = plan.filter((n) => n.status === "done").length, skipped = plan.filter((n) => n.status === "skipped").length;
  const agents = T.status.agents || [];
  const has = (s) => !s.missing;
  side.innerHTML = html`
    <button class="btn btn-quiet btn-icon side-close" type="button" aria-label="Close panel">${icon("x")}</button>
    <h3>Goal</h3>
    <p class="side-goal">${t.goal ? mdi(t.goal) : '<span class="muted">Not set yet: the tutor sets it while framing.</span>'}</p>
    <div class="chips">${dl ? `<span class="${dl.cls}">${esc(dl.text)}</span><span class="chip chip-sm">${new Date(t.deadline + "T12:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>` : ""}
      ${t.why ? `<span class="chip chip-sm">${esc(t.why)}</span>` : ""}${t.course ? `<span class="chip chip-sm">${esc(t.course)}</span>` : ""}</div>
    ${t.integrity ? `<p class="side-note">${mdi(t.integrity)}</p>` : ""}
    <h3>Plan <span class="n">${plan.length ? `${doneN} of ${plan.length}${skipped ? ` · ${skipped} skipped` : ""}` : "after the probe"}</span></h3>
    ${plan.length ? `<ol class="plan">${plan.map((n) => `<li class="step" data-status="${n.status}" data-id="${esc(n.id)}"><details${open.has(n.id) || (n.status === "current" && !open.size) ? " open" : ""}>
      <summary><span class="step-mark"></span><span class="step-title">${mdi(n.title)}</span>${n.result && n.result.length <= 6 ? `<span class="step-result">${esc(n.result)}</span>` : ""}</summary>
      <div class="step-detail">${n.result && n.result.length > 6 ? `<p class="mono faint">${esc(n.result)}</p>` : ""}${n.detail ? `<p>${mdi(n.detail)}</p>` : ""}${n.note ? `<p class="muted">${mdi(n.note)}</p>` : ""}${n.deps.length ? `<p class="faint mono">after ${n.deps.map(esc).join(", ")}</p>` : ""}</div></details></li>`).join("")}</ol>`
      : `<p class="muted side-empty">The plan appears here once the probe has found your edge.</p>`}
    ${t.map.length ? `<h3>Knowledge map <span class="n">from the probe</span></h3><ul class="strands">${t.map.map((s) => `<li data-has="${has(s)}"><span class="strand-mark"></span><span>${mdi(s.strand)}${s.misconception ? ' <span class="flag">misconception</span>' : ""}
      <span class="edge">${[s.has && `has ${s.has}`, s.missing && `not yet: ${s.missing}`, s.misconception].filter(Boolean).map(mdi).join("; ")}</span></span></li>`).join("")}</ul>` : ""}
    ${t.facts.length ? `<h3>Fact-check notes <span class="n">${t.facts.length}</span></h3><ul class="side-list">${t.facts.map((f) => `<li>${mdi(f)}</li>`).join("")}</ul>` : ""}
    ${t.sources.length || T.data.files.length ? `<h3>Sources and files <span class="n">${t.sources.length + T.data.files.length}</span></h3><ul class="side-list">
      ${T.data.files.map((f) => `<li><span class="ftype">${esc((f.name.split(".").pop() || "").slice(0, 4))}</span><a href="${fileURL(f.path)}" target="_blank" rel="noreferrer">${esc(f.name)}</a></li>`).join("")}
      ${t.sources.map((s) => `<li><span class="ftype">${s.url ? "web" : s.path ? "file" : "src"}</span>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.label)}</a>` : s.path ? `<a href="${fileURL(s.path)}" target="_blank" rel="noreferrer">${esc(s.label)}</a>` : esc(s.label)}</li>`).join("")}</ul>` : ""}
    ${agents.length ? `<h3>Background work <span class="n">${agents.filter((a) => a.state === "running").length} running</span></h3><ul class="side-list agents">
      ${agents.map((a) => `<li>${a.state === "running" ? '<span class="spinner" aria-hidden="true"></span>' : icon("check", "icon done-mark")}<span>${esc(a.label)}</span><span class="t">${a.state === "running" ? "" : a.state === "error" ? "failed" : "done"}</span></li>`).join("")}</ul>` : ""}
    <h3>Session</h3>
    <p class="side-note">${T.status.alive ? (T.status.busy ? "The tutor is working." : "The tutor is here.") : "The tutor starts when you send something."} ${t.settings.model} · ${t.settings.effort}</p>`;
  $(".side-close", side).addEventListener("click", () => { $(".lesson").classList.remove("side-open"); });
}

// ---------- notes and files tabs ----------

async function mountNotes(shell) {
  const { text } = await api(`/api/topics/${T.slug}/log`);
  const doc = frag(`<div class="doc"><div class="doc-head"><h1>Notes</h1><span class="meta">learning/topics/${esc(T.slug)}/log.md · the tutor's log</span></div><div class="prose"></div></div>`);
  $(".prose", doc).innerHTML = text ? md(text) : `<p class="muted">No log yet. The tutor starts one after the probe.</p>`;
  shell.append(doc);
}

function mountFiles(shell) {
  const t = T.data.topic, files = T.data.files;
  const doc = frag(html`<div class="doc"><div class="doc-head"><h1>Files</h1><span class="meta">attachments stay on this machine</span></div>
    <div class="prose">
      ${files.length ? `<ul class="file-grid">${files.map((f) => `<li>${/\.(png|jpe?g|gif|webp|svg)$/i.test(f.name) ? `<a href="${fileURL(f.path)}" target="_blank" rel="noreferrer"><img src="${fileURL(f.path)}" alt=""></a>` : ""}
        <a href="${fileURL(f.path)}" target="_blank" rel="noreferrer">${esc(f.name)}</a> <span class="faint mono">${f.kind} · ${Math.max(1, Math.round(f.size / 1024))} KB</span></li>`).join("")}</ul>` : `<p class="muted">Nothing attached yet. Attach files from the lesson's composer.</p>`}
      ${t.sources.length ? `<h2>Sources</h2><ul>${t.sources.map((s) => `<li>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.label)}</a>` : esc(s.label)}${s.path ? ` <span class="faint mono">${esc(s.path)}</span>` : ""}</li>`).join("")}</ul>` : ""}
      <h2>Sessions</h2><ul>${t.sessions.map((s, i) => `<li>Session ${i + 1} · ${s.started ? shortDate(s.started) : ""} · ${esc({ t3: "T3 thread", focus: "focus tutor", terminal: "terminal", app: "Teach" }[s.via] || s.via)}${s.title ? ` · ${esc(s.title)}` : ""} <span class="faint mono">${esc(s.id.slice(0, 8))}</span></li>`).join("")}</ul>
    </div></div>`);
  shell.append(doc);
}

// =====================================================================================================
// Review: the spaced queue (global or one topic) and the topic's drills and sheet
// =====================================================================================================

const R = { items: [], i: 0, slug: "", cram: false, flipped: false, done: 0, typed: null };

async function showReview() {
  listen(null, () => {});
  document.title = "Review · Teach";
  if (!home) home = await api("/api/home").catch(() => ({ topics: [], due: { total: 0, by: {} } }));
  const main = el("main", "review");
  app.replaceChildren(main);
  R.slug = new URLSearchParams(location.search).get("topic") || "";
  await loadQueue(main);
}

async function loadQueue(main, slug = R.slug) {
  R.slug = slug;
  const q = await api(`/api/review?topic=${encodeURIComponent(slug)}&cram=${R.cram ? 1 : 0}`);
  Object.assign(R, { items: q.items, i: 0, flipped: false, done: 0, typed: null });
  setBadge(q.due.total);
  renderQueue(main);
}

function renderQueue(main) {
  const topics = (home?.topics || []).filter((t) => t.status !== "archived");
  const total = R.items.length;
  const headN = R.cram ? total : (R.slug ? (home?.due.by[R.slug] || 0) : (home?.due.total || 0));
  const head = frag(html`
    <div>
      <div class="queue-head">
        <div class="count"><span class="num">${Math.max(0, total - R.i)}</span><span class="label">${R.cram ? "to cram" : "due"}${R.slug ? "" : ` · across ${new Set(R.items.map((x) => x.slug)).size || 0} topics`}</span></div>
        <div class="controls">
          ${page === "review" ? `<select class="field field-sm" aria-label="Topic"><option value="">All topics</option>${topics.map((t) => `<option value="${t.slug}"${R.slug === t.slug ? " selected" : ""}>${esc(t.title)}${t.due ? ` · ${t.due}` : ""}</option>`).join("")}</select>` : ""}
          <button class="chip" type="button" aria-pressed="${R.cram}" title="Every item in the topic, missed ones first, not just what's due">Cram${R.slug ? "" : " (pick a topic)"}</button>
        </div>
      </div>
    </div>`);
  void headN;
  $("select", head)?.addEventListener("change", (e) => loadQueue(main, e.target.value));
  $(".chip", head).addEventListener("click", () => { if (!R.slug && page === "review") { toast("Pick a topic to cram."); return; } R.cram = !R.cram; loadQueue(main); });
  const box = el("div", "queue");
  main.replaceChildren(head, box);
  paintCard(box);
}

function paintCard(box) {
  const it = R.items[R.i];
  if (!it) {
    box.innerHTML = `<div class="empty"><b>${R.done ? `Done: ${R.done} reviewed.` : "Nothing due right now."}</b> ${R.slug ? "Cram goes through everything in this topic." : "New items arrive as you learn; up to 20 new ones a day."}</div>`;
    return;
  }
  R.flipped = false; R.typed = null;
  const pos = `<div class="queue-pos"><span>${R.i + 1} of ${R.items.length}</span><span>${esc(it.topic)}</span><span>${{ card: "flashcard", mcq: "choice", recall: "typed", trap: "trap" }[it.type]}</span>${it.isNew ? "<span>new</span>" : `<span>box ${it.box}</span>`}</div>`;
  const grade = async (good) => {
    await api("/api/review/grade", { slug: it.slug, id: it.id, good });
    if (!good && !R.cram) R.items.push({ ...it, isNew: false });   // again: comes back this session
    R.i++; R.done++;
    paintCard(box);
  };
  const againGood = (hint = "") => `<div class="review-actions"><button class="btn btn-bad" type="button" data-g="0">Again <kbd>A</kbd></button><button class="btn btn-ok" type="button" data-g="1">Good <kbd>G</kbd></button>${hint ? `<span class="hint">${hint}</span>` : ""}</div>`;
  const wireGrade = () => $$("[data-g]", box).forEach((b) => b.addEventListener("click", () => grade(b.dataset.g === "1")));
  R.grade = grade;

  if (it.type === "card") {
    const paint = () => {
      box.innerHTML = pos + `<div class="flash" tabindex="0"><div class="flash-front">${md(it.front)}</div>${R.flipped ? `<div class="flash-back">${md(it.back)}</div>` : ""}</div>` +
        (R.flipped ? againGood("Again comes back this session") : `<div class="review-actions"><button class="btn" type="button" data-flip>Flip <kbd>Space</kbd></button><span class="hint">answer in your head first, then flip</span></div>`);
      $("[data-flip]", box)?.addEventListener("click", () => { R.flipped = true; paint(); });
      $(".flash", box).addEventListener("click", () => { if (!R.flipped) { R.flipped = true; paint(); } });
      wireGrade();
    };
    R.flip = () => { if (!R.flipped) { R.flipped = true; paint(); } };
    paint();
  } else if (it.type === "mcq") {
    const order = it.options.map((_, j) => j).sort(() => Math.random() - 0.5);
    const paint = (pick) => {
      const answered = pick !== undefined;
      box.innerHTML = pos + `<form class="qcard" data-state="${answered ? "submitted" : "open"}" style="margin-top:0"><div class="qcard-head"><span>${esc(it.group || "Review")}</span>${answered ? `<span class="score">${pick === it.answer ? "right" : "wrong"}</span>` : ""}</div>
        <div class="qcard-body"><ol class="qs"><li class="q"${answered ? ` data-result="${pick === it.answer ? "right" : "wrong"}"` : ""}><div class="q-text">${md(it.prompt)}</div><div class="choices">
        ${order.map((j, k) => { const cls = !answered ? "" : j === it.answer && j === pick ? " is-right" : j === pick ? " is-wrong" : j === it.answer ? " is-missed" : "";
          return `<button class="choice${cls}" type="button" data-j="${j}"${answered ? " disabled" : ""}><span class="key">${k + 1}</span><span>${mdi(it.options[j])}</span>${cls === " is-right" ? '<span class="verdict">right</span>' : cls === " is-missed" ? '<span class="verdict">right</span>' : cls === " is-wrong" ? '<span class="verdict">your pick</span>' : ""}</button>`; }).join("")}
        </div>${answered && it.why ? `<div class="q-why"><b>Why:</b> ${mdi(it.why)}</div>` : ""}</li></ol></div>
        <div class="qcard-foot">${answered ? `<button class="btn btn-primary" type="button" data-next>Next <kbd>Enter</kbd></button>` : `<span class="hint"><kbd>1–${order.length}</kbd> pick</span>`}</div></form>`;
      $$("[data-j]", box).forEach((b) => b.addEventListener("click", () => paint(+b.dataset.j)));
      $("[data-next]", box)?.addEventListener("click", () => grade(pick === it.answer));
      R.pick = answered ? null : (k) => { if (order[k] !== undefined) paint(order[k]); };
      R.next = answered ? () => grade(pick === it.answer) : null;
    };
    paint();
  } else if (it.type === "recall") {
    box.innerHTML = pos + `<div class="flash"><div class="flash-front">${md(it.prompt)}</div><div class="typed"><input class="field" type="text" aria-label="Your answer" autocomplete="off"><button class="btn" type="button">Check <kbd>Enter</kbd></button></div><div class="typed-out"></div></div>`;
    const inp = $("input", box), out = $(".typed-out", box);
    const check = () => {
      const v = inp.value.trim();
      const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
      let ok = false;
      try { ok = it.accept ? new RegExp(it.accept, "i").test(norm(v)) || new RegExp(it.accept, "i").test(v) : norm(v) === norm(it.answer); } catch { ok = norm(v) === norm(it.answer); }
      R.typed = ok;
      out.innerHTML = `<div class="typed-result ${ok ? "is-right" : "is-wrong"}"><span class="exp">${ok ? "Right." : "Expected:"} <b>${mdi(it.answer)}</b></span>
        <span style="margin-left:auto;display:flex;gap:6px">${ok ? `<button class="btn btn-sm btn-ok" type="button" data-g="1">Next <kbd>Enter</kbd></button>` : `<button class="btn btn-sm btn-quiet" type="button" data-g="1">I was right</button><button class="btn btn-sm" type="button" data-g="0">Again <kbd>A</kbd></button>`}</span></div>`;
      wireGrade();
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (R.typed === null) check(); else grade(R.typed); } });
    $(".typed .btn", box).addEventListener("click", check);
    inp.focus();
  } else if (it.type === "trap") {
    const paint = () => {
      box.innerHTML = pos + `<div class="trap"><div class="trap-label">Spot the trap</div><div class="trap-wrong">${md(it.wrong)}</div>${R.flipped ? `<div class="trap-fix"><span class="lead">Fix</span>${md(it.right)}</div>` : ""}</div>` +
        (R.flipped ? againGood() : `<div class="review-actions"><button class="btn" type="button" data-flip>Show the fix <kbd>Space</kbd></button><span class="hint">say what's wrong first</span></div>`);
      $("[data-flip]", box)?.addEventListener("click", () => { R.flipped = true; paint(); });
      wireGrade();
    };
    R.flip = () => { if (!R.flipped) { R.flipped = true; paint(); } };
    paint();
  }
}

document.addEventListener("keydown", (e) => {
  if (!(page === "review" || (page === "topic" && T.tab === "review"))) return;
  if (e.target.matches("textarea, input, select") || e.ctrlKey || e.metaKey || e.altKey) return;
  const it = R.items[R.i];
  if (!it) return;
  if (e.key === " " && R.flip && (it.type === "card" || it.type === "trap") && !R.flipped) { e.preventDefault(); R.flip(); }
  else if ((e.key === "a" || e.key === "A") && R.flipped) R.grade(false);
  else if ((e.key === "g" || e.key === "G") && R.flipped) R.grade(true);
  else if (it.type === "mcq" && /^[1-9]$/.test(e.key) && R.pick) R.pick(+e.key - 1);
  else if (it.type === "mcq" && e.key === "Enter" && R.next) { e.preventDefault(); R.next(); }
});

async function mountTopicReview(shell) {
  const t = T.data.topic;
  const main = el("main", "review");
  shell.append(main);
  const deck = await api(`/api/topics/${T.slug}/deck`);
  const { text: sheet } = await api(`/api/topics/${T.slug}/sheet`);
  R.cram = R.cram && R.slug === T.slug;
  const queueBox = el("div");
  main.append(queueBox);
  await loadQueue(queueBox, T.slug);
  const toggle = frag(`<label class="review-toggle"><input type="checkbox"${t.settings.review !== false ? " checked" : ""}> Include this topic in daily review</label>`);
  $("input", toggle).addEventListener("change", (e) => api(`/api/topics/${T.slug}/settings`, { review: e.target.checked }).then(refreshHome));
  main.append(toggle);
  for (const item of deck.items.filter((x) => x.type === "order")) main.append(timelineDrill(item));
  for (const item of deck.items.filter((x) => x.type === "outline")) main.append(dumpDrill(item), paragraphDrill(item, deck.checks));
  if (sheet) {
    const s = frag(`<section class="sheet"><div class="sheet-head"><h2>Reference sheet · ${esc(t.title)}</h2><button class="btn btn-sm" type="button">${icon("print", "icon icon-sm")}Print</button></div><div class="prose"></div></section>`);
    $(".prose", s).innerHTML = md(sheet);
    $("button", s).addEventListener("click", () => { document.body.classList.add("print-sheet"); window.print(); document.body.classList.remove("print-sheet"); });
    main.append(s);
  }
  if (!deck.items.length && !sheet) main.append(frag(`<div class="empty">No review material yet. The tutor adds every check you answer, plus key facts, as you go.</div>`));
}

function timelineDrill(item) {
  const sec = frag(`<section class="drill"><div class="drill-head"><h2>${esc(item.title)}</h2><span class="sub">drag into order, then check</span></div><ol class="order" aria-label="Drag to reorder"></ol>
    <div class="review-actions"><button class="btn" type="button" data-check>Check</button><button class="btn btn-quiet" type="button" data-shuffle>Shuffle</button><span class="hint"></span></div></section>`);
  const ol = $("ol", sec);
  const shuffle = () => {
    ol.innerHTML = "";
    item.items.map((x, j) => j).sort(() => Math.random() - 0.5).forEach((j) => {
      const li = el("li"); li.draggable = true; li.tabIndex = 0; li.dataset.j = j;
      li.innerHTML = `${icon("grip", "icon handle")}<span>${mdi(item.items[j].text)}</span>`;
      ol.append(li);
    });
    $(".hint", sec).textContent = "";
  };
  shuffle();
  wireOrder(ol, () => $$("li", ol).forEach((li) => li.classList.remove("is-right", "is-wrong")));
  $("[data-check]", sec).addEventListener("click", () => {
    let right = 0;
    $$("li", ol).forEach((li, pos) => {
      const ok = +li.dataset.j === pos;
      if (ok) right++;
      li.classList.toggle("is-right", ok); li.classList.toggle("is-wrong", !ok);
      const lab = item.items[+li.dataset.j].label;
      if (lab && !$(".faint", li)) li.insertAdjacentHTML("beforeend", ` <span class="faint mono">${esc(lab)}</span>`);
    });
    $(".hint", sec).textContent = `${right} of ${item.items.length} in place`;
  });
  $("[data-shuffle]", sec).addEventListener("click", shuffle);
  return sec;
}

function kwHit(text, k) {
  const pat = k.pattern || k.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try { return new RegExp(pat, "i").test(text); } catch { return text.toLowerCase().includes(k.label.toLowerCase()); }
}

function countdown(span, minutes, key) {
  const start = Date.now();
  span.dataset.key = key;
  const tick = () => {
    if (!span.isConnected || span.dataset.key !== key) return;
    const left = Math.max(0, minutes * 60 - (Date.now() - start) / 1000);
    span.textContent = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}`;
    span.classList.toggle("is-low", left < 60);
    if (left > 0) setTimeout(tick, 500);
  };
  tick();
}

function dumpDrill(item) {
  const sec = frag(`<section class="drill"><div class="drill-head"><h2>Margin dump</h2><span class="sub">${esc(item.title)}: write the outline from memory; keywords light up as you hit them</span>
    <button class="btn btn-sm" type="button" data-start>Start ${item.minutes}:00</button><span class="timer timer-lg">${item.minutes}:00</span></div><div class="dump"></div>
    <textarea class="field" style="margin-top:12px;min-height:140px" aria-label="Your outline" placeholder="Everything you can, any order; short words are fine"></textarea></section>`);
  const ta = $("textarea", sec), dump = $(".dump", sec);
  const paint = () => {
    const v = ta.value;
    dump.innerHTML = item.sections.map((s, n) => {
      const hits = s.keywords.filter((k) => kwHit(v, k)).length;
      return `<div class="dump-sec"><h4>${esc(s.title)}<span class="n">${hits} of ${s.keywords.length}</span></h4><div class="kws">${s.keywords.map((k) => `<span class="kw${kwHit(v, k) ? " is-hit" : sec.dataset.checked ? " is-miss" : " is-hidden"}">${esc(sec.dataset.checked || kwHit(v, k) ? k.label : "hidden")}</span>`).join("")}</div></div>`;
    }).join("");
  };
  ta.addEventListener("input", paint);
  $("[data-start]", sec).addEventListener("click", () => { countdown($(".timer", sec), item.minutes, String(Date.now())); ta.focus(); });
  const check = el("button", "btn btn-sm");
  check.type = "button"; check.textContent = "Show what I missed";
  check.addEventListener("click", () => { sec.dataset.checked = "1"; paint(); });
  $(".drill-head", sec).append(check);
  paint();
  return sec;
}

function paragraphDrill(item, checks) {
  const sec = frag(`<section class="drill"><div class="drill-head"><h2>Paragraph drill</h2><span class="sub">one paragraph, closed notes</span>
    <select class="field field-sm" aria-label="Paragraph">${item.sections.map((s, i) => `<option value="${i}">${esc(s.title)}</option>`).join("")}</select>
    <button class="btn btn-sm" type="button" data-start>Start</button><span class="timer timer-lg"></span></div>
    <textarea class="field" style="min-height:170px" aria-label="Your paragraph" placeholder="Write it from memory…"></textarea>
    <div class="q-meta"><span class="wc">0 words</span><span>aim for 150–200</span></div><div class="kws" style="margin-top:10px"></div><ul class="warnings"></ul>
    <div class="review-actions"><button class="btn" type="button" data-check>Check</button></div></section>`);
  const ta = $("textarea", sec), sel = $("select", sec);
  const sect = () => item.sections[+sel.value];
  $(".timer", sec).textContent = `${sect().minutes}:00`;
  sel.addEventListener("change", () => { $(".timer", sec).textContent = `${sect().minutes}:00`; $(".kws", sec).innerHTML = ""; $(".warnings", sec).innerHTML = ""; });
  ta.addEventListener("input", () => { const n = (ta.value.match(/\S+/g) || []).length; $(".wc", sec).textContent = `${n} word${n === 1 ? "" : "s"}`; });
  $("[data-start]", sec).addEventListener("click", () => { countdown($(".timer", sec), sect().minutes, String(Date.now())); ta.focus(); });
  $("[data-check]", sec).addEventListener("click", () => {
    const v = ta.value;
    $(".kws", sec).innerHTML = sect().keywords.map((k) => `<span class="kw${kwHit(v, k) ? " is-hit" : " is-miss"}">${esc(k.label)}</span>`).join("");
    const warn = (checks || []).filter((c) => { try { return new RegExp(c.pattern, "i").test(v) && !(c.unless && new RegExp(c.unless, "i").test(v)); } catch { return false; } });
    $(".warnings", sec).innerHTML = warn.map((c) => `<li>${mdi(c.message)}</li>`).join("") || (v.trim() ? "<li class=\"ok\">No warnings from the writing checks.</li>" : "");
  });
  return sec;
}

// =====================================================================================================
// Profile
// =====================================================================================================

async function showProfile() {
  listen(null, () => {});
  document.title = "Profile · Teach";
  const { text } = await api("/api/profile");
  const view = () => {
    const doc = frag(`<div class="doc"><div class="doc-head"><h1>Learner profile</h1><span class="meta">learning/PROFILE.md · every tutor reads it first</span><span class="acts"><button class="btn btn-sm" type="button">Edit</button></span></div><div class="prose"></div></div>`);
    $(".prose", doc).innerHTML = md(text.replace(/^# .*\n/, ""));
    $("button", doc).addEventListener("click", edit);
    app.replaceChildren(doc);
  };
  const edit = () => {
    const doc = frag(`<div class="doc doc-edit"><div class="doc-head"><h1>Learner profile</h1><span class="meta">editing · markdown</span></div><textarea class="field field-mono" aria-label="Profile markdown"></textarea>
      <div class="acts"><button class="btn btn-primary" type="button" data-save>Save</button><button class="btn btn-quiet" type="button" data-cancel>Cancel</button><span class="hint">The tutor reads this before every session. Your edits win over its own notes.</span></div></div>`);
    const ta = $("textarea", doc);
    ta.value = text;
    $("[data-cancel]", doc).addEventListener("click", view);
    $("[data-save]", doc).addEventListener("click", async () => { await api("/api/profile", { text: ta.value }, "PUT"); showProfile(); });
    app.replaceChildren(doc);
    ta.focus();
  };
  view();
}

route();
refreshHome();
