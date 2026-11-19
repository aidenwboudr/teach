// Voice: the tutor read out loud (narration) and the learner answering out loud (voice input), on top of where the
// lesson is (the board, or their screen). Three switches the learner flips at any time, in any combination:
//   - On my screen: the topic's own setting (lib/screen.mjs); the tutor can take a step there too.
//   - Narrate: read the tutor out loud. Remembered for each place: on the board it reads the reply in the Teach
//     window (off until they turn it on), on their screen it's the tutor's `say` through chalk (on, as it always was).
//   - Voice input: the page listens through the microphone; what they say becomes their message, or their answer
//     to the question card in front of them.
// The learner's last choice holds for every topic and the next session (prefs in the state folder, this machine only).
//
// Speech to text is TEACH_STT_CMD (examples/whisper_stt.py: faster-whisper on the CPU), one long-lived process
// started the first time they speak and stopped after STT_IDLE unused. Text to speech is TEACH_TTS_CMD (text on
// stdin, 24 kHz mono s16le PCM or a WAV on stdout), else chalk's voice (`chalk say --pcm`) when chalk is installed,
// else the browser's own voice.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { STATE, STT_CMD, TTS_CMD, splitCmd } from "./paths.mjs";
import { readJSON, writeJSON } from "./store.mjs";
import { CHALK, installed as chalkInstalled } from "./screen.mjs";

const FILE = () => path.join(STATE, "voice.json");

// ---------- the learner's switches ----------

// What's on. `topic` only matters for an install from before these switches: a topic whose old "Talk out loud on my
// screen" was off stays quiet on the screen until they choose for themselves.
export function prefs(topic) {
  const p = readJSON(FILE(), {});
  const screen = typeof p.narrate?.screen === "boolean" ? p.narrate.screen : topic?.settings?.voice !== false;
  return { narrate: { board: p.narrate?.board === true, screen }, mic: p.mic === true };
}

// Change some of them: { narrate: { board?, screen? }, mic? }. Returns what changed, as [place or "mic", on].
export function setPrefs(patch, topic) {
  const was = prefs(topic), p = readJSON(FILE(), {});
  const changed = [];
  for (const place of ["board", "screen"]) {
    const v = patch?.narrate?.[place];
    if (typeof v !== "boolean") continue;
    p.narrate = { ...(p.narrate || {}), [place]: v };
    if (v !== was.narrate[place]) changed.push([place, v]);
  }
  if (typeof patch?.mic === "boolean") { p.mic = patch.mic; if (patch.mic !== was.mic) changed.push(["mic", patch.mic]); }
  writeJSON(FILE(), p);
  return changed;
}

// Where the lesson is decides which narration switch counts.
export const placeOf = (onScreen) => (onScreen ? "screen" : "board");
export const narrates = (topic, onScreen) => prefs(topic).narrate[placeOf(onScreen)];

// ---------- text that reads well out loud ----------

const GREEK = { alpha: "alpha", beta: "beta", gamma: "gamma", delta: "delta", epsilon: "epsilon", varepsilon: "epsilon", theta: "theta", lambda: "lambda", mu: "mu",
  pi: "pi", rho: "rho", sigma: "sigma", tau: "tau", phi: "phi", varphi: "phi", omega: "omega", Omega: "ohms", Delta: "delta", Sigma: "sigma", Phi: "phi" };
const SYMBOL = { times: "times", cdot: "times", approx: "about", neq: "isn't", leq: "at most", le: "at most", geq: "at least", ge: "at least", to: "to",
  rightarrow: "gives", Rightarrow: "so", infty: "infinity", partial: "partial", int: "the integral of", sum: "the sum of", pm: "plus or minus", circ: "degrees" };

