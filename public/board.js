"use strict";
// The lesson as a board (lib/board.mjs has its rules). The server owns the board and sends it whole on every change;
// this paints it and keeps the DOM of every block that didn't change (a scene's canvas, an answer half typed, an
// interactive figure). On top: the step bar. Under it: the shelf (blocks folded to a chip) and the blocks in view,
// arranged the way the server's arrangement says (rows of cells side by side; a cell stacks its blocks): the tutor's
// layout, or the app's. Docked over the composer: the tutor's latest reply, which each turn replaces, so it's in view
// wherever the board is scrolled. Focus mode hides everything but the board, the step bar and a slim composer.
// Loaded before app.js and uses its helpers ($, el, frag, api, md, T…) at call time.

const B = { view: null, rev: -1, inst: null, els: new Map(), cards: new Map(), stages: new Map(), slug: null, streaming: null,
  activity: null, error: null, said: null, saidUntil: 0, plan: null, tick: null, sendQ: [], sending: false, painted: false };

// ---------- mounting ----------

function boardMount(shell, main) {
  (shell.matches(".lesson") ? shell : $(".lesson", shell))?.classList.add("ws");
  main.prepend(frag(`<div class="ws-top"><section class="ws-step" aria-live="polite"></section><div class="board" aria-label="The board" data-empty="true">` +
    `<nav class="shelf" aria-label="Folded blocks" hidden></nav><div class="board-hold" hidden></div></div></div>`));
  $(".ws-step", main).addEventListener("click", (e) => {
    if (e.target.closest(".focus-toggle")) return focusMode(!document.body.classList.contains("focus-mode"));
    const d = e.target.closest(".ws-step-do");
    if (d) d.classList.toggle("is-open");
  });
  $(".shelf", main).addEventListener("click", (e) => { const c = e.target.closest("[data-show]"); if (c) boardOp("show", c.dataset.show); });
  focusMode(focusSaved(), false);
  $(".dock-inner", main).prepend(frag(html`
    <section class="reply" hidden aria-live="polite" aria-label="The tutor's reply">
      <p class="reply-you"></p>
      <div class="reply-body prose"></div>
      <div class="reply-foot"><span class="reply-status"></span>
        <button class="btn btn-sm btn-quiet reply-more" type="button" aria-expanded="false">Show all</button>
        <button class="btn btn-sm btn-quiet reply-keep" type="button" title="Pin this reply to the board as a note">${icon("check", "icon icon-sm")}Keep on the board</button></div>
    </section>`));
  $(".reply-more", main).addEventListener("click", (e) => {
    const box = $(".reply"), open = !box.classList.contains("is-open");
    box.classList.toggle("is-open", open);
    e.currentTarget.textContent = open ? "Show less" : "Show all";
    e.currentTarget.setAttribute("aria-expanded", String(open));
    clampReply();
  });
  $(".reply-keep", main).addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try { await api(`/api/topics/${T.slug}/board`, { op: "keep" }); toast("Kept on the board", "green"); }
    catch (err) { toast(err.message, "red"); }
  });
  $(".lesson-head .acts", shell)?.prepend(frag(`<div class="ws-status"><span class="link-pill" hidden></span><span class="tutor" data-state="waiting"><i></i><span class="word">your move</span></span></div>`));
  if (B.slug !== T.slug) B.cards = new Map();   // answers half given stay while the page is on this topic
  Object.assign(B, { view: null, rev: -1, inst: null, els: new Map(), stages: new Map(), slug: T.slug, streaming: null, activity: null, error: null,
    said: null, saidUntil: 0, painted: false, plan: (T.data.topic.plan || []).map((n) => n.status) });
  // the dock covers the bottom of the window: blocks scrolled into view stop above it
  const dock = $(".dock", main);
  new ResizeObserver(() => document.documentElement.style.setProperty("--dock-h", `${dock.offsetHeight}px`)).observe(dock);
  if (!B.measuring) { B.measuring = true; addEventListener("resize", measureBoard); }
  clearInterval(B.tick);
  B.tick = setInterval(() => { if (page === "topic" && T.tab === "lesson") wsPaint(); else clearInterval(B.tick); }, 1000);
}

// ---------- the board ----------

