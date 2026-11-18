"use strict";
// The Courses tab: programs (a whole major or track, its requirement slots in order), courses (units, schedule, work,
// exams, grades, the professor's log), units, exam sittings, the pre-test and written work. The server owns all state
// (lib/courseapp.mjs); this renders it. Loaded after next.js and before app.js; uses app.js's helpers ($, el, frag,
// api, esc, icon, mdi, md, go, toast) and genbtn.js's genButton at call time.

const CS = { path: "", view: null, buttons: new Map(), timer: null, saveTimer: null, clock: null, gen: 0 };
const KIND_LABEL = { foundation: "Foundation", core: "Core", theme: "Theme", capstone: "Capstone", prereq: "Before the capstone", elective: "Elective" };
const STATUS_LABEL = { open: "no course yet", candidate: "not loaded", loaded: "ready", pretested: "pre-tested", active: "in progress", done: "done" };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const cday = (d, o = { weekday: "short", month: "short", day: "numeric" }) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, o) : "");
const hrs = (h) => (h === null || h === undefined ? "?" : h >= 10 ? Math.round(h) : Math.round(h * 10) / 10);
const pct = (g) => (g && g.max ? Math.round((g.score / g.max) * 100) : null);

// ---------- routing ----------

async function showCourses(path) {
  CS.path = path;
  CS.gen++;
  clearInterval(CS.clock); clearTimeout(CS.saveTimer);
  listen(null, () => {});
  const seg = path.replace(/\/+$/, "").split("/").slice(2);   // ["", "courses", ...]
  try {
    if (!seg.length) return await courseIndex();
    if (seg[0] === "p" && seg[1]) return await programPage(seg[1]);
    if (seg[0] === "c" && seg[1]) {
      const slug = seg[1];
      if (seg[2] === "u" && seg[3]) return await unitPage(slug, Number(seg[3]));
      if (seg[2] === "x" && seg[3]) return await examPage(slug, seg[3]);
      if (seg[2] === "a" && seg[3]) return await workPage(slug, seg[3]);
      if (seg[2] === "pretest") return await pretestPage(slug);
      return await coursePage(slug, seg[2] || "overview");
    }
  } catch (e) {
    app.innerHTML = `<main class="cx"><div class="empty"><b>${esc(e.message)}</b> <a href="/courses" data-link>Back to courses</a></div></main>`;
    return;
  }
  go("/courses");
}

// Live: the server says a course or program changed; repaint what's open (not while typing or sitting an exam).
function coursesEvent(ev) {
  if (page !== "courses" || CS.sitting) return;
  if (document.activeElement && /TEXTAREA|INPUT|SELECT/.test(document.activeElement.tagName) && !document.activeElement.closest(".cx-grid")) return;
  clearTimeout(CS.timer);
  CS.timer = setTimeout(() => showCourses(location.pathname), 300);
}

const crumbs = (items) => `<nav class="cx-crumbs" aria-label="Where you are">${items.map(([label, href], i) => `${i ? '<span class="sep">›</span>' : ""}${href ? `<a href="${href}" data-link>${esc(label)}</a>` : `<span>${esc(label)}</span>`}`).join("")}</nav>`;
const stitchLine = (pv, small = false) => (pv?.stitched ? `<p class="cx-stitch${small ? " cx-stitch-sm" : ""}"><b>Stitched</b><span>${esc(pv.line)}.</span></p>` : "");

// ---------- the action grid (genbuttons, as at the end of a session) ----------

function gridMount(box, tiles, handler, { title = "What next?", sub = "Nothing is made until you click it." } = {}) {
  const sec = frag(`<section class="cx-grid" aria-label="${esc(title)}"><header class="next-head"><h2>${esc(title)}</h2><span class="next-sub">${esc(sub)}</span></header><div class="next-grid" role="list"></div></section>`);
  const grid = $(".next-grid", sec);
  tiles.forEach((x, i) => {
    const wrap = frag(`<div class="next-tile" role="listitem" data-kind="${esc(x.kind)}"><button class="gen" type="button"></button></div>`);
    const g = genButton($(".gen", wrap), {
      title: x.title, glyph: x.glyph || "i-task",
      onGenerate: () => handler(x, "go"), onRetry: () => handler(x, "go"), onPause: () => handler(x, "pause"), onResume: () => handler(x, "go"), onOpen: () => handler(x, "open"),
      hints: x.generative ? {} : { idle: x.hint || "Open" },
    });
    g.set(x.state || "idle", { title: x.title, sub: x.sub || "", hint: x.state === "ready" || !x.generative ? x.hint || null : null });
    if (x.disabled) $(".gen", wrap).disabled = true;
    wrap.dataset.best = String(i === 0 && x.state === "idle");
    grid.append(wrap);
  });
  if (!tiles.length) grid.innerHTML = `<p class="muted next-empty">Nothing to do here yet.</p>`;
  box.append(sec);
}

// What a tile does, for a course's tiles (its own grid, a unit's, or the program's).
async function courseTile(slug, x, how) {
  const A = (path, body) => api(`/api/courses/${slug}${path}`, body);
  try {
    if (x.kind === "pretest") {
      if (how === "pause") return A("/pretest", { op: "pause" });
      if (x.state === "ready") return go(`/courses/c/${slug}/pretest`);
      await A("/pretest", { op: "make" }); toast("Writing the pre-test");
    } else if (x.kind.startsWith("unit-")) {
      if (x.topic) return go(`/t/${x.topic}`);
      const r = await A(`/unit/${x.unit}`, {}); return go(`/t/${r.topic}`);
    } else if (x.kind.startsWith("review-")) {
      const r = await A(`/review/${x.review}`, {}); return go(`/t/${r.topic}`);
    } else if (x.kind.startsWith("work-")) {
      return go(`/courses/c/${slug}/a/${x.work}`);
    } else if (x.kind.startsWith("practice-")) {
      if (how === "pause") return A(`/exam/${x.practiceOf}`, { op: "pause", key: `practice-${x.practiceOf}` });
      if (x.exam && x.state === "ready") return go(`/courses/c/${slug}/x/${x.exam}`);
      await A(`/exam/${x.practiceOf}`, { op: "practice" }); toast("Writing a practice version");
    } else if (x.kind.startsWith("exam-")) {
      if (how === "pause") return A(`/exam/${x.exam}`, { op: "pause" });
      if (!x.generative) return go(`/courses/c/${slug}/x/${x.exam}`);
      await A(`/exam/${x.exam}`, { op: "load" }); toast("Loading the exam. You won't see it until you sit it.");
    } else if (x.kind === "calendar") {
      if (!CS.view?.calendar?.can && CS.view) { location.href = `/api/courses/${slug}/ics`; return; }
      const r = await A("/calendar", {}); toast(`On your calendar: ${r.added} added, ${r.moved} moved`, "green");
    }
  } catch (e) { toast(e.message, "red"); }
  showCourses(location.pathname);
}

// ---------- index ----------