// LaTeX inside $...$, said roughly the way a tutor would read it ("f c equals 1 over 2 pi R C").
export function sayMath(tex) {
  // letters side by side are a product, said one by one ("IR" -> "I R", "RC" -> "R C"), not read as a word
  let s = String(tex).replace(/(?<![\\A-Za-z])[A-Za-z]{2,3}\b/g, (w) => (/^(sin|cos|tan|log|ln|exp|max|min|lim|dB|Hz|kHz|mA|mV|kV|ms|rad|deg|kg|cm|mm|km)$/.test(w) ? w : w.split("").join(" ")));
  for (let i = 0; i < 4; i++) s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, " $1 over $2 ").replace(/\\sqrt\s*\{([^{}]*)\}/g, " root $1 ");
  s = s.replace(/\^\{?\s*2\s*\}?/g, " squared ").replace(/\^\{?\s*3\s*\}?/g, " cubed ").replace(/\^\{([^{}]*)\}/g, " to the $1 ").replace(/\^(\S)/g, " to the $1 ")
    .replace(/_\{([^{}]*)\}/g, " $1 ").replace(/_(\S)/g, " $1 ")
    .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\s*\{([^{}]*)\}/g, " $1 ")
    .replace(/\\([A-Za-z]+)/g, (_, w) => ` ${GREEK[w] || SYMBOL[w] || ""} `)
    .replace(/=/g, " equals ").replace(/\+/g, " plus ").replace(/(\s)-(\s)/g, "$1minus$2").replace(/</g, " is less than ").replace(/>/g, " is more than ")
    .replace(/[{}\\&]/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

// A reply's Markdown -> plain sentences to say. Code and displayed equations aren't read out (they're on the page).
export function speakable(md) {
  let s = String(md || "");
  s = s.replace(/```[\s\S]*?(```|$)/g, " ").replace(/\$\$[\s\S]*?\$\$/g, " ").replace(/\\\[[\s\S]*?\\\]/g, " ");
  s = s.replace(/\$([^$\n]+)\$/g, (_, m) => ` ${sayMath(m)} `).replace(/\\\((.+?)\\\)/g, (_, m) => ` ${sayMath(m)} `);
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, " ")
    .replace(/`([^`]*)`/g, "$1").replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~\n]+?)\1/g, "$2")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/^\s*[-*+]\s+/gm, "").replace(/^\s*>\s?/gm, "").replace(/^\s*\|?[-:| ]+\|?\s*$/gm, " ")
    .replace(/\|/g, ", ").replace(/https?:\/\/\S+/g, "the link").replace(/[*_#>]/g, " ")
    .replace(/\s*\n\s*\n\s*/g, ". ").replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").replace(/([.!?])\s*\.(?=\s|$)/g, "$1").replace(/^[\s.,;:]+/, "");
  return s.trim();
}

// Said text -> pieces of a sentence or two, so the voice starts after the first while the rest is made.
export function speechParts(md, { max = 2400, piece = 220 } = {}) {
  const s = speakable(md).slice(0, max);
  if (!s) return [];
  const sentences = s.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map((x) => x.trim()).filter(Boolean) || [s];
  const out = [];
  for (const x of sentences) {
    if (out.length && (out.at(-1) + " " + x).length <= piece && out.at(-1).length < 60) out[out.length - 1] += " " + x;   // a short first bit carries the next
    else out.push(x);
  }
  return out;
}

// A question card read out: its intro, the question, and the options by number (the keys the card shows).
export function askSpeech(ask, i = 0) {
  const q = ask?.questions?.[i];
  if (!q) return "";
  const lead = i === 0 && ask.intro ? `${ask.intro}\n\n` : "";
  const n = ask.questions.length > 1 ? `Question ${i + 1}. ` : "";
  if (q.kind === "choice" || q.kind === "multi") {
    return `${lead}${n}${q.prompt}\n\n${q.options.map((o, j) => `${j + 1}: ${o}.`).join(" ")}${q.kind === "multi" ? " Say every number that fits." : ""}`;
  }
  return `${lead}${n}${q.prompt}`;
}

// ---------- what they said, against the card in front of them ----------

const NUM = { one: 1, won: 1, first: 1, two: 2, to: 2, too: 2, second: 2, three: 3, third: 3, four: 4, for: 4, fore: 4, fourth: 4, five: 5, fifth: 5,
  six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, ate: 8, eighth: 8, nine: 9, ninth: 9 };
const LETTER = { a: 1, b: 2, bee: 2, be: 2, c: 3, see: 3, sea: 3, d: 4, dee: 4, e: 5 };
// lower-case words without punctuation ("Three." -> "three", "-3" -> "3"; "4.7" stays)
const words = (s) => String(s).toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9.\s-]/g, " ").split(/\s+/)
  .map((x) => x.replace(/^[-.]+/, "").replace(/[.-]+$/, "")).filter(Boolean);
const STOP = new Set("the a an of to is it its and or in on at for by be as that this with from are was i think im my answer option number choice one".split(" "));
const DIGIT = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
  fifteen: "15", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", hundred: "100", thousand: "1000" };
const content = (s) => new Set(words(s).map((x) => DIGIT[x] || x).filter((x) => !STOP.has(x)));
const CUES = ["option", "number", "choice", "letter", "pick"];
const LEADS = new Set(["its", "is", "say", "answer", "pick", "go", "with"]);   // words before a number that make it their pick
const NEGATE = new Set(["not", "isnt", "arent", "wasnt", "except", "never"]);

// Which option(s) they named: "two", "number 3", "the second one", "option B", or the option's own words.
// Returns [indexes] (empty: couldn't tell; the page asks again rather than guess). A number is the option's place,
// the way the card and the narration number them ("1: -3 dB. 2: -6 dB."), even when the options are numbers; said
// with its unit or sign ("minus three dB") it's the option's value. "Not the first one" picks nothing.
export function pickOptions(said, options, { many = false } = {}) {
  const w = words(said), n = options.length;
  if (w.some((x) => NEGATE.has(x))) return [];
  // their own words: the option sharing the most content words with what they said, clearly ahead of the rest
  const own = () => {
    const s = content(said);
    if (!s.size) return [];
    // (overlap over the shorter side: "the current" picks "The current through the resistor" when no other option says current)
    const score = options.map((o) => { const ow = [...content(speakable(o))]; return ow.length ? ow.filter((x) => s.has(x)).length / Math.min(ow.length, s.size) : 0; });
    if (many) return score.map((x, j) => (x >= 0.6 ? j : -1)).filter((j) => j >= 0);
    const best = Math.max(...score), j = score.indexOf(best);
    const second = Math.max(...score.filter((_, k) => k !== j), 0);
    return best >= 0.5 && best - second >= 0.25 ? [j] : [];
  };
  // a value, not a place: a sign, a decimal, or a word beside the number that one of the options has ("dB", "ohms")
  const numeric = options.some((o) => /\d/.test(String(o)));
  const valueLike = numeric && (/(^|\s)(-|minus|negative)\s*\d|\b(minus|negative|point)\b|\d\.\d/i.test(said) ||
    [...content(said)].some((x) => !/^\d+$/.test(x) && !(x in NUM) && options.some((o) => content(speakable(o)).has(x))));
  if (valueLike) { const o = own(); if (o.length) return o; }
  const hits = [];
  w.forEach((x, k) => {
    const prev = w[k - 1] || "";
    const cue = CUES.includes(prev);
    let v = /^\d$/.test(x) ? +x : NUM[x];
    if (v === undefined && LETTER[x] !== undefined && (prev === "option" || prev === "letter" || w.length === 1)) v = LETTER[x];   // ("a capacitor" isn't option A)
    if (v === undefined) return;
    if (["to", "too", "for", "fore", "won", "ate"].includes(x) && w.length > 2 && !cue) return;   // homophones only alone or after a cue word
    if (/^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)$/.test(x)) { if (w.length <= 6 || cue || prev === "the") hits.push(v - 1); return; }
    // "one" after another word is "the capacitor one", not option 1: only alone, after a cue, or after "it's", "is", "say"
    if (x === "one" && w.length > 1 && prev && !cue && !LEADS.has(prev) && !["and", "or"].includes(prev)) return;
    if (v >= 1 && v <= n && (cue || w.length <= 6 || LEADS.has(prev))) hits.push(v - 1);
  });
  if (w.includes("last") && (w.length <= 6 || w.includes("option"))) hits.push(n - 1);
  const uniq = [...new Set(hits)].filter((j) => j >= 0 && j < n);
  if (uniq.length && (many || uniq.length === 1)) return uniq;
  return uniq.length ? [] : own();
}

const SPOKEN_NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
// A number they said: "3.2", "minus 4", "twenty five", "two point five", "1,200". null when there's none, or when it
// isn't one plain number ("3 times 10 to the minus 3", "one over two", "one two"): those they type.
export function spokenNumber(said) {
  const s = String(said).toLowerCase().replace(/,(?=\d{3}\b)/g, "").replace(/[.!?]+$/, "");
  if (/\b(times|over|divided|power|to the|squared|cubed|per|half|quarter|percent)\b|[×*/^%]|\d\s*e\s*-?\d/.test(s)) return null;
  const digits = s.match(/\d+(?:\.\d+)?/g) || [];
  const tok = words(s), isNum = (x) => x in SPOKEN_NUM || x === "point" || x === "hundred" || x === "thousand";
  if (digits.length > 1 || (digits.length && tok.some(isNum))) return null;
  if (digits.length === 1) {
    const before = s.slice(0, s.indexOf(digits[0]));
    return String((/(-|\b(minus|negative)\s*)$/.test(before) ? -1 : 1) * Number(digits[0]));
  }
  const first = tok.findIndex(isNum);
  if (first < 0) return null;
  let end = first;
  while (end < tok.length && (isNum(tok[end]) || (tok[end] === "oh" && tok.includes("point")))) end++;
  if (tok.slice(end).some(isNum)) return null;   // two numbers
  let total = 0, cur = 0, frac = "", inFrac = false, last = "";
  for (const x of tok.slice(first, end)) {
    if (x === "point") { if (inFrac) return null; inFrac = true; continue; }
    if (inFrac) { const d = x === "oh" ? 0 : SPOKEN_NUM[x]; if (!(d >= 0 && d <= 9)) return null; frac += d; continue; }
    if (x === "hundred") { cur = (cur || 1) * 100; last = "h"; continue; }
    if (x === "thousand") { total += (cur || 1) * 1000; cur = 0; last = "k"; continue; }
    const v = SPOKEN_NUM[x];
    if (last === "u" || last === "teen" || (last === "t" && (v >= 10 || v === 0))) return null;   // "one two", "twenty thirty"
    cur += v; last = v >= 20 ? "t" : v >= 10 ? "teen" : "u";
  }
  if (inFrac && !frac) return null;
  const v = total + cur;
  return String((/^(minus|negative)$/.test(tok[first - 1] || "") ? -1 : 1) * Number(frac ? `${v}.${frac}` : v));
}

const IDK = /\b(i\s*(do\s*n[o']?t|dont)\s*know|no idea|i\s*have\s*no\s*clue|idk)\b|^not sure$/i;
const HEDGE = /\b(i'?m\s+)?not (really\s+)?sure( but)?\b|\bmaybe\b|\bi guess\b/gi;
const TO_TUTOR = /^(hint|can you|could you|would you|what does|what's|whats|what is|why|how|wait|hold on|hang on|repeat|say that again|explain|i don'?t (get|understand)|sorry|huh)\b/i;
const MUTE = /^(please\s+)?(stop|quit|end) listening( to me)?( please)?$|^(mute|turn off)( the)? (mic|microphone)( please)?$|^(mic|microphone) off$/i;
// What Whisper hears in silence and room noise (it hallucinates these), dropped unless it was clearly speech.
const GHOSTS = /^(thank you|thanks|thank you for watching|thanks for watching|please subscribe|you|bye|okay|so|uh|um|hmm|\.|\s)*$/i;

// What to do with what they said: drop it (noise), mute the mic, answer the card's question `focus`, or send it as
// a message. `heard`: { text, no_speech } from the speech-to-text. `ask`: the open card's question set, if any.
export function interpret(heard, { ask = null, focus = 0 } = {}) {
  const text = String(heard?.text || "").replace(/\s+/g, " ").trim();
  const bare = text.replace(/[.!?,]+$/g, "").trim();
  if (!bare || (heard?.no_speech ?? 0) >= 0.6 || (GHOSTS.test(bare) && (heard?.no_speech ?? 0) >= 0.2) || /^(thanks? for watching|please subscribe)/i.test(bare)) return { kind: "drop", text };
  if (MUTE.test(bare)) return { kind: "mute", text };
  const q = ask?.questions?.[focus];
  if (!q || TO_TUTOR.test(bare) || /\?$/.test(text)) return { kind: "message", text };
  const answer = (a) => ({ kind: "answer", text, index: focus, answer: a });
  const unclear = () => (bare.split(/\s+/).length > 12 ? { kind: "message", text } : { kind: "unclear", text, index: focus });   // (a long turn was for the tutor)
  if (q.kind === "choice" || q.kind === "multi") {
    const sure = bare.replace(HEDGE, " ").replace(/\s+/g, " ").trim();   // "not sure, but two" picks two
    const picks = sure ? pickOptions(sure, q.options || [], { many: q.kind === "multi" }) : [];
    if (picks.length) return answer(q.kind === "choice" ? { choice: picks[0] } : { choices: picks });
    if (IDK.test(bare)) return q.idk ? answer({ idk: true }) : { kind: "message", text };
    return unclear();
  }
  if (q.kind === "number") {
    if (IDK.test(bare) && q.idk) return answer({ idk: true });
    const v = spokenNumber(bare);
    return v === null ? unclear() : answer({ value: v });
  }
  if (q.kind === "task") {
    if (/\b(stuck|can'?t|cannot|help|lost)\b/i.test(bare)) return answer({ task: "stuck", text });
    if (/\b(not|no|nope|haven'?t|hasn'?t|isn'?t|didn'?t|yet|what|how|why|where)\b/i.test(bare)) return { kind: "message", text };   // "not done yet", "okay so now what"
    if (/\b(done|did it|finished|got it|ready|yes|yep|it works|worked)\b/i.test(bare)) return answer({ task: "done", text });
    return { kind: "message", text };
  }
  if (q.kind === "text") return answer({ text });
  return { kind: "message", text };   // order questions (drag to reorder) stay with the mouse
}

// ---------- speech to text: one process, started on the first clip ----------

export const STT_IDLE = 10 * 60e3;
export const sttReady = () => !!STT_CMD;
let stt = null;   // { proc, waiting: Map(id -> resolve), seq, ready: Promise, idle }

function sttStart() {
  const [cmd, ...args] = splitCmd(STT_CMD);
  const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
  const s = { proc, waiting: new Map(), seq: 0, idle: null, err: "" };
  let buf = "", ready;
  s.ready = new Promise((r) => { ready = r; });
  proc.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.ready) { ready(true); continue; }
      const w = s.waiting.get(m.id);
      if (w) { s.waiting.delete(m.id); w(m); }
    }
  });
  proc.stderr.on("data", (d) => { s.err = (s.err + d).slice(-600); });
  const gone = (why) => {
    ready(false);
    for (const w of s.waiting.values()) w({ error: why });
    s.waiting.clear();
    if (stt === s) stt = null;
  };
  proc.on("error", (e) => gone(e.message));
  proc.on("exit", (code) => gone(`speech-to-text stopped (exit ${code}): ${s.err.trim().split("\n").at(-1) || "no output"}`));
  proc.stdin.on("error", () => {});
  return s;
}

// Start it now (the mic was just turned on), so the model has loaded by the time they first speak: a cold start
// takes seconds, longer on a busy machine. Each use keeps it another STT_IDLE.
export function sttWarm() {
  if (!STT_CMD) return null;
  if (!stt) stt = sttStart();
  const s = stt;
  clearTimeout(s.idle);
  s.idle = setTimeout(() => { try { s.proc.kill("SIGTERM"); } catch { /* gone */ } }, STT_IDLE);
  s.idle.unref?.();
  return s;
}

// A clip (a WAV file) -> { text, no_speech, ms } or { error }. `prompt`: words to spell right (the topic, the options).
export async function transcribe(file, prompt = "", { timeout = 90e3 } = {}) {
  if (!STT_CMD) return { error: "no speech-to-text command (TEACH_STT_CMD)" };
  const s = sttWarm();
  const id = ++s.seq;
  return new Promise((resolve) => {
    // (a process that stopped answering is stopped: the next clip starts a fresh one instead of timing out too)
    const t = setTimeout(() => { s.waiting.delete(id); try { s.proc.kill("SIGKILL"); } catch { /* gone */ } if (stt === s) stt = null; resolve({ error: "speech-to-text took too long" }); }, timeout);
    s.waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    s.proc.stdin.write(JSON.stringify({ id, path: file, prompt: String(prompt).slice(0, 600) }) + "\n");
  });
}

export function sttStop() { if (stt) { try { stt.proc.kill("SIGTERM"); } catch { /* gone */ } stt = null; } }

// ---------- text to speech, for narration in the Teach window ----------

const ttsCmd = () => (TTS_CMD ? splitCmd(TTS_CMD) : chalkInstalled() ? [CHALK, "say", "--pcm"] : null);
export const ttsReady = () => !!ttsCmd();

// 24 kHz mono 16-bit PCM -> a WAV file's bytes.
export function wav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

let ttsQueue = Promise.resolve();
const ttsCache = new Map();   // text -> WAV (the last few: a second page, or a repeat)
// Text -> a WAV (Buffer), or null when there's no voice here. One at a time: it's CPU work next to the tutors.
export function synth(text) {
  const cmd = ttsCmd(), key = String(text).trim();
  if (!cmd || !key) return Promise.resolve(null);
  if (ttsCache.has(key)) return Promise.resolve(ttsCache.get(key));
  const job = ttsQueue.then(() => new Promise((resolve) => {
    const [c, ...args] = cmd;
    let p;
    try { p = spawn(c, args, { stdio: ["pipe", "pipe", "ignore"] }); } catch { return resolve(null); }
    const chunks = [];
    const timer = setTimeout(() => { try { p.kill("SIGTERM"); } catch { /* gone */ } }, 60e3);
    p.stdout.on("data", (d) => chunks.push(d));
    p.on("error", () => { clearTimeout(timer); resolve(null); });
    p.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      if (code !== 0 || out.length < 200) return resolve(null);
      const w = out.subarray(0, 4).toString() === "RIFF" ? out : wav(out);
      ttsCache.set(key, w);
      while (ttsCache.size > 24) ttsCache.delete(ttsCache.keys().next().value);
      resolve(w);
    });
    p.stdin.on("error", () => {});
    p.stdin.end(key);
  }));
  ttsQueue = job.catch(() => {});
  return job;
}

// A clip the page sent, saved where the speech-to-text can read it (and removed after).
export function saveClip(buf) {
  const dir = path.join(STATE, "voice");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `clip-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`);
  fs.writeFileSync(f, buf);
  return f;
}
