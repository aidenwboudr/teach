"use strict";
// After a session: a grid of actions (lib/actions.mjs picks which fit and in what order). Each is a generate button
// (genbtn.js): grey until it's made, and nothing is made until it's clicked. While it's being made a click pauses it
// (the server stops the tutor's turn) and the next resumes; once made, a click opens it. The line under each button
// shows its settings, and opens them: a small form before (or instead of) generating. Loaded after genbtn.js and
// before app.js; uses app.js's helpers ($, el, frag, api, T, toast, go, md…) at call time.

const N = { view: null, buttons: new Map(), open: false, timer: null, activity: "" };
const NEXT_NAMES = { idle: "", queued: "Waiting", working: "Making", paused: "Paused", ready: "Ready", failed: "Didn't finish" };

// Is the grid in view: after a pause or a close, once the plan is through, when something's being made or was made
// in the last few hours, or when they opened it from the menu. "Hide" keeps it away until the topic's state changes.
function nextWanted() {
  const t = T.data?.topic;
  if (!t) return false;
  const plan = t.plan || [], outs = Object.values(t.outputs || {});
  const busy = outs.some((o) => ["queued", "working", "paused"].includes(o.state))
    || outs.some((o) => ["ready", "failed"].includes(o.state) && Date.now() - Date.parse(o.at || 0) < 6 * 3600e3);   // made in the last few hours
  const ended = t.status === "paused" || t.status === "done" || (plan.length > 0 && plan.every((n) => ["done", "shaky", "skipped"].includes(n.status)));
  if (busy || N.open) return true;
  if (!ended) return false;
  try { return localStorage.getItem(`teach-next-hide-${t.slug}`) !== nextKey(t); } catch { return true; }
}
const nextKey = (t) => `${t.status}:${(t.plan || []).filter((n) => n.status === "done").length}`;

function nextMount(main) {
  const box = frag(`<section class="next" aria-label="What next" hidden>
      <header class="next-head"><h2>What next?</h2><span class="next-sub"></span>
        <button class="btn btn-sm btn-quiet next-hide" type="button">Hide</button></header>
      <div class="next-grid" role="list"></div>
    </section>`);
  $(".ws-top", main).insertBefore(box, $(".board", main));
  $(".next-hide", box).addEventListener("click", () => {
    N.open = false;
    try { localStorage.setItem(`teach-next-hide-${T.slug}`, nextKey(T.data.topic)); } catch { /* private window */ }
    nextShow(false);
  });
  if (N.slug !== T.slug) { N.open = false; N.activity = ""; }
  N.buttons = new Map(); N.view = null; N.slug = T.slug;
  nextRefresh(0);
}

function nextShow(on) {
  const box = $(".next");
  if (!box || box.hidden === !on) return;
  if (on) { box.hidden = false; requestAnimationFrame(() => box.classList.add("is-in")); }
  else { box.classList.remove("is-in"); setTimeout(() => { if (!box.classList.contains("is-in")) box.hidden = true; }, 260); }
}

// (from the topic menu)
function nextOpen() {
  N.open = true;
  nextRefresh(0);
  setTimeout(() => $(".next")?.scrollIntoView({ block: "start", behavior: "smooth" }), 80);
}

function nextRefresh(delay = 200) {
  clearTimeout(N.timer);
  N.timer = setTimeout(async () => {
    if (page !== "topic" || T.tab !== "lesson" || !$(".next")) return;
    const want = nextWanted();
    if (!want) return nextShow(false);
    try { nextPaint(await api(`/api/topics/${T.slug}/actions`)); } catch { /* server restarting */ }
  }, delay);
}

