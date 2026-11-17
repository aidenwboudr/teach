// Figures look like part of the app (lib/figures.mjs, public/figure.js + figure.css, lib/figure-render.mjs), and
// "Visualize it" (lib/visualize.mjs) only keeps a picture that passes the same checks. The checks are what keeps a
// white, default-styled figure out of a lesson, so they're tested on the kind of figure that slipped through
// (a physics lesson, 2026-11: a white box, hex colours, Helvetica, a label on an arrow) and on the themed redraw.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teach-figures-test-"));
Object.assign(process.env, { TEACH_DATA: path.join(tmp, "learning"), TEACH_STATE: path.join(tmp, "state"), TEACH_PROJECTS: path.join(tmp, "projects"), TEACH_WORK: path.join(tmp, "work") });
fs.mkdirSync(path.join(tmp, "learning", "topics"), { recursive: true });
const F = await import("../lib/figures.mjs");
const { findChrome } = await import("../skill/render-svg.mjs");
const store = await import("../lib/store.mjs");

// the figure from the screenshot, as the tutor drew it
const OLD = `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280" viewBox="0 0 440 280" font-family="Helvetica, Arial, sans-serif">
<rect width="440" height="280" fill="white"/>
<g fill="#1f6fd1" font-size="18" text-anchor="middle"><text x="60" y="70">×</text><text x="220" y="230">×</text></g>
<line x1="90" y1="170" x2="340" y2="170" stroke="#222" stroke-width="5"/>
<line x1="220" y1="160" x2="220" y2="85" stroke="#b5361a" stroke-width="4"/>
<text x="232" y="110" font-size="16" fill="#b5361a">F = IL × B : up</text></svg>`;
// the same figure to the contract
const THEMED = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 280">
<g class="blue small"><text x="40" y="58" text-anchor="middle">×</text><text x="380" y="238" text-anchor="middle">×</text></g>
<line class="thick" x1="40" y1="170" x2="420" y2="170"/>
<line class="yellow arrow" x1="160" y1="196" x2="260" y2="196"/>
<text class="yellow" x="272" y="202">$I,\\ \\vec L$</text>
<line class="red arrow thick" x1="210" y1="160" x2="210" y2="70"/>
<text class="red" x="224" y="96">$\\vec F = I\\vec L\\times\\vec B$</text></svg>`;

test("an SVG: the white box, colour codes and fonts are refused; the themed one passes", () => {
  const p = F.checkSvg(OLD);
  assert.ok(p.some((x) => /colour codes .*fill="white"/.test(x)), p.join("\n"));
  assert.ok(p.some((x) => /font-family/.test(x)));
  assert.ok(p.some((x) => /rect fills the whole figure/.test(x)));
  assert.deepEqual(F.checkSvg(THEMED), []);
  assert.ok(F.checkSvg(THEMED.replace('class="thick"', 'class="thick" style="stroke:#000"')).some((x) => /stroke: #000|stroke="#000"|#000/.test(x)));
  assert.ok(F.checkSvg(THEMED.replace(' viewBox="0 0 460 280"', ' width="460" height="280"')).some((x) => /viewBox/.test(x)));
  assert.ok(F.checkSvg(`<svg viewBox="0 0 10 10"><!-- Created with matplotlib --></svg>`).some((x) => /matplotlib/.test(x)));
  assert.ok(F.checkSvg(`<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>`).some((x) => /scripts/.test(x)));
  // links only inside the figure, however the scheme is spelled; nothing from another namespace
  assert.ok(F.checkSvg(`<svg viewBox="0 0 9 9"><a href="java&#9;script:alert(1)"><rect width="9" height="9" fill="none"/></a></svg>`).some((x) => /link to "javascript:/.test(x)));
  assert.ok(F.checkSvg(`<svg xmlns:h="http://www.w3.org/1999/xhtml" viewBox="0 0 9 9"><h:meta http-equiv="refresh" content="0;url=https://x"/></svg>`).some((x) => /SVG only/.test(x)));
  assert.ok(F.checkSvg(`<svg viewBox="0 0 9 9"><style>body{display:none}</style></svg>`).some((x) => /<style>/.test(x)));
  assert.deepEqual(F.checkSvg(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 9 9"><use xlink:href="#a"/></svg>`), []);
  // a frame drawn round the figure (not a fill) is fine
  assert.deepEqual(F.checkSvg(`<svg viewBox="0 0 100 50"><rect class="dim" width="100" height="50" fill="none"/></svg>`), []);
});

