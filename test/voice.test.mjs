// Narration and voice input (lib/voice.mjs): the switches and what they remember, text made speakable, what a spoken
// reply means for the card in front of the learner, and the server's half end to end with a fake speech-to-text and
// a fake voice (no model, no microphone): a clip in, the words and their meaning out; a line in, a WAV out.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teach-voice-test-"));
const DATA = path.join(tmp, "learning"), STATE = path.join(tmp, "state"), PROJECTS = path.join(tmp, "projects"), WORK = path.join(tmp, "school");
for (const d of [path.join(DATA, "topics"), STATE, PROJECTS, WORK]) fs.mkdirSync(d, { recursive: true });

// A speech-to-text that "hears" the text written in the clip after its 44-byte header; a voice that answers with PCM.
const STT = path.join(tmp, "stt.mjs"), TTS = path.join(tmp, "tts.mjs"), STT_LOG = path.join(tmp, "stt.log");
fs.writeFileSync(STT, `import fs from "node:fs";
import { createInterface } from "node:readline";
process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
  const r = JSON.parse(l);
  fs.appendFileSync(${JSON.stringify(STT_LOG)}, JSON.stringify(r) + "\\n");
  const said = fs.readFileSync(r.path).subarray(44).toString();
  process.stdout.write(JSON.stringify({ id: r.id, text: said, no_speech: said ? 0.01 : 0.9, ms: 5 }) + "\\n");
});
`);
fs.writeFileSync(TTS, `let s = ""; process.stdin.on("data", (d) => { s += d; }); process.stdin.on("end", () => process.stdout.write(Buffer.alloc(4800 + s.length * 2, 1)));\n`);
Object.assign(process.env, { TEACH_DATA: DATA, TEACH_STATE: STATE, TEACH_PROJECTS: PROJECTS, TEACH_WORK: WORK,
  TEACH_STT_CMD: `${process.execPath} ${STT}`, TEACH_TTS_CMD: `${process.execPath} ${TTS}` });
const store = await import("../lib/store.mjs");
const voice = await import("../lib/voice.mjs");
after(() => voice.sttStop());

test("defaults keep the old behavior: text in Teach, narration on the screen, no mic; the last choice holds", () => {
  const t = store.createTopic({ slug: "defaults", title: "Defaults" });
  assert.deepEqual(voice.prefs(t), { narrate: { board: false, screen: true }, mic: false });
  assert.equal(voice.narrates(t, false), false);
  assert.equal(voice.narrates(t, true), true);
  // a topic whose old "Talk out loud on my screen" was off stays quiet until they choose for themselves
  store.mutateTopic("defaults", (x) => { x.settings.voice = false; });
  assert.equal(voice.prefs(store.getTopic("defaults")).narrate.screen, false);
  assert.deepEqual(voice.setPrefs({ narrate: { board: true }, mic: true }), [["board", true], ["mic", true]]);
  assert.deepEqual(voice.setPrefs({ narrate: { board: true } }), [], "no change, nothing to tell");
  assert.deepEqual(voice.setPrefs({ narrate: { screen: true } }, store.getTopic("defaults")), [["screen", true]]);
  // remembered for every topic (and the next session): it's the learner's, not the topic's
  const other = store.createTopic({ slug: "other", title: "Other" });
  assert.deepEqual(voice.prefs(other), { narrate: { board: true, screen: true }, mic: true });
  assert.equal(voice.prefs(store.getTopic("defaults")).narrate.screen, true, "their choice beats the old per-topic switch");
  voice.setPrefs({ narrate: { board: false, screen: true }, mic: false });
});

test("replies are said as words: no code, no Markdown, math read out", () => {
  assert.equal(voice.speakable("At $f_c$ the gain is $\\frac{1}{\\sqrt{2}}$, so **-3 dB**.\n\n```py\nx = 1\n```\nSee [the note](http://x)."),
    "At f c the gain is 1 over root 2, so -3 dB. See the note.");
  assert.equal(voice.speakable("# Ohm's law\n- $V = IR$\n- $P = I^2 R$"), "Ohm's law V equals I R P equals I squared R");
  assert.equal(voice.speakable("$$\\int_0^1 x\\,dx$$\nThat's the area."), "That's the area.");
  assert.deepEqual(voice.speechParts("Right. Look at the note: that's why. Now the next one, which is harder? Yes!"),
    ["Right. Look at the note: that's why.", "Now the next one, which is harder?", "Yes!"].reduce((a, x) => (a.length && a.at(-1).length < 60 ? [...a.slice(0, -1), `${a.at(-1)} ${x}`] : [...a, x]), []));
  assert.deepEqual(voice.speechParts("```js\nonly code\n```"), []);
  assert.equal(voice.askSpeech({ intro: "Quick check.", questions: [{ kind: "choice", prompt: "How far down at $f_c$?", options: ["-3 dB", "-6 dB"] }] }),
    "Quick check.\n\nHow far down at $f_c$?\n\n1: -3 dB. 2: -6 dB.");
});