async function courseIndex() {
  const v = await api("/api/courses");
  document.title = "Courses · Teach";
  const main = el("main", "cx");
  const active = v.programs.filter((p) => p.status === "active");
  const others = v.programs.filter((p) => p.status !== "active");
  const inProgram = new Set(v.programs.flatMap((p) => p.slots.map((s) => s.id)));
  const loose = v.courses.filter((c) => !c.program);
  main.append(frag(`<header class="cx-head"><div class="cx-eyebrow">Self-study</div><h1 class="cx-title">Courses</h1>
    <p class="cx-about">Whole courses from real universities' own materials, taught here one unit at a time, with their real graded work and exams.</p></header>`));
  for (const p of active) main.append(programCard(p));
  if (!v.programs.length && !v.courses.length) main.append(frag(`<div class="empty"><b>No courses yet.</b> Import a program or a course with <code>teach course import FILE.json</code>; examples are in the app's <code>examples/</code> folder.</div>`));
  if (others.length) {
    const sec = frag(`<section class="cx-sec"><div class="cx-sec-head"><h2>Other tracks</h2></div><ul class="prog-list"></ul></section>`);
    for (const p of others) $(".prog-list", sec).append(frag(`<li><div><div class="t"><a href="/courses/p/${p.slug}" data-link>${esc(p.title)}</a>${p.status === "alternative" ? '<span class="tag">alternative</span>' : ""}</div>
      <div class="d">${esc(p.model || p.about || "")} · ${p.slots.length} course${p.slots.length === 1 ? "" : "s"}</div></div><a class="btn btn-sm" href="/courses/p/${p.slug}" data-link>Open</a></li>`));
    main.append(sec);
  }
  if (loose.length) {
    const sec = frag(`<section class="cx-sec"><div class="cx-sec-head"><h2>Courses on their own</h2></div><ul class="prog-list"></ul></section>`);
    for (const c of loose) $(".prog-list", sec).append(frag(`<li><div><div class="t"><a href="/courses/c/${c.slug}" data-link>${esc(c.title)}</a></div><div class="d">${esc([c.code, c.institution].filter(Boolean).join(" · "))}</div>${stitchLine(c.provenance, true)}</div>
      <a class="btn btn-sm" href="/courses/c/${c.slug}" data-link>Open</a></li>`));
    main.append(sec);
  }
  main.append(professorCorner(v));
  app.replaceChildren(main);
}

function reqmap(slots, { small = false } = {}) {
  const groups = ["foundation", "core", "theme", "capstone", "prereq", "elective"].map((k) => [k, slots.filter((s) => s.kind === k)]).filter(([, l]) => l.length);
  return `<div class="reqmap" aria-label="Requirements">${groups.map(([k, l]) => `<div class="reqmap-group"><span class="label"><b>${KIND_LABEL[k]}</b> ${l.filter((s) => s.status === "done").length}/${l.length}</span>
    <span class="reqmap-cells">${l.map((s) => `<${small ? "span" : "button type=\"button\""} class="reqcell" data-s="${s.status}" data-slot="${esc(s.id)}" title="${s.order}. ${esc(s.area)}: ${esc(s.code ? `${s.code} ` : "")}${esc(s.title || s.course?.title || s.candidate?.title || "")} (${STATUS_LABEL[s.status]})"></${small ? "span" : "button"}>`).join("")}</span></div>`).join("")}</div>`;
}

function programCard(p) {
  const fin = p.timeline.finish ? `finishes around <span class="num">${cday(p.timeline.finish, { month: "short", year: "numeric" })}</span>` : "";
  return frag(`<a class="prog-card" href="/courses/p/${p.slug}" data-link>
    <div class="cx-eyebrow">${esc(p.kind === "major" ? "Major" : "Track")} · ${esc(p.model || "")}</div>
    <h2 class="cx-title">${esc(p.title)}</h2>
    ${reqmap(p.slots, { small: true })}
    <div class="cx-facts"><span><span class="num">${p.progress.done}/${p.progress.total}</span> courses done</span>${p.progress.active ? `<span><span class="num">${p.progress.active}</span> in progress</span>` : ""}
      <span>${esc(p.start.text)}</span>${fin ? `<span>${fin}${p.timeline.estimated ? " (estimate)" : ""}</span>` : ""}</div></a>`);
}

function professorCorner(v) {
  const s = v.settings.checkin;
  const sec = frag(`<section class="cx-sec"><div class="cx-sec-head"><h2>Check-ins and notes</h2></div>
    <div class="prof">
      <div><p class="cx-note">Every <b>${DAYS[s.day]}</b> at <b>${esc(s.time)}</b> the course professor reviews the week: what was due and done, scores, what's behind and what's due next. It changes the plan where the evidence says so, then tells you${v.features.checkin ? "" : " here (no check-in command is set up, so it only shows in Teach)"}.</p>
        <p class="cx-note">If you fall behind, it texts you instead, and checks in twice a week until you're back on track.</p>
        <form class="note-form ci-form"><label class="visually-hidden" for="ci-day">Day</label><select class="field field-sm" id="ci-day">${DAYS.map((d, i) => `<option value="${i}"${i === s.day ? " selected" : ""}>${d}</option>`).join("")}</select>
          <label class="visually-hidden" for="ci-time">Time</label><input class="field field-sm" id="ci-time" type="time" value="${esc(s.time)}" style="max-width:120px"><button class="btn btn-sm" type="submit">Save</button>
          <button class="btn btn-sm btn-quiet" type="button" data-preview>Preview this week's</button></form>
        <div class="checkin-preview" hidden></div></div>
      <div><p class="cx-note">Notes for the professor: anything school and your calendar don't show (“busy week, travelling”). It reads them when it sets each week's load. They stay on this machine.</p>
        <ul class="notes-list">${v.notes.map((n) => `<li><span class="wk">wk of ${cday(n.monday, { month: "short", day: "numeric" })}</span><span>${esc(n.text)}</span><button class="btn btn-sm btn-quiet x" type="button" data-drop="${esc(n.id)}" aria-label="Remove">${icon("x", "icon icon-sm")}</button></li>`).join("") || '<li class="faint">No notes.</li>'}</ul>
        <form class="note-form nt-form"><input class="field field-sm" name="text" placeholder="e.g. busy week, travelling Thursday" maxlength="300"><input class="field field-sm" type="date" name="week" style="max-width:150px" aria-label="Which week"><button class="btn btn-sm" type="submit">Add</button></form></div>
    </div></section>`);
  $(".ci-form", sec).addEventListener("submit", async (e) => { e.preventDefault(); await api("/api/courses/settings", { checkin: { day: Number($("#ci-day", sec).value), time: $("#ci-time", sec).value } }, "PUT"); toast("Saved"); });
  $("[data-preview]", sec).addEventListener("click", async () => { const r = await api("/api/courses/checkin", { dry: true }); const box = $(".checkin-preview", sec); box.hidden = false; box.textContent = r.message || r.why || ""; });
  $(".nt-form", sec).addEventListener("submit", async (e) => { e.preventDefault(); const f = new FormData(e.target); if (!f.get("text")) return; await api("/api/context", { text: f.get("text"), week: f.get("week") || "" }); showCourses("/courses"); });
  $$("[data-drop]", sec).forEach((b) => b.addEventListener("click", async () => { await api("/api/context", { id: b.dataset.drop }, "DELETE"); showCourses("/courses"); }));
  return sec;
}

// ---------- a program (a major or a track) ----------

async function programPage(slug) {
  const v = await api(`/api/programs/${slug}`);
  CS.view = v;
  const p = v.program;
  document.title = `${p.title} · Teach`;
  const main = el("main", "cx");
  main.append(frag(`<header class="cx-head">${crumbs([["Courses", "/courses"], [p.title]])}
    <div class="cx-eyebrow">${esc(p.kind === "major" ? "Major" : "Track")}${p.status === "alternative" ? " · the alternative track" : ""}${p.model ? ` · ${esc(p.model)}` : ""}</div>
    <h1 class="cx-title">${esc(p.title)}</h1>${p.about ? `<p class="cx-about">${esc(p.about)}</p>` : ""}</header>`));
  main.append(startBanner(slug, v));
  const rm = frag(reqmap(v.slots));
  $$(".reqcell", rm).forEach((b) => b.addEventListener("click", () => { const row = $(`#slot-${b.dataset.slot}`); if (row) { row.scrollIntoView({ behavior: "smooth", block: "center" }); row.classList.add("is-flash"); setTimeout(() => row.classList.remove("is-flash"), 1400); } }));
  main.append(rm);
  main.append(paceBar(slug, v));
  gridMount(main, v.tiles, (x, how) => programTile(slug, x, how));
  const seq = frag(`<section class="cx-sec"><div class="cx-sec-head"><h2>The sequence</h2><span class="hint">in the order you'll take them, prerequisites first</span></div><ol class="seq"></ol></section>`);
  for (const s of v.slots) $(".seq", seq).append(seqRow(slug, s, v));
  main.append(seq);
  if (p.theme) main.append(frag(`<section class="cx-sec"><h2>The theme</h2><p class="cx-note"><b>${esc(p.theme.name)}.</b> ${esc(p.theme.why)}</p></section>`));
  app.replaceChildren(main);
}

