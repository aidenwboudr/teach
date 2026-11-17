// Figures: the checks, and the kit for interactive pages. Every figure Teach makes has to look like part of the app, in chalk's visual language (the dark
// Manim ground, the 3b1b palette, the stage's serif and KaTeX), never a white box with a plotting library's
// defaults dropped into the lesson. The theme kit (public/figure.css + figure.js) styles a figure from the app's own
// tokens, so a figure only stays native if it leaves colour, fonts and background to the kit. These checks enforce
// that, without a browser, wherever a figure enters the lesson: `show`, `render`, notes' "Visualize it", and CI.
//   checkSvg(text)    an SVG figure (the contract: viewBox, no background, colour by class, fonts by the kit)
//   checkHtml(text)   an interactive page (its colours and fonts come from the kit's CSS variables / TF.color)
//   checkPng(buf)     a raster figure: refuses a light background (a white plot pasted in)
//   checkScene(spec)  a chalk scene (labels inside the frame, palette colours, no background rect)
// Each returns a list of problems (strings the tutor can act on); empty means it passes. withFigureKit(page) puts the
// kit into an interactive figure as the server sends it.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// The palette names a figure may use: the app's colour roles (public/style.css) = chalk's scene colours (scene.py).
export const PALETTE = ["ink", "dim", "blue", "yellow", "teal", "green", "gold", "red", "orange", "purple", "pink", "grey", "gray", "white"];

const NAMED = { white: "#ffffff", black: "#000000", red: "#ff0000", blue: "#0000ff", green: "#008000", yellow: "#ffff00", gray: "#808080", grey: "#808080",
  orange: "#ffa500", purple: "#800080", navy: "#000080", silver: "#c0c0c0", whitesmoke: "#f5f5f5", ivory: "#fffff0", beige: "#f5f5dc",
  snow: "#fffafa", linen: "#faf0e6", lightgray: "#d3d3d3", lightgrey: "#d3d3d3", gainsboro: "#dcdcdc", darkred: "#8b0000", crimson: "#dc143c",
  steelblue: "#4682b4", royalblue: "#4169e1", darkblue: "#00008b", teal: "#008080", tomato: "#ff6347", firebrick: "#b22222", magenta: "#ff00ff", cyan: "#00ffff" };

// A colour literal -> [r, g, b] 0..255, or null when it isn't one (none, currentColor, var(...), url(...)).
export function parseColor(v) {
  const s = String(v || "").trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
    if (h.length < 6) return null;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) return [m[1], m[2], m[3]].map(Number);
  m = s.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/);
  if (m) {   // (only its lightness matters here)
    const l = Number(m[3]) / 100, v = Math.round(l * 255);
    return [v, v, v];
  }
  return NAMED[s] ? parseColor(NAMED[s]) : null;
}