test("a spoken pick: by number, by place, by letter, or by the option's own words", () => {
  const words = ["The current through the resistor", "The voltage across the capacitor", "The total power"];
  const pick = (s, o = words) => voice.pickOptions(s, o);
  assert.deepEqual(pick("two"), [1]);
  assert.deepEqual(pick("Number three."), [2]);
  assert.deepEqual(pick("The second one."), [1]);
  assert.deepEqual(pick("it's the first"), [0]);
  assert.deepEqual(pick("option C"), [2]);
  assert.deepEqual(pick("B"), [1]);
  assert.deepEqual(pick("the last one"), [2]);
  assert.deepEqual(pick("the voltage across the capacitor"), [1]);
  assert.deepEqual(pick("I think it's the current"), [0]);
  assert.deepEqual(pick("To."), [1], "Whisper's spelling of a lone 'two'");
  assert.deepEqual(pick("I want to go with the power"), [2], "'to' in a sentence isn't option 2");
  assert.deepEqual(pick("the voltage"), [1]);
  assert.deepEqual(pick("hmm, something about voltage or current"), [], "two options named: unclear");
  // options that are numbers themselves: a bare number is still the place (the card and the narration number them),
  // said with its unit or sign it's the value
  const db = ["-20 dB", "-3 dB", "-6 dB"];
  assert.deepEqual(pick("minus three dB", db), [1]);
  assert.deepEqual(pick("three dB", db), [1]);
  assert.deepEqual(pick("three", db), [2]);
  assert.deepEqual(pick("two", db), [1]);
  assert.deepEqual(pick("number three", db), [2]);
  assert.deepEqual(pick("the first one", db), [0]);
  // a word before "one" names the option ("the capacitor one"); "a" is an article; "not" picks nothing
  const parts = ["Resistor", "Capacitor", "Inductor"];
  assert.deepEqual(pick("the capacitor one", parts), [1]);
  assert.deepEqual(pick("I think it's the capacitor one", parts), [1]);
  assert.deepEqual(pick("a capacitor", parts), [1]);
  assert.deepEqual(pick("not the first one", parts), []);
  assert.deepEqual(pick("I'd go with two", parts), [1]);
  assert.deepEqual(voice.pickOptions("just the capacitor one", parts, { many: true }), [1]);
  assert.deepEqual(voice.pickOptions("one and three", ["a", "b", "c"], { many: true }), [0, 2]);
});

