"use strict";
// The figure kit (public/figure.css has the look): puts an SVG figure into the page as part of it, not as a picture
// of one, so it takes the app's theme (and its light/dark switch), its fonts and KaTeX. Used by the lesson board, the
// render page (lib/figure-render.mjs: the PNG the tutor checks) and, injected by the server, interactive figures.
//   TF.mount(host, svgText)   a sanitized, themed copy of the SVG in host (a <figure class="tf-figure">)
//   TF.problems(svg)          layout problems once it's drawn: labels past the frame, labels on labels, labels on lines
//   TF.color("red"), TF.font(15), TF.typeset(el)   for interactive pages (canvas paint, text, $…$ math)
// No dependencies besides KaTeX (window.katex), which is optional: without it math stays as its TeX source.
(function () {
  const NS = "http://www.w3.org/2000/svg";
  let seq = 0;

  // ---------- math ----------

  // "text with $x^2$ in it" -> HTML: KaTeX for the $…$ parts, the rest as text.
  function texHTML(src) {
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    return String(src).split(/(\$[^$]+\$)/).map((part) => {
      if (/^\$[^$]+\$$/.test(part) && window.katex) {
        try { return window.katex.renderToString(part.slice(1, -1), { throwOnError: false, strict: "ignore", output: "html" }); }
        catch { return esc(part); }
      }
      return esc(part);
    }).join("");
  }

  // Typeset $…$ in an element's text (interactive pages: labels, readouts). Skips code and inputs.
  function typeset(root) {
    if (!root || !window.katex) return;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/\$[^$]+\$/.test(n.nodeValue) && !n.parentElement.closest("script,style,textarea,code,pre,canvas,.katex,svg") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const hits = [];
    while (walk.nextNode()) hits.push(walk.currentNode);
    for (const n of hits) {
      const span = document.createElement("span");
      span.innerHTML = texHTML(n.nodeValue);
      n.replaceWith(...span.childNodes);
    }
  }

  // ---------- an SVG figure ----------

  // Strip what a figure may not carry, and give its ids a prefix of their own so two figures on one page can't trade
  // gradients or markers. What stays: SVG elements only (an HTML <meta>, <link> or <form> in another namespace would act
  // on the page), no scripts, styles, handlers or href-setting animation, and links only inside the figure (#id).
  const SVGNS = "http://www.w3.org/2000/svg";
  function clean(svg) {
    const pre = `f${++seq}-`;
    for (const el of [...svg.querySelectorAll("*")]) {
      if (!svg.contains(el)) continue;   // (inside something already removed)
      const tag = el.localName.toLowerCase(), target = (el.getAttribute("attributeName") || "").toLowerCase();
      if (el.namespaceURI !== SVGNS || ["script", "style", "foreignobject", "iframe", "object", "embed", "set", "handler", "listener"].includes(tag)
        || (/^animate/.test(tag) && /href/.test(target))) el.remove();
    }
    for (const el of [svg, ...svg.querySelectorAll("*")]) {
      for (const a of [...el.attributes]) {
        const n = a.localName.toLowerCase(), v = a.value, bare = v.replace(/[\x00-\x20]/g, "");
        if (n.startsWith("on") || /^(javascript|vbscript):/i.test(bare) || /^data:text\/html/i.test(bare)) { el.removeAttributeNode(a); continue; }
        if (n === "href") {
          if (bare.startsWith("#")) el.setAttributeNS(a.namespaceURI, a.name, "#" + pre + bare.slice(1));
          else if (!(el.localName === "image" && /^data:image\/(png|jpe?g|gif|webp);/i.test(bare))) el.removeAttributeNode(a);
          continue;
        }
        if (n === "id") el.setAttribute("id", pre + v);
        else if (/url\(#/.test(v)) el.setAttribute(a.name, v.replace(/url\(#([^)]+)\)/g, `url(#${pre}$1)`));
      }
    }
  }

  // A figure drawn to the contract (skill/figures.md) leaves colour, fonts and styling to the theme. One that paints its
  // own (a figure made before the contract) is shown as it was drawn, as a picture: themed, its fills would go.
  function themable(text) {
    const t = String(text || "");
    if (/<style\b|\sfont-family\s*=|font-family\s*:/i.test(t)) return false;
    for (const m of t.matchAll(/\s(fill|stroke|stop-color|color)\s*=\s*"([^"]*)"/gi)) if (!/^\s*(none|transparent|currentcolor|inherit|var\(.*\)|url\(.*\))\s*$/i.test(m[2])) return false;
    for (const m of t.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) if (/(fill|stroke|color|background)\s*:\s*(#|rgb|hsl|[a-z]+\s*(;|$))/i.test(m[1]) && !/:\s*var\(/.test(m[1])) return false;
    return true;
  }

  // chalk's arrowhead: a filled triangle 11 long, 0.42 rad either side of the line, at the end (and the start for arrow2).
  function arrowheads(svg) {
    for (const el of svg.querySelectorAll(".arrow, .arrow2")) {
      if (typeof el.getTotalLength !== "function") continue;
      let len; try { len = el.getTotalLength(); } catch { continue; }
      if (!(len > 2)) continue;
      const head = (atEnd) => {
        const tip = el.getPointAtLength(atEnd ? len : 0), back = el.getPointAtLength(atEnd ? Math.max(0, len - 3) : Math.min(len, 3));
        const ang = Math.atan2(tip.y - back.y, tip.x - back.x), hl = el.classList.contains("thick") ? 13 : 11;
        const p = (s) => `${(tip.x + Math.cos(ang + Math.PI + s * 0.42) * hl).toFixed(2)},${(tip.y + Math.sin(ang + Math.PI + s * 0.42) * hl).toFixed(2)}`;
        const h = document.createElementNS(NS, "path");
        h.setAttribute("d", `M${tip.x.toFixed(2)},${tip.y.toFixed(2)} L${p(-1)} L${p(1)} Z`);
        h.setAttribute("class", "tf-head");
        const tr = el.getAttribute("transform");
        if (tr) h.setAttribute("transform", tr);
        el.after(h);
        // the colour comes from the line's own class (or a group's): the head copies the line's colour classes
        for (const c of el.classList) if (!/^(arrow2?|thin|thick|dash|dot)$/.test(c)) h.classList.add(c);
      };
      head(true);
      if (el.classList.contains("arrow2")) head(false);
      // the shaft stops inside the head, so a thick line doesn't poke through its point
      const inset = (el.classList.contains("thick") ? 13 : 11) * 0.6, two = el.classList.contains("arrow2");
      if (el.nodeName === "line") {
        const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((a) => Number(el.getAttribute(a)) || 0), d = Math.hypot(x2 - x1, y2 - y1) || 1;
        const ux = (x2 - x1) / d, uy = (y2 - y1) / d;
        el.setAttribute("x2", (x2 - ux * inset).toFixed(2)); el.setAttribute("y2", (y2 - uy * inset).toFixed(2));
        if (two) { el.setAttribute("x1", (x1 + ux * inset).toFixed(2)); el.setAttribute("y1", (y1 + uy * inset).toFixed(2)); }
      } else if (!el.closest(".dash, .dot")) {
        el.style.strokeDasharray = two ? `0 ${inset} ${len - 2 * inset} ${len}` : `${len - inset} ${len}`;
      }
    }
  }

  // <text> with $…$ in it becomes KaTeX in a foreignObject, placed where the text was (same anchor, same baseline).
  function mathLabels(svg) {
    for (const t of [...svg.querySelectorAll("text")]) {
      const src = t.textContent;
      if (!/\$[^$]+\$/.test(src)) continue;
      const cs = getComputedStyle(t);
      const fo = document.createElementNS(NS, "foreignObject");
      const div = document.createElement("div");
      div.className = "tf-tex";
      div.style.fontSize = cs.fontSize;
      div.innerHTML = texHTML(src) + '<span class="tf-base" style="display:inline-block;width:0;height:0;vertical-align:baseline"></span>';
      fo.append(div);
      for (const c of t.classList) fo.classList.add(c);
      fo.setAttribute("x", "0"); fo.setAttribute("y", "0"); fo.setAttribute("width", "2000"); fo.setAttribute("height", "400");
      fo.dataset.tex = src;
      const tr = t.getAttribute("transform");
      if (tr) fo.setAttribute("transform", tr);
      t.replaceWith(fo);
      fo._anchor = { x: Number(t.getAttribute("x")) || 0, y: Number(t.getAttribute("y")) || 0, align: t.getAttribute("text-anchor") || cs.textAnchor || "start" };
    }
    placeMath(svg);
  }

  // (again once fonts are in: KaTeX's metrics change when its fonts load)
  function placeMath(svg) {
    const m = svg.getScreenCTM();
    if (!m || !m.a) return;
    const k = 1 / m.a;
    for (const fo of svg.querySelectorAll("foreignObject[data-tex]")) {
      const a = fo._anchor;
      if (!a) continue;
      const div = fo.firstChild, base = div.querySelector(".tf-base");
      const r = div.getBoundingClientRect(), b = base.getBoundingClientRect();
      const w = r.width * k, h = r.height * k, asc = (b.top - r.top) * k;
      const x = a.align === "middle" ? a.x - w / 2 : a.align === "end" ? a.x - w : a.x;
      fo.setAttribute("x", x.toFixed(2)); fo.setAttribute("y", (a.y - asc).toFixed(2));
      fo.setAttribute("width", Math.ceil(w + 2)); fo.setAttribute("height", Math.ceil(h + 2));
    }
  }

  function mount(host, text, { caption = "", url = "" } = {}) {
    host.classList.add("tf-figure");
    const keep = host.querySelector(":scope > figcaption");   // a caption the page wrote (Markdown, math) stays
    host.textContent = "";
    if (!themable(text)) {   // drawn before the contract: as a picture, the way it was drawn
      host.classList.add("tf-legacy");
      const img = document.createElement("img");
      img.alt = keep?.textContent || caption || "figure";
      img.src = url || `data:image/svg+xml;charset=utf-8,${encodeURIComponent(String(text || ""))}`;
      host.append(img);
      if (keep) host.append(keep);
      return null;
    }
    let src0 = String(text || "");
    if (!/<svg\b[^>]*\sxmlns=/.test(src0)) src0 = src0.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');   // (a figure that left it out)
    const doc = new DOMParser().parseFromString(src0, "image/svg+xml");
    const src = doc.documentElement;
    if (!src || src.nodeName !== "svg" || doc.querySelector("parsererror")) {
      host.innerHTML = `<p class="tf-error">This figure's SVG doesn't parse.</p>`;
      return null;
    }
    const svg = document.importNode(src, true);
    clean(svg);
    svg.classList.add("tf");
    svg.setAttribute("role", "img");
    // its own size, at most the room it's given (the viewBox sets the shape)
    const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    const w = vb.length === 4 ? vb[2] : Number(svg.getAttribute("width")) || 480;
    if (vb.length !== 4) svg.setAttribute("viewBox", `0 0 ${w} ${Number(svg.getAttribute("height")) || 320}`);
    svg.removeAttribute("height");
    svg.setAttribute("width", String(w));
    svg.style.width = `${w}px`;
    host.append(svg);
    if (keep) host.append(keep);
    else if (caption) { const c = document.createElement("figcaption"); c.textContent = caption; host.append(c); }
    arrowheads(svg);
    mathLabels(svg);
    if (document.fonts?.ready) document.fonts.ready.then(() => placeMath(svg));
    // a figure mounted while folded (no layout yet) places its math when it first shows
    if (!svg.getScreenCTM()?.a && "ResizeObserver" in window) {
      const ro = new ResizeObserver(() => { if (svg.getScreenCTM()?.a) { placeMath(svg); ro.disconnect(); } });
      ro.observe(svg);
    }
    return svg;
  }

  // ---------- the layout check ----------

  // Problems a reader would see: a label past the frame (cut off), two labels on top of each other, a label sitting
  // on a line. Boxes in the SVG's own units. Run after mount, once fonts are loaded.
  function problems(svg) {
    const out = [];
    const vb = svg.viewBox.baseVal;
    const m = svg.getScreenCTM();
    if (!m || !m.a) return out;
    const inv = m.inverse();
    const toUser = (r) => {
      const p = new DOMPoint(r.left, r.top).matrixTransform(inv), q = new DOMPoint(r.right, r.bottom).matrixTransform(inv);
      return { x0: p.x, y0: p.y, x1: q.x, y1: q.y };
    };
    const labels = [];
    for (const el of svg.querySelectorAll("text, foreignObject[data-tex]")) {
      const txt = (el.dataset?.tex || el.textContent || "").trim();
      if (!txt) continue;
      const r = (el.nodeName === "foreignObject" ? el.firstChild : el).getBoundingClientRect();
      if (!r.width) continue;
      labels.push({ el, txt: txt.length > 28 ? txt.slice(0, 27) + "…" : txt, b: toUser(r) });
    }
    const tol = 1;
    for (const l of labels) {
      const { b } = l, edges = [];
      if (b.x0 < vb.x - tol) edges.push("left"); if (b.x1 > vb.x + vb.width + tol) edges.push("right");
      if (b.y0 < vb.y - tol) edges.push("top"); if (b.y1 > vb.y + vb.height + tol) edges.push("bottom");
      if (edges.length) out.push(`"${l.txt}" runs past the ${edges.join(" and ")} edge of the frame: move it inside the viewBox (or widen the viewBox)`);
    }
    const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i].b, c = labels[j].b;
      const ix = Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0), iy = Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0);
      if (ix > 1 && iy > 1 && ix * iy > 0.12 * Math.min(area(a), area(c))) out.push(`"${labels[i].txt}" and "${labels[j].txt}" overlap: move one`);
    }
    // a label on a stroke: sample its box (inset, so a line passing beside it doesn't count) against each stroked shape
    const shapes = [...svg.querySelectorAll("line, polyline, path, rect, circle, ellipse, polygon")].filter((s) => {
      if (s.classList.contains("tf-head")) return false;
      const cs = getComputedStyle(s);
      return cs.stroke !== "none" && cs.visibility !== "hidden" && typeof s.isPointInStroke === "function";
    });
    for (const l of labels) {
      const { b } = l, w = b.x1 - b.x0, h = b.y1 - b.y0;
      const pts = [];
      for (let i = 0; i < 7; i++) for (let j = 0; j < 9; j++) pts.push([b.x0 + w * (0.1 + 0.8 * i / 6), b.y0 + h * (0.2 + 0.6 * j / 8)]);
      for (const s of shapes) {
        const sm = s.getScreenCTM(), sinv = sm && sm.inverse();
        if (!sinv) continue;
        let hits = 0;
        for (const [x, y] of pts) {
          const scr = new DOMPoint(x, y).matrixTransform(m), p = scr.matrixTransform(sinv);
          const pt = svg.createSVGPoint(); pt.x = p.x; pt.y = p.y;
          try { if (s.isPointInStroke(pt)) hits++; } catch { /* not a geometry element */ }
        }
        if (hits >= 2) { out.push(`"${l.txt}" sits on a ${s.nodeName}${s.getAttribute("class") ? ` (${s.getAttribute("class")})` : ""}: move the label off the line`); break; }
      }
    }
    return [...new Set(out)];
  }

  // ---------- interactive pages ----------

  // A token as a colour a canvas can use: the tokens are light-dark(…) pairs, so the browser resolves them on a probe.
  let probe = null;
  const color = (name) => {
    const v = `--${name === "dim" ? "stage-dim" : ["orange", "purple", "pink", "grey", "gray"].includes(name) ? `fig-${name === "gray" ? "grey" : name}` : name}`;
    if (!probe) { probe = document.createElement("span"); probe.style.display = "none"; probe.setAttribute("aria-hidden", "true"); }
    if (!probe.isConnected) (document.body || document.documentElement).append(probe);
    probe.style.color = ""; probe.style.color = `var(${v})`;
    return getComputedStyle(probe).color || "currentColor";
  };
  const font = (size = 15, kind = "math") => `${size}px ${getComputedStyle(document.documentElement).getPropertyValue(`--font-${kind}`).trim() || "serif"}`;

  // Markdown's SVG pictures (app.js renders them as <figure class="tf-figure" data-svg="url"> or data-svg-src="…"):
  // fetched and mounted where they sit. getText(url) -> Promise<string>.
  function upgrade(root, getText) {
    for (const f of (root || document).querySelectorAll("figure[data-svg], figure[data-svg-src]")) {
      const url = f.dataset.svg, src = f.dataset.svgSrc, caption = f.dataset.caption || "";
      f.removeAttribute("data-svg"); f.removeAttribute("data-svg-src");
      if (src !== undefined) { mount(f, src, { caption }); continue; }
      getText(url).then((t) => mount(f, t, { caption, url }), () => { f.innerHTML = `<p class="tf-error">This figure couldn't be loaded.</p>`; });
    }
  }

  window.TF = { upgrade, themable, mount, problems, placeMath, typeset, texHTML, color, font };
  // inside an interactive figure (the server marks it): typeset its $…$ once it's loaded
  if (document.documentElement.hasAttribute("data-teach-figure")) {
    // chalk's slider: the track fills up to the knob
    const fill = (r) => r.style.setProperty("--fill", `${(100 * ((Number(r.value) - Number(r.min || 0)) / ((Number(r.max || 100) - Number(r.min || 0)) || 1))).toFixed(1)}%`);
    // the app's theme switch reaches an open figure (app.js posts it to iframe.themed)
    addEventListener("message", (e) => { if (e.data && (e.data.theme === "light" || e.data.theme === "dark")) document.documentElement.dataset.theme = e.data.theme; });
    document.addEventListener("input", (e) => { if (e.target.matches?.("input[type=range]")) fill(e.target); }, true);
    const go = () => { typeset(document.body); document.querySelectorAll("input[type=range]").forEach(fill); };
    // canvas text drawn before the stage serif loaded fell back to another font: load it, then let the page redraw
    // (its sliders' input handlers draw; a page can also listen for "tf-fonts")
    const fam = (k) => getComputedStyle(document.documentElement).getPropertyValue(`--font-${k}`).trim();
    Promise.all(["math", "mono", "ui"].map((k) => document.fonts.load(`15px ${fam(k) || "serif"}`).catch(() => {}))).then(() => {
      dispatchEvent(new Event("tf-fonts"));
      document.querySelectorAll("input[type=range]").forEach((r) => r.dispatchEvent(new Event("input", { bubbles: true })));
    });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
  }
})();