// Relative luminance, 0 (black) .. 1 (white).
export function luminance([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const COLOR_PROPS = ["fill", "stroke", "stop-color", "flood-color", "lighting-color", "color", "background", "background-color"];
const GENERATORS = /\b(matplotlib|plotly|gnuplot|bokeh|seaborn|altair|vega-lite|highcharts|chart\.js)\b/i;
const list = (m, n = 6) => [...m].slice(0, n).map(([k, c]) => `${k}${c > 1 ? ` ×${c}` : ""}`).join(", ") + (m.size > n ? `, and ${m.size - n} more` : "");
const short = (s, n = 40) => { s = String(s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

// CSS declarations in a style attribute or a <style> block: [prop, value] pairs.
function declarations(css) {
  return String(css).replace(/\/\*[\s\S]*?\*\//g, "").split(/[;{}]/).map((d) => d.split(":")).filter((p) => p.length >= 2)
    .map(([k, ...v]) => [k.trim().toLowerCase(), v.join(":").trim()]).filter(([k]) => /^[a-z-]+$/.test(k));
}

// ---------- SVG ----------

export function checkSvg(text) {
  const out = [];
  const src = String(text || "");
  const tag = (src.match(/<svg\b[^>]*>/i) || [""])[0];
  if (!tag) return ["not an SVG (no <svg> element)"];
  const gen = src.match(GENERATORS);
  if (gen) out.push(`made by ${gen[1]}: plotting-library output keeps its own white, default look. Draw it to the figure contract instead (SKILL.md, Visuals), or make it a scene`);
  if (!/\bviewBox="[^"]+"/.test(tag)) out.push('the <svg> needs a viewBox (e.g. viewBox="0 0 440 280"): the board sizes figures from it');
  if (/<script\b|\son[a-z]+\s*=|javascript:/i.test(src)) out.push("no scripts or event handlers in a figure SVG (an interactive figure is an HTML page or a scene)");
  if (/<foreignObject\b/i.test(src)) out.push("no <foreignObject>: write math as $…$ inside a <text>, and the app typesets it with KaTeX");
  if (/<style\b/i.test(src)) out.push("no <style> block: the figure goes into the page itself, and the theme's classes do the styling");
  // links: only inside the figure (#id). The browser drops tabs and newlines inside a scheme ("java&#9;script:"), so
  // the value is decoded and squeezed first; anything else in another namespace (an HTML <meta>, <link>, <form>) goes too.
  const decode = (v) => v.replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&#(\d+);?/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&(tab|newline);/gi, " ").replace(/&colon;/gi, ":").replace(/&amp;/gi, "&");
  for (const m of src.matchAll(/\s([\w-]+:)?href\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const v = decode(m[3] ?? m[4] ?? "").replace(/[\x00-\x20]/g, "");
    if (!v.startsWith("#") && !/^data:image\/(png|jpe?g|gif|webp);/i.test(v)) { out.push(`a link to "${short(v, 30)}": links in a figure only point inside it (#id), and pictures in it are data: images`); break; }
  }
  for (const m of src.matchAll(/\sxmlns:([\w-]+)\s*=\s*"([^"]*)"/gi)) if (!/svg|xlink/i.test(m[2])) { out.push(`namespace ${m[1]} (${short(m[2], 30)}): a figure holds SVG only`); break; }
  if (/\son[a-z]+\s*=/i.test(src.replace(/&#\d+;|&#x[0-9a-f]+;/gi, ""))) out.push("no event handlers in a figure");

  // colour: every paint goes through the theme (a class, var(--…), currentColor), never a literal, so the figure
  // follows the app's dark (and light) theme. A literal is the classic white box or #222 ink.
  const literals = new Map();
  const note = (prop, val) => {
    const v = val.trim();
    if (!v || /^(none|transparent|currentcolor|inherit|context-(fill|stroke))$/i.test(v) || /^(var|url)\(/i.test(v)) return;
    if (!parseColor(v)) return;
    literals.set(`${prop}="${v}"`, (literals.get(`${prop}="${v}"`) || 0) + 1);
  };
  for (const m of src.matchAll(/\s(fill|stroke|stop-color|flood-color|lighting-color|color)\s*=\s*"([^"]*)"/gi)) note(m[1].toLowerCase(), m[2]);
  const css = [...src.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map((m) => m[1]).concat([...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]));
  for (const block of css) for (const [k, v] of declarations(block)) {
    if (COLOR_PROPS.includes(k)) note(k, v);
    if (k === "font-family" || k === "font") out.push(`style sets ${k}: ${short(v)}. Fonts come from the theme (the stage serif, KaTeX for $…$); leave them out`);
  }
  if (literals.size) out.push(`colour codes ${list(literals)}: colour with a theme class instead (class="red", "blue", "dim", … on the element or a group) or var(--red), so the figure follows the app's theme`);
  if (/\sfont-family\s*=/i.test(src)) out.push("font-family is set: fonts come from the theme (the stage serif, KaTeX for $…$); leave it out");

  // a background: a rect (or the svg itself) painted under the whole figure. The board's card is the ground.
  const vb = (tag.match(/viewBox="([^"]+)"/) || [])[1]?.trim().split(/[\s,]+/).map(Number);
  const [vw, vh] = vb && vb.length === 4 ? [vb[2], vb[3]] : [Number((tag.match(/\swidth="([\d.]+)/) || [])[1]) || 0, Number((tag.match(/\sheight="([\d.]+)/) || [])[1]) || 0];
  for (const m of src.matchAll(/<rect\b([^>]*)>/gi)) {
    const a = m[1], num = (n) => { const x = a.match(new RegExp(`\\s${n}="([\\d.]+)(%?)"`)); return x ? (x[2] ? (n === "width" || n === "x" ? vw : vh) * Number(x[1]) / 100 : Number(x[1])) : null; };
    const w = num("width"), h = num("height");
    const filled = !/\sfill="(none|transparent)"/i.test(a) && !/class="[^"]*\b(outline|frame)\b/.test(a);
    if (filled && vw && vh && w && h && w * h >= 0.85 * vw * vh) { out.push("a rect fills the whole figure: drop the background, the board's card is the figure's ground"); break; }
  }
  if (/<svg\b[^>]*style="[^"]*background/i.test(tag)) out.push("the <svg> has a background: drop it, the board's card is the figure's ground");
  return [...new Set(out)];
}

// ---------- interactive HTML ----------

export function checkHtml(text) {
  const out = [];
  const src = String(text || "");
  const gen = src.match(GENERATORS);
  if (gen && !/teach-figure-kit/.test(src)) out.push(`made with ${gen[1]}: its default look won't match the app. Draw with canvas/SVG and the kit (TF.color, the CSS variables)`);
  if (/<(script|link)\b[^>]*(src|href)="(https?:)?\/\//i.test(src)) out.push("loads something from the web: figures run offline, keep it self-contained");
  const lit = new Map();
  const add = (where, v) => { const k = `${where} ${short(v, 24)}`; lit.set(k, (lit.get(k) || 0) + 1); };
  // CSS (style blocks and attributes)
  const css = [...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).concat([...src.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map((m) => m[1]));
  for (const block of css) for (const [k, v] of declarations(block)) {
    if (k === "font-family" && !/^var\(/i.test(v)) out.push(`CSS sets font-family: ${short(v)}. Use var(--font-ui), var(--font-math) or var(--font-mono) (or leave it to the kit)`);
    if (/(^|-)(color|background|fill|stroke|border|outline|shadow)/.test(k)) for (const c of v.replace(/var\([^)]*\)/g, "").match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b[a-z]+\b/gi) || []) if (parseColor(c)) add(`CSS ${k}:`, c);
  }
  // script: canvas paint and inline colours
  for (const s of [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].replace(/TF\.color\(\s*(["'`])[^"'`]*\1\s*\)/g, "TF.color()"))) {
    for (const m of s.matchAll(/(["'`])(#[0-9a-f]{3,8}|rgba?\([^"'`]*\)|hsla?\([^"'`]*\)|white|black|red|blue|green|gr[ae]y|orange|purple|navy|silver|steelblue|crimson|tomato)\1/gi)) add("script colour", m[2]);
    if (/\.font\s*=\s*["'`][^"'`]*\b(sans-serif|serif|arial|helvetica|system-ui|monospace)\b/i.test(s) && !/TF\.font/.test(s)) out.push("canvas text sets its own font: use TF.font(size) so it's the stage serif");
  }
  if (lit.size) out.push(`colour codes ${list(lit)}: use the theme instead (var(--red), var(--ink), var(--card) in CSS; TF.color("red") in canvas code), so it matches the app and its light/dark switch`);
  return [...new Set(out)];
}

// ---------- PNG ----------

// Decode an 8-bit PNG (any colour type, not interlaced) to { w, h, px(x, y) -> [r, g, b, a] }. Enough for the checks
// here; anything else (16-bit, interlaced, palette) comes back null and is only checked by its SVG source.
export function decodePng(buf) {
  if (!buf || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let o = 8, w = 0, h = 0, depth = 0, type = 0, inter = 0;
  const idat = [];
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o), kind = buf.toString("latin1", o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
    if (kind === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; inter = d[12]; }
    else if (kind === "IDAT") idat.push(d);
    else if (kind === "IEND") break;
    o += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || inter || !ch || !w || !h) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = w * ch, img = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), at = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? img[at + x - ch] : 0, b = y ? img[at - stride + x] : 0, c = x >= ch && y ? img[at - stride + x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      img[at + x] = v & 255;
    }
  }
  const px = (x, y) => {
    const i = y * stride + x * ch;
    if (ch === 1) return [img[i], img[i], img[i], 255];
    if (ch === 2) return [img[i], img[i], img[i], img[i + 1]];
    return [img[i], img[i + 1], img[i + 2], ch === 4 ? img[i + 3] : 255];
  };
  return { w, h, px };
}

// A raster figure's ground: the pixels of its outer ring (where a plot's background shows). Light = a white figure.
// Transparent pixels count as the board's own ground (they show the card through).
// `inset` (a fraction of the size) samples a ring that far in instead: for a picture of a card on its own ground.
export function checkPng(buf, { name = "the image", inset = 0 } = {}) {
  const meta = buf ? buf.toString("latin1", 0, Math.min(buf.length, 4096)) : "";
  const out = [];
  const gen = meta.match(/Software\0?\s*(matplotlib|plotly|gnuplot|bokeh)/i) || meta.match(GENERATORS);
  if (gen) out.push(`${name} was made by ${gen[1]}: plotting-library output keeps its default white look. Draw it as a themed SVG or a scene`);
  const png = decodePng(buf);
  if (!png) return out;
  const { w, h, px } = png;
  let n = 0, light = 0;
  const ring = Math.max(2, Math.round(Math.min(w, h) * 0.02)), step = Math.max(1, Math.round((w + h) / 400)), o = Math.round(Math.min(w, h) * inset);
  const look = (x, y) => { const [r, g, b, a] = px(x, y); n++; if (a > 200 && luminance([r, g, b]) > 0.55) light++; };
  for (let x = o; x < w - o; x += step) for (let k = o; k < o + ring; k++) { look(x, k); look(x, h - 1 - k); }
  for (let y = o; y < h - o; y += step) for (let k = o; k < o + ring; k++) { look(k, y); look(w - 1 - k, y); }
  if (n && light / n > 0.5) out.push(`${name} has a light background (${Math.round(100 * light / n)}% of its edge is near-white): figures sit on the dark board. Leave the background out (transparent) or use the theme's ground`);
  return out;
}

// ---------- chalk scenes ----------

// Rough text extents in canvas units (chalk's own rule of thumb: ~8 units a character at size 15).
function textWidth(s, size, tex) {
  let t = String(s || "");
  if (tex || t.includes("$")) t = t.replace(/\\(frac|dfrac|tfrac)\{([^{}]*)\}\{([^{}]*)\}/g, (_, __, a, b) => (a.length > b.length ? a : b))
    .replace(/\\(left|right|,|;|!|quad|qquad|mathrm|text|vec|hat|bar|mathbf|operatorname)\b/g, "").replace(/\\[a-zA-Z]+/g, "x").replace(/[{}^_$]/g, "");
  t = t.replace(/\{[^{}:]+(:[^{}]*)?\}/g, "0.00");   // a live value
  return t.length * size * 0.53;
}

export function checkScene(spec) {
  const out = [];
  const sc = spec && typeof spec === "object" ? (spec.scene && typeof spec.scene === "object" ? spec.scene : spec) : null;
  if (!sc || !Array.isArray(sc.objects) || !sc.objects.length) return ["the scene needs objects"];
  const [W, H] = Array.isArray(sc.size) ? sc.size.map(Number) : [520, 300];
  if (!(W >= 200 && W <= 700 && H >= 140 && H <= 460)) out.push(`size ${W}x${H}: keep scenes about 520x300 (200-700 wide, 140-460 high)`);
  if (sc.theme && sc.theme !== "dark") out.push(`theme "${sc.theme}": leave theme out, the app picks it to match its own`);
  if (sc.objects.length > 40) out.push(`${sc.objects.length} objects: keep it to 6-18 (one idea per scene)`);
  const num = (v) => (typeof v === "number" ? v : typeof v === "string" && /^-?[\d.]+$/.test(v.trim()) ? Number(v) : null);
  const boxes = [];
  for (const o of sc.objects) {
    const id = o.id || Object.keys(o)[0];
    for (const k of ["color", "fill"]) {
      const c = o[k];
      if (typeof c === "string" && !PALETTE.includes(c.toLowerCase())) out.push(`${id}: ${k} "${c}" isn't a theme colour (use ${PALETTE.filter((p) => !["ink", "dim", "gray", "white"].includes(p)).join(", ")})`);
    }
    // TeX outside $…$ in plain text shows as its source ("\Phi = BA"): a text, label or caption with a command in it
    for (const k of ["text", "label"]) {
      const t = o[k];
      if (typeof t === "string" && /\\[a-zA-Z]+/.test(t.replace(/\$[^$]*\$/g, ""))) out.push(`${id}: ${k} "${short(t, 30)}" has TeX outside $…$, so it shows as source: wrap the math in $…$ (or make it a tex object)`);
    }
    if (o.on) continue;   // data units on axes: chalk clamps those into the axes
    if (Array.isArray(o.rect) && (o.fill === true || typeof o.fill === "string")) {
      const [, , w, h] = o.rect.map(num);
      if (w && h && w * h >= 0.8 * W * H) out.push(`${id}: a filled rect covers the whole scene: drop the background, the scene has the app's ground`);
    }
    const label = o.text ?? o.tex;
    if (label !== undefined && Array.isArray(o.at)) {
      const [x, y] = o.at.map(num);
      if (x === null || y === null) continue;
      const size = num(o.size) || (o.tex !== undefined ? 22 : 15), w = textWidth(label, size, o.tex !== undefined);
      const al = o.align || "left", x0 = al === "center" ? x - w / 2 : al === "right" ? x - w : x;
      const box = { id, x0, x1: x0 + w, y0: y - size * 0.95, y1: y + size * 0.3 };
      if (box.x0 < 2 || box.x1 > W - 2) out.push(`${id}: "${short(label, 30)}" runs past the ${box.x0 < 2 ? "left" : "right"} edge (about ${Math.round(box.x0)}..${Math.round(box.x1)} of ${W} wide): move it in, shorten it, or make it smaller`);
      if (box.y0 < 0 || box.y1 > H) out.push(`${id}: "${short(label, 30)}" runs past the ${box.y0 < 0 ? "top" : "bottom"} (baseline y ${y}, size ${size}, ${H} high)`);
      boxes.push(box);
    }
    for (const k of ["line", "arrow", "rect", "circle"]) {
      const v = Array.isArray(o[k]) ? o[k].map(num) : null;
      if (!v || v.some((n) => n === null)) continue;
      const xs = k === "rect" ? [v[0], v[0] + v[2]] : k === "circle" ? [v[0] - v[2], v[0] + v[2]] : [v[0], v[2]];
      const ys = k === "rect" ? [v[1], v[1] + v[3]] : k === "circle" ? [v[1] - v[2], v[1] + v[2]] : [v[1], v[3]];
      if (Math.min(...xs) < -1 || Math.max(...xs) > W + 1 || Math.min(...ys) < -1 || Math.max(...ys) > H + 1) out.push(`${id}: the ${k} goes outside the ${W}x${H} canvas`);
    }
  }
  for (const [i, st] of (Array.isArray(sc.steps) ? sc.steps : []).entries()) {
    if (typeof st?.say === "string" && /\\[a-zA-Z]+|\$/.test(st.say)) out.push(`step ${i + 1}: its "say" is plain text (no TeX): write "Φ = BA", not "\\Phi = BA"`);
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (ix > 0 && iy > 0 && ix * iy > 0.2 * Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0))) out.push(`${a.id} and ${b.id}: their text overlaps; move one`);
  }
  return [...new Set(out)];
}

// ---------- a file ----------

// The figure at `file`, checked by its kind. A PNG made from an SVG next to it is checked by the SVG (the source the
// tutor edits); a PNG from anywhere else by its pixels.
export function checkFigureFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".svg") return checkSvg(fs.readFileSync(file, "utf8"));
  if (ext === ".html" || ext === ".htm") return checkHtml(fs.readFileSync(file, "utf8"));
  if (ext === ".png") {
    const svg = file.replace(/\.png$/i, ".svg");
    if (fs.existsSync(svg)) return checkSvg(fs.readFileSync(svg, "utf8"));
    return checkPng(fs.readFileSync(file), { name: path.basename(file) });
  }
  if (ext === ".json") { try { return checkScene(JSON.parse(fs.readFileSync(file, "utf8"))); } catch (e) { return [`not a scene: ${e.message}`]; } }
  return [];
}

// ---------- the kit, in an interactive figure ----------

// An interactive figure the tutor wrote, with the figure kit put in at the top of its <head> (its own styles still come
// after, so a page made before the kit keeps its look): the app's tokens and fonts, the chalk-style base look,
// KaTeX and figure.js (TF.color, TF.font, $…$ typeset). `theme` follows the page that shows it.
export function withFigureKit(page, theme = "dark") {
  const kit = `<script>document.documentElement.setAttribute("data-teach-figure","");document.documentElement.dataset.theme=${JSON.stringify(theme === "light" ? "light" : "dark")};</script>` +
    `<link rel="stylesheet" href="/style-tokens.css"><link rel="stylesheet" href="/vendor/katex.min.css"><link rel="stylesheet" href="/figure.css"><link rel="stylesheet" href="/figure-page.css">` +
    `<script src="/vendor/katex.min.js"></script><script src="/figure.js"></script><!-- teach-figure-kit -->`;
  const text = String(page);
  if (/<head\b[^>]*>/i.test(text)) return text.replace(/<head\b[^>]*>/i, (m) => m + kit);
  if (/<html\b[^>]*>/i.test(text)) return text.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${kit}</head>`);
  return (/^\s*<!doctype/i.test(text) ? text.replace(/^\s*<!doctype[^>]*>/i, (m) => `${m}<head>${kit}</head>`) : `<!doctype html><head>${kit}</head>`) + (/^\s*<!doctype/i.test(text) ? "" : text);
}