function nextPaint(v) {
  const box = $(".next"), grid = $(".next-grid", box);
  const before = new Map((N.view?.tiles || []).map((x) => [x.kind, x.state]));
  N.view = v;
  const a = v.situation.allowance;
  $(".next-sub", box).textContent = v.tiles.length ? "Nothing is made until you click it." : "";
  if (!v.tiles.length) { grid.innerHTML = `<p class="muted next-empty">Nothing to make yet: once a step is taught, its sheet, worksheet and the rest show up here.</p>`; nextShow(true); return; }
  grid.querySelector(".next-empty")?.remove();
  const keep = new Set(v.tiles.map((x) => x.kind));
  for (const [kind, b] of N.buttons) if (!keep.has(kind)) { b.wrap.remove(); N.buttons.delete(kind); }
  v.tiles.forEach((x, i) => {
    let b = N.buttons.get(x.kind);
    if (!b) {
      const wrap = frag(`<div class="next-tile" role="listitem" data-kind="${x.kind}"><button class="gen" type="button"></button><button class="next-meta" type="button"></button></div>`);
      const g = genButton($(".gen", wrap), {
        title: x.title, glyph: x.glyph,
        onGenerate: () => nextStart(x.kind), onRetry: () => nextStart(x.kind),
        onPause: () => nextOp(x.kind, "pause"), onResume: () => nextOp(x.kind, "resume"),
        onOpen: () => nextOpenMade(N.view.tiles.find((y) => y.kind === x.kind)),
      });
      $(".next-meta", wrap).addEventListener("click", () => nextSettings(N.view.tiles.find((y) => y.kind === x.kind)));
      b = { wrap, g };
      N.buttons.set(x.kind, b);
    }
    if (grid.children[i] !== b.wrap) grid.insertBefore(b.wrap, grid.children[i] || null);
    b.wrap.dataset.best = String(i === 0 && x.state === "idle");
    b.g.set(x.state, { title: x.title, sub: nextSub(x), hint: nextHint(x) });
    const meta = $(".next-meta", b.wrap);
    const keyFile = x.kind === "worksheet" && x.state === "ready" ? x.files.find((f) => f.label === "Answer key") : null;
    meta.innerHTML = `${icon("gear", "icon icon-sm")}<span>${esc(x.state === "ready" && x.kind === "session" ? "Change or cancel" : x.summary)}</span>${keyFile ? `<a class="next-key" href="${fileURL(keyFile.path)}" target="_blank" rel="noreferrer">Answer key</a>` : ""}`;
    meta.title = "Settings";
    const was = before.get(x.kind);
    if (was && was !== x.state && x.state === "ready") toast(`${x.title} ready`, "green");
    if (was && was !== x.state && x.state === "failed") toast(`${x.title} didn't finish`, "red");
  });
  $$(".next-key", grid).forEach((k) => k.addEventListener("click", (e) => e.stopPropagation()));
  nextShow(true);
}

function nextSub(x) {
  if (x.state === "idle") return x.why;
  if (x.state === "queued") return x.progress || "Waiting its turn";
  if (x.state === "working") return (N.view?.running === x.kind && N.activity) || x.progress || "Working on it";
  if (x.state === "paused") return x.progress === "Teach restarted" ? "Teach restarted, so it stopped. Click to pick up where it was." : "Stopped. Click to pick up where it was.";
  if (x.state === "failed") return x.error || "It stopped before it was done.";
  if (x.kind === "session" && x.session) return `${x.summary}${x.session.calendar?.ok ? " · on your calendar" : ""}`;
  const pdf = x.files.find((f) => /\.pdf$/.test(f.path));
  return x.made || (pdf ? `${pdf.pages || "?"} page${pdf.pages === 1 ? "" : "s"}` : "Made");
}

function nextHint(x) {
  if (x.state !== "ready") return null;
  return { cards: "Review them", practice: "See how it went", session: "Details" }[x.kind] || (x.kind === "worksheet" ? "Open worksheet" : "Open PDF");
}

async function nextOp(kind, op, extra = {}) {
  try { const r = await api(`/api/topics/${T.slug}/actions`, { kind, op, ...extra }); nextPaint(r.view); return r; }
  catch (e) { toast(e.message, "red"); return null; }
}