function boardRender(v) {
  const grid = $(".board");
  if (!v || !grid) return;
  if (B.view && v.inst === B.inst && v.rev < B.rev) return;          // an older copy arriving late
  const first = !B.painted, turn = B.view?.reply?.turn, restarted = B.painted && v.inst !== B.inst;
  B.view = v; B.rev = v.rev; B.inst = v.inst; B.painted = true;
  if (restarted) for (const st of B.stages.values()) stageOpen(st);
  if (v.reply.turn !== turn) {   // a new turn: the last one's words are done, and its reply starts folded
    B.error = null; B.streaming = null;
    const box = $(".reply");
    if (box?.classList.contains("is-open")) { box.classList.remove("is-open"); $(".reply-more", box).textContent = "Show all"; }
  }
  const live = new Set(v.blocks.map((x) => x.id));
  for (const [id, e] of B.els) if (!live.has(id)) { leave(e); B.els.delete(id); }
  const fresh = [];
  for (const x of v.blocks) {
    let e = B.els.get(x.id);
    if (!e) { e = makeBlock(x); B.els.set(x.id, e); fresh.push(e); } else if (e.rev !== x.rev) updateBlock(e, x);
  }
  arrangeBoard(grid, v.arrangement || { template: "compare", rows: [{ cells: v.blocks.map((x) => ({ ids: [x.id], w: 1 })) }], shelf: [] });
  paintReply();
  paintStep();
  paintDock();
  const shown = fresh.filter((e) => !e.el.closest(".board-hold"));
  if (!first && shown.length) reveal(shown);
}
const nextLive = (n) => { let s = n.nextElementSibling; while (s && s.classList.contains("is-leaving")) s = s.nextElementSibling; return s; };
const firstLive = (p) => { const f = p.firstElementChild; return f && f.classList.contains("is-leaving") ? nextLive(f) : f; };
// Move a node without reloading it where the browser can (an iframe or a scene keeps its state); else a plain insert.
function place(parent, node, ref) {
  if (parent.moveBefore && node.isConnected && parent.isConnected) { try { parent.moveBefore(node, ref); return; } catch { /* fall through */ } }
  parent.insertBefore(node, ref);
}

