// Printable documents: Markdown (with LaTeX math and images) → a PDF laid out to a page budget, with headless Chrome
// and no other dependencies. It backs the end-of-session actions (lib/actions.mjs): a note sheet that must fit the
// one sheet a course allows, a worksheet and its key, a reference card, lesson notes.
//
// How the fit works: the page lays the content out in fixed-height columns (CSS multi-column with a set height), so
// whatever doesn't fit spills into extra columns to the right, and the last element's column says how many pages the
// content needs. With "auto" font it binary-searches the largest size that fits the page budget. Each printed page is
// then a page-sized window onto that one layout (clones shifted left page by page), so what was measured is exactly
// what prints. Formulas and tables too wide for a column are scaled down to fit (down to 70%); anything that still
// doesn't fit, math that doesn't parse and images that don't load come back as problems, with PNG previews of the
// pages, so the tutor can fix the source and render again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { APP } from "./paths.mjs";
import { which } from "./platform.mjs";
import { findChrome, chromeArgs } from "../skill/render-svg.mjs";

// Paper sizes in inches, portrait (width, height). Index cards print landscape.
export const PAPERS = {
  letter: { w: 8.5, h: 11, label: "Letter (8.5 × 11 in)" },
  a4: { w: 8.27, h: 11.69, label: "A4" },
  "half-letter": { w: 5.5, h: 8.5, label: "Half letter (5.5 × 8.5 in)" },
  "index-3x5": { w: 5, h: 3, label: "Index card (3 × 5 in)" },
  "index-4x6": { w: 6, h: 4, label: "Index card (4 × 6 in)" },
};
export const STYLES = ["sheet", "doc"];   // sheet: dense, columns, sans, black heading bars; doc: one column, serif, page numbers

export function normalizeLayout(inp = {}) {
  const style = STYLES.includes(inp.style) ? inp.style : "doc";
  const paper = PAPERS[inp.paper] ? inp.paper : "letter";
  const small = paper.startsWith("index");
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const font = inp.font === "auto" || inp.font === undefined || inp.font === "" ? "auto" : num(inp.font, 4.5, 16, "auto");
  return {
    style, paper,
    pages: Math.round(num(inp.pages, 1, 40, style === "sheet" ? 2 : 6)),
    columns: Math.round(num(inp.columns, 1, 5, style === "sheet" ? (small ? 2 : 3) : 1)),
    font,
    minFont: num(inp.minFont, 4.5, 14, style === "sheet" ? 5.5 : 9),
    maxFont: num(inp.maxFont, 5, 16, style === "sheet" ? (small ? 8 : 10.5) : 11.5),
    margin: num(inp.margin, 0.15, 1.25, style === "sheet" ? (small ? 0.18 : 0.3) : 0.65),
    title: String(inp.title || "").slice(0, 160),
    footer: inp.footer !== undefined ? !!inp.footer : style === "doc",
  };
}

// ---------- the page ----------

const fileUrl = (p) => pathToFileURL(p).href;
const FONT_DIR = path.join(APP, "public", "fonts");
const VENDOR = path.join(APP, "public", "vendor");

function fontFaces() {
  const f = (file) => fileUrl(path.join(FONT_DIR, file));
  return `
@font-face{font-family:"Doc Sans";font-weight:200 900;font-style:normal;src:url("${f("source-sans-3-latin-wght-normal.woff2")}") format("woff2")}
@font-face{font-family:"Doc Sans";font-weight:200 900;font-style:normal;src:url("${f("source-sans-3-greek-wght-normal.woff2")}") format("woff2");unicode-range:U+0370-03FF}
@font-face{font-family:"Doc Sans";font-weight:200 900;font-style:italic;src:url("${f("source-sans-3-latin-wght-italic.woff2")}") format("woff2")}
@font-face{font-family:"Doc Serif";font-weight:400 700;font-style:normal;src:url("${f("source-serif-4-latin-standard-normal.woff2")}") format("woff2")}
@font-face{font-family:"Doc Serif";font-weight:400 700;font-style:normal;src:url("${f("source-serif-4-greek-standard-normal.woff2")}") format("woff2");unicode-range:U+0370-03FF}
@font-face{font-family:"Doc Serif";font-weight:400 700;font-style:italic;src:url("${f("source-serif-4-latin-standard-italic.woff2")}") format("woff2")}
@font-face{font-family:"Doc Mono";font-weight:400;src:url("${f("jetbrains-mono-latin-400-normal.woff2")}") format("woff2")}`;
}

