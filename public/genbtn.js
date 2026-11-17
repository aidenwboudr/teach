"use strict";
// The generate button (public/genbtn.css has the look): one control for everything Teach makes only when asked.
// Nothing runs until it's clicked; while it runs, a click pauses it (the caller stops the model for real) and the next
// click resumes; once it's made, a click opens what it made. Loaded before app.js; no dependencies.
//
//   const g = genButton(el, { title, sub, glyph, size: "sm", onGenerate, onPause, onResume, onOpen, onRetry })
//   g.set("working", { sub: "Writing problem 3 of 8" })       // idle | queued | working | paused | ready | failed
//
// `el` is a <button> (made into button.gen) or any element (a button.gen is put inside it). `glyph` is an icon id
// from the page's sprite (#i-…) or raw <svg> markup. Hints (the small line that says what a click does) default per
// state; pass `hints: { idle: "Visualize it" }` to change one.
const GEN_HINTS = { idle: "Generate", queued: "Waiting · Pause", working: "Generating · Pause", paused: "Paused · Resume", ready: "Open", failed: "Try again" };

function genButton(el, o = {}) {
  const btn = el.tagName === "BUTTON" ? el : el.appendChild(document.createElement("button"));
  btn.type = "button";
  btn.classList.add("gen");
  if (o.size === "sm") btn.classList.add("gen-sm");
  const glyph = !o.glyph ? "" : o.glyph.trim().startsWith("<") ? o.glyph : `<svg aria-hidden="true"><use href="#${o.glyph.replace(/^#/, "")}"/></svg>`;
  btn.innerHTML = `<span class="gen-glyph">${glyph}</span><span class="gen-text"><span class="gen-title"></span><span class="gen-sub"></span></span><span class="gen-hint"></span>`;
  const st = { state: "idle", title: o.title || "", sub: o.sub || "", hint: null };
  const hints = { ...GEN_HINTS, ...(o.hints || {}) };
  const paint = () => {
    btn.dataset.state = st.state;
    btn.querySelector(".gen-title").textContent = st.title;
    const sub = btn.querySelector(".gen-sub");
    sub.textContent = st.sub;
    sub.hidden = !st.sub;
    btn.querySelector(".gen-hint").textContent = st.hint || hints[st.state] || "";
    btn.setAttribute("aria-busy", String(st.state === "working" || st.state === "queued"));
    btn.setAttribute("aria-label", `${st.title}${st.sub ? `: ${st.sub}` : ""}. ${st.hint || hints[st.state] || ""}`);
  };
  let busy = false;   // one click at a time: a slow request doesn't get sent twice
  btn.addEventListener("click", async (e) => {
    if (busy) return;
    const fn = { idle: o.onGenerate, failed: o.onRetry || o.onGenerate, queued: o.onPause, working: o.onPause, paused: o.onResume, ready: o.onOpen }[st.state];
    if (!fn) return;
    busy = true;
    try { await fn(e, api); } finally { busy = false; }
  });
  const api = {
    el: btn,
    get state() { return st.state; },
    // state, plus any of { title, sub, hint } (hint: null goes back to the state's default)
    set(state, patch = {}) {
      if (state) st.state = state;
      for (const k of ["title", "sub", "hint"]) if (k in patch) st[k] = patch[k];
      paint();
      return api;
    },
  };
  paint();
  return api;
}