// Lay the blocks out as the arrangement says: the shelf's chips, then rows of cells (reused, so only what moved
// moves), and every folded block parked out of sight with its state intact.
function arrangeBoard(grid, a) {
  const shelf = $(".shelf", grid), hold = $(".board-hold", grid);
  const byId = new Map(B.view.blocks.map((x) => [x.id, x]));
  let rowEls = $$(":scope > .brow", grid);
  a.rows.forEach((r, i) => {
    let row = rowEls[i];
    if (!row) { row = el("div", "brow"); grid.insertBefore(row, hold); }
    row.dataset.t = a.template;
    const cellEls = $$(":scope > .bcell", row);
    r.cells.forEach((c, j) => {
      let cell = cellEls[j];
      if (!cell) { cell = el("div", "bcell"); row.append(cell); }
      const kinds = c.ids.map((id) => byId.get(id));
      cell.style.setProperty("--w", c.w || 1);
      cell.dataset.role = a.rows.length === 1 && r.cells.length > 1 && ["focus-aside"].includes(a.template) ? (j ? "aside" : "focus") : "";
      // a scene or a picture is as wide as it is (no empty card around it); text and pages take the width they're given
      cell.dataset.fit = kinds.length === 1 && (kinds[0]?.kind === "scene" || (kinds[0]?.kind === "figure" && kinds[0].show?.kind !== "html")) ? "content" : "";
      cell.dataset.text = kinds.every((x) => x && (x.kind === "note" || x.kind === "ask")) ? "true" : "";
      // given the room, a scene or picture may grow into it (a scene's frames are drawn at 2x, so it stays sharp)
      cell.toggleAttribute("data-zoom", cell.dataset.fit === "content" && (a.template === "focus" || cell.dataset.role === "focus"));
      let ref = firstLive(cell);
      for (const id of c.ids) {
        const node = B.els.get(id)?.el;
        if (!node) continue;
        if (node === ref) ref = nextLive(ref); else place(cell, node, ref);
      }
    });
    for (const extra of cellEls.slice(r.cells.length)) { for (const n of [...extra.children]) if (!n.classList.contains("is-leaving")) place(hold, n, null); extra.remove(); }
  });
  for (const extra of rowEls.slice(a.rows.length)) {
    for (const n of $$(".blk", extra)) if (!n.classList.contains("is-leaving")) place(hold, n, null);
    extra.remove();
  }
  for (const id of a.shelf) { const n = B.els.get(id)?.el; if (n && n.parentNode !== hold) place(hold, n, null); }
  // the shelf: one chip per folded block, oldest first
  const chips = a.shelf.map((id) => byId.get(id)).filter(Boolean);
  const key = chips.map((x) => `${x.id}:${x.rev}`).join("|");
  if (shelf.dataset.key !== key) {
    shelf.dataset.key = key;
    shelf.hidden = !chips.length;
    shelf.innerHTML = chips.length ? `<span class="shelf-label">Folded</span>` + chips.map((x) => {
      const state = x.kind === "ask" ? (x.status === "answered" ? "answered" : x.status === "pending" ? "waiting" : "skipped") : "";
      return `<button type="button" class="shelf-chip" data-show="${esc(x.id)}" title="Open it on the board"><span class="kind">${esc(SHELF_KIND[x.kind] || x.kind)}</span>` +
        `<span class="title">${esc(blockTitle(x))}</span>${state ? `<span class="state">${state}</span>` : ""}</button>`;
    }).join("") : "";
  }
  grid.dataset.empty = String(!B.view.blocks.length);
  grid.dataset.layout = a.template;
  measureBoard();
}
// Where the board's first row starts on the page: a scene or picture sized to the window stops above the dock.
function measureBoard() {
  requestAnimationFrame(() => {
    const row = $(".board > .brow");
    if (row) document.documentElement.style.setProperty("--board-top", `${Math.round(row.getBoundingClientRect().top + scrollY)}px`);
  });
}
const SHELF_KIND = { note: "Note", ask: "Questions", scene: "Scene", figure: "Figure" };
const ASK_NAME = { probe: "Probe", check: "Check", review: "Review", setup: "Setup", approve: "Your call", practice: "Practice" };
function blockTitle(x) {
  if (x.kind === "note") return x.title || (String(x.body || "").match(/^\s*#*\s*(.{1,80})/) || [])[1]?.replace(/[*_`$]/g, "") || "Note";
  if (x.kind === "ask") return x.ask?.title || ASK_NAME[x.ask?.purpose] || "Questions";
  if (x.kind === "scene") return x.scene?.title || "Scene";
  return x.show?.title || String(x.show?.path || "").split("/").pop() || "Figure";
}

// ---------- focus mode: the board and nothing else ----------

const FOCUS_KEY = "teach-focus";
const focusSaved = () => { try { return localStorage.getItem(FOCUS_KEY) === "1"; } catch { return false; } };
function focusMode(on, remember = true) {
  document.body.classList.toggle("focus-mode", on);
  if (remember) { try { if (on) localStorage.setItem(FOCUS_KEY, "1"); else localStorage.removeItem(FOCUS_KEY); } catch { /* no storage: this page only */ } }
  for (const b of $$(".focus-toggle")) paintFocusToggle(b);
  if (remember) toast(on ? "Focus: just the board · Esc or F to leave" : "Focus off", "blue");
  clampReply();
  measureBoard();
}
function paintFocusToggle(b) {
  const on = document.body.classList.contains("focus-mode");
  b.setAttribute("aria-pressed", String(on));
  b.title = on ? "Leave focus mode (Esc or F)" : "Focus mode: hide everything but the board (F)";
  b.innerHTML = `${icon(on ? "unfocus" : "focus", "icon icon-sm")}<span>${on ? "Exit" : "Focus"}</span><kbd>${on ? "Esc" : "F"}</kbd>`;
}

function leave(e) {
  e.el.classList.add("is-leaving");
  setTimeout(() => e.el.remove(), 220);
  if (e.x.kind === "scene") B.stages.delete(e.id);
  if (e.x.kind === "note") B.stages.delete(`vis:${T.slug}:${e.id}`);
  if (e.x.kind === "ask" && e.x.status !== "pending") B.cards.delete(e.id);
}

// A new block: it fades in with a brief outline, and the most urgent one (a question waiting for them) scrolls into
// view, unless they're typing an answer somewhere on the board.
function reveal(fresh) {
  for (const e of fresh) { e.el.classList.add("is-new"); setTimeout(() => e.el.classList.remove("is-new"), 1800); }
  const a = document.activeElement;
  if (a?.closest?.(".board") && a.matches("input, textarea, select")) return;
  const target = fresh.find((e) => e.x.kind === "ask" && e.x.status === "pending") || fresh[0];
  requestAnimationFrame(() => {
    const r = target.el.getBoundingClientRect();
    const room = innerHeight - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dock-h")) || 0);
    target.el.scrollIntoView({ block: r.height > room * 0.8 ? "start" : "nearest", behavior: "smooth" });
  });
}

const KIND = { note: "Note", scene: "Scene", figure: "Figure" };

function makeBlock(x) {
  const node = frag(`<article class="blk" data-kind="${x.kind}"><header class="blk-head"><span class="blk-label"></span><span class="blk-acts"></span></header><div class="blk-body"></div></article>`);
  node.dataset.id = x.id;
  const e = { id: x.id, el: node, rev: null, x: null };   // (updateBlock paints everything the first time)
  if (x.kind === "scene") stageMount(e, x);
  if (x.kind === "ask") {
    const card = B.cards.get(x.id) || { answers: x.ask.questions.map(() => ({})), focus: 0 };
    Object.assign(card, { el: node, body: $(".blk-body", node), painted: () => blockActs(e, $(".qcard-head", node)) });
    B.cards.set(x.id, card);
  }
  updateBlock(e, x);
  return e;
}

function updateBlock(e, x) {
  const was = e.x;
  e.x = x; e.rev = x.rev;
  const node = e.el, body = $(".blk-body", node);
  node.dataset.size = x.size || "half";
  node.toggleAttribute("data-pin", !!x.pin);
  if (x.kind === "note") {
    $(".blk-label", node).innerHTML = `<span class="kind">${x.kept ? "Kept" : "Note"}</span>${x.title ? `<span class="title">${mdi(x.title)}</span>` : ""}`;
    if (!body.firstChild) body.innerHTML = `<div class="prose"></div><div class="note-visual" hidden></div><div class="note-foot"></div>`;
    if (was?.body !== x.body || !was) $(".prose", body).innerHTML = md(x.body);
    paintNoteVisual(e, x);
  } else if (x.kind === "figure") {
    const s = x.show || {};
    $(".blk-label", node).innerHTML = `<span class="kind">Figure</span>${s.title ? `<span class="title">${mdi(s.title)}</span>` : ""}`;
    if (!body.firstChild) body.append(figureEl(s));
  } else if (x.kind === "scene") {
    $(".blk-label", node).innerHTML = `<span class="kind">Scene</span>`;
    const st = B.stages.get(x.id);
    if (st) { st.it = x; paintPredict(st); }
  } else if (x.kind === "ask") {
    const card = B.cards.get(x.id);
    const it = { id: x.id, ask: x.ask, status: x.status, answers: x.answers, results: x.results, via: x.via, onScreen: x.onScreen, legacy: x.legacy, moved: x.moved };
    if (x.onScreen && !was?.onScreen && x.status === "pending" && was) toast("Question on your screen · answer it there or here", "teal");
    const changed = !was || ["status", "onScreen", "via", "ask"].some((k) => JSON.stringify(was[k]) !== JSON.stringify(x[k]));
    card.it = it;
    if (changed) paintAsk(card);   // (paintAsk calls card.painted, which puts the block's buttons in the card's head)
    else blockActs(e, $(".qcard-head", node));
    return;
  }
  blockActs(e, $(".blk-head", node));
}

// Pin and close, in the block's head (a question card's own head, for a question set). A question set still waiting
// has neither: answer it, or Skip it.
function blockActs(e, head) {
  if (!head) return;
  const acts = $(":scope > .blk-acts", head) || head.appendChild(el("span", "blk-acts"));
  const x = e.x;
  acts.innerHTML = x.kind === "ask" && x.status === "pending" ? ""
    : `<button class="btn btn-quiet btn-icon blk-fold" type="button" title="Fold it onto the shelf (one click brings it back)" aria-label="Fold">${icon("fold", "icon icon-sm")}</button>` +
      `<button class="btn btn-quiet btn-icon blk-pin" type="button" aria-pressed="${!!x.pin}" title="${x.pin ? "Pinned: it stays when the next step starts. Click to unpin." : "Pin it: it stays when the next step starts"}">${icon("pin", "icon icon-sm")}</button>` +
      `<button class="btn btn-quiet btn-icon blk-close" type="button" title="Take it off the board" aria-label="Close">${icon("x", "icon icon-sm")}</button>`;
  $(".blk-pin", acts)?.addEventListener("click", () => boardOp(x.pin ? "unpin" : "pin", x.id));
  $(".blk-close", acts)?.addEventListener("click", () => boardOp("dismiss", x.id));
  $(".blk-fold", acts)?.addEventListener("click", () => boardOp("shelve", x.id));
}

async function boardOp(op, target) {
  try { await api(`/api/topics/${T.slug}/board`, { op, target }); } catch (err) { toast(err.message, "red"); }
}

function figureEl(s) {
  const p = s.path || "";
  if (s.kind === "html" || /\.html?$/i.test(p) || (!p && s.html)) {
    const f = frag(`<div class="figure-html"><iframe title="${esc(s.title || "interactive figure")}" sandbox="allow-scripts allow-forms" style="height:${Number(s.height) || 420}px"></iframe>
      ${p ? `<a class="btn btn-sm btn-quiet figure-open" href="${fileURL(p)}&fig=1&theme=${document.documentElement.dataset.theme === "light" ? "light" : "dark"}" target="_blank" rel="noreferrer">${icon("open", "icon icon-sm")}Open</a>` : ""}${s.caption ? `<p class="aside">${mdi(s.caption)}</p>` : ""}</div>`);
    const frame = $("iframe", f);
    frame.classList.add("themed");   // the theme switch reaches it (figure.js listens)
    if (p) frame.src = `${fileURL(p)}&fig=1&theme=${document.documentElement.dataset.theme === "light" ? "light" : "dark"}`;
    else frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:">${s.html}`;
    return f;
  }
  if (/\.svg$/i.test(p)) return frag(`<figure class="tf-figure" data-svg="${esc(fileURL(p))}">${s.caption || s.title ? `<figcaption>${mdi(s.caption || s.title)}</figcaption>` : ""}</figure>`);
  return frag(`<figure class="prose"><img src="${fileURL(p)}" alt="${esc(s.title || "figure")}">${s.caption || s.title ? `<figcaption>${mdi(s.caption || s.title)}</figcaption>` : ""}</figure>`);
}

// ---------- a note's own visual: "Visualize it" ----------

// The button at the bottom right of every note card (the generate button, public/genbtn.js): grey until a visual is
// made; a click draws one into the card (cancel while it's drawing); then it hides and shows it, and "Another view"
// draws a different one. The visual is a live scene (chalk's engine, like a scene block) or a themed SVG figure.
const VIS_HINT = { idle: "draw it", failed: "didn't work · try again" };
function paintNoteVisual(e, x) {
  const body = $(".blk-body", e.el), box = $(".note-visual", body), foot = $(".note-foot", body);
  if (!box || !foot) return;
  const v = x.visual || null, job = x.vjob || null, sid = v?.stage || `vis:${T.slug}:${x.id}`;
  const hasFigure = /!\[[^\]]*\]\([^)]+\)|```svg/.test(x.body || "");
  const send = (op) => api(`/api/topics/${T.slug}/visualize`, { op, note: x.id }).catch((err) => toast(err.message, "red"));
  if (!e.vis) {
    foot.innerHTML = `<span class="vis-err" hidden></span><button class="btn btn-sm btn-quiet vis-redo" type="button" hidden>${icon("visual", "icon icon-sm")}Another view</button><button type="button"></button>`;
    e.vis = { g: genButton($("button:last-child", foot), { glyph: "i-visual", size: "sm", title: "Visualize it", hints: VIS_HINT,
      onGenerate: () => send("start"), onRetry: () => send("start"), onPause: () => send("cancel"),
      onOpen: () => send(e.x.visual?.hidden ? "show" : "hide") }), key: "" };
    $(".vis-redo", foot).addEventListener("click", () => send("start"));
  }
  const g = e.vis.g, err = $(".vis-err", foot), redo = $(".vis-redo", foot);
  if (job?.state === "working") g.set("working", { title: v ? "Another view" : "Visualizing", hint: `${(job.sub || "drawing").toLowerCase()} · click to cancel` });
  else if (job?.state === "failed") g.set("failed", { title: "Visualize it", hint: null });
  else if (v) g.set("ready", { title: v.hidden ? "Show visual" : "Visual", hint: v.hidden ? "show" : "hide" });
  else g.set("idle", { title: hasFigure ? "Another view" : "Visualize it", hint: null });
  err.hidden = job?.state !== "failed" && !(v?.stale && !job);
  err.classList.toggle("is-stale", !job && !!v?.stale);
  err.textContent = job?.state === "failed" ? job.error || "" : v?.stale && !job ? "Drawn for an earlier version of this note" : "";
  err.title = err.textContent;
  redo.hidden = !v || !!job;
  // the picture itself: while one is drawing (and none is up yet), a placeholder that drifts like the button
  const key = job?.state === "working" && !v ? "wait" : v && !v.hidden ? `${v.kind}:${v.at}:${v.path || ""}` : "";
  if (key === e.vis.key) return;
  e.vis.key = key;
  B.stages.delete(sid);
  box.hidden = !key;
  box.innerHTML = "";
  if (!key) return;
  if (key === "wait") { box.innerHTML = `<div class="vis-wait"><span>Drawing a visual for this note…</span></div>`; return; }
  if (v.kind === "svg") { box.append(frag(`<figure class="tf-figure" data-svg="${esc(`${fileURL(v.path)}&v=${encodeURIComponent(v.at)}`)}"></figure>`)); return; }
  box.append(frag(html`
    <section class="stage" aria-label="${esc(v.title || "Visual")}">
      <div class="stage-canvas" tabindex="0"><img alt="${esc(v.title || "visual")}" draggable="false" hidden><p class="stage-wait">Setting up the scene…</p></div>
      <aside class="predict" hidden></aside>
    </section>`));
  const st = { id: sid, it: { id: sid, scene: { title: v.title, predict: [] }, predictions: {} }, el: $(".stage", box), seq: 0, w: 0, h: 0, step: 0, gate: null, sent: new Map(), lat: [], inSeq: 0 };
  B.stages.set(sid, st);
  wireStage(st);
  stageOpen(st);
}

// The question card the keys work on: the first one still waiting, in board order.
function boardPendingCard() {
  const x = B.view?.blocks.find((b) => b.kind === "ask" && b.status === "pending");
  return x ? B.cards.get(x.id) : null;
}

// ---------- the reply: the tutor's latest turn, docked over the composer ----------

function paintReply() {
  const box = $(".reply");
  if (!box) return;
  const r = B.view?.reply || { parts: [] };
  const parts = r.parts.slice();
  if (B.streaming && !parts.some((p) => p.id === B.streaming.id)) parts.push({ ...B.streaming, live: true });
  const busy = !!T.status?.busy;
  const said = parts.filter((p) => p.text.trim());
  const you = r.user ? (r.user.text || "") + (r.user.images ? ` (${r.user.images} picture${r.user.images === 1 ? "" : "s"})` : "") : "";
  box.hidden = !said.length && !you.trim() && !busy && !B.error;
  if (box.hidden) return;
  const youEl = $(".reply-you", box);
  youEl.hidden = !you.trim();
  youEl.innerHTML = you.trim() ? `<span class="who">You</span>${esc(you.length > 280 ? you.slice(0, 280) + "…" : you)}` : "";
  const live = parts.some((p) => p.live);
  $(".reply-body", box).innerHTML = said.length
    ? said.map((p) => `<div class="${p.said ? "said" : ""}">${md(p.text)}</div>`).join("") + (live ? '<span class="caret" aria-hidden="true"></span>' : "")
    : busy ? `<p class="muted">${live ? '<span class="caret" aria-hidden="true"></span>' : "Thinking…"}</p>` : "";
  $(".reply-status", box).innerHTML = B.error ? `<span class="bad">${esc(B.error)}</span>`
    : busy && B.activity ? `<span class="spinner" aria-hidden="true"></span>${esc(B.activity.label)}` : "";
  const keep = $(".reply-keep", box);
  keep.hidden = !said.length || busy;
  keep.disabled = false;
  clampReply();
}

function clampReply() {
  const box = $(".reply"), body = box && $(".reply-body", box);
  if (!body || box.hidden) return;
  box.classList.remove("is-clamped");
  if (!box.classList.contains("is-open") && body.scrollHeight > body.clientHeight + 4) box.classList.add("is-clamped");
}

function boardText(ev) {
  if (ev.said) wsSaid(ev);
  if (ev.streaming && !ev.final) B.streaming = { id: ev.id, text: ev.text || "", said: !!ev.said };
  else if (B.streaming?.id === ev.id || !B.view?.reply.parts.some((p) => p.id === ev.id)) B.streaming = { id: ev.id, text: ev.text || "", said: !!ev.said };
  paintReply();
}
function boardDelta(ev) {
  if (!B.streaming || B.streaming.id !== ev.id) B.streaming = { id: ev.id, text: "" };
  B.streaming.text += ev.text;
  if (!B.queued) { B.queued = true; setTimeout(() => { B.queued = false; paintReply(); }, 60); }
}
function boardActivity(ev) {
  if (ev.state === "running") B.activity = { id: ev.id, label: ev.label };
  else if (B.activity?.id === ev.id) B.activity = null;
  paintReply();
}
function boardIdle(ev) {
  B.streaming = null; B.activity = null;
  if (ev.error) B.error = ev.error;
  paintReply();
}
function boardError(text) { B.error = text; paintReply(); }

// What they just sent shows at once; the server's copy of the board follows.
function boardEcho(text, images) {
  if (!B.view) return;
  B.view = { ...B.view, reply: { ...B.view.reply, user: { text, images }, parts: [] } };
  B.streaming = null; B.error = null;
  paintReply();
}

// ---------- the tutor's state and the step card ----------

function tutorState() {
  const st = T.status || {};
  if (Date.now() < B.saidUntil) return ["speaking", "speaking"];
  if (st.watching != null) return ["watching", "watching your screen"];
  if (st.busy) return ["thinking", "thinking"];
  if ([...B.stages.values()].some((s) => s.gate != null)) return ["waiting", "your prediction"];
  return ["waiting", "your move"];
}

function wsPaint() {
  const [state, word] = tutorState();
  for (const t of $$(".tutor")) {
    if (t.dataset.state !== state) t.dataset.state = state;
    const w = $(".word", t);
    if (w && w.textContent !== word) w.textContent = word;
  }
  paintStep();
}

function paintStep() {
  const box = $(".ws-step");
  if (!box) return;
  const t = T.data.topic, plan = t.plan || [];
  const i = plan.findIndex((n) => n.status === "current"), cur = plan[i] || plan.find((n) => n.status === "todo");
  const n = cur ? plan.indexOf(cur) + 1 : 0;
  const st = T.status || {};
  const pending = B.view?.blocks.find((x) => x.kind === "ask" && x.status === "pending");
  const doing = st.watching ? `Your turn on screen: ${mdi(st.watching)}`
    : [...B.stages.values()].some((s) => s.gate != null) ? "Make your prediction on the scene, then it plays."
    : pending ? `Answer the question card${pending.onScreen ? " (it's on your screen too)" : ""}.`
    : B.said ? esc(B.said)
    : cur?.detail ? mdi(cur.detail) : "";
  const [state, word] = tutorState();
  const key = [n, cur?.title, doing, state, plan.map((x) => x.status).join("")].join("|");
  if (box.dataset.key === key) return;
  const fresh = box.dataset.n !== String(n);
  box.dataset.key = key; box.dataset.n = String(n);
  const inner = html`
    <div class="ws-step-head"><span>${plan.length ? `Step ${n || plan.filter((x) => x.status === "done").length} of ${plan.length}` : esc(t.phase || "starting")}</span>${plan.length ? meter(plan.map((x) => x.status)) : ""}</div>
    <h2 class="ws-step-title">${cur ? mdi(cur.title) : esc(t.title)}</h2>
    ${doing ? `<p class="ws-step-do" title="${esc(doing.replace(/<[^>]+>/g, ""))}">${doing}</p>` : ""}
    <div class="ws-step-wait"><span class="tutor" data-state="${state}"><i></i><span class="word">${word}</span></span></div>
    <button class="btn btn-sm btn-quiet focus-toggle" type="button"></button>`;
  // a new step crossfades in place; small changes (what it's waiting for) just repaint
  if (fresh && box.firstElementChild) {
    box.classList.add("is-fading");
    setTimeout(() => { box.innerHTML = inner; paintFocusToggle($(".focus-toggle", box)); box.classList.remove("is-fading"); }, 220);
  } else { box.innerHTML = inner; paintFocusToggle($(".focus-toggle", box)); }
}

// A spoken line: it leads the step card while it plays (Kokoro runs ~2.7 words a second, ~1 s to the first sound).
function wsSaid(ev) {
  if (!ev.text) return;
  B.said = String(ev.text);
  B.saidUntil = Date.now() + (1 + B.said.split(/\s+/).length / 2.7) * 1000;
  wsPaint();
}

// The plan changed: a tiny toast names what happened to a step.
function wsPlanChanged() {
  const plan = T.data.topic.plan || [], now = plan.map((n) => n.status), before = B.plan || [];
  B.plan = now;
  const done = now.filter((s) => s === "done").length;
  plan.forEach((n, i) => {
    if (before.length !== now.length || before[i] === now[i]) return;
    if (now[i] === "done") toast(`Step ${i + 1} done · ${done} of ${plan.length}`, "green");
    else if (now[i] === "shaky") toast(`Step ${i + 1} marked shaky · we'll come back`, "gold");
  });
  wsPaint();
}