test("an interactive page: a light page and its own colours and fonts are refused", () => {
  const light = `<!doctype html><style>body{font-family:system-ui;background:#fbfaf7;color:#222}canvas{background:#fff}</style><canvas></canvas><script>g.fillStyle="#b5361a";g.font="14px sans-serif"</script>`;
  const p = F.checkHtml(light);
  assert.ok(p.some((x) => /font-family/.test(x)));
  assert.ok(p.some((x) => /#fbfaf7/.test(x) && /#b5361a/.test(x)), p.join("\n"));
  assert.ok(p.some((x) => /TF\.font/.test(x)));
  const kit = `<!doctype html><style>.row{display:flex;gap:12px}.big{color:var(--red)}</style><label>N <input type=range></label><canvas id=c></canvas><script>g.strokeStyle=TF.color("blue");g.font=TF.font(15)</script>`;
  assert.deepEqual(F.checkHtml(kit), []);
  const kitted = F.withFigureKit(kit, "light");
  assert.match(kitted, /^<!doctype html><head><script>[^<]*data-teach-figure[^<]*"light"/);
  assert.match(kitted, /figure\.js"><\/script><!-- teach-figure-kit -->/);
  assert.match(F.withFigureKit("<html><head><title>x</title></head></html>"), /<head><script>/);
});

// a w x h PNG of one colour, made here (8-bit RGB)
function png(w, h, [r, g, b]) {
  const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const t = Buffer.from(type, "latin1"); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([r, g, b], y * (1 + w * 3) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("a raster figure: a light background is refused, the app's ground passes", () => {
  assert.match(F.checkPng(png(40, 30, [255, 255, 255]))[0], /light background/);
  assert.deepEqual(F.checkPng(png(40, 30, [0x29, 0x29, 0x2d])), []);
  const d = F.decodePng(png(3, 2, [10, 20, 30]));
  assert.deepEqual([d.w, d.h, ...d.px(2, 1)], [3, 2, 10, 20, 30, 255]);
});

test("a scene: labels inside the frame, palette colours, no background, the app's theme", () => {
  const ok = { title: "t", size: [520, 300], objects: [{ id: "a", text: "B into the page", at: [20, 40] }, { id: "l", line: [10, 100, 300, 100], color: "red" }] };
  assert.deepEqual(F.checkScene(ok), []);
  const cut = F.checkScene({ ...ok, objects: [{ id: "lab", text: "L sin θ beside the wire", at: [470, 120] }] });
  assert.ok(cut.some((x) => /runs past the right edge/.test(x)), cut.join("\n"));
  assert.ok(F.checkScene({ ...ok, theme: "paper" }).some((x) => /theme/.test(x)));
  assert.ok(F.checkScene({ ...ok, objects: [{ id: "bg", rect: [0, 0, 520, 300], fill: true, color: "white" }] }).some((x) => /background/.test(x)));
  assert.ok(F.checkScene({ ...ok, objects: [{ id: "x", circle: [50, 50, 10], color: "#ff0000" }] }).some((x) => /theme colour/.test(x)));
  assert.ok(F.checkScene({ ...ok, objects: [{ id: "phi", text: "\\Phi = BA", at: [300, 60] }] }).some((x) => /TeX outside/.test(x)));
  assert.deepEqual(F.checkScene({ ...ok, objects: [{ id: "phi", text: "$\\Phi = BA$", at: [300, 60] }] }), []);
  assert.ok(F.checkScene({ ...ok, steps: [{ say: "flux \\Phi drops" }] }).some((x) => /plain text/.test(x)));
  const over = F.checkScene({ ...ok, objects: [{ id: "a", text: "first label", at: [100, 100] }, { id: "b", text: "second label", at: [104, 102] }] });
  assert.ok(over.some((x) => /overlaps/.test(x)));
});

test("the theme's colours are chalk's (one palette for both)", () => {
  const css = fs.readFileSync(path.join(APP, "public/style.css"), "utf8");
  const dark = (name) => (css.match(new RegExp(`--${name}:\\s*light-dark\\(#[0-9A-Fa-f]{6},\\s*(#[0-9A-Fa-f]{6})\\)`)) || [])[1]?.toUpperCase();
  // chalk's scene.py THEMES["dark"] (and Manim's): blue, yellow, teal, green, red, gold
  assert.deepEqual(["blue", "yellow", "teal", "green", "red", "gold"].map(dark), ["#58C4DD", "#FFFF00", "#5CD0B3", "#83C167", "#FC6255", "#F0AC5F"]);
  const chalk = process.env.TEACH_CHALK_DIR || path.join(os.homedir(), "Documents/projects/chalk");
  const py = fs.existsSync(path.join(chalk, "scene.py")) && fs.readFileSync(path.join(chalk, "scene.py"), "utf8");
  if (py) for (const [k, v] of [["blue", "#58C4DD"], ["red", "#FC6255"], ["teal", "#5CD0B3"]]) assert.match(py, new RegExp(`"${k}": "${v}"`));
});

test("figures shipped with the app pass the checks", () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(svg|html)$/.test(e.name) && f.includes(`${path.sep}figures${path.sep}`)) files.push(f); } };
  walk(path.join(APP, "examples"));
  for (const f of files) assert.deepEqual(F.checkFigureFile(f), [], f);
});

const chrome = findChrome();
test("render: the board's look, and the layout problems a reader would see", { skip: !chrome && "no Chrome here" }, async () => {
  const { renderFigure } = await import("../lib/figure-render.mjs");
  const dir = path.join(tmp, "figs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "good.svg"), THEMED);
  const r = await renderFigure(path.join(dir, "good.svg"));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(F.checkPng(fs.readFileSync(r.png)), [], "a themed figure renders on the dark card");
  // a label past the right edge, two labels on each other, a label on a line
  const bad = `<svg viewBox="0 0 300 160"><line x1="10" y1="80" x2="290" y2="80"/>
    <text x="250" y="40">sticks out past the edge</text><text x="20" y="40">first</text><text x="24" y="42">second</text>
    <text x="100" y="86">on the wire</text></svg>`;
  fs.writeFileSync(path.join(dir, "bad.svg"), bad);
  const b = await renderFigure(path.join(dir, "bad.svg"));
  assert.ok(b.problems.some((x) => /sticks out.*right edge/.test(x)), b.problems.join("\n"));
  assert.ok(b.problems.some((x) => /"first" and "second" overlap/.test(x)));
  assert.ok(b.problems.some((x) => /"on the wire" sits on a line/.test(x)));
  // the old figure: a white box (refused by the checks; shown as it was drawn, as a picture, not themed into ink outlines)
  fs.writeFileSync(path.join(dir, "old.svg"), OLD);
  const o = await renderFigure(path.join(dir, "old.svg"));
  assert.ok(o.problems.some((x) => /colour codes/.test(x)));
  assert.ok(!o.problems.some((x) => /doesn't parse/.test(x)));
  // mounting into the page strips what could act on it: script-ish links (a tab in the scheme), other namespaces, <style>
  const { withBrowser, RENDER_PAGE } = await import("../lib/figure-render.mjs");
  const { pathToFileURL } = await import("node:url");
  const left = await withBrowser(async (page) => {
    await page.goto(pathToFileURL(RENDER_PAGE).href);
    return page.eval(`(() => { const h = document.getElementById("fig"); TF.mount(h, ${JSON.stringify(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:h="http://www.w3.org/1999/xhtml" xmlns:y="http://www.w3.org/1999/xlink" viewBox="0 0 90 90">
      <a href="java&#9;script:alert(1)"><rect width="9" height="9"/></a><a y:href="javascript:alert(2)"><circle r="3"/></a><h:meta http-equiv="refresh" content="0;url=https://x"/><h:link rel="stylesheet" href="data:text/css,body{display:none}"/>
      <rect onclick="alert(3)" width="5" height="5"/><animate attributeName="href" to="javascript:alert(4)"/><set attributeName="href" to="javascript:alert(5)"/><use href="#ok"/><g id="ok"/></svg>`)});
      const s = h.querySelector("svg"); return { links: [...s.querySelectorAll("*")].flatMap((e) => [...e.attributes].filter((a) => a.localName === "href").map((a) => a.value)),
        foreign: [...s.querySelectorAll("*")].filter((e) => e.namespaceURI !== "http://www.w3.org/2000/svg").length, style: s.querySelectorAll("style, set, animate").length,
        handlers: s.querySelectorAll("[onclick]").length, body: getComputedStyle(document.body).display }; })()`);
  });
  // and one with its own <style> isn't inlined at all: a picture, which can't touch the page
  const asImg = await withBrowser(async (page) => {
    await page.goto(pathToFileURL(RENDER_PAGE).href);
    return page.eval(`(() => { const h = document.getElementById("fig"); TF.mount(h, ${JSON.stringify(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 9"><style>body{display:none}</style></svg>`)}); return [!!h.querySelector("img"), !!h.querySelector("svg"), getComputedStyle(document.body).display]; })()`);
  });
  assert.deepEqual(asImg, [true, false, "block"]);
  assert.deepEqual(left, { links: [left.links.find((v) => /^#f\d+-ok$/.test(v))], foreign: 0, style: 0, handlers: 0, body: "block" });
});

// ---------- Visualize it ----------

const slug = "lenz";
store.createTopic?.({ slug, title: "Lenz's law" });
if (!store.getTopic(slug)) { fs.mkdirSync(store.topicDir(slug), { recursive: true }); store.saveTopic(store.blankTopic(slug, { title: "Lenz's law" })); }
const note = { id: "lenz", title: "Lenz's law, the recipe", body: "A loop hates having its flux changed. Example: $B$ into the page, area shrinking: **clockwise**." };
const fakeModel = (file, body) => { fs.writeFileSync(file, body); return `${process.execPath} ${file}`; };
const runJob = (V, ctx) => new Promise((resolve) => {
  V.listen((s, id, made) => { const j = V.job(s, id); if (made || j?.state === "failed" || (!j && !made)) resolve({ made, job: j }); });
  V.start(slug, note, ctx);
});

test("visualize: a scene passes the checks and is kept with the topic", async () => {
  const V = await import("../lib/visualize.mjs");
  const scene = { title: "Squish the loop", size: [520, 300], objects: [{ id: "loop", rect: [100, 80, 200, 140], color: "blue" }, { id: "t", text: "clockwise", at: [340, 150], color: "yellow" }], steps: [{ show: ["loop", "t"], say: "Area drops, current clockwise." }] };
  process.env.TEACH_VISUALIZE_CMD = fakeModel(path.join(tmp, "m1.mjs"), `process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({ scene: ${JSON.stringify(scene)} })));`);
  const seen = [];
  const r = await runJob(V, { topic: store.getTopic(slug), provider: "claude", stage: { available: true, dir: tmp, storyboard: async (spec, dir) => { seen.push(spec); fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, "step1.png"); fs.writeFileSync(f, png(60, 40, [0x1c, 0x1c, 0x1e])); return [f]; } } });
  assert.equal(r.made?.kind, "scene");
  const v = store.getTopic(slug).visuals.lenz;
  assert.equal(v.title, "Squish the loop");
  assert.equal(v.noteHash, V.hashBody(note.body));
  assert.equal(seen.length, 1, "the storyboard was made for the check");
});

test("visualize: an SVG figure that keeps breaking the contract isn't kept", async () => {
  const V = await import("../lib/visualize.mjs");
  process.env.TEACH_VISUALIZE_CMD = fakeModel(path.join(tmp, "m2.mjs"), `process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({ title: "x", svg: ${JSON.stringify(OLD)} })));`);
  const before = store.getTopic(slug).visuals.lenz.at;
  const r = await runJob(V, { topic: store.getTopic(slug), provider: "claude", stage: null, render: null });
  assert.equal(r.job?.state, "failed");
  assert.match(r.job.error, /still has problems/);
  assert.equal(store.getTopic(slug).visuals.lenz.at, before, "the visual that was there stays");
  assert.ok(!fs.readdirSync(path.join(store.topicDir(slug), "figures")).length, "the failed figure was removed");
});

test("visualize: cancel stops the model", async () => {
  const V = await import("../lib/visualize.mjs");
  const mark = path.join(tmp, "still-running");
  process.env.TEACH_VISUALIZE_CMD = fakeModel(path.join(tmp, "m3.mjs"), `import fs from "node:fs"; setTimeout(() => fs.writeFileSync(${JSON.stringify(mark)}, "x"), 1500); setInterval(() => {}, 1000);`);
  V.listen(() => {});
  V.start(slug, { ...note, id: "other" }, { topic: store.getTopic(slug), provider: "claude", stage: null });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(V.job(slug, "other")?.state, "working");
  assert.equal(V.cancel(slug, "other"), true);
  assert.equal(V.job(slug, "other"), null);
  await new Promise((r) => setTimeout(r, 2000));
  assert.ok(!fs.existsSync(mark), "the model process was killed before it could finish");
  delete process.env.TEACH_VISUALIZE_CMD;
});

test("visualize: a job cancelled and started again: the late end of the first can't touch the second", async () => {
  const V = await import("../lib/visualize.mjs");
  const scene = { title: "Second", size: [520, 300], objects: [{ id: "a", text: "ok", at: [20, 40] }], steps: [{ show: ["a"], say: "ok" }] };
  // the first ignores SIGTERM for a moment (a model process that takes its time to go)
  const slowCmd = fakeModel(path.join(tmp, "m4.mjs"), `process.on("SIGTERM", () => setTimeout(() => process.exit(0), 600)); setInterval(() => {}, 1000);`);
  const fastCmd = fakeModel(path.join(tmp, "m5.mjs"), `process.stdin.resume(); process.stdin.on("end", () => setTimeout(() => console.log(JSON.stringify({ scene: ${JSON.stringify(scene)} })), 900));`);
  const ctx = () => ({ topic: store.getTopic(slug), provider: "claude", stage: { available: true, dir: tmp, storyboard: async () => [] } });
  V.listen(() => {});
  process.env.TEACH_VISUALIZE_CMD = slowCmd;
  V.start(slug, { ...note, id: "race" }, ctx());
  await new Promise((r) => setTimeout(r, 300));
  V.cancel(slug, "race");
  process.env.TEACH_VISUALIZE_CMD = fastCmd;
  V.start(slug, { ...note, id: "race" }, ctx());
  await new Promise((r) => setTimeout(r, 400));   // the first one's process exits now
  assert.equal(V.job(slug, "race")?.state, "working", "the second job is still there");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(V.visualOf(store.getTopic(slug), "race")?.title, "Second");
  assert.equal(V.job(slug, "race"), null);
  delete process.env.TEACH_VISUALIZE_CMD;
  // ids every object has are refused, and a topic's visuals are read as its own
  assert.equal(V.noteIdOk("__proto__"), false); assert.equal(V.noteIdOk("constructor"), false); assert.equal(V.noteIdOk("lenz"), true);
  assert.equal(V.visualOf({ visuals: {} }, "toString"), null);
});

test("visualize: the prompt is chalk's own, about the note", async () => {
  const V = await import("../lib/visualize.mjs");
  const chalk = path.join(tmp, "chalk");
  fs.mkdirSync(chalk, { recursive: true });
  fs.writeFileSync(path.join(chalk, "scene.md"), "Screen intro.\n\nWhat makes a good scene:\n- Real values from the screen\n\nReply JSON:\n- draw\n\nparams: [the format]\nLayout: margins");
  const p = V.scenePrompt(chalk, { topic: { title: "Physics II", course: "Physics II" }, note, previous: { title: "Squish", says: ["Area drops"] }, hasFigure: false });
  assert.match(p, /What makes a good scene:\n- Real values from the note/);
  assert.match(p, /params: \[the format\]/);
  assert.doesNotMatch(p, /Screen intro|Reply JSON:\n- draw/);
  assert.match(p, /another view/i);
  assert.match(p, /clockwise/);
  assert.deepEqual(V.answerJSON('Here: ```json\n{"scene": {"objects": [1]}}\n```'), { scene: { objects: [1] } });
});