test("what they said, put to use on the card in front of them", () => {
  const ask = { questions: [{ kind: "choice", options: ["-3 dB", "-6 dB"], idk: true }, { kind: "number", prompt: "R?", unit: "Ω" }, { kind: "text", prompt: "Why?" }, { kind: "task", prompt: "Open it" }] };
  const hear = (text, focus = 0, no_speech = 0.02) => voice.interpret({ text, no_speech }, { ask, focus });
  assert.deepEqual(hear("Two."), { kind: "answer", text: "Two.", index: 0, answer: { choice: 1 } });
  assert.deepEqual(hear("I don't know.").answer, { idk: true });
  assert.equal(hear("Um, which?").kind, "message", "a question goes to the tutor");
  assert.equal(hear("Can you give me a hint").kind, "message");
  assert.equal(hear("purple").kind, "unclear", "a short miss asks again instead of guessing");
  assert.equal(hear("so I was thinking about how the capacitor charges and why that would make the output drop off like that").kind, "message", "a long turn was for the tutor");
  assert.deepEqual(hear("about 4.7 kilo ohms", 1).answer, { value: "4.7" });
  assert.deepEqual(hear("twenty two", 1).answer, { value: "22" });
  assert.deepEqual(hear("minus four", 1).answer, { value: "-4" });
  assert.deepEqual(hear("two point five", 1).answer, { value: "2.5" });
  assert.deepEqual(hear("one thousand two hundred", 1).answer, { value: "1200" });
  // anything but one plain number is theirs to type: never a wrong value
  for (const said of ["3 times 10 to the minus 3", "ten to the minus three", "one over two", "one two", "1.5 times 10 to the 3", "negative feedback gives 20 and then 30"]) {
    assert.equal(hear(said, 1).kind, "unclear", said);
  }
  assert.deepEqual(hear("negative 20", 1).answer, { value: "-20" });
  assert.deepEqual(hear("not sure, but two", 0).answer, { choice: 1 }, "a hedge isn't I don't know");
  const pass = { questions: [{ kind: "choice", options: ["Lets DC pass", "Blocks DC"], idk: true }] };
  assert.deepEqual(voice.interpret({ text: "lets DC pass" }, { ask: pass }).answer, { choice: 0 }, "'pass' in an option isn't I don't know");
  assert.deepEqual(hear("Because the reactance falls.", 2).answer, { text: "Because the reactance falls." });
  assert.deepEqual(hear("Done.", 3).answer, { task: "done", text: "Done." });
  assert.deepEqual(hear("I'm stuck", 3).answer, { task: "stuck", text: "I'm stuck" });
  for (const said of ["not done yet", "I'm not ready", "no I haven't finished", "okay so now what"]) assert.equal(hear(said, 3).kind, "message", said);
  // no card: everything is a message, except noise and "stop listening"
  assert.equal(voice.interpret({ text: "What's a phasor?" }).kind, "message");
  assert.equal(voice.interpret({ text: "Stop listening." }).kind, "mute");
  assert.equal(voice.interpret({ text: "Mute the mic" }).kind, "mute");
  assert.equal(voice.interpret({ text: "Thank you.", no_speech: 0.4 }).kind, "drop", "Whisper's ghost in a quiet room");
  assert.equal(voice.interpret({ text: "Thanks for watching!" }).kind, "drop");
  assert.equal(voice.interpret({ text: "Thank you.", no_speech: 0.02 }).kind, "message", "a clear thank-you is theirs");
  assert.equal(voice.interpret({ text: "anything", no_speech: 0.8 }).kind, "drop");
  assert.equal(voice.interpret({ text: "" }).kind, "drop");
});

test("speech-to-text runs one process for every clip, and a voice makes WAVs", async () => {
  const clip = (s) => voice.saveClip(Buffer.concat([voice.wav(Buffer.alloc(0), 16000), Buffer.from(s)]));
  const a = await voice.transcribe(clip("number two"), "RC low-pass. -3 dB");
  const b = await voice.transcribe(clip("hello"));
  assert.equal(a.text, "number two");
  assert.equal(b.text, "hello");
  const log = fs.readFileSync(STT_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(log.map((r) => r.id), [1, 2], "one process, numbered requests");
  assert.equal(log[0].prompt, "RC low-pass. -3 dB");
  const w = await voice.synth("Hello there.");
  assert.equal(w.subarray(0, 4).toString(), "RIFF");
  assert.equal(w.readUInt32LE(24), 24000);
  assert.equal(await voice.synth("Hello there."), w, "the same line again comes from the cache");
});

// ---------- the server's half ----------

const PORT = 7900 + Math.floor(Math.random() * 60);
const CHALK = path.join(tmp, "chalk.mjs"), CHALK_LOG = path.join(tmp, "chalk.log");
fs.writeFileSync(CHALK, `#!${process.execPath}\nrequire("fs").appendFileSync(${JSON.stringify(CHALK_LOG)}, process.argv.slice(2).join(" ") + "\\n");\n`, { mode: 0o755 });
fs.renameSync(CHALK, CHALK.replace(/\.mjs$/, ".cjs"));
let server = null;
const streams = [];
after(async () => { for (const s of streams) s.abort(); if (server) { server.kill("SIGTERM"); await new Promise((r) => server.once("exit", r)); } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, body, raw) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`, body !== undefined ? { method: "POST", headers: { "X-Teach": "1", "Content-Type": raw === true ? "audio/wav" : "application/json" }, body: raw === true ? body : JSON.stringify(body) } : {});
      return raw === "bytes" ? Buffer.from(await r.arrayBuffer()) : { status: r.status, ...(await r.json()) };
    } catch { await sleep(100); }
  }
  throw new Error("server didn't come up");
}
function events(q) {
  const got = [], ctl = new AbortController();
  streams.push(ctl);
  (async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/events?${q}`, { signal: ctl.signal });
    let buf = "";
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString();
      for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) { const d = buf.slice(0, i).match(/^data: (.*)$/m); if (d) got.push(JSON.parse(d[1])); }
    }
  })().catch(() => {});
  return got;
}
async function until(fn, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(60); } return fn(); }