// ---------- scenes: chalk's scene engine, live in a block ----------

function stageMount(e, x) {
  const s = frag(html`
    <section class="stage" aria-label="${esc(x.scene?.title || "Scene")}">
      <div class="stage-canvas" tabindex="0"><img alt="${esc(x.scene?.title || "scene")}" draggable="false" hidden><p class="stage-wait">Setting up the scene…</p></div>
      <aside class="predict" hidden></aside>
    </section>`);
  $(".blk-body", e.el).append(s);
  const st = { id: x.id, it: x, el: s, seq: 0, w: 0, h: 0, step: 0, gate: null, sent: new Map(), lat: [], inSeq: 0 };
  B.stages.set(x.id, st);
  wireStage(st);
  stageOpen(st);
}

// The server opens a scene the moment the tutor makes it; this (re)opens it after a reload or a server restart.
function stageOpen(st) {
  api(`/api/topics/${T.slug}/stage`, { op: "open", id: st.id }).catch((err) => { const w = $(".stage-wait", st.el); if (w) w.textContent = err.message; });
}

function wireStage(st) {
  const canvas = $(".stage-canvas", st.el), img = $("img", canvas);
  const at = (e) => {
    const r = img.getBoundingClientRect();
    return { x: Math.round((e.clientX - r.left) * (st.w / r.width) * 10) / 10, y: Math.round((e.clientY - r.top) * (st.h / r.height) * 10) / 10 };
  };
  canvas.addEventListener("pointerdown", (e) => { if (e.button) return; canvas.setPointerCapture(e.pointerId); canvas.focus({ focusVisible: false }); stageSend(st, { op: "pointer", t: "down", ...at(e) }); });
  canvas.addEventListener("pointermove", (e) => stageSend(st, { op: "pointer", t: "move", ...at(e) }));
  canvas.addEventListener("pointerup", (e) => stageSend(st, { op: "pointer", t: "up", ...at(e) }));
  canvas.addEventListener("pointerleave", () => stageSend(st, { op: "pointer", t: "leave", x: 0, y: 0 }));
  canvas.addEventListener("keydown", (e) => {
    const key = { ArrowRight: "Right", ArrowLeft: "Left", Enter: "Return", " ": "space" }[e.key];
    if (!key) return;
    e.preventDefault();
    stageSend(st, { op: "key", name: key, char: e.key.length === 1 ? e.key : "" });
  });
}