function nextStart(kind) {
  const x = N.view.tiles.find((y) => y.kind === kind);
  if (kind === "session") return nextSettings(x, { go: true });   // a time has to be picked: the form first
  N.buttons.get(kind)?.g.set("queued", { sub: "Starting", hint: null });
  return nextOp(kind, "start");
}

// What a made thing opens: its PDF (on the laptop through the app's opener when Teach is an app window there), the
// Review tab for cards, the transcript for a practice test, the details for a session.
async function nextOpenMade(x) {
  if (!x) return;
  if (x.kind === "cards") return go(`/t/${T.slug}/review`);
  if (x.kind === "practice") return go(`/t/${T.slug}/transcript`);
  if (x.kind === "session") return nextSessionDetails(x);
  const f = x.files.find((y) => /\.pdf$/.test(y.path) && y.label !== "Answer key") || x.files[0];
  if (f) openFile(f.path);
}

async function openFile(p) {
  const url = new URL(fileURL(p), location.href).href;
  if (laptopApp) {
    const r = await api("/api/open", { url }).catch((e) => ({ why: e.message }));
    if (r.ok) return toast("Opened on your laptop");
  }
  window.open(url, "_blank", "noreferrer");
}

const allowanceLine = (a) => `${a.sheets} ${a.paper?.startsWith("index") ? "index card" : "sheet"}${a.sheets > 1 ? "s" : ""}, ${a.sides === 2 ? "front and back" : "one side"}`;

