// Voice in the Teach window: narration (the tutor read out loud) and voice input (they answer out loud). The server's
// half is lib/voice.mjs: the switches, speech to text, the voice, and what a spoken answer means for the card.
//
// Three switches, any combination: On my screen (where the lesson is), Narrate (read out loud: in this window on the
// board, through chalk on their screen), Voice (the microphone). The page listens only while a lesson is open and
// only on one device at a time (the one that turned it on, or opened last with it on). It never listens while the
// tutor is speaking (its own narration here, or `say` on their computer), so the tutor's voice coming out of the
// speakers isn't taken for theirs: half duplex, the way a walkie-talkie takes turns.

const VOICE = {
  id: (globalThis.crypto?.randomUUID?.() || String(Math.random()).slice(2)).slice(0, 36),
  s: { narrate: { board: false, screen: true }, mic: false, stt: false, tts: false, holder: null, speaking: false },
  state: "off",          // the mic: off · starting · listening · hearing · thinking · paused · elsewhere · denied · error
  why: "",               // (denied / error: what went wrong, for the chip's title)
  level: 0,
  cap: null,             // the capture: { stream, ctx, node, rate }
  vad: null,
  sending: 0,
  serverUntil: 0,        // the tutor's say is playing on their computer until then
  say: { queue: [], audio: null, busy: false, gen: 0, until: 0 },   // busy: the generation playing, or false
};

// ---------- the switches ----------

const voicePlace = () => (T.data?.topic?.settings?.screen || T.data?.live ? "screen" : "board");
const voiceInLesson = () => typeof page !== "undefined" && page === "topic" && T.tab === "lesson" && !!$(".dock");

function voiceEvent(ev) {
  if (ev.t === "voice") {
    const was = VOICE.s;
    VOICE.s = { ...VOICE.s, ...ev.voice };
    if (!VOICE.s.narrate[voicePlace()] && was.narrate[voicePlace()]) voiceHush();
    voiceSync();
  }
  if (ev.t === "speaking") {
    // until the server says the last line ended (+0.5 s for its tail); 120 s is only a backstop for a lost "off"
    VOICE.serverUntil = ev.on ? Date.now() + 120e3 : Date.now() + 500;
    voicePaint();
  }
}

async function voiceSet(patch) {
  try {
    const r = await api("/api/voice", { ...patch, topic: T.slug, client: VOICE.id });
    VOICE.s = { ...VOICE.s, ...r.voice };
  } catch (e) { toast(`Couldn't switch: ${e.message}`, "red"); }
  voiceSync();
}

function voiceToggleNarrate() {
  const place = voicePlace(), on = !VOICE.s.narrate[place];
  if (!on) voiceHush();
  voiceSet({ narrate: { [place]: on } });
  toast(on ? (place === "board" ? "Narration on: the tutor's replies are read out loud here" : "Narration on: the tutor talks out loud on your screen")
    : (place === "board" ? "Narration off: replies are text only" : "Narration off: the tutor writes on your screen instead of talking"));
}

function voiceToggleMic() {
  if (!VOICE.s.stt) { toast("Voice input needs speech-to-text on the server (TEACH_STT_CMD)", "gold"); return; }
  if (VOICE.state === "click") return;   // that click was what the browser waited for: it starts listening now
  if (VOICE.state === "denied" || VOICE.state === "error") { VOICE.state = "off"; if (VOICE.s.mic) return voiceSync(); }   // try again
  const on = !(VOICE.s.mic && VOICE.s.holder === VOICE.id);
  if (on && VOICE.s.mic && VOICE.s.holder && VOICE.s.holder !== VOICE.id) {   // on elsewhere: listen here instead
    api("/api/voice/claim", { client: VOICE.id }).then(() => { VOICE.s.holder = VOICE.id; voiceSync(); }).catch(() => {});
    return;
  }
  voiceSet({ mic: on });
  if (!on) toast("Not listening");
}

// This page listens from now on (the one he's using: it opened the lesson, or he came back to it).
function voiceClaim() {
  if (!VOICE.s.mic || !VOICE.s.stt || !voiceInLesson() || VOICE.s.holder === VOICE.id) return;
  VOICE.s.holder = VOICE.id;
  api("/api/voice/claim", { client: VOICE.id }).catch(() => {});
  voiceSync();
}
window.addEventListener("focus", voiceClaim);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && document.hasFocus()) voiceClaim(); });