// Their input, in order, one request at a time; moves that pile up while one is in flight merge into the newest.
function stageSend(st, m) {
  if (!st || !B.stages.has(st.id)) return;
  const last = B.sendQ.at(-1);
  if (m.op === "pointer" && m.t === "move" && last?.op === "pointer" && last.t === "move" && last.id === st.id) B.sendQ.pop();
  m.id = st.id; m.seq = ++st.inSeq;
  st.sent.set(m.seq, performance.now());
  B.sendQ.push(m);
  if (!B.sending) stagePump();
}
async function stagePump() {
  B.sending = true;
  while (B.sendQ.length) {
    const m = B.sendQ.shift();
    try { await api(`/api/topics/${T.slug}/stage`, m); } catch { /* the scene went away */ }
  }
  B.sending = false;
}

function wsStageEvent(ev) {
  const st = B.stages.get(ev.id);
  if (!st) return;
  if (ev.kind === "frame") {
    if (ev.seq <= st.seq) return;
    st.seq = ev.seq; st.w = ev.w; st.h = ev.h;
    const img = $("img", st.el);
    img.src = `data:image/png;base64,${ev.png}`;
    img.style.setProperty("--w", `${ev.w}px`);   // its own size, or up to 1.6x that given the room and a 2x frame (board.css)
    img.style.setProperty("--zmax", String(Math.min(1.6, Number(ev.scale) || 1)));
    img.hidden = false;
    $(".stage-wait", st.el)?.remove();
    // input → frame on screen: from the newest input this frame includes (moves merged in the queue never get their own)
    let newest = null;
    for (const [seq, t0] of st.sent) if (seq <= ev.ack) { newest = t0; st.sent.delete(seq); }
    if (newest !== null) img.decode().then(() => st.lat.push(performance.now() - newest), () => {});
    if (st.lat.length > 200) st.lat.splice(0, 100);
  } else if (ev.kind === "state") {
    st.step = ev.step;
    if (st.gate != null && ev.step >= st.gate) st.gate = null;
    paintPredict(st);
  } else if (ev.kind === "gate") {
    st.gate = ev.step;
    paintPredict(st, true);
    wsPaint();
  } else if (ev.kind === "error") {
    const p = $(".stage-wait", st.el) || $(".stage-canvas", st.el).appendChild(el("p", "stage-wait"));
    p.textContent = `The scene hit a problem: ${ev.error}`;
  }
}