function startBanner(slug, v) {
  const s = v.start, last = s.last;
  if (s.state === "started") return frag(`<div class="cx-banner" data-tone="ok"><span class="cx-dot"></span><span class="text"><b>Started ${esc(cday(s.date, { weekday: "long", month: "long", day: "numeric" }))}.</b> Deadlines and the calendar run from that day.</span></div>`);
  const open = last?.open?.length ? `Still open at school (${last.open.length}): ${last.open.slice(0, 3).join("; ")}${last.open.length > 3 ? "…" : ""}` : last?.error ? last.error : last ? "Nothing open." : "";
  const b = frag(`<div class="cx-banner" data-tone="${s.state === "asked" ? "warn" : "wait"}"><span class="cx-dot"></span>
    <span class="text"><b>${esc(s.text)}</b>${s.state === "asked" ? " Teach asked you whether to start: say go here, or it keeps checking." : ""}
      ${last ? `<span class="sub">Last checked ${esc(new Date(last.at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }))}${open ? ` · ${esc(open)}` : ""}</span>` : ""}</span>
    <span class="acts">${s.through ? '<button class="btn btn-sm" type="button" data-check>Check now</button>' : ""}<button class="btn btn-sm btn-primary" type="button" data-go>Start now</button></span></div>`);
  $("[data-check]", b)?.addEventListener("click", async (e) => { e.target.disabled = true; await api(`/api/programs/${slug}/check`, {}).catch((x) => toast(x.message, "red")); showCourses(location.pathname); });
  $("[data-go]", b).addEventListener("click", async () => { if (!confirm(`Start ${v.program.title} today? Deadlines run from today, and the first course's pre-test is made now.`)) return; await api(`/api/programs/${slug}/start`, {}); toast("Started", "green"); showCourses(location.pathname); });
  return b;
}

function paceBar(slug, v) {
  const p = v.program.pace, t = v.timeline;
  const f = frag(`<form class="pace" aria-label="Pace"><label>Hours a week <input class="field field-sm" type="number" min="1" max="40" step="0.5" name="h" value="${p.hoursPerWeek}"></label>
    <label>Courses at a time <select class="field field-sm" name="c">${[1, 2, 3].map((n) => `<option${n === p.concurrent ? " selected" : ""}>${n}</option>`).join("")}</select></label>
    <span class="out"><span class="num">${t.weeks}</span> weeks${t.finish ? ` · done around <span class="num">${cday(t.finish, { month: "short", year: "numeric" })}</span>` : ""}
      <small>${t.estimated ? "An estimate: each course's hours firm up after its pre-test." : "From each course's hours at this pace."} The professor moves each week's load with school.</small></span></form>`);
  const save = async () => { await api(`/api/programs/${slug}/pace`, { hoursPerWeek: Number($("[name=h]", f).value), concurrent: Number($("[name=c]", f).value) }); showCourses(location.pathname); };
  $("[name=h]", f).addEventListener("change", save); $("[name=c]", f).addEventListener("change", save);
  f.addEventListener("submit", (e) => { e.preventDefault(); save(); });
  return f;
}

function seqRow(slug, s, v) {
  const c = s.course, cand = s.candidate || {};
  const title = c ? c.title : cand.title || s.area, code = c ? c.code : cand.code;
  const by = c ? [c.institution, (c.instructors || []).join(", ")] : [cand.institution, (cand.instructors || []).join(", "), cand.edition];
  const href = c ? `/courses/c/${c.slug}` : cand.url;
  const h = s.when?.hours || {};
  const order = (id) => v.slots.find((x) => x.id === id)?.order;
  const li = frag(`<li class="seq-row" id="slot-${esc(s.id)}" data-s="${s.status}" data-kind="${s.kind}">
    <span class="seq-node" aria-hidden="true">${s.order}</span>
    <div>
      <div class="seq-kind">${KIND_LABEL[s.kind]}<span class="area">${esc(s.area)}</span></div>
      <h3 class="seq-title">${href ? `<a href="${esc(href)}"${c ? " data-link" : ' target="_blank" rel="noreferrer"'}>` : ""}${code ? `<span class="code">${esc(code)}</span>` : ""}${esc(title)}${href ? "</a>" : ""}</h3>
      <div class="seq-by">${esc(by.filter(Boolean).join(" · "))}</div>
      ${stitchLine(s.provenance, true)}
      ${s.why ? `<p class="seq-why">${esc(s.why)}${cand.note && !c ? ` ${esc(cand.note)}` : ""}</p>` : ""}
      ${s.after.length ? `<div class="seq-after">after ${s.after.map((a) => `<a href="#slot-${esc(a)}">#${order(a)}</a>`).join(" · ")}</div>` : ""}
    </div>
    <div class="seq-side">
      <span class="seq-hours">${h.total === null || h.total === undefined ? "?" : `${hrs(h.left ?? h.total)} h`}<small>${esc(h.left !== null && h.left !== undefined && h.left !== h.total ? `left of ${hrs(h.total)} · ${h.basis}` : h.basis || "")}</small></span>
      ${s.when ? `<span class="seq-when">${s.when.start ? `${cday(s.when.start, { month: "short", day: "numeric" })} – ${cday(s.when.end, { month: "short", day: "numeric", year: "2-digit" })}` : `wk ${s.when.startWeek + 1}–${s.when.endWeek}`}</span>` : ""}
      <span class="chip chip-sm${s.status === "done" ? " chip-ok" : ""}">${STATUS_LABEL[s.status]}</span>
      <button class="btn btn-sm btn-quiet" type="button" data-swap>Swap</button>
    </div></li>`);
  $("[data-swap]", li).addEventListener("click", () => swapDialog(slug, s));
  return li;
}

function swapDialog(slug, s) {
  const d = frag(`<dialog class="dialog swap-dialog"><form method="dialog"><h2>Swap: ${esc(s.area)}</h2>
    <p class="hint" style="margin:0 0 8px">Pick an alternate, or paste another free course's page. Teach reads it when you load it.</p>
    ${s.alternates.map((a, i) => `<label class="opt"><input type="radio" name="pick" value="${i}"><b>${esc(`${a.code} ${a.title}`.trim())}</b><span>${esc([a.institution, a.edition, a.note].filter(Boolean).join(" · "))}</span></label>`).join("")}
    <label class="opt"><input type="radio" name="pick" value="url"${s.alternates.length ? "" : " checked"}><b>Another course</b><span><input class="field field-sm" name="url" placeholder="https://… the course's page" style="margin-top:6px"><input class="field field-sm" name="title" placeholder="Its title" style="margin-top:6px"></span></label>
    <div class="acts"><button class="btn btn-primary" value="go">Use this course</button><button class="btn btn-quiet" value="cancel">Cancel</button></div></form></dialog>`);
  document.body.append(d);
  d.addEventListener("close", async () => {
    if (d.returnValue === "go") {
      const f = new FormData($("form", d)), pick = f.get("pick");
      const body = pick === "url" ? { url: f.get("url"), title: f.get("title") } : { alternate: Number(pick) };
      try { await api(`/api/programs/${slug}/slot`, { slot: s.id, ...body }); toast("Swapped"); } catch (e) { toast(e.message, "red"); }
      showCourses(location.pathname);
    }
    d.remove();
  });
  d.showModal();
}