// Start or stop the capture to match the switches and the page; then paint.
function voiceSync() {
  const want = VOICE.s.mic && VOICE.s.stt && voiceInLesson();
  if (want && !VOICE.s.holder) api("/api/voice/claim", { client: VOICE.id }).catch(() => {});   // nobody listens: this page does
  // this page left the lesson (home, review…): it stops listening, and the other device may take the mic
  if (!voiceInLesson() && VOICE.s.mic && VOICE.s.holder === VOICE.id) { VOICE.s.holder = null; api("/api/voice/claim", { client: VOICE.id, release: true }).catch(() => {}); }
  const mine = want && (VOICE.s.holder === VOICE.id || !VOICE.s.holder);
  if (mine && !VOICE.cap && !["starting", "denied", "error"].includes(VOICE.state)) voiceStart();   // (a failed start waits for a click on the chip)
  if (!mine && VOICE.cap) voiceStop();
  if (!want) VOICE.state = "off";
  else if (!mine) VOICE.state = "elsewhere";
  voicePaint();
}

// ---------- the chips in the dock ----------

function voiceChips() {
  return `<button class="chip voice-chip narrate-chip" type="button" aria-pressed="false" data-voice="narrate">${icon("speaker", "icon icon-sm")}<span>Narrate</span></button>
    <button class="chip voice-chip mic-chip" type="button" aria-pressed="false" data-voice="mic" data-state="off">${icon("mic", "icon icon-sm")}<span class="mic-word">Voice</span><span class="mic-level" aria-hidden="true"><i></i><i></i><i></i></span></button>
    <span class="quick-sep" aria-hidden="true"></span>`;
}

function voiceWire(root) {
  $("[data-voice=narrate]", root)?.addEventListener("click", voiceToggleNarrate);
  $("[data-voice=mic]", root)?.addEventListener("click", voiceToggleMic);
}

const MIC_WORD = { off: "Voice", starting: "Starting mic…", listening: "Listening", hearing: "Hearing you", thinking: "Writing it down…", paused: "Tutor talking",
  elsewhere: "Listening on your other device", denied: "Mic blocked", error: "Mic error", click: "Click to listen" };
const MIC_TITLE = {
  off: "Answer out loud: the microphone listens, and what you say becomes your message or your answer to the card (M)",
  listening: "Listening. Say your answer, or “stop listening”. Click or press M to mute.",
  hearing: "Hearing you: it sends when you pause. Click or press M to mute.",
  thinking: "Turning what you said into text", paused: "Not listening while the tutor talks, so its voice isn't taken for yours",
  elsewhere: "The mic is on in Teach on another device. Click to listen here instead.",
  click: "The browser starts the mic once you click or press a key in Teach",
};

function voicePaint() {
  const n = $(".narrate-chip"), m = $(".mic-chip");
  if (n) {
    const place = voicePlace(), on = !!VOICE.s.narrate[place];
    n.setAttribute("aria-pressed", String(on));
    n.title = place === "board"
      ? (on ? "The tutor's replies are read out loud here. Click to stop (N)." : "Read the tutor's replies out loud here (N)")
      : (on ? "The tutor talks out loud on your screen. Click to have it write instead (N)." : "The tutor writes on your screen. Click to have it talk (N).");
  }
  if (m) {
    let st = VOICE.state;
    if (VOICE.cap && voiceGated() && ["listening", "hearing"].includes(st)) st = "paused";
    m.dataset.state = st;
    m.setAttribute("aria-pressed", String(!["off", "denied"].includes(st)));
    $(".mic-word", m).textContent = MIC_WORD[st] || "Voice";
    m.title = (st === "denied" || st === "error") ? `${VOICE.why || "The microphone didn't start"}. Click to try again.` : MIC_TITLE[st] || MIC_TITLE.off;
    m.hidden = !VOICE.s.stt;
    m.style.setProperty("--level", String(Math.min(1, VOICE.level * 14).toFixed(2)));
  }
}

// ---------- listening ----------

const FRAME_MS = 20, PRE_FRAMES = 15, START_FRAMES = 5, END_MS = 1200, MAX_MS = 30e3, MIN_SPEECH = 12;

// Not now: the tutor is talking (here, or on their computer), or a clip is being written down for the card.
const voiceGated = () => VOICE.say.busy !== false || Date.now() < VOICE.say.until || Date.now() < VOICE.serverUntil;