// ---------- predict, then reveal ----------

// The next prediction they owe: the gate on the step after the one showing, not yet committed.
function nextPrediction(st) {
  const preds = st.it.scene?.predict || [], made = st.it.predictions || {};
  return preds.find((p) => p.step > st.step && !made[p.step]) || null;
}

function paintPredict(st, nudge) {
  const box = $(".predict", st.el);
  if (!box) return;
  const made = st.it.predictions || {};
  const shown = st.result && made[st.result.step];
  const q = nextPrediction(st);
  if (!q && !shown) { box.hidden = true; return; }
  box.hidden = false;
  if (shown && (!q || st.result.until > Date.now())) {
    const r = made[st.result.step];
    box.dataset.state = r.result.ok === false ? "wrong" : "right";
    box.innerHTML = html`<div class="p-head"><span>Predict, then I reveal</span></div>
      <p class="p-verdict">${r.result.ok === true ? "Right." : r.result.ok === false ? "Not quite." : "Committed."}</p>
      <p class="p-mine">You said ${esc(r.result.text.replace(/ \((correct|wrong[^)]*)\)$/, ""))}</p>
      ${st.result.why ? `<div class="p-why prose">${md(st.result.why)}</div>` : ""}`;
    if (q) setTimeout(() => paintPredict(st), Math.max(0, st.result.until - Date.now()) + 50);
    return;
  }
  const all = st.it.scene.predict, k = all.indexOf(q) + 1;
  box.dataset.state = nudge ? "nudge" : "open";
  const pick = st.pick?.step === q.step ? st.pick.value : undefined;
  box.innerHTML = html`<div class="p-head"><span>Predict, then I reveal</span><span>${k} of ${all.length}</span></div>
    <div class="p-q prose">${md(q.prompt)}</div>
    ${q.kind === "choice"
      ? `<div class="choices">${q.options.map((o, i) => `<button type="button" class="choice" data-i="${i}" aria-checked="${pick === i}"><span class="key">${i + 1}</span><span>${mdi(o)}</span></button>`).join("")}</div>`
      : `<div class="num-field"><input class="field field-mono" inputmode="decimal" placeholder="your number" value="${pick ?? ""}">${q.unit ? `<span class="unit">${esc(q.unit)}</span>` : ""}</div>`}
    <div class="p-foot"><button class="btn btn-primary" type="button" ${pick === undefined || pick === "" ? "disabled" : ""}>Commit <kbd>Enter</kbd></button><span class="hint">${nudge ? "commit first, then it plays" : "no take-backs"}</span></div>`;
  const setPick = (v) => { st.pick = { step: q.step, value: v }; paintPredict(st); };
  $$(".choice", box).forEach((b) => b.addEventListener("click", () => setPick(Number(b.dataset.i))));
  const inp = $("input", box);
  if (inp) {
    inp.addEventListener("input", () => { st.pick = { step: q.step, value: inp.value }; $(".p-foot .btn", box).disabled = !inp.value.trim(); });
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") commitPrediction(st, q); });
  }
  $(".p-foot .btn", box).addEventListener("click", () => commitPrediction(st, q));
  box.onkeydown = (e) => {
    if (q.kind === "choice" && /^[1-9]$/.test(e.key) && q.options[+e.key - 1] !== undefined) setPick(+e.key - 1);
    if (e.key === "Enter" && st.pick?.step === q.step) commitPrediction(st, q);
  };
}

async function commitPrediction(st, q) {
  if (st.pick?.step !== q.step || st.committing) return;
  const answer = q.kind === "choice" ? { choice: st.pick.value } : { value: String(st.pick.value).trim() };
  st.committing = true;
  try { await api(`/api/topics/${T.slug}/stage`, { op: "predict", id: st.id, step: q.step, answer }); }
  catch (e) { toast(e.message, "red"); }
  st.committing = false;
}

function wsPredicted(ev) {
  const st = B.stages.get(ev.id);
  if (!st) return;
  st.it = { ...st.it, predictions: { ...(st.it.predictions || {}), [ev.step]: { answer: ev.answer, result: ev.result } } };
  st.gate = null; st.pick = null;
  st.result = { step: ev.step, why: ev.why, until: Date.now() + 9000 };
  paintPredict(st);
  wsPaint();
}