// Runs inside the page: Markdown → HTML (the app's own rules: math lifted out before Markdown, raw HTML escaped,
// absolute image paths as file URLs), then the fit, then the print pages. Writes its findings to #result.
const PAGE_JS = String.raw`
(async () => {
  const O = JSON.parse(document.getElementById("opts").textContent);
  const src = JSON.parse(document.getElementById("src").textContent);
  const q = new URLSearchParams(location.search);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const problems = [];
  // directives, one per line: ::: break | ::: space 1.5in | ::: lines 6 | ::: box 1in
  const dirs = [];
  const text = src.replace(/^:::\s*(break|space|lines|box)\b[ \t]*([^\n]*)$/gm, (_, k, arg) => { dirs.push({ k, arg: arg.trim() }); return "\n@@D" + (dirs.length - 1) + "@@\n"; });
  const len = (a, d) => { const m = String(a).match(/^([\d.]+)\s*(in|cm|mm|pt|lines?)?$/); if (!m) return d; const v = Number(m[1]); const u = m[2] || "in"; return u.startsWith("line") ? (v * 1.9) + "em" : v + u; };
  const dirHtml = (d) => d.k === "break" ? '<div class="brk"></div>'
    : d.k === "space" ? '<div class="space" style="height:' + len(d.arg || "1in", "1in") + '"></div>'
    : d.k === "box" ? '<div class="box" style="height:' + len(d.arg || "0.8in", "0.8in") + '"></div>'
    : '<div class="lines">' + '<i></i>'.repeat(Math.min(40, Math.max(1, Number(d.arg) || 4))) + '</div>';
  marked.use({ gfm: true, renderer: {
    html({ text }) { return esc(text); },
    image({ href, text }) {
      let s = href || "";
      if (s.startsWith("file://")) s = decodeURIComponent(s.slice(7));
      const url = s.startsWith("/") ? "file://" + encodeURI(s) : s;
      return '<figure><img src="' + esc(url) + '" alt="' + esc(text || "") + '">' + (text ? "<figcaption>" + esc(text) + "</figcaption>" : "") + "</figure>";
    },
  } });
  const math = [];
  const slot = (tex, display) => { math.push({ tex, display }); return "@@M" + (math.length - 1) + "@@"; };
  const parts = text.split(/(\x60\x60\x60[\s\S]*?(?:\x60\x60\x60|$)|\x60[^\x60\n]+\x60)/g);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]
      .replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, a, b) => slot(a ?? b, true))
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, a) => slot(a, false))
      .replace(/(^|[^\\$\w])\$(?=\S)([^$\n]+?)(?<=\S)\$(?![\w$])/g, (_, pre, a) => pre + slot(a, false));
  }
  let html = marked.parse(parts.join(""));
  html = html.replace(/@@M(\d+)@@/g, (_, n) => {
    const m = math[+n];
    try {
      const k = katex.renderToString(m.tex, { displayMode: m.display, throwOnError: true, strict: "ignore" });
      return m.display ? '<div class="mathd">' + k + "</div>" : k;
    } catch (e) {
      problems.push({ kind: "math", text: m.tex.slice(0, 120), why: String(e.message).replace(/^KaTeX parse error: /, "").slice(0, 160) });
      return '<code class="bad">' + esc(m.tex) + "</code>";
    }
  }).replace(/<p>\s*@@D(\d+)@@\s*<\/p>|@@D(\d+)@@/g, (_, a, b) => dirHtml(dirs[+(a ?? b)]));

  const flow = document.getElementById("flow");
  flow.innerHTML = (O.title && !/^\s*#\s/.test(src) ? "<h1>" + esc(O.title) + "</h1>" : "") + html + '<span id="end"></span>';
  // Wait with timers, not promises: headless Chrome's virtual-time budget (what --dump-dom and --print-to-pdf wait on)
  // only waits for pending timers, so a bare await on fonts or an image's decode() let it dump an unfinished page.
  const tick = () => new Promise((r) => setTimeout(r, 25));
  const imgs = [...flow.querySelectorAll("img")];
  for (let i = 0; i < 400 && (document.fonts.status !== "loaded" || imgs.some((im) => !im.complete)); i++) await tick();
  for (const im of imgs) if (!im.complete || !im.naturalWidth) problems.push({ kind: "image", text: decodeURIComponent(im.getAttribute("src")).replace(/^file:\/\//, ""), why: "didn't load" });
  await tick();

  const IN = 96, colGap = O.style === "sheet" ? 0.14 : 0.3;
  const cw = (O.w - 2 * O.margin) * IN, ch = (O.h - 2 * O.margin - (O.footer ? 0.28 : 0)) * IN;
  const colW = (cw - (O.columns - 1) * colGap * IN) / O.columns, pitch = colW + colGap * IN;
  Object.assign(flow.style, { width: cw + "px", height: ch + "px", columnCount: O.columns, columnGap: colGap + "in" });

  const fit = () => {   // wide formulas and tables: scale them to the column (down to 70%)
    for (const e of flow.querySelectorAll(".mathd, table, pre")) {
      e.style.fontSize = "";
      const need = e.scrollWidth, have = colW;
      if (need > have + 1) e.style.fontSize = Math.max(0.7, have / need) * 100 + "%";
    }
  };
  const pagesAt = (pt) => {
    flow.style.fontSize = pt + "pt";
    fit();
    const end = document.getElementById("end").getBoundingClientRect(), box = flow.getBoundingClientRect();
    const col = Math.max(0, Math.floor((end.left - box.left + 2) / pitch));
    return Math.ceil((col + 1) / O.columns);
  };
  let font, pages, fits;
  if (q.get("font")) { font = Number(q.get("font")); pages = pagesAt(font); fits = pages <= O.pages; }
  else if (O.font !== "auto") { font = O.font; pages = pagesAt(font); fits = pages <= O.pages; }
  else {
    let lo = O.minFont, hi = O.maxFont;
    if (pagesAt(hi) <= O.pages) font = hi;
    else if (pagesAt(lo) > O.pages) font = lo;
    else { for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (pagesAt(mid) <= O.pages) lo = mid; else hi = mid; } font = Math.floor(lo * 20) / 20; }
    pages = pagesAt(font); fits = pages <= O.pages;
  }
  // what's still too wide for its column after scaling
  for (const e of flow.querySelectorAll(".mathd, table, pre, figure img")) {
    if (e.scrollWidth > colW + 2) problems.push({ kind: "wide", text: (e.textContent || e.getAttribute("alt") || e.tagName).replace(/\s+/g, " ").trim().slice(0, 80), why: "wider than the column even at 70%" });
  }
  const used = (() => {   // how full the last page is, by columns
    const end = document.getElementById("end").getBoundingClientRect(), box = flow.getBoundingClientRect();
    const col = Math.max(0, Math.floor((end.left - box.left + 2) / pitch));
    return { lastCols: (col % O.columns) + 1, lastColFill: Math.min(1, Math.max(0, (end.top - box.top) / ch)) };
  })();
  const result = { pages, font, fits, columns: O.columns, problems, ...used };
  if (!fits && O.font === "auto") result.needPages = pages;

  // print pages: windows onto the one layout
  const view = q.get("page");
  const host = document.getElementById("pages");
  const n = Math.max(1, pages);
  for (let p = 0; p < n; p++) {
    if (view !== null && Number(view) !== p) continue;
    const pg = document.createElement("section");
    pg.className = "page";
    const win = document.createElement("div");
    win.className = "win";
    const c = flow.cloneNode(true);
    c.removeAttribute("id");
    c.style.marginLeft = (-p * O.columns * pitch) + "px";
    win.append(c);
    pg.append(win);
    if (O.footer) { const f = document.createElement("footer"); f.textContent = (O.title ? O.title + " · " : "") + "page " + (p + 1) + " of " + n; pg.append(f); }
    host.append(pg);
  }
  flow.remove();
  const out = document.getElementById("result");
  out.textContent = JSON.stringify(result);
  document.title = "ready";
})().catch((e) => { document.getElementById("result").textContent = JSON.stringify({ error: String(e && e.stack || e) }); document.title = "ready"; });
`;