async function voiceStart() {
  VOICE.state = "starting"; VOICE.why = ""; voicePaint();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const ctx = new AudioContext();
    const code = `class Tap extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(Math.round(sampleRate * ${FRAME_MS} / 1000)); this.n = 0; }
      process(inputs) { const ch = inputs[0] && inputs[0][0]; if (!ch) return true;
        for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; } }
        return true; } }
      registerProcessor("teach-tap", Tap);`;
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = ctx.createMediaStreamSource(stream), node = new AudioWorkletNode(ctx, "teach-tap");
    src.connect(node);
    node.port.onmessage = (e) => voiceFrame(e.data);
    if (!VOICE.s.mic || !voiceInLesson()) { stream.getTracks().forEach((t) => t.stop()); ctx.close(); VOICE.state = "off"; return voicePaint(); }   // switched off meanwhile
    VOICE.cap = { stream, ctx, node, rate: ctx.sampleRate };
    VOICE.vad = { floor: 0.004, ring: [], speech: [], talking: false, silent: 0, voiced: 0, recent: [] };
    VOICE.state = "listening";
    // A page that opened with the mic already on hasn't been clicked yet, and the browser keeps its audio paused
    // until it is: say so on the chip, and start on the first click or key.
    if (ctx.state === "suspended") await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
    if (ctx.state === "suspended") {
      VOICE.state = "click";
      const go = () => { ctx.resume().then(() => { if (VOICE.cap?.ctx === ctx) { VOICE.state = "listening"; voicePaint(); } }); };
      for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, go, { once: true, capture: true });
    }
    stream.getAudioTracks()[0]?.addEventListener("ended", () => { voiceStop(); VOICE.state = "error"; VOICE.why = "The microphone went away"; voicePaint(); });
  } catch (e) {
    VOICE.cap = null;
    VOICE.state = e.name === "NotAllowedError" ? "denied" : "error";
    VOICE.why = e.name === "NotAllowedError" ? "The browser blocked the microphone: allow it for Teach (the icon in the address bar or the site settings)" : String(e.message || e);
    toast(VOICE.state === "denied" ? "Mic blocked: allow the microphone for Teach, then click Voice" : `Mic didn't start: ${VOICE.why}`, "red");
  }
  voicePaint();
}

function voiceStop() {
  const c = VOICE.cap;
  VOICE.cap = null; VOICE.vad = null; VOICE.level = 0;
  if (c) { try { c.node.port.onmessage = null; c.stream.getTracks().forEach((t) => t.stop()); c.ctx.close(); } catch { /* gone */ } }
  if (!["denied", "error"].includes(VOICE.state)) VOICE.state = "off";
  voicePaint();
}

// One 20 ms frame: track the room's noise floor, find where speech starts and stops, keep the frames in between.
let voicePainted = 0;
function voiceFrame(f) {
  const v = VOICE.vad;
  if (!v) return;
  let e = 0;
  for (let i = 0; i < f.length; i++) e += f[i] * f[i];
  const rms = Math.sqrt(e / f.length);
  VOICE.level = VOICE.level * 0.7 + rms * 0.3;
  if (Date.now() - voicePainted > 120) { voicePainted = Date.now(); voicePaint(); }
  if (voiceGated()) {   // the tutor is talking: nothing heard now counts, and a half-heard turn is dropped
    if (v.talking) { v.talking = false; v.speech = []; }
    v.ring = []; v.recent = [];
    return;
  }
  if (!v.talking) v.floor = rms < v.floor ? v.floor * 0.9 + rms * 0.1 : v.floor * 0.998 + rms * 0.002;
  const loud = rms > Math.max(0.008, v.floor * 3);
  v.recent.push(loud); if (v.recent.length > 8) v.recent.shift();
  if (!v.talking) {
    v.ring.push(f); if (v.ring.length > PRE_FRAMES) v.ring.shift();
    if (v.recent.filter(Boolean).length >= START_FRAMES) {
      v.talking = true; v.speech = v.ring.slice(); v.ring = []; v.silent = 0; v.voiced = START_FRAMES;
      VOICE.state = "hearing"; voicePaint();
    }
    return;
  }
  v.speech.push(f);
  if (loud) { v.voiced++; v.silent = 0; } else v.silent++;
  const ms = v.speech.length * FRAME_MS;
  if (v.silent * FRAME_MS >= END_MS || ms >= MAX_MS) {
    const frames = v.speech, voiced = v.voiced;
    if (ms >= MAX_MS) {   // no pause in 30 s: a fan or a TV, likely. The floor rises to it, so the next turn has to be louder
      const r = frames.map((f) => { let e = 0; for (let i = 0; i < f.length; i++) e += f[i] * f[i]; return Math.sqrt(e / f.length); }).sort((a, b) => a - b);
      v.floor = Math.max(v.floor, r[Math.floor(r.length / 2)] * 1.1);
    }
    v.talking = false; v.speech = []; v.recent = [];
    VOICE.state = "listening";
    if (voiced >= MIN_SPEECH) voiceSend(frames); else voicePaint();
  }
}