// The settings step: the form for one action, with its defaults filled in. Save keeps them on the button; Generate
// (or Schedule) saves and starts it.
function nextSettings(x, { go: goNow = false } = {}) {
  if (!x) return;
  const field = (f) => {
    const id = `nf-${f.key}`;
    if (f.type === "select") return `<label class="field-row"><span>${esc(f.label)}</span><select class="field" id="${id}" name="${f.key}">${f.options.map((o) => `<option value="${esc(o.value)}"${String(f.value) === o.value ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label>`;
    if (f.type === "number") return `<label class="field-row"><span>${esc(f.label)}</span><input class="field field-sm" type="number" name="${f.key}" min="${f.min}" max="${f.max}" value="${esc(f.value)}">${f.hint ? `<small class="faint">${esc(f.hint)}</small>` : ""}</label>`;
    if (f.type === "datetime") return `<label class="field-row"><span>${esc(f.label)}</span><input class="field" type="datetime-local" name="${f.key}" value="${esc(f.value)}"></label>`;
    if (f.type === "check") return `<label class="field-row check"><input type="checkbox" name="${f.key}"${f.value ? " checked" : ""}> <span>${esc(f.label)}</span></label>`;
    if (f.type === "multi") return `<fieldset class="field-row multi"><legend>${esc(f.label)}</legend><div class="chips">${f.options.map((o) => `<label class="chip chip-check"><input type="checkbox" name="${f.key}" value="${esc(o.value)}"${(f.value || []).includes(o.value) ? " checked" : ""}><span>${mdi(o.label)}</span></label>`).join("")}</div></fieldset>`;
    return `<label class="field-row"><span>${esc(f.label)}</span><input class="field" name="${f.key}" value="${esc(f.value)}" placeholder="${esc(f.placeholder || "")}"></label>`;
  };
  const a = N.view.situation.allowance;
  const rule = x.kind === "sheet" && a?.kind === "sheet" ? `<p class="next-rule">${icon("check", "icon icon-sm")}${a.text ? `Your course: “${esc(a.text)}”` : `Your course allows ${esc(allowanceLine(a))}`}${a.source ? ` <span class="faint">(${esc(a.source)})</span>` : ""}</p>` : "";
  const session = x.kind === "session" && x.state === "ready";
  const verb = x.kind === "session" ? "Schedule" : x.state === "ready" || x.state === "failed" ? "Make it again" : "Generate";
  const d = frag(`<dialog class="dialog next-dialog"><form method="dialog">
      <h2>${esc(x.title)}</h2>${rule}
      ${x.fields.map(field).join("")}
      <p class="hint">${x.kind === "session" ? (N.view.calendar ? "It goes on your calendar with the reminder, and shows in Teach when it's time." : "Teach shows it when it's time; download the .ics to put it on a calendar.") : "Nothing is made until you press " + verb + "; you can pause it while it's being made."}</p>
      <div class="acts"><button class="btn btn-primary" value="go">${verb}</button><button class="btn" value="save">Save settings</button>
        ${session ? `<button class="btn btn-quiet" value="reset">Cancel the session</button>` : ""}<button class="btn btn-quiet" value="cancel">Close</button></div>
    </form></dialog>`);
  document.body.append(d);
  const values = () => {
    const out = {};
    for (const f of x.fields) {
      if (f.type === "multi") out[f.key] = $$(`[name="${f.key}"]:checked`, d).map((i) => i.value);
      else if (f.type === "check") out[f.key] = $(`[name="${f.key}"]`, d).checked;
      else out[f.key] = $(`[name="${f.key}"]`, d).value;
    }
    return out;
  };
  d.addEventListener("close", async () => {
    const v = d.returnValue;
    if (v === "save" || v === "go") {
      const settings = values();
      await nextOp(x.kind, "save", { settings });
      if (v === "go") {
        if (x.kind === "session") {
          const at = new Date(settings.when);
          await nextOp("session", "start", { settings, at: isNaN(at) ? undefined : at.toISOString() });
        } else {
          N.buttons.get(x.kind)?.g.set("queued", { sub: "Starting", hint: null });
          await nextOp(x.kind, "start", { settings });
        }
      }
    }
    if (v === "reset") await nextOp(x.kind, "reset");
    d.remove();
  });
  d.showModal();
  if (goNow) $(".btn-primary", d).focus();
}

function nextSessionDetails(x) {
  const s = x.session;
  const d = frag(`<dialog class="dialog next-dialog"><form method="dialog">
      <h2>${esc(s.title)}</h2>
      <p class="next-when">${esc(new Date(s.at).toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }))} · ${s.minutes} min</p>
      <p class="hint">${s.calendar ? (s.calendar.ok ? `${icon("check", "icon icon-sm")} On your calendar${s.remind ? `, with a reminder ${s.remind} min before` : ""}.` : `Couldn't add it to your calendar: ${esc(s.calendar.text)}`) : "Not on a calendar: download the .ics to add it."}</p>
      <div class="acts"><button class="btn btn-primary" value="begin">Start it now</button>
        <a class="btn" href="/api/topics/${T.slug}/session-ics" download>Download .ics</a>
        <button class="btn btn-quiet" value="change">Change</button><button class="btn btn-quiet" value="cancel">Close</button></div>
    </form></dialog>`);
  document.body.append(d);
  d.addEventListener("close", async () => {
    if (d.returnValue === "begin") { await nextOp("session", "begin"); toast("Starting the session"); }
    if (d.returnValue === "change") nextSettings(x);
    d.remove();
  });
  d.showModal();
}

// Live: the grid follows the server (actions and topic events), and the tile being made shows what the tutor is doing.
function nextEvent(ev) {
  if (ev.t === "actions" || ev.t === "topic") return nextRefresh(ev.t === "actions" ? 0 : 250);
  if (ev.t === "activity" && ev.label && N.view?.running) {
    N.activity = ev.state === "running" ? ev.label : N.activity;
    const b = N.buttons.get(N.view.running), x = N.view.tiles.find((y) => y.kind === N.view.running);
    if (b && x?.state === "working") b.g.set("working", { sub: nextSub(x) });
  }
}