function pageCss(L) {
  const P = PAPERS[L.paper];
  const sheet = L.style === "sheet";
  return `${fontFaces()}
@page{size:${P.w}in ${P.h}in;margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:${sheet ? '"Doc Sans"' : '"Doc Serif"'},"DejaVu Sans",Arial,sans-serif}
#flow{position:absolute;left:0;top:0;column-fill:auto;line-height:${sheet ? 1.2 : 1.42};${sheet ? "column-rule:0.5pt solid #999;" : ""}overflow:visible}
.page{position:relative;width:${P.w}in;height:${P.h}in;overflow:hidden;break-after:page;page-break-after:always}
.page:last-child{break-after:auto;page-break-after:auto}
.win{position:absolute;left:${L.margin}in;top:${L.margin}in;right:${L.margin}in;bottom:${L.margin + (L.footer ? 0.28 : 0)}in;overflow:hidden}
.win > div{position:absolute;left:0;top:0;column-fill:auto;line-height:${sheet ? 1.2 : 1.42};${sheet ? "column-rule:0.5pt solid #999;" : ""}}
footer{position:absolute;left:${L.margin}in;right:${L.margin}in;bottom:${Math.max(0.12, L.margin - 0.1)}in;font:400 7.5pt "Doc Sans",sans-serif;color:#555;text-align:right}
h1{font:700 1.3em/1.15 "Doc Sans",sans-serif;margin:0 0 .35em;padding-bottom:.15em;border-bottom:1.2pt solid #000;break-after:avoid}
h2{font:700 1.05em/1.2 "Doc Sans",sans-serif;margin:.55em 0 .25em;break-after:avoid;${sheet ? "background:#000;color:#fff;padding:.1em .35em" : "border-bottom:0.6pt solid #888;padding-bottom:.1em"}}
h3{font:700 1em/1.2 "Doc Sans",sans-serif;margin:.45em 0 .15em;break-after:avoid}
h4{font:600 .95em/1.2 "Doc Sans",sans-serif;margin:.35em 0 .1em;break-after:avoid}
h1+*,h2+*,h3+*{break-before:avoid}
p{margin:${sheet ? ".18em 0" : ".45em 0"}}
ul,ol{margin:${sheet ? ".1em 0" : ".35em 0"};padding-left:${sheet ? "1.1em" : "1.5em"}}
li{margin:${sheet ? ".05em 0" : ".15em 0"}}
li>p{margin:.1em 0}
${sheet ? "" : "ol > li{break-inside:avoid}"}
ul:has(> li > input[type=checkbox]),ul.contains-task-list{list-style:none;padding-left:.2em}
li:has(> input[type=checkbox]){list-style:none}
li input[type=checkbox]{width:.95em;height:.95em;margin:0 .45em 0 0;vertical-align:-.1em}
table{border-collapse:collapse;width:100%;margin:.3em 0;break-inside:avoid;font-size:.94em}
th,td{border:.5pt solid #555;padding:.08em .3em;text-align:left;vertical-align:top}
th{background:#ddd}
code{font-family:"Doc Mono",monospace;font-size:.9em}
pre{margin:.3em 0;padding:.25em .4em;border:.5pt solid #777;background:#f2f2f2;break-inside:avoid;white-space:pre-wrap;overflow-wrap:anywhere}
pre code{font-size:.86em;line-height:1.2}
code.bad{background:#fdd;color:#900}
.mathd{margin:.25em 0;break-inside:avoid;overflow:hidden;text-align:${sheet ? "left" : "center"}}
.mathd .katex-display{margin:0}
.katex{font-size:1.05em}
figure{margin:.3em 0;break-inside:avoid;text-align:center}
figure img{max-width:100%;max-height:${sheet ? "2.4in" : "4in"};height:auto}
figcaption{font-size:.85em;color:#333}
blockquote{margin:.3em 0;padding:.2em .5em;background:#f1f1f1}
hr{border:0;border-top:.6pt solid #999;margin:.4em 0}
strong{font-weight:700}
.brk{break-before:column;height:0}
.space{break-inside:avoid}
.box{border:.6pt solid #444;border-radius:3pt;margin:.3em 0;break-inside:avoid}
.lines{break-inside:avoid;margin:.2em 0}
.lines i{display:block;height:1.9em;border-bottom:.5pt solid #999}
#end{display:block;height:1px}`;
}