async function programTile(slug, x, how) {
  if (x.course) return courseTile(x.course, x, how);
  try {
    if (x.kind.startsWith("load-")) await api(`/api/programs/${slug}/slot`, { slot: x.slot, op: how === "pause" ? "pause" : "load" });
  } catch (e) { toast(e.message, "red"); }
  showCourses(location.pathname);
}

// ---------- a course ----------

const COURSE_TABS = [["overview", "Overview"], ["units", "Units"], ["work", "Work"], ["exams", "Exams"], ["grades", "Grades"], ["changes", "Plan changes"]];

async function coursePage(slug, tab) {
  const v = await api(`/api/courses/${slug}`);
  CS.view = v;
  const c = v.course;
  document.title = `${c.title} · Teach`;
  const main = el("main", "cx");
  const prog = v.program ? [[v.program.title, `/courses/p/${v.program.slug}`]] : [];
  const g = v.gradebook;
  main.append(frag(`<header class="cx-head">${crumbs([["Courses", "/courses"], ...prog, [c.title]])}
    <div class="cx-eyebrow">${esc([c.code, c.institution].filter(Boolean).join(" · "))}</div>
    <h1 class="cx-title">${esc(c.title)}</h1>
    <div class="cx-by">${esc((c.instructors || []).join(", "))}${c.edition ? ` · ${esc(c.edition)}` : ""}</div>
    ${stitchLine(c.provenance)}
    <div class="cx-facts">${meter(c.progress.steps)}<span><span class="num">${c.progress.done}/${c.progress.items}</span> done</span>
      <span><span class="num">${hrs(c.hours.left)} h</span> left <span class="faint">(${esc(c.hours.basis)})</span></span>
      ${g.current !== null ? `<span>grade so far <span class="num">${g.current}%</span> ${esc(g.letter)}</span>` : ""}
      ${c.pretest ? `<span>pre-test <span class="num">${c.pretest.right}/${c.pretest.of}</span></span>` : ""}
      ${c.behind ? `<span class="chip chip-sm chip-warn">${c.behind} behind</span>` : ""}</div>
    <div class="tabs" role="tablist">${COURSE_TABS.map(([k, l]) => `<a class="tab" role="tab" data-link href="/courses/c/${slug}${k === "overview" ? "" : `/${k}`}" aria-selected="${tab === k}">${l}${k === "changes" && v.changes.length ? ` <span class="n">${v.changes.filter((x) => !x.undone).length}</span>` : ""}</a>`).join("")}</div></header>`));
  ({ overview: courseOverview, units: courseUnits, work: courseWork, exams: courseExams, grades: courseGrades, changes: courseChanges }[tab] || courseOverview)(main, v, slug);
  app.replaceChildren(main);
}

