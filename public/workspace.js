"use strict";
// The lesson as a workspace (design/workspace/DIRECTION.md): a step card on top (the one thing the tutor is
// waiting for), a focus area under it (the stage with a chalk scene, the question card that's waiting), the
// lesson itself below as a quiet caption trail, and the plan on the right. One breathing dot says what the
// tutor is doing; a pill says where Super+/ goes. Loaded before app.js and uses its helpers ($, el, frag, api,
// md, T…) at call time.

const W = { stage: null, said: null, saidUntil: 0, plan: null, tick: null, sendQ: [], sending: false };

// ---------- mounting ----------

// Called by mountLesson: the step card and focus area go above the lesson stream.
function wsMount(shell, stream) {
  (shell.matches(".lesson") ? shell : $(".lesson", shell))?.classList.add("ws");
  stream.prepend(frag(`<div class="ws-top"><section class="ws-step" aria-live="polite"></section><div class="ws-focus"></div></div>`));
  const head = $(".lesson-head .acts", shell);
  head?.prepend(frag(`<div class="ws-status"><span class="link-pill" hidden></span><span class="tutor" data-state="waiting"><i></i><span class="word">your move</span></span></div>`));
  Object.assign(W, { stage: null, said: null, saidUntil: 0, plan: (T.data.topic.plan || []).map((n) => n.status) });
  $(".stream-inner", stream).addEventListener("scroll", () => {
    const s = $(".stream-inner");
    if (s && wsScrolls()) stick.on = s.scrollHeight - s.scrollTop - s.clientHeight < 140;
  }, { passive: true });
  clearInterval(W.tick);
  W.tick = setInterval(() => { if (page === "topic" && T.tab === "lesson") wsPaint(); else clearInterval(W.tick); }, 1000);
}

// Wide windows scroll the trail inside the workspace; phones scroll the page.
const wsScrolls = () => { const s = $(".lesson.ws .stream-inner"); return !!s && getComputedStyle(s).overflowY === "auto"; };

// ---------- the tutor's state and the step card ----------

function tutorState() {
  const st = T.status || {};
  if (Date.now() < W.saidUntil) return ["speaking", "speaking"];
  if (st.watching != null) return ["watching", "watching your screen"];
  if (st.busy) return ["thinking", "thinking"];
  if (W.stage?.gate != null) return ["waiting", "your prediction"];
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
  const pending = [...T.items.values()].find((x) => x.form && x.it?.status === "pending");
  const doing = st.watching ? `Your turn: ${mdi(st.watching)}`
    : W.stage?.gate != null ? "Make your prediction on the stage, then it plays."
    : pending ? "Answer the card below."
    : W.said ? esc(W.said)
    : cur?.detail ? mdi(cur.detail) : "";
  const [state, word] = tutorState();
  const key = [n, cur?.title, doing, state].join("|");
  if (box.dataset.key === key) return;
  const fresh = box.dataset.n !== String(n);
  box.dataset.key = key; box.dataset.n = String(n);
  const inner = html`
    <div class="ws-step-head"><span>${plan.length ? `Step ${n || plan.filter((x) => x.status === "done").length} of ${plan.length}` : esc(t.phase || "starting")}</span>${plan.length ? meter(plan.map((x) => x.status)) : ""}</div>
    <h2 class="ws-step-title">${cur ? mdi(cur.title) : esc(t.title)}</h2>
    ${doing ? `<p class="ws-step-do">${doing}</p>` : ""}
    <div class="ws-step-wait"><span class="tutor" data-state="${state}"><i></i><span class="word">${word}</span></span></div>`;
  // a new step crossfades in place; small changes (what it's waiting for) just repaint
  if (fresh && box.firstElementChild) {
    box.classList.add("is-fading");
    setTimeout(() => { box.innerHTML = inner; box.classList.remove("is-fading"); }, 220);
  } else box.innerHTML = inner;
}

// A spoken line: it leads the step card while it plays (Kokoro runs ~2.7 words a second, ~1 s to the first sound).
function wsSaid(ev) {
  if (!ev.said || !ev.text) return;
  W.said = String(ev.text);
  W.saidUntil = Date.now() + (1 + W.said.split(/\s+/).length / 2.7) * 1000;
  wsPaint();
}

// The plan changed: a tiny toast names what happened to a step.
function wsPlanChanged() {
  const plan = T.data.topic.plan || [], now = plan.map((n) => n.status), before = W.plan || [];
  W.plan = now;
  const done = now.filter((s) => s === "done").length;
  plan.forEach((n, i) => {
    if (before.length !== now.length || before[i] === now[i]) return;
    if (now[i] === "done") toast(`Step ${i + 1} done · ${done} of ${plan.length}`, "green");
    else if (now[i] === "shaky") toast(`Step ${i + 1} marked shaky · we'll come back`, "gold");
  });
  wsPaint();
}

// ---------- the focus area: what's waiting on them ----------