test("the server: switches for everyone, one listening page, clips heard against the open card, lines voiced", async () => {
  store.createTopic({ slug: "rc", title: "RC low-pass" });
  server = spawn(process.execPath, [path.join(APP, "server.mjs")], {
    env: { ...process.env, TEACH_T3_DB: path.join(tmp, "no-t3.sqlite"), TEACH_SYNC: "off", TEACH_CAPTURE_CMD: "", TEACH_OPEN_CMD: "", TEACH_PORT: String(PORT),
      TEACH_SOCKET: "", TEACH_CHALK: CHALK.replace(/\.mjs$/, ".cjs"), TEACH_CHALK_MCP: process.execPath, TEACH_CLAUDE: process.execPath, TEACH_URL: "" },
    stdio: ["ignore", "ignore", "inherit"] });
  const v0 = await api("/api/voice");
  assert.deepEqual([v0.narrate, v0.mic, v0.stt, v0.tts], [{ board: false, screen: true }, false, true, true]);
  const laptop = events("client=laptop"), phone = events("topic=rc&client=phone");
  await until(() => laptop.length && phone.length);
  // the laptop turns the mic on: it's the one listening, and both pages hear about it
  await api("/api/voice", { mic: true, client: "laptop", topic: "rc" });
  assert.ok(await until(() => phone.some((e) => e.t === "voice" && e.voice.mic && e.voice.holder === "laptop")));
  // the phone takes over; the laptop leaving its lesson doesn't take it back from the phone
  await api("/api/voice/claim", { client: "phone" });
  assert.equal((await api("/api/voice")).holder, "phone");
  await api("/api/voice/claim", { client: "laptop", release: true });
  assert.equal((await api("/api/voice")).holder, "phone");
  // a clip of them talking, with no card open: a message; "stop listening": the mic goes off
  const wav = (s) => Buffer.concat([voice.wav(Buffer.alloc(0), 16000), Buffer.from(s)]);
  const r1 = await api("/api/voice/hear?topic=rc", wav("What's a phasor?"), true);
  assert.deepEqual([r1.kind, r1.text], ["message", "What's a phasor?"]);
  const r2 = await api("/api/voice/hear?topic=rc", wav("Stop listening."), true);
  assert.equal(r2.kind, "mute");
  assert.equal((await api("/api/voice")).mic, false);
  assert.equal((await api("/api/voice/hear?topic=rc", Buffer.from("not a wav"), true)).status, 400);
  // the tutor's say playing on their computer: every page hears "speaking", then that it's over
  await api("/api/topics/rc/speaking", { on: true, seconds: 4 });
  assert.ok(await until(() => laptop.some((e) => e.t === "speaking" && e.on && e.seconds === 4)));
  assert.equal((await api("/api/voice")).speaking, true);
  await api("/api/topics/rc/speaking", { on: false });
  assert.equal((await api("/api/voice")).speaking, false);
  // narration in Teach: the pieces to say, and each one's WAV
  const parts = (await api("/api/voice/parts", { text: "Good. Now **look** at the note:\n\n```py\nx = 1\n```" })).parts;
  assert.deepEqual(parts, ["Good. Now look at the note:"]);
  const audio = await api("/api/voice/tts", { text: parts[0] }, "bytes");
  assert.equal(audio.subarray(0, 4).toString(), "RIFF");
  // the topic's page knows the switches too, and the old "Talk out loud on my screen" setting still works
  assert.deepEqual((await api("/api/topics/rc")).voice.narrate, { board: false, screen: true });
  await api("/api/topics/rc/settings", { voice: false });
  assert.equal((await api("/api/voice")).narrate.screen, false);
  assert.ok(await until(() => fs.existsSync(CHALK_LOG) && /^hush$/m.test(fs.readFileSync(CHALK_LOG, "utf8"))), "turning narration off on the screen hushes it");
  // the listening page closes: the mic is free for the next one
  await api("/api/voice", { mic: true, client: "phone", topic: "rc" });
  streams[1].abort();
  assert.ok(await until(async () => (await api("/api/voice")).holder === null), "the phone's page went away");
});