function courseOverview(main, v, slug) {
  const c = v.course;
  if (!c.start) {
    const b = frag(`<div class="cx-banner" data-tone="wait"><span class="cx-dot"></span><span class="text"><b>${v.program ? `Starts with ${esc(v.program.title)}.` : "Not started."}</b> Nothing is taught and no deadlines are set until it starts.</span>
      ${v.program ? `<span class="acts"><a class="btn btn-sm" href="/courses/p/${v.program.slug}" data-link>The program</a></span>` : `<span class="acts"><input class="field field-sm" type="date" aria-label="Start date"><button class="btn btn-sm btn-primary" type="button">Start</button></span>`}</div>`);
    $(".btn-primary", b)?.addEventListener("click", async () => { const d = $("input", b).value; if (!d) return toast("Pick a day"); await api(`/api/courses/${slug}/start`, { date: d }); showCourses(location.pathname); });
    main.append(b);
  }
  if (v.behind.length) main.append(frag(`<div class="cx-banner" data-tone="warn"><span class="cx-dot"></span><span class="text"><b>Behind:</b> ${v.behind.map((x) => `${esc(x.title)} (due ${cday(x.due)})`).join(", ")}. The professor moves a missed deadline once, to the end of the week, and texts you.</span></div>`));
  gridMount(main, v.tiles, (x, how) => courseTile(slug, x, how));
  if (c.summary) main.append(frag(`<section class="cx-sec"><h2>About the course</h2><p class="cx-about" style="margin-top:0">${esc(c.summary)}</p>${c.url ? `<p class="cx-note" style="margin-top:8px"><a href="${esc(c.url)}" target="_blank" rel="noreferrer">The course's own page</a></p>` : ""}</section>`));
  main.append(scheduleSec(v, slug));
  if (v.changes.length) {
    const sec = frag(`<section class="cx-sec"><div class="cx-sec-head"><h2>What I changed and why</h2><span class="hint">the course professor</span><a class="btn btn-sm btn-quiet end" href="/courses/c/${slug}/changes" data-link>All ${v.changes.length}</a></div><ul class="log"></ul></section>`);
    for (const ch of v.changes.slice(0, 3)) $(".log", sec).append(changeRow(slug, ch));
    main.append(sec);
  }
}

function scheduleSec(v, slug) {
  const sec = frag(`<section class="cx-sec"><div class="cx-sec-head"><h2>Schedule</h2><span class="hint">${v.course.start ? "each week's deadlines; the professor re-paces them when the evidence says so" : "it's set when the course starts"}</span></div></section>`);
  if (!v.schedule.length) {
    sec.append(frag(`<p class="cx-note">${v.units.length} units, ${v.assignments.length} pieces of written work and ${v.exams.filter((x) => !x.practice).length} exams, about ${hrs(v.course.hours.total)} hours in all (${esc(v.course.hours.basis)}).</p>`));
    return sec;
  }
  const ul = el("ul", "weeks"), today = v.today;
  for (const w of v.schedule) {
    const sunday = new Date(`${w.monday}T12:00:00`); sunday.setDate(sunday.getDate() + 6);
    const now = today >= w.monday && today <= sunday.toLocaleDateString("en-CA");
    const kind = /^lighter/.test(w.why) ? "lighter" : /^heavier/.test(w.why) ? "heavier" : "";
    ul.append(frag(`<li class="week" data-now="${now}"><div class="week-when">Week ${w.week}<small>${cday(w.monday, { month: "short", day: "numeric" })}${w.target ? ` · ${hrs(w.target)} h` : ""}</small></div>
      <div><ul class="week-items">${w.items.map((x) => `<li data-done="${x.done}" data-late="${!x.done && x.due < today}" data-kind="${x.kind}"><span class="mark"></span><span class="t">${x.kind === "unit" ? `<a href="/courses/c/${slug}/u/${x.n}" data-link style="color:inherit;text-decoration:none">${esc(x.title)}</a>` : esc(x.title)}</span><span class="due">${cday(x.due, { weekday: "short" })} ${Number(x.due.slice(8))}</span></li>`).join("")}</ul>
      ${w.why && w.why !== "a normal week" ? `<div class="week-why" data-kind="${kind}">${esc(w.why)}</div>` : ""}</div></li>`));
  }
  sec.append(ul);
  return sec;
}

function changeRow(slug, ch) {
  const li = frag(`<li data-undone="${!!ch.undone}"><span class="when">${cday(ch.at, { month: "short", day: "numeric" })}</span>
    <div><div class="rule">${esc({ load: "weekly load", edge: "pace", sessions: "session length", time: "study time", review: "review", strong: "fast track", stuck: "stuck", slip: "missed deadline", consistency: "check-ins", repace: "re-paced" }[ch.rule] || ch.rule)}</div>
      <div class="what">${esc(ch.title)}</div><p class="why">${esc(ch.reason)}</p>${ch.evidence?.length ? `<ul class="ev">${ch.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}</div>
    <div>${ch.undone ? '<span class="faint" style="font-size:12.5px">undone</span>' : ch.patch?.length ? '<button class="btn btn-sm" type="button">Undo</button>' : ""}</div></li>`);
  $("button", li)?.addEventListener("click", async () => { try { await api(`/api/courses/${slug}/undo`, { id: ch.id }); toast("Undone"); } catch (e) { toast(e.message, "red"); } showCourses(location.pathname); });
  return li;
}

function courseChanges(main, v, slug) {
  const sec = frag(`<section class="cx-sec"><div class="cx-sec-head"><h2>What I changed and why</h2><span class="hint">every change the course professor made, the evidence, and Undo. It never changes an exam, the graded work or the grading: only how you get there.</span></div><ul class="log"></ul></section>`);
  for (const ch of v.changes) $(".log", sec).append(changeRow(slug, ch));
  if (!v.changes.length) sec.append(frag(`<p class="cx-note">No changes yet. The professor first looks at the evidence on the first ${DAYS[v.settings.checkin.day]} after the course starts, and after anything that slips.</p>`));
  const plan = v.course.plan;
  sec.append(frag(`<p class="cx-note" style="margin-top:16px">Right now: sessions of <b>${plan.sessionMinutes} min</b>${plan.preferred ? `, in the <b>${esc(plan.preferred)}</b>` : ""}, pace <b>×${plan.edge || 1}</b>, check-ins <b>${plan.checkin?.freq === "twice" ? "twice a week, by text" : `weekly, on ${DAYS[v.settings.checkin.day]}`}</b>.</p>`));
  main.append(sec);
}

function courseUnits(main, v, slug) {
  const sec = frag(`<section class="cx-sec"><ul class="units"></ul></section>`);
  for (const u of v.units) {
    const r = u.pretest;
    $(".units", sec).append(frag(`<li data-done="${u.done}"><span class="n">${u.n}</span><div><h3 class="t"><a href="/courses/c/${slug}/u/${u.n}" data-link>${esc(u.title)}</a>${u.mode === "fast" ? '<span class="tag">fast track</span>' : ""}</h3>
      <p class="s">${esc(u.summary || "")}</p><p class="s faint">${u.lectures.length} lecture${u.lectures.length === 1 ? "" : "s"} · ${u.readings.filter((x) => x.required).length} reading${u.readings.length === 1 ? "" : "s"}${u.topic ? ` · <a href="/t/${u.topic}" data-link>the lesson</a>` : ""}</p></div>
      <div class="side"><span>${hrs(u.hours.total)} h</span><span class="faint">${esc(u.hours.basis)}</span>${u.due ? `<span>due ${cday(u.due)}</span>` : ""}
        ${r ? `<span class="pre-dots" title="pre-test: ${r.right} of ${r.of}">${Array.from({ length: r.of }, (_, i) => `<i data-r="${i < r.right ? 1 : 0}"></i>`).join("")}</span>` : ""}</div></li>`));
  }
  main.append(sec);
}

function courseWork(main, v, slug) {
  const sec = frag(`<section class="cx-sec"><div class="cx-sec-head"><h2>Written work</h2><span class="hint">graded against the rubric by a grader that isn't your tutor</span></div><ul class="items"></ul></section>`);
  for (const a of v.assignments) {
    const w = a.work, s = pct(w.grade);
    $(".items", sec).append(frag(`<li><div><div class="t"><a href="/courses/c/${slug}/a/${a.id}" data-link>${esc(a.title)}</a>${a.source === "generated" ? '<span class="tag tag-generated">generated</span>' : ""}</div>
      <div class="d">${esc([a.length, `after unit ${a.unit}`, v.course && CS.view.schedule.flatMap((x) => x.items).find((x) => x.id === a.id)?.due ? `due ${cday(CS.view.schedule.flatMap((x) => x.items).find((x) => x.id === a.id).due)}` : ""].filter(Boolean).join(" · "))}</div></div>
      <div>${s !== null ? `<span class="score">${s}%</span>` : w.state === "grading" ? '<span class="chip chip-sm">being graded</span>' : w.state === "draft" ? `<span class="chip chip-sm">draft · ${w.words} words</span>` : ""}</div></li>`));
  }
  if (!v.assignments.length) sec.append(frag(`<p class="cx-note">This course has no written work.</p>`));
  main.append(sec);
}

function courseExams(main, v, slug) {
  const sec = frag(`<section class="cx-sec"><div class="cx-sec-head"><h2>Exams and graded problems</h2><span class="hint">a real exam is one sitting; practice versions can be retaken and don't count</span></div><ul class="items"></ul></section>`);
  for (const x of v.exams) {
    const a = x.attempt, s = pct(a?.grade);
    $(".items", sec).append(frag(`<li><div><div class="t"><a href="/courses/c/${slug}/x/${x.id}" data-link>${esc(x.title)}</a>${x.practice ? '<span class="tag tag-practice">practice</span>' : x.source === "generated" ? '<span class="tag tag-generated">generated</span>' : '<span class="tag tag-real">real exam</span>'}</div>
      <div class="d">${esc([`${x.minutes} min`, x.closedBook ? "closed book" : "open book", x.covers.length ? `units ${x.covers.join(", ")}` : "", x.loaded ? `${x.count} questions` : "not loaded yet"].filter(Boolean).join(" · "))}</div></div>
      <div>${s !== null ? `<span class="score">${s}%</span>` : a ? `<span class="chip chip-sm">${a.state === "in-progress" ? "in progress" : "being graded"}</span>` : ""}</div></li>`));
  }
  main.append(sec);
}

function courseGrades(main, v) {
  const g = v.gradebook;
  const sec = frag(`<section class="cx-sec"><div class="score-head">${g.current !== null ? `<span class="score-big">${g.current}<small>%</small></span><span class="letter">${esc(g.letter)}</span>` : '<span class="cx-note">No graded work yet.</span>'}
      <span class="by">${g.weightGraded} of ${g.weightTotal}% of the grade graded so far${g.passMark ? ` · pass mark ${g.passMark}%` : ""}</span></div>
    <table class="gb" style="margin-top:18px"><thead><tr><th>Graded work</th><th class="num">Weight</th><th class="num">Score</th></tr></thead><tbody>
    ${g.rows.map((r) => `<tr><td>${esc(r.what)}<span class="sub">${r.items.map((i) => `${esc(i.title)}: ${i.score ? `${i.score.pct}%` : "—"}`).join(" · ")}</span></td><td class="num">${r.weight}%</td><td class="num">${r.pct === null ? "—" : `${r.pct}%`}</td></tr>`).join("")}
    </tbody></table></section>`);
  main.append(sec);
  const extra = frag(`<section class="cx-sec"><h2>Not counted</h2><table class="gb"><tbody>
    ${g.pretest ? `<tr><td>Pre-test<span class="sub">what you knew before the course: ${Object.entries(g.pretest.byUnit).map(([n, r]) => `unit ${n} ${r.right}/${r.of}`).join(" · ")}</span></td><td class="num">${g.pretest.right}/${g.pretest.of}</td></tr>` : ""}
    ${g.practice.map((p) => `<tr><td>${esc(p.title)} <span class="tag tag-practice">practice</span></td><td class="num">${p.score ? `${p.score.pct}%` : "—"}</td></tr>`).join("")}
    ${v.units.filter((u) => u.retention?.reviews).map((u) => `<tr><td>Review, unit ${u.n}<span class="sub">flashcards remembered</span></td><td class="num">${Math.round(100 - (u.retention.again / u.retention.reviews) * 100)}%</td></tr>`).join("")}
    </tbody></table></section>`);
  if ($("tbody", extra).children.length) main.append(extra);
}

// ---------- a unit ----------

async function unitPage(slug, n) {
  const v = await api(`/api/courses/${slug}`);
  CS.view = v;
  const u = v.units.find((x) => x.n === n);
  if (!u) throw new Error("No such unit");
  const c = v.course;
  document.title = `Unit ${n}: ${u.title} · Teach`;
  const main = el("main", "cx");
  const prog = v.program ? [[v.program.title, `/courses/p/${v.program.slug}`]] : [];
  main.append(frag(`<header class="cx-head">${crumbs([["Courses", "/courses"], ...prog, [c.title, `/courses/c/${slug}/units`], [`Unit ${n}`]])}
    <div class="cx-eyebrow">${esc(c.code || c.title)} · unit ${n} of ${v.units.length}</div><h1 class="cx-title cx-title-sm">${esc(u.title)}</h1>
    ${u.summary ? `<p class="cx-about">${esc(u.summary)}</p>` : ""}
    <div class="cx-facts"><span><span class="num">${hrs(u.hours.total)} h</span> <span class="faint">(${esc(u.hours.basis)}: ${hrs(u.hours.concept)} h lessons, ${hrs(u.hours.reading)} h reading)</span></span>${u.due ? `<span>due <span class="num">${cday(u.due)}</span></span>` : ""}
      ${u.pretest ? `<span>pre-test <span class="num">${u.pretest.right}/${u.pretest.of}</span></span>` : ""}${u.mode === "fast" ? '<span class="tag">fast track</span>' : ""}</div></header>`));
  if (u.directive) main.append(frag(`<p class="cx-note" style="margin-top:14px">${esc(u.directive)}</p>`));
  gridMount(main, u.tiles, (x, how) => courseTile(slug, x, how), { title: "This unit" });
  if (u.readings.length) {
    const sec = frag(`<section class="cx-sec"><h2>Readings</h2><ul class="reading-list"></ul></section>`);
    u.readings.forEach((r, i) => $(".reading-list", sec).append(frag(`<li><span class="k">${i + 1}</span><div><div class="t">${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.title)}</a>` : esc(r.title)}</div><div class="a">${esc(r.author)}${r.note ? ` · ${esc(r.note)}` : ""}</div></div><span class="x">${r.pages ? `${r.pages} pp` : ""}${r.required ? "" : " optional"}</span></li>`)));
    main.append(sec);
  }
  if (u.lectures.length) {
    const sec = frag(`<section class="cx-sec"><h2>Lectures</h2><ul class="lecture-list"></ul></section>`);
    for (const l of u.lectures) $(".lecture-list", sec).append(frag(`<li><span class="k">L${l.n}</span><div class="t">${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noreferrer">${esc(l.title)}</a>` : esc(l.title)}</div><span class="x">${l.minutes ? `${l.minutes} min` : ""}${l.slides ? ` <a href="${esc(l.slides)}" target="_blank" rel="noreferrer">slides</a>` : ""}</span></li>`));
    main.append(sec);
  }
  app.replaceChildren(main);
}

// ---------- sittings: the pre-test, an exam, a problem set ----------

function questionCard(q, i, { answer = {}, result = null, open = true, idk = false } = {}) {
  const li = frag(`<li class="sit-q" data-i="${i}"${result && result.ok !== undefined ? ` data-ok="${result.ok}"` : ""}>${q.part ? `<div class="part">${esc(q.part)}</div>` : ""}
    <div class="head"><span class="num">${q.n}</span><div class="prompt">${md(q.prompt)}</div><span class="pts">${q.points ? `${q.points} pt${q.points === 1 ? "" : "s"}` : ""}</span></div></li>`);
  if (q.kind === "choice" || q.kind === "multi") {
    const box = el("div", "sit-opts");
    q.options.forEach((o, j) => {
      const chosen = q.kind === "multi" ? (answer.choices || []).includes(j) : answer.choice === j;
      const cls = result && q.answer !== undefined ? ((q.kind === "multi" ? q.answer.includes(j) : q.answer === j) ? " is-right" : chosen ? " is-wrong" : "") : "";
      box.append(frag(`<label class="sit-opt${cls}"><input type="${q.kind === "multi" ? "checkbox" : "radio"}" name="q${i}" value="${j}"${chosen ? " checked" : ""}${open ? "" : " disabled"}><span>${mdi(o)}</span></label>`));
    });
    if (idk) box.append(frag(`<label class="sit-opt idk"><input type="radio" name="q${i}" value="idk"${answer.idk ? " checked" : ""}${open ? "" : " disabled"}><span>I don't know</span></label>`));
    li.append(box);
  } else if (q.kind === "number") {
    li.append(frag(`<div class="sit-opts"><input class="field field-mono" style="max-width:220px" inputmode="decimal" name="q${i}" value="${esc(answer.value ?? "")}"${open ? "" : " disabled"} aria-label="Answer"></div>`));
  } else {
    const ta = frag(`<textarea class="field" name="q${i}" placeholder="Your answer"${open ? "" : " disabled"} aria-label="Answer to question ${q.n}"></textarea>`);
    ta.value = answer.text || "";
    const count = frag(`<div class="count">${(ta.value.match(/\S+/g) || []).length} words${q.words ? ` · aim for ${q.words}` : ""}</div>`);
    ta.addEventListener("input", () => { count.textContent = `${(ta.value.match(/\S+/g) || []).length} words${q.words ? ` · aim for ${q.words}` : ""}`; });
    li.append(ta, count);
  }
  if (result) {
    const bits = [];
    if (Number.isFinite(result.points)) bits.push(`<b>${result.points}/${result.max}</b>`);
    if (result.comment) bits.push(esc(result.comment));
    if (q.why) bits.push(`<b>Why:</b> ${mdi(q.why)}`);
    if (q.kind === "text" && q.model) bits.push(`<b>The course's answer:</b> ${mdi(q.model)}`);
    if (result.pending) bits.push("Being graded…");
    if (bits.length) li.append(frag(`<div class="result">${bits.join(" · ")}</div>`));
  }
  return li;
}

function readAnswers(root, qs) {
  return qs.map((q, i) => {
    if (q.kind === "choice") { const v = $(`[name="q${i}"]:checked`, root)?.value; return v === undefined ? {} : v === "idk" ? { idk: true } : { choice: Number(v) }; }
    if (q.kind === "multi") return { choices: $$(`[name="q${i}"]:checked`, root).map((x) => Number(x.value)) };
    if (q.kind === "number") return { value: $(`[name="q${i}"]`, root)?.value ?? "" };
    return { text: $(`[name="q${i}"]`, root)?.value || "" };
  });
}

async function pretestPage(slug) {
  const v = await api(`/api/courses/${slug}/pretest`);
  const c = v.course, pt = v.pretest;
  document.title = `Pre-test: ${c.title} · Teach`;
  const main = el("main", "cx cx-narrow");
  main.append(frag(`<header class="cx-head">${crumbs([["Courses", "/courses"], [c.title, `/courses/c/${slug}`], ["Pre-test"]])}<div class="cx-eyebrow">${esc(c.code || "")} · pre-test</div><h1 class="cx-title cx-title-sm">What do you already know?</h1>
    <p class="cx-about">Multiple choice on every unit, so the lessons skip what you already have. Expect to know little: pick “I don't know” rather than guess, because a lucky guess makes the course skip something you need. It isn't graded.</p></header>`));
  if (!pt?.questions) { main.append(frag(`<div class="empty"><b>No pre-test yet.</b> <a href="/courses/c/${slug}" data-link>Make it from the course page.</a></div>`)); app.replaceChildren(main); return; }
  const taken = !!pt.result;
  if (taken) main.append(frag(`<div class="score-head"><span class="score-big">${pt.result.right}<small>/${pt.result.of}</small></span><span class="by">${Object.entries(pt.result.byUnit).map(([n, r]) => `unit ${n}: ${r.right}/${r.of}`).join(" · ")}. Each unit's tutor gets this and probes only what it didn't settle.</span></div>`));
  const form = el("form");
  const ol = el("ol", "sit-qs");
  pt.questions.forEach((q, i) => ol.append(questionCard({ ...q, part: i === 0 || q.unit !== pt.questions[i - 1].unit ? `Unit ${q.unit}` : "" }, i, { answer: pt.answers?.[i] || {}, result: taken ? { ok: !pt.answers?.[i]?.idk && pt.answers?.[i]?.choice === q.answer } : null, open: !taken, idk: true })));
  form.append(ol);
  if (!taken) {
    form.append(frag(`<div class="sit-foot"><button class="btn btn-primary btn-lg" type="submit">Hand it in</button><span class="hint">Unanswered ones count as “I don't know”.</span></div>`));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      $("[type=submit]", form).disabled = true;
      try { await api(`/api/courses/${slug}/pretest`, { op: "answer", answers: readAnswers(form, pt.questions) }); toast("Pre-test in: the plan now skips what you know", "green"); window.scrollTo(0, 0); showCourses(location.pathname); }
      catch (err) { toast(err.message, "red"); $("[type=submit]", form).disabled = false; }
    });
  } else form.append(frag(`<div class="sit-foot"><a class="btn btn-primary" href="/courses/c/${slug}" data-link>Back to the course</a></div>`));
  main.append(form);
  app.replaceChildren(main);
}

async function examPage(slug, id) {
  const v = await api(`/api/courses/${slug}/exam/${id}`);
  const c = v.course, x = v.exam, a = v.attempt;
  const offset = Date.parse(v.now) - Date.now();
  document.title = `${x.title} · Teach`;
  const main = el("main", "cx cx-narrow");
  const label = x.practice ? '<span class="tag tag-practice">practice</span>' : x.source === "generated" ? '<span class="tag tag-generated">generated</span>' : '<span class="tag tag-real">real exam</span>';
  main.append(frag(`<header class="cx-head">${crumbs([["Courses", "/courses"], [c.title, `/courses/c/${slug}/exams`], [x.title]])}<div class="cx-eyebrow">${esc(c.code || c.title)} · ${esc(x.kind)}</div><h1 class="cx-title cx-title-sm">${esc(x.title)}${label}</h1></header>`));
  CS.sitting = false;
  if (!a) {
    if (!x.loaded) { main.append(frag(`<div class="empty"><b>Not loaded yet.</b> Load it from the course page. You won't see the questions until you sit it.</div>`)); app.replaceChildren(main); return; }
    const gate = frag(`<section class="sit-gate"><h2>${x.practice ? "A practice version" : "Before you start"}</h2>${x.rules ? `<p class="rules">${esc(x.rules)}</p>` : ""}
      <ul class="terms">${x.practice ? `<li>${icon("check", "icon icon-sm")}<span>Practice: new questions in the exam's format. Retake it as often as you like. It doesn't count.</span></li>`
        : `<li>${icon("check", "icon icon-sm")}<span><b>One sitting.</b> Once you open it, it counts: you can't see it first and you can't retake it.</span></li>`}
        <li>${icon("timer", "icon icon-sm")}<span>${x.minutes} minutes from when you start. It's handed in with what's saved when the time runs out.</span></li>
        <li>${icon("notes", "icon icon-sm")}<span>${x.closedBook ? "Closed book: no notes, readings, lessons or other windows. Leaving the page is noted on the result." : "The course allows its own materials, nothing else."}</span></li>
        <li>${icon("task", "icon icon-sm")}<span>${x.count} questions. Answers save as you go.</span></li></ul>
      <div class="acts">${x.practice ? "" : `<label class="field-row check" style="margin:0"><input type="checkbox" required> <span>I'm ready to sit it now</span></label>`}<button class="btn btn-primary btn-lg" type="button">Start · ${x.minutes} min</button></div></section>`);
    $(".btn-primary", gate).addEventListener("click", async () => {
      const ok = $("input[type=checkbox]", gate);
      if (ok && !ok.checked) return toast("Tick that you're ready: it's one sitting");
      try { await api(`/api/courses/${slug}/exam/${id}`, { op: "start" }); showCourses(location.pathname); } catch (e) { toast(e.message, "red"); }
    });
    main.append(gate);
    app.replaceChildren(main);
    return;
  }
  if (a.state === "in-progress") return examSitting(main, slug, x, a, offset);
  // handed in: the result
  const g = a.grade, s = pct(g);
  main.append(frag(`<div class="score-head">${g ? `<span class="score-big">${s}<small>%</small></span><span class="by">${g.score}/${g.max} points${g.ungraded ? ` · ${g.ungraded} without a key, not counted` : ""}${a.away ? ` · left the page ${a.away} time${a.away === 1 ? "" : "s"}` : ""}</span>` : '<span class="cx-note">Being graded: the written answers go to a grader that isn\'t your tutor.</span>'}</div>`));
  if (a.error) main.append(frag(`<div class="cx-banner" data-tone="warn"><span class="cx-dot"></span><span class="text">${esc(a.error)}</span><span class="acts"><button class="btn btn-sm" type="button" data-regrade>Grade it again</button></span></div>`));
  if (x.practice && a.state === "graded") main.append(frag(`<div class="sit-foot"><button class="btn" type="button" data-retake>Retake this practice</button></div>`));
  const ol = el("ol", "sit-qs");
  (a.questions || []).forEach((q, i) => ol.append(questionCard(q, i, { answer: a.answers[i] || {}, result: a.results?.[i] || null, open: false })));
  main.append(ol);
  $("[data-retake]", main)?.addEventListener("click", async () => { try { await api(`/api/courses/${slug}/exam/${id}`, { op: "start" }); } catch (e) { toast(e.message, "red"); } showCourses(location.pathname); });
  $("[data-regrade]", main)?.addEventListener("click", async () => { try { await api(`/api/courses/${slug}/exam/${id}`, { op: "regrade" }); toast("Grading it again"); } catch (e) { toast(e.message, "red"); } showCourses(location.pathname); });
  app.replaceChildren(main);
}

function examSitting(main, slug, x, a, offset) {
  CS.sitting = true;
  const gen = CS.gen;
  const bar = frag(`<div class="sit-bar"><span class="t">${esc(x.title)}${x.practice ? " · practice" : ""}</span><span class="sit-saved"></span><span class="sit-clock" aria-live="off"></span></div>`);
  const form = el("form");
  const ol = el("ol", "sit-qs");
  (a.questions || []).forEach((q, i) => ol.append(questionCard(q, i, { answer: a.answers[i] || {} })));
  form.append(ol, frag(`<div class="sit-foot"><button class="btn btn-primary btn-lg" type="submit">Hand it in</button><span class="hint">Answers save as you go. Handed in, it's final.</span></div>`));
  main.append(bar, form);
  app.replaceChildren(main);
  let away = false;
  const save = async (extra = {}) => {
    if (gen !== CS.gen) return;
    try { await api(`/api/courses/${slug}/exam/${x.id}`, { op: "save", answers: readAnswers(form, a.questions), ...extra }); $(".sit-saved", bar).textContent = `saved ${clock(Date.now())}`; }
    catch (e) { if (/time's up/.test(e.message)) { CS.sitting = false; toast(e.message); showCourses(location.pathname); } }
  };
  form.addEventListener("input", () => { clearTimeout(CS.saveTimer); CS.saveTimer = setTimeout(save, 1500); });
  form.addEventListener("change", () => { clearTimeout(CS.saveTimer); CS.saveTimer = setTimeout(save, 300); });
  const onVis = () => { if (gen !== CS.gen) return document.removeEventListener("visibilitychange", onVis); if (document.hidden && !away && x.closedBook) { away = true; save({ away: true }); } if (!document.hidden) away = false; };
  document.addEventListener("visibilitychange", onVis);
  const ends = Date.parse(a.ends);
  const tickClock = () => {
    if (gen !== CS.gen) return clearInterval(CS.clock);
    const left = Math.max(0, ends - (Date.now() + offset));
    const m = Math.floor(left / 60e3), s = Math.floor((left % 60e3) / 1000);
    const c = $(".sit-clock", bar);
    c.textContent = `${m}:${String(s).padStart(2, "0")}`;
    c.dataset.low = String(left < 5 * 60e3);
    if (!left) { clearInterval(CS.clock); submit(true); }
  };
  const submit = async (timeUp) => {
    clearInterval(CS.clock);
    try { await api(`/api/courses/${slug}/exam/${x.id}`, { op: "submit", answers: readAnswers(form, a.questions) }); } catch { /* handed in by the server at time */ }
    CS.sitting = false;
    toast(timeUp ? "Time's up: handed in" : "Handed in", "green");
    window.scrollTo(0, 0);
    showCourses(location.pathname);
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); if (confirm("Hand it in? It's final.")) submit(false); });
  tickClock();
  CS.clock = setInterval(tickClock, 1000);
}

// ---------- written work ----------

async function workPage(slug, id) {
  const v = await api(`/api/courses/${slug}/work/${id}`);
  const c = v.course, a = v.assignment, w = v.work;
  document.title = `${a.title} · Teach`;
  const main = el("main", "cx cx-narrow");
  main.append(frag(`<header class="cx-head">${crumbs([["Courses", "/courses"], [c.title, `/courses/c/${slug}/work`], [a.title]])}<div class="cx-eyebrow">${esc(c.code || c.title)} · ${esc(a.kind.replace("-", " "))}${a.length ? ` · ${esc(a.length)}` : ""}</div>
    <h1 class="cx-title cx-title-sm">${esc(a.title)}${a.source === "generated" ? '<span class="tag tag-generated">generated</span>' : ""}</h1></header>`));
  main.append(frag(`<div class="prompt-doc">${md(a.prompt || "")}</div>`));
  if (a.url) main.append(frag(`<p class="cx-note" style="margin-top:8px"><a href="${esc(a.url)}" target="_blank" rel="noreferrer">The assignment on the course's site</a></p>`));
  if (a.rubric?.length) main.append(frag(`<section class="cx-sec"><div class="cx-sec-head"><h2>Rubric</h2>${a.rubricSource ? `<span class="hint">${esc(a.rubricSource)}</span>` : ""}</div>
    <table class="rubric"><thead><tr><th>Criterion</th><th>What it takes</th><th class="pts" style="text-align:right">Points</th></tr></thead><tbody>${a.rubric.map((r) => `<tr><td>${esc(r.criterion)}</td><td>${esc(r.detail)}</td><td class="pts">${r.points}</td></tr>`).join("")}</tbody></table></section>`));
  if (w.state === "graded" || w.state === "grading") {
    main.append(gradedReport(v));
    app.replaceChildren(main);
    return;
  }
  const sec = frag(`<section class="cx-sec"><div class="cx-sec-head"><h2>Your ${a.questions ? "answers" : "paper"}</h2><span class="hint">saves as you type · one graded submission</span></div></section>`);
  const form = el("form");
  let getBody;
  if (a.questions) {
    const ol = el("ol", "sit-qs");
    a.questions.forEach((q, i) => ol.append(questionCard(q, i, { answer: v.answers[i] || {} })));
    form.append(ol);
    getBody = () => ({ answers: readAnswers(form, a.questions) });
  } else {
    const wr = frag(`<div class="writer"><textarea class="field" placeholder="Write it here. Markdown works." aria-label="Your paper"></textarea></div>`);
    $("textarea", wr).value = v.text;
    form.append(wr);
    getBody = () => ({ text: $("textarea", form).value });
  }
  const bar = frag(`<div class="writer-bar"><span class="meta"></span><span class="end"><button class="btn btn-primary" type="submit">Submit for grading</button></span></div>`);
  form.append(bar);
  if (w.error) form.append(frag(`<p class="cx-note bad" style="margin-top:8px">${esc(w.error)}</p>`));
  const meta = $(".meta", bar);
  const words = () => (a.questions ? "" : `${(($("textarea", form)?.value || "").match(/\S+/g) || []).length} words`);
  meta.textContent = [words(), w.saved ? `saved ${ago(w.saved)}` : ""].filter(Boolean).join(" · ");
  const save = async () => { try { await api(`/api/courses/${slug}/work/${id}`, { op: "save", ...getBody() }); meta.textContent = [words(), "saved"].filter(Boolean).join(" · "); } catch (e) { meta.textContent = e.message; } };
  form.addEventListener("input", () => { meta.textContent = [words(), "…"].filter(Boolean).join(" · "); clearTimeout(CS.saveTimer); CS.saveTimer = setTimeout(save, 1200); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!confirm("Submit it for grading? This is the one graded submission: a grader that isn't your tutor marks it against the rubric.")) return;
    clearTimeout(CS.saveTimer);
    try { await api(`/api/courses/${slug}/work/${id}`, { op: "submit", ...getBody() }); toast("Submitted: being graded"); showCourses(location.pathname); } catch (err) { toast(err.message, "red"); }
  });
  sec.append(form);
  main.append(sec);
  app.replaceChildren(main);
}

function gradedReport(v) {
  const w = v.work, g = w.grade, a = v.assignment;
  const sec = el("section", "cx-sec");
  if (!g) {
    const b = frag(w.error ? `<div class="cx-banner" data-tone="warn"><span class="cx-dot"></span><span class="text">${esc(w.error)}</span><span class="acts"><button class="btn btn-sm" type="button">Grade it again</button></span></div>`
      : `<div class="cx-banner" data-tone="wait"><span class="cx-dot"></span><span class="text"><b>Being graded.</b> A grader that never saw your lessons marks it against the rubric, the way the course's own TA would.</span></div>`);
    $("button", b)?.addEventListener("click", async () => { try { await api(`/api/courses/${v.course.slug}/work/${a.id}`, { op: "regrade" }); toast("Grading it again"); } catch (e) { toast(e.message, "red"); } showCourses(location.pathname); });
    sec.append(b);
    return sec;
  }
  sec.append(frag(`<div class="score-head"><span class="score-big">${pct(g)}<small>%</small></span>${g.letter ? `<span class="letter">${esc(g.letter)}</span>` : ""}<span class="by">${g.score}/${g.max} · graded ${ago(g.at)}</span></div>`));
  if (g.summary) sec.append(frag(`<p class="prompt-doc">${esc(g.summary)}</p>`));
  if (g.criteria?.length) sec.append(frag(`<table class="rubric" style="margin-top:16px"><thead><tr><th>Criterion</th><th>Comment</th><th class="pts" style="text-align:right">Score</th></tr></thead><tbody>${g.criteria.map((c) => `<tr><td>${esc(c.criterion)}</td><td>${esc(c.comment)}</td><td class="pts">${c.points}/${c.max}</td></tr>`).join("")}</tbody></table>`));
  if (g.problems?.length) {
    const f = frag(`<div class="cx-sec"><h2>What to fix</h2><div class="feedback"></div></div>`);
    for (const p of g.problems) $(".feedback", f).append(frag(`<div>${p.quote ? `<blockquote class="quote">${esc(p.quote)}</blockquote>` : ""}<p class="issue"><b>${esc(p.issue)}</b>${p.fix ? ` ${esc(p.fix)}` : ""}</p></div>`));
    sec.append(f);
  }
  if (g.strengths?.length) sec.append(frag(`<div class="cx-sec"><h2>What works</h2><ul class="cx-note">${g.strengths.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>`));
  if (a.questions && v.results) {
    const ol = el("ol", "sit-qs");
    a.questions.forEach((q, i) => ol.append(questionCard(q, i, { answer: v.answers[i] || {}, result: v.results[i], open: false })));
    sec.append(ol);
  }
  if (!a.questions) sec.append(frag(`<details class="fold" style="margin-top:22px"><summary>What you handed in</summary><div class="prompt-doc">${md(v.text)}</div></details>`));
  return sec;
}
