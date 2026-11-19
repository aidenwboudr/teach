// Render a figure the way the lesson board shows it: the SVG mounted by the figure kit (public/figure.js + figure.css,
// on the app's own stylesheet, fonts and KaTeX) on a note card's ground, in headless Chrome, driven over the DevTools
// protocol on a pipe (no port, no dependencies). Returns the PNG and the kit's layout check (labels past the frame,
// on each other, on lines), so what the tutor looks at is what the learner gets, and what's wrong comes back in words.
//   renderFigure(svgPath, { out, theme }) -> { png, problems, width, height }
//   withBrowser(async (page) => …)        one Chrome for several renders (page.goto, page.eval, page.shot)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findChrome, chromeArgs, removeProfile } from "../skill/render-svg.mjs";
import { checkSvg } from "./figures.mjs";

const PUBLIC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "public");
export const RENDER_PAGE = path.join(PUBLIC, "figure-render.html");

// A Chrome on --remote-debugging-pipe: fd 3 takes our JSON messages, fd 4 gives its own, each ending in a NUL.
export async function withBrowser(fn, { timeout = 60e3 } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error("no Chrome, Edge or Chromium found to render with; install one or set TEACH_CHROME to its path");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "teach-figure-"));
  const proc = spawn(chrome, [...chromeArgs(chrome), "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--font-render-hinting=none", "about:blank"], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
  let err = "";
  proc.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
  const out = proc.stdio[3], inp = proc.stdio[4];
  let id = 0, buf = Buffer.alloc(0);
  const waiting = new Map(), listeners = new Set();
  inp.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    let i;
    while ((i = buf.indexOf(0)) >= 0) {
      let m;
      try { m = JSON.parse(buf.subarray(0, i).toString("utf8")); } catch { m = {}; }
      buf = buf.subarray(i + 1);
      if (m.id && waiting.has(m.id)) {
        const w = waiting.get(m.id); waiting.delete(m.id);
        m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
      } else for (const l of listeners) l(m);
    }
  });
  // (the server renders for "Visualize it": a browser that won't start or dies mid-render is an error, never a crash)
  const exited = new Promise((_, reject) => {
    proc.on("exit", (code) => reject(new Error(`the browser quit (${code}): ${err.trim().split("\n").pop() || "no output"}`)));
    proc.on("error", (e) => reject(new Error(`couldn't start the browser (${chrome}): ${e.message}`)));
  });
  for (const st of [out, inp, proc.stderr]) st?.on("error", () => {});
  exited.catch(() => {});
  const send = (method, params = {}, sessionId) => {
    const m = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
    return Promise.race([new Promise((resolve, reject) => { waiting.set(m.id, { resolve, reject }); out.write(JSON.stringify(m) + "\0"); }), exited]);
  };
  const event = (name, sessionId) => new Promise((resolve) => {
    const l = (m) => { if (m.method === name && m.sessionId === sessionId) { listeners.delete(l); resolve(m.params); } };
    listeners.add(l);
  });
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const { targetId } = await send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
        const s = (m, p) => send(m, p, sessionId);
        await s("Page.enable");
        await s("Runtime.enable");
        const page = {
          async goto(url, { width = 900, height = 700, scale = 2 } = {}) {
            await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
            const loaded = event("Page.loadEventFired", sessionId);
            await s("Page.navigate", { url });
            await loaded;
          },
          async eval(expr) {
            const r = await s("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
            return r.result.value;
          },
          async shot(file, clip) {
            const r = await s("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}), captureBeyondViewport: true });
            fs.writeFileSync(file, Buffer.from(r.data, "base64"));
            return file;
          },
        };
        return await fn(page);
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the browser took over ${timeout / 1000} s`)), timeout); }),
    ]);
  } finally {
    clearTimeout(timer);
    try { out.write(JSON.stringify({ id: ++id, method: "Browser.close" }) + "\0"); } catch { /* gone */ }
    setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 1500).unref();
    await new Promise((r) => { if (proc.exitCode !== null) r(); else { proc.once("exit", r); setTimeout(r, 2000).unref(); } });
    removeProfile(profile);
  }
}

// Mount an SVG (text) on the render page and measure it: { width, height, problems } plus the PNG at `out`.
export async function renderSvgText(page, svg, out, { theme = "dark", ground = "card" } = {}) {
  await page.goto(pathToFileURL(RENDER_PAGE).href + `?theme=${theme}&ground=${ground}`);
  const r = await page.eval(`window.__render(${JSON.stringify(svg)})`);
  if (out) await page.shot(out, { x: r.x, y: r.y, width: r.width, height: r.height });
  return r;
}

export async function renderFigure(svgPath, { out, theme = "dark" } = {}) {
  const src = fs.realpathSync(svgPath);
  const png = path.resolve(out || src.replace(/\.svg$/i, "") + ".png");
  const text = fs.readFileSync(src, "utf8");
  const r = await withBrowser((page) => renderSvgText(page, text, png, { theme }));
  return { png, width: r.width, height: r.height, problems: [...checkSvg(text), ...r.problems] };
}