export function pageHtml(markdown, L) {
  const P = PAPERS[L.paper];
  const json = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>render</title>
<link rel="stylesheet" href="${fileUrl(path.join(VENDOR, "katex.min.css"))}">
<style>${pageCss(L)}</style>
<script src="${fileUrl(path.join(VENDOR, "marked.umd.js"))}"></script>
<script src="${fileUrl(path.join(VENDOR, "katex.min.js"))}"></script>
</head><body>
<div id="flow"></div><div id="pages"></div>
<script type="application/json" id="opts">${json({ ...L, w: P.w, h: P.h })}</script>
<script type="application/json" id="src">${json(markdown)}</script>
<script type="application/json" id="result"></script>
<script>${PAGE_JS}</script>
</body></html>`;
}

// ---------- Chrome ----------

function chrome(args, { timeout = 90e3 } = {}) {
  const bin = findChrome();
  if (!bin) return Promise.reject(new Error("no Chrome, Edge or Chromium found to render with; install one or set TEACH_CHROME to its path"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "teach-doc-"));
  return new Promise((resolve, reject) => execFile(bin, [...chromeArgs(bin), "--no-pdf-header-footer", "--virtual-time-budget=20000", `--user-data-dir=${profile}`, ...args],
  { timeout, maxBuffer: 64 << 20, windowsHide: true }, (err, stdout, stderr) => {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    if (err && !stdout) reject(new Error(`the browser failed: ${String(stderr || err.message).trim().split("\n").pop()}`));
    else resolve(String(stdout));
  }));
}

// Pages in a PDF Chrome wrote (page objects are plain dictionaries in Skia's output).
export function pdfPages(file) {
  const b = fs.readFileSync(file, "latin1");
  return (b.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
}

async function previews(pdf, page, L, pages, outBase) {
  const files = [];
  const pdftoppm = which("pdftoppm");
  if (pdftoppm) {
    await new Promise((resolve) => execFile(pdftoppm, ["-png", "-r", PAPERS[L.paper].w <= 6 ? "150" : "100", pdf, outBase], { timeout: 60e3 }, () => resolve()));
    const dir = path.dirname(outBase), base = path.basename(outBase);
    for (const n of fs.readdirSync(dir).filter((f) => f.startsWith(base + "-") && f.endsWith(".png")).sort()) files.push(path.join(dir, n));
    if (files.length) return files;
  }
  const P = PAPERS[L.paper];
  for (let p = 0; p < pages; p++) {   // no poppler: Chrome screenshots of each page
    const out = `${outBase}-${p + 1}.png`;
    await chrome([`--window-size=${Math.round(P.w * 96)},${Math.round(P.h * 96)}`, "--force-device-scale-factor=1.3", `--screenshot=${out}`, `${fileUrl(page)}?page=${p}`]).catch(() => {});
    if (fs.existsSync(out)) files.push(out);
  }
  return files;
}

// Render `source` (a Markdown file) to `out` (a PDF). Returns what happened: pages, font, whether it fits the budget,
// problems to fix, preview PNGs (in a .previews folder beside the PDF).
export async function renderDoc(source, out, layout = {}, { preview = true } = {}) {
  const L = normalizeLayout(layout);
  const markdown = fs.readFileSync(source, "utf8");
  out = path.resolve(out || source.replace(/\.md$/i, "") + ".pdf");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // the page sits next to the output, not in /tmp: a snap-packaged Chromium can't read other users' /tmp
  const page = path.join(path.dirname(out), `.render-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(page, pageHtml(markdown, L));
  try {
    const dom = await chrome(["--dump-dom", fileUrl(page)]);
    const m = dom.match(/<script type="application\/json" id="result">([\s\S]*?)<\/script>/);
    let r;
    try { r = JSON.parse(m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")); } catch { throw new Error("the page didn't finish laying out"); }
    if (r.error) throw new Error(`layout failed: ${r.error.split("\n")[0]}`);
    fs.rmSync(out, { force: true });
    await chrome([`--print-to-pdf=${out}`, `${fileUrl(page)}?font=${r.font}`]);
    if (!fs.existsSync(out)) throw new Error("the browser made no PDF");
    const printed = pdfPages(out);
    const prevDir = path.join(path.dirname(out), ".previews");
    let pngs = [];
    if (preview) {
      fs.mkdirSync(prevDir, { recursive: true });
      const base = path.join(prevDir, path.basename(out, ".pdf"));
      for (const f of fs.readdirSync(prevDir)) if (f.startsWith(path.basename(base) + "-")) fs.rmSync(path.join(prevDir, f), { force: true });
      pngs = await previews(out, page, L, r.pages, base);
    }
    return { pdf: out, layout: L, pages: printed || r.pages, measured: r.pages, font: r.font, fits: r.fits && (printed || r.pages) <= L.pages,
      needPages: r.needPages, lastCols: r.lastCols, lastColFill: r.lastColFill, problems: r.problems, previews: pngs };
  } finally {
    fs.rmSync(page, { force: true });
  }
}

// The tutor's reading of a render: one paragraph it can act on.
export function describe(r) {
  const L = r.layout, P = PAPERS[L.paper];
  const lines = [`Rendered ${path.basename(r.pdf)}: ${r.pages} page${r.pages === 1 ? "" : "s"} of ${P.label}, ${L.columns} column${L.columns === 1 ? "" : "s"}, ${r.font} pt.`];
  if (!r.fits) lines.push(`DOESN'T FIT: the budget is ${L.pages} page${L.pages === 1 ? "" : "s"}${r.needPages ? `, and even at ${L.minFont} pt it needs ${r.needPages}` : ""}. Cut or tighten content (or fewer columns' worth of prose), then render again.`);
  else if (L.style === "sheet" && r.pages === L.pages && r.lastCols < L.columns) lines.push(`It fits with room to spare on the last page (${r.lastCols} of ${L.columns} columns used): fine, or add what would help most.`);
  if (L.style === "sheet" && r.font < 6.5) lines.push(`The font is small (${r.font} pt): readable when printed, but only if every line earns its place.`);
  for (const p of r.problems || []) lines.push(`Problem (${p.kind}): ${p.text}: ${p.why}.`);
  if (!(r.problems || []).length) lines.push("No layout problems found (no math errors, nothing too wide, every image loaded).");
  lines.push("Look at the page images below before you deliver it: headings stranded at a column's foot, a table split badly, a figure too small to read.");
  return lines.join("\n");
}