// A question card waiting for them sits in the focus area; once answered it goes back to its place in the trail.
// Only while the workspace fits the window: on a phone the page scrolls and the trail ends at the composer, so the
// card stays there instead of jumping above the whole lesson.
function wsPlaceAsk(card) {
  const focus = $(".ws-focus");
  if (!focus || !card.el) return;
  if (!card.home) { card.home = el("div", "ask-home"); card.el.after(card.home); }
  const waiting = card.it.status === "pending" && wsScrolls();
  if (waiting && card.el.parentNode !== focus) {
    for (const other of T.items.values()) if (other !== card && other.form && other.el.parentNode === focus) other.home?.before(other.el);
    focus.append(card.el);
    wsFocusShape();
    // stacked under a scene, the focus area scrolls: start it at the card
    requestAnimationFrame(() => {
      if (card.el.parentNode !== focus || getComputedStyle(focus).overflowY !== "auto") return;
      focus.scrollTop += card.el.getBoundingClientRect().top - focus.getBoundingClientRect().top;
    });
  } else if (!waiting && card.el.parentNode === focus) {
    card.el.classList.add("is-fading");
    setTimeout(() => { card.home.before(card.el); card.el.classList.remove("is-fading"); wsFocusShape(); scrollDown(); }, 220);
  }
  paintStep();
}

// A scene and a waiting card up together: wide windows put them side by side, narrower ones stack them in a
// focus area that scrolls (workspace.css, .has-stage.has-ask).
function wsFocusShape() {
  $(".lesson.ws")?.classList.toggle("has-ask", !!$(".ws-focus > .msg"));
}

// The window crossed between fitting the workspace and scrolling the page: put a waiting card where it belongs.
let wsFitted = null;
window.addEventListener("resize", () => {
  const now = wsScrolls();
  if (now === wsFitted) return;
  wsFitted = now;
  if ($(".lesson.ws")) for (const card of T.items.values()) if (card.form) wsPlaceAsk(card);
}, { passive: true });

// ---------- the stage ----------

// A scene from the tutor (live or from the history): the newest one is on the stage; older ones leave a line in
// the trail that puts them back.
function wsScene(it, past) {
  const title = it.scene?.title || "Scene";
  const line = frag(`<div class="status scene-line"><button class="status-chip" type="button">${icon("open", "icon icon-sm")}${esc(title)}<span class="on-stage"> · on the stage</span></button></div>`);
  line.dataset.id = it.id;
  $("button", line).addEventListener("click", () => { const x = T.items.get(it.id); if (x) stageOpen(x.it); });
  append(line, "scene");
  T.items.set(it.id, { el: line, it, scene: true });
  if (it.scene?.replaces && W.stage?.id === it.scene.replaces) { W.stage.it = it; line.hidden = true; return; }   // it morphs in place
  stageOpen(it, past);
}

function stageOpen(it, past) {
  const focus = $(".ws-focus");
  if (!focus) return;
  $(".stage", focus)?.remove();
  for (const l of $$(".scene-line")) l.classList.toggle("is-on", l.dataset.id === it.id);
  const s = frag(html`
    <section class="stage" aria-label="${esc(it.scene?.title || "Scene")}">
      <div class="stage-canvas" tabindex="0"><img alt="${esc(it.scene?.title || "scene")}" draggable="false" hidden><p class="stage-wait">Setting up the scene…</p></div>
      <aside class="predict" hidden></aside>
    </section>`);
  focus.prepend(s);
  $(".lesson.ws")?.classList.add("has-stage");
  W.stage = { id: it.id, it, el: s, seq: 0, w: 0, h: 0, step: 0, gate: null, sent: new Map(), lat: [], inSeq: 0 };
  wireStage(s);
  paintPredict();
  if (past) api(`/api/topics/${T.slug}/stage`, { op: "open", id: it.id }).catch((e) => { $(".stage-wait", s).textContent = e.message; });
}

function wireStage(s) {
  const canvas = $(".stage-canvas", s), img = $("img", canvas);
  const at = (e) => {
    const r = img.getBoundingClientRect();
    return { x: Math.round((e.clientX - r.left) * (W.stage.w / r.width) * 10) / 10, y: Math.round((e.clientY - r.top) * (W.stage.h / r.height) * 10) / 10 };
  };
  canvas.addEventListener("pointerdown", (e) => { if (e.button) return; canvas.setPointerCapture(e.pointerId); canvas.focus({ focusVisible: false }); stageSend({ op: "pointer", t: "down", ...at(e) }); });
  canvas.addEventListener("pointermove", (e) => stageSend({ op: "pointer", t: "move", ...at(e) }));
  canvas.addEventListener("pointerup", (e) => stageSend({ op: "pointer", t: "up", ...at(e) }));
  canvas.addEventListener("pointerleave", () => stageSend({ op: "pointer", t: "leave", x: 0, y: 0 }));
  canvas.addEventListener("keydown", (e) => {
    const key = { ArrowRight: "Right", ArrowLeft: "Left", Enter: "Return", " ": "space" }[e.key];
    if (!key) return;
    e.preventDefault();
    stageSend({ op: "key", name: key, char: e.key.length === 1 ? e.key : "" });
  });
}

