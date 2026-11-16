#!/usr/bin/env node
// render-svg.mjs IN.svg [OUT.png]: rasterize an SVG with headless Chrome (or Edge, or Chromium) so a diagram can be
// looked at (Read the PNG) before it's shown to the learner. Prints the PNG's path. Inside the Teach app the tutor
// calls the teach tool `render`, which runs this same code. Size comes from the SVG's width/height or viewBox,
// scaled 2x for sharpness. TEACH_CHROME names the browser when it isn't found by itself.
// --no-sandbox: Chrome's own sandbox aborts inside agent sandboxes; the input is a local file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { which } from "../lib/platform.mjs";

export function svgSize(text) {
  const tag = (text.match(/<svg\b[^>]*>/s) || [""])[0];
  const attr = (n) => { const m = tag.match(new RegExp(`\\b${n}="([\\d.]+)(px)?"`)); return m ? Number(m[1]) : null; };
  let w = attr("width"), h = attr("height");
  if (!(w && h)) {
    const vb = tag.match(/viewBox="([^"]+)"/);
    [w, h] = vb ? vb[1].trim().split(/[\s,]+/).slice(2).map(Number) : [800, 600];
  }
  return [Math.max(1, Math.round(w)), Math.max(1, Math.round(h))];
}

export function findChrome({ platform = process.platform, env = process.env, exists = (f) => fs.existsSync(f) } = {}) {
  if (env.TEACH_CHROME) return env.TEACH_CHROME;
  if (platform === "darwin") {
    return ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser"].map((a) => `/Applications/${a}.app/Contents/MacOS/${a}`).find(exists)
      || ["google-chrome", "chromium"].map((c) => which(c, { platform, env, exists })).find(Boolean) || null;
  }
  if (platform === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean);
    const rel = ["Google\\Chrome\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe", "Chromium\\Application\\chrome.exe"];
    return rel.flatMap((r) => roots.map((d) => path.win32.join(d, r))).find(exists)
      || ["chrome", "msedge"].map((c) => which(c, { platform, env, exists })).find(Boolean) || null;   // Edge ships with Windows
  }
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map((c) => which(c, { platform, env, exists })).find(Boolean) || null;
}

export async function renderSvg(input, output) {
  const src = fs.realpathSync(input);
  const out = path.resolve(output || src.replace(/\.svg$/i, "") + ".png");
  const [w, h] = svgSize(fs.readFileSync(src, "utf8"));
  const chrome = findChrome();
  if (!chrome) throw new Error("no Chrome, Edge or Chromium found to render with; install one or set TEACH_CHROME to its path");
  // The wrapper page sits next to the SVG, not in /tmp: a snap-packaged Chromium can't read other users' /tmp.
  const page = path.join(path.dirname(src), `.render-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(page, `<html><body style="margin:0;background:#fff"><img src="${pathToFileURL(src).href}" style="width:${w}px;height:${h}px;display:block"></body></html>`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "teach-render-"));   // its own profile: works next to an open browser
  try {
    await new Promise((resolve, reject) => execFile(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
      `--user-data-dir=${profile}`, "--force-device-scale-factor=2", `--window-size=${w},${h}`, `--screenshot=${out}`, pathToFileURL(page).href],
      { timeout: 60e3, windowsHide: true }, (err) => (err && !fs.existsSync(out) ? reject(new Error(`the browser couldn't render it: ${err.message}`)) : resolve())));
  } finally {
    fs.rmSync(page, { force: true });
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
  if (!fs.existsSync(out)) throw new Error("the browser made no image");
  return out;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input) { console.error("usage: render-svg.mjs IN.svg [OUT.png]"); process.exit(2); }
  renderSvg(input, output).then((f) => console.log(f), (e) => { console.error(`render-svg: ${e.message}`); process.exit(1); });
}