// Frames at the capture's rate -> a 16 kHz mono 16-bit WAV.
function voiceWav(frames, rate) {
  const n = frames.reduce((a, f) => a + f.length, 0), all = new Float32Array(n);
  let o = 0; for (const f of frames) { all.set(f, o); o += f.length; }
  const ratio = rate / 16000, len = Math.floor(n / ratio), pcm = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const a = Math.floor(i * ratio), b = Math.min(n, Math.floor((i + 1) * ratio));
    let s = 0; for (let k = a; k < b; k++) s += all[k];
    const x = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
    pcm[i] = x < 0 ? x * 32768 : x * 32767;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf);
  const w = (p, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i)); };
  w(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

// The question the card in front of them is on: the one they last touched, else the first not answered yet.
function voiceFocus(card) {
  if (!card) return 0;
  const qs = card.it.ask.questions;
  if (card.focus != null && !isAnswered(card.answers[card.focus]) && qs[card.focus]?.kind !== "order") return card.focus;
  const i = qs.findIndex((q, k) => q.kind !== "order" && !isAnswered(card.answers[k]));
  return i < 0 ? 0 : i;
}

// Clips go one at a time: the next is read against the card as the one before left it ("two" … "three" on a
// two-question card answers both questions, not the first one twice).
let voiceChain = Promise.resolve();
function voiceSend(frames) {
  if (!VOICE.cap) return;
  const wav = voiceWav(frames, VOICE.cap.rate);
  VOICE.sending++; VOICE.state = "thinking"; voicePaint();
  voiceChain = voiceChain.then(() => voiceHear(wav)).catch(() => {});
}

async function voiceHear(wav) {
  const slug = T.slug, card = boardPendingCard(), focus = voiceFocus(card);
  let r;
  try {
    const q = new URLSearchParams({ topic: slug, focus: String(focus), ...(card ? { card: card.it.id } : {}) });
    const res = await fetch(`/api/voice/hear?${q}`, { method: "POST", headers: { "X-Teach": "1", "Content-Type": "audio/wav" }, body: wav });
    r = await res.json().catch(() => ({ kind: "error", error: `${res.status}` }));
    if (!res.ok) r = { kind: "error", error: r.error || `${res.status}` };
  } catch (e) { r = { kind: "error", error: e.message }; }
  VOICE.sending--;
  if (VOICE.cap) VOICE.state = VOICE.vad?.talking ? "hearing" : "listening";
  voicePaint();
  if (T.slug !== slug) return;
  voiceApply(r, card);
}

// What they said, put to use: their answer on the card, a message to the tutor, or the mic muted.
function voiceApply(r, card) {
  switch (r.kind) {
    case "drop": return;
    case "error": toast(`Didn't hear that: ${r.error}`, "red"); return;
    case "mute": toast("Stopped listening. Click Voice (or press M) to listen again."); return;
    case "unclear": {
      const q = card?.it.ask.questions[r.index];
      const n = q?.options?.length || 0;
      const tip = n ? `say the number of your pick (1–${n})${q.idk ? " or “I don't know”" : ""}` : "say just the number";
      toast(`Heard “${r.text}”: ${tip}`, "gold");
      voiceSpeak(`Which one? ${tip.replace(/^say/, "Say")}.`);
      return;
    }
    case "answer": {
      if (!card || boardPendingCard() !== card || card.voiceSent) return voiceMessage(r.text);   // the card went (or is going) meanwhile: it's a message
      card.answers[r.index] = r.answer;
      paintAsk(card);
      const qs = card.it.ask.questions;
      const next = qs.findIndex((q, k) => q.kind !== "order" && !isAnswered(card.answers[k]));
      const picked = r.answer.choice !== undefined ? `${r.answer.choice + 1}` : r.answer.choices ? r.answer.choices.map((x) => x + 1).join(", ") : r.answer.idk ? "I don't know" : r.answer.value ?? r.answer.task ?? "";
      toast(`Heard “${r.text}”${picked && picked !== r.text ? ` → ${picked}` : ""}`, "green");
      if (next < 0) { card.voiceSent = true; submitAsk(card); return; }
      card.focus = next;
      if (VOICE.s.narrate.board && voicePlace() === "board") voiceSpeakAsk(card.it.ask, next);
      return;
    }
    default: voiceMessage(r.text);
  }
}

function voiceMessage(text) {
  if (!text) return;
  boardEcho(text, 0);
  api(`/api/topics/${T.slug}/message`, { text, via: "voice" }).catch((e) => boardError(`Couldn't send: ${e.message}`));
}

// ---------- narration in this window ----------

// Only one window reads out loud: the listening one, else whichever is in front.
// (two windows reading would put the other's voice in the listening one's mic)
const voiceSpeaker = () => (VOICE.s.mic && VOICE.s.holder ? VOICE.s.holder === VOICE.id : document.visibilityState === "visible");

// The tutor's events -> what to read: its replies, and a new question card's question (so it can be answered by ear).
function voiceOnTopicEvent(ev) {
  if (!VOICE.s.narrate.board || voicePlace() !== "board" || !voiceSpeaker()) return;
  if (ev.t === "text" && ev.final && !ev.said && ev.text) voiceSpeak(ev.text);
  if (ev.t === "ask" && ev.status === "pending" && ev.ask && ev.ask.purpose !== "approve") voiceSpeakAsk(ev.ask, 0);
}

async function voiceSpeakAsk(ask, i) {
  try { const { parts } = await api("/api/voice/parts", { ask, i }); voiceQueue(parts); } catch { /* quiet */ }
}
async function voiceSpeak(text) {
  try { const { parts } = await api("/api/voice/parts", { text }); voiceQueue(parts); } catch { /* quiet */ }
}

function voiceQueue(parts) {
  if (!parts?.length) return;
  const gen = VOICE.say.gen;
  for (const text of parts) VOICE.say.queue.push({ text, gen, audio: null });
  voicePlay();
}

function voiceFetch(text) {
  if (!VOICE.s.tts) return Promise.resolve(null);
  return fetch("/api/voice/tts", { method: "POST", headers: { "X-Teach": "1", "Content-Type": "application/json" }, body: JSON.stringify({ text }) })
    .then((r) => (r.ok ? r.blob() : null)).catch(() => null);
}

async function voicePlay() {
  if (VOICE.say.busy !== false) return;
  const next = VOICE.say.queue.shift();
  if (!next) { VOICE.say.until = Date.now() + 400; voicePaint(); return; }
  if (next.gen !== VOICE.say.gen) return voicePlay();
  VOICE.say.busy = next.gen; voicePaint();
  next.audio ||= voiceFetch(next.text);
  const after = VOICE.say.queue[0];   // the next piece is made while this one plays
  if (after && !after.audio) after.audio = voiceFetch(after.text);
  const blob = await next.audio;
  if (next.gen !== VOICE.say.gen) { if (VOICE.say.busy === next.gen) VOICE.say.busy = false; return voicePlay(); }
  await new Promise((done) => {
    if (blob) {
      const a = new Audio(URL.createObjectURL(blob));
      VOICE.say.audio = a;
      a.onended = a.onerror = a.onpause = () => { URL.revokeObjectURL(a.src); done(); };
      a.play().catch(() => done());
    } else if ("speechSynthesis" in window) {   // no voice on the server: the browser's own
      const u = new SpeechSynthesisUtterance(next.text);
      u.rate = 1.05;
      u.onend = u.onerror = () => done();
      speechSynthesis.speak(u);
      setTimeout(done, 3000 + next.text.length * 90);   // (Chrome sometimes never ends a long one: don't hold the mic for it)
      VOICE.say.audio = { pause: () => { speechSynthesis.cancel(); done(); } };
    } else done();
  });
  VOICE.say.audio = null;
  if (VOICE.say.busy === next.gen) VOICE.say.busy = false;
  voicePlay();
}

// Stop reading now (Esc, Stop, the switch turned off, a new message).
function voiceHush() {
  VOICE.say.gen++;
  VOICE.say.busy = false;
  VOICE.say.queue = [];
  try { VOICE.say.audio?.pause(); } catch { /* gone */ }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  VOICE.say.until = Date.now() + 300;
  voicePaint();
}

// M: the mic on or off; N: narration. (Not while typing.)
document.addEventListener("keydown", (e) => {
  if (!voiceInLesson() || e.ctrlKey || e.metaKey || e.altKey || e.target.matches("textarea, input, select") || e.target.closest("dialog")) return;
  if (e.key === "m" || e.key === "M") { e.preventDefault(); voiceToggleMic(); }
  else if (e.key === "n" || e.key === "N") { e.preventDefault(); voiceToggleNarrate(); }
  else if (e.key === "Escape") voiceHush();
});

// Leaving the lesson (another page, another topic) lets go of the microphone; coming back picks it up.
setInterval(() => { if (!!VOICE.cap !== (VOICE.s.mic && voiceInLesson() && VOICE.s.holder === VOICE.id)) voiceSync(); }, 1000);