// Their input, in order, one request at a time; moves that pile up while one is in flight merge into the newest.
function stageSend(m) {
  const st = W.stage;
  if (!st) return;
  const last = W.sendQ.at(-1);
  if (m.op === "pointer" && m.t === "move" && last?.op === "pointer" && last.t === "move") W.sendQ.pop();
  m.id = st.id; m.seq = ++st.inSeq;
  st.sent.set(m.seq, performance.now());
  W.sendQ.push(m);
  if (!W.sending) stagePump();
}
async function stagePump() {
  W.sending = true;
  while (W.sendQ.length) {
    const m = W.sendQ.shift();
    try { await api(`/api/topics/${T.slug}/stage`, m); } catch { /* the scene went away */ }
  }
  W.sending = false;
}

function wsStageEvent(ev) {
  const st = W.stage;
  if (!st || ev.id !== st.id) return;
  if (ev.kind === "frame") {
    if (ev.seq <= st.seq) return;
    st.seq = ev.seq; st.w = ev.w; st.h = ev.h;
    const img = $("img", st.el);
    img.src = `data:image/png;base64,${ev.png}`;
    img.style.maxWidth = `${ev.w}px`;
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
    paintPredict();
  } else if (ev.kind === "gate") {
    st.gate = ev.step;
    paintPredict(true);
    wsPaint();
  } else if (ev.kind === "closed") {
    st.el.classList.add("is-fading");
    setTimeout(() => { st.el.remove(); }, 220);
    for (const l of $$(".scene-line")) l.classList.remove("is-on");
    $(".lesson.ws")?.classList.remove("has-stage");
    W.stage = null;
    toast("Scene closed · it's still in the lesson", "blue");
  } else if (ev.kind === "error") {
    const p = $(".stage-wait", st.el) || $(".stage-canvas", st.el).appendChild(el("p", "stage-wait"));
    p.textContent = `The scene hit a problem: ${ev.error}`;
  }
}

// ---------- predict, then reveal ----------

// The next prediction they owes: the gate on the step after the one showing, not yet committed.
function nextPrediction() {
  const st = W.stage, preds = st?.it.scene?.predict || [];
  const made = st?.it.predictions || {};
  return preds.find((p) => p.step > st.step && !made[p.step]) || null;
}

function paintPredict(nudge) {
  const st = W.stage;
  if (!st) return;
  const box = $(".predict", st.el);
  const made = st.it.predictions || {};
  const shown = st.result && made[st.result.step];
  const q = nextPrediction();
  if (!q && !shown) { box.hidden = true; return; }
  box.hidden = false;
  if (shown && (!q || st.result.until > Date.now())) {
    const r = made[st.result.step];
    box.dataset.state = r.result.ok === false ? "wrong" : "right";
    box.innerHTML = html`<div class="p-head"><span>Predict, then I reveal</span></div>
      <p class="p-verdict">${r.result.ok === true ? "Right." : r.result.ok === false ? "Not quite." : "Committed."}</p>
      <p class="p-mine">You said ${esc(r.result.text.replace(/ \((correct|wrong[^)]*)\)$/, ""))}</p>
      ${st.result.why ? `<div class="p-why prose">${md(st.result.why)}</div>` : ""}`;
    if (q) setTimeout(() => paintPredict(), Math.max(0, st.result.until - Date.now()) + 50);
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
  const setPick = (v) => { st.pick = { step: q.step, value: v }; paintPredict(); };
  $$(".choice", box).forEach((b) => b.addEventListener("click", () => setPick(Number(b.dataset.i))));
  const inp = $("input", box);
  if (inp) {
    inp.addEventListener("input", () => { st.pick = { step: q.step, value: inp.value }; $(".p-foot .btn", box).disabled = !inp.value.trim(); });
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") commitPrediction(q); });
  }
  $(".p-foot .btn", box).addEventListener("click", () => commitPrediction(q));
  box.onkeydown = (e) => {
    if (q.kind === "choice" && /^[1-9]$/.test(e.key) && q.options[+e.key - 1] !== undefined) setPick(+e.key - 1);
    if (e.key === "Enter" && st.pick?.step === q.step) commitPrediction(q);
  };
}

async function commitPrediction(q) {
  const st = W.stage;
  if (!st || st.pick?.step !== q.step || st.committing) return;
  const answer = q.kind === "choice" ? { choice: st.pick.value } : { value: String(st.pick.value).trim() };
  st.committing = true;
  try { await api(`/api/topics/${T.slug}/stage`, { op: "predict", id: st.id, step: q.step, answer }); }
  catch (e) { toast(e.message, "red"); }
  st.committing = false;
}

function wsPredicted(ev) {
  const x = T.items.get(ev.id);
  if (x?.it) x.it.predictions = { ...(x.it.predictions || {}), [ev.step]: { answer: ev.answer, result: ev.result } };
  const st = W.stage;
  if (!st || st.id !== ev.id) return;
  st.it.predictions = x?.it.predictions || { ...(st.it.predictions || {}), [ev.step]: { answer: ev.answer, result: ev.result } };
  st.gate = null; st.pick = null;
  st.result = { step: ev.step, why: ev.why, until: Date.now() + 9000 };
  paintPredict();
  wsPaint();
}
