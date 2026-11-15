// The lesson board: what the lesson page shows instead of a chat. The tutor's latest reply shows over the composer
// (replaced every turn); everything meant to last a while is a block on the board: notes the tutor writes
// (the `board` tool), question sets (`ask`), scenes (`scene`) and figures (`show`). The tutor adds, replaces,
// pins and removes blocks; the learner can close them or keep a reply. Two rules keep it from silting up, so
// the tutor doesn't have to remember to tidy:
//   - a new plan step turns the page: blocks from earlier turns leave, unless pinned;
//   - an answered (or skipped, or superseded) question set leaves when the learner's next turn starts, once
//     they've seen the tutor react to it.
// The board is a fold over the lesson's items (lib/transcript.mjs history, or the live events the engine emits,
// which have the same shapes) and the learner's own board actions, so it can always be rebuilt from the record.
// Applying an item twice is a no-op, which lets the server rebuild it and keep applying live events on top.
//
// Which blocks are in view, and how they're arranged, is arrange(): the tutor can set a layout (a template such as
// one block given the room, or a block with others beside it, or its own rows) through the `board` tool; otherwise
// the app picks one. Blocks not in view sit on the shelf, folded to a one-line chip the learner can open.

export const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SIZES = ["half", "full"];
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const fail = (m) => { throw new Error(m); };
const PURPOSE = { probe: "Probe", check: "Check", review: "Review", setup: "Setup", approve: "Your call", practice: "Practice" };

export function newBoard() {
  return { rev: 0, turn: 0, seq: 0, step: null, blocks: [], layout: null, reply: { turn: 0, user: null, parts: [] }, turned: null, seen: {} };
}

// What a block is called, in the tutor's listing and the block's own head.
export function titleOf(b) {
  if (b.title) return b.title;
  if (b.kind === "note") return (String(b.body || "").match(/^\s*#*\s*(.{1,80})/) || [])[1]?.replace(/[*_`$]/g, "") || "Note";
  if (b.kind === "ask") return `${PURPOSE[b.ask?.purpose] || "Questions"}${b.ask?.node ? ` · step ${b.ask.node}` : ""}`;
  if (b.kind === "scene") return b.scene?.title || "Scene";
  if (b.kind === "figure") return b.show?.title || String(b.show?.path || "").split("/").pop() || "Figure";
  return b.id;
}

// The `board` tool's input, checked. put: notes to add or replace (by id); remove: ids, or "all" for every
// unpinned block; pin / unpin: ids.
export function normalizeOp(inp = {}) {
  const ids = (v, what) => {
    if (v === undefined) return [];
    if (v === "all" && what === "remove") return ["all"];
    const list = Array.isArray(v) ? v : fail(`${what} takes a list of block ids`);
    return list.map((x) => (ID_RE.test(String(x)) ? String(x) : fail(`${what}: "${x}" isn't a block id`)));
  };
  const put = (Array.isArray(inp.put) ? inp.put : inp.put === undefined ? [] : fail("put takes a list of notes")).map((n, i) => {
    const id = String(n?.id ?? "");
    if (!ID_RE.test(id)) fail(`put[${i}]: give each note an id (letters, digits, - _ . :), e.g. "sd-bands"`);
    const body = str(n.body, 20000) || fail(`put[${i}] ("${id}"): body is empty`);
    if (n.size !== undefined && !SIZES.includes(n.size)) fail(`put[${i}]: size is "half" or "full"`);
    return { id, title: str(n.title, 120), body, size: n.size || "half", pin: n.pin === true, place: n.place === "top" ? "top" : "end" };
  });
  const op = { put, remove: ids(inp.remove, "remove"), pin: ids(inp.pin, "pin"), unpin: ids(inp.unpin, "unpin"), layout: inp.layout === undefined ? null : normalizeLayout(inp.layout) };
  if (!op.put.length && !op.remove.length && !op.pin.length && !op.unpin.length && !op.layout) fail("say what to change: put, remove, pin, unpin or layout");
  return op;
}

// The `layout` part of the board tool: which blocks are in view and how they sit. A template and the blocks it shows
// (`show`, first = the one given the room), or your own `rows`; "auto" hands it back to the app. Every block it
// doesn't show goes to the shelf (still there, folded to a chip).
export const TEMPLATES = ["auto", "focus", "focus-aside", "compare", "stack", "custom"];
const MAX_IN_VIEW = 6;
export function normalizeLayout(v) {
  if (typeof v === "string") v = { template: v };
  if (!v || typeof v !== "object" || Array.isArray(v)) fail('layout is an object, e.g. { template: "focus-aside", show: ["scene-id", "note-id"] }, or "auto"');
  const id = (x, where) => (ID_RE.test(String(x ?? "")) ? String(x) : fail(`layout ${where}: "${x}" isn't a block id`));
  const template = v.template ?? (v.rows ? "custom" : Array.isArray(v.show) && v.show.length > 1 ? "focus-aside" : v.show ? "focus" : "auto");
  if (!TEMPLATES.includes(template)) fail(`layout.template is one of ${TEMPLATES.join(", ")}`);
  if (template === "auto") return { template };
  let rows;
  if (template === "custom") {
    if (!Array.isArray(v.rows) || !v.rows.length) fail("a custom layout needs rows: [[id, [id, id]], [id]] (a row's cells side by side; a list in a cell stacks)");
    const widths = Array.isArray(v.widths) ? v.widths : [];
    rows = v.rows.map((r, i) => {
      const cells = (Array.isArray(r) ? r : [r]).map((c, j) => {
        const list = (Array.isArray(c) ? c : [c]).map((x) => id(x, `rows[${i}][${j}]`));
        if (!list.length) fail(`layout rows[${i}][${j}] is empty`);
        const w = Number(Array.isArray(widths[i]) ? widths[i][j] : undefined);
        return { ids: list, w: w > 0 && w <= 12 ? w : 1 };
      });
      if (!cells.length) fail(`layout rows[${i}] is empty`);
      if (cells.length > 4) fail(`layout rows[${i}]: at most 4 cells side by side`);
      return { cells };
    });
  } else {
    const show = (Array.isArray(v.show) ? v.show : v.show === undefined ? [] : [v.show]).map((x, i) => id(x, `show[${i}]`));
    if (!show.length) fail(`layout ${template} needs show: the block ids to keep in view${template === "focus" ? "" : ", first the main one"}`);
    if (template === "focus" && show.length > 1) fail('focus shows one block; use "focus-aside" to keep others beside it');
    if (template === "compare" && show.length > 4) fail("compare puts at most 4 blocks side by side");
    rows = template === "stack" ? show.map((x) => ({ cells: [{ ids: [x], w: 1 }] }))
      : template === "compare" ? [{ cells: show.map((x) => ({ ids: [x], w: 1 })) }]
      : template === "focus" ? [{ cells: [{ ids: show, w: 1 }] }]
      : [{ cells: [{ ids: [show[0]], w: 2 }, { ids: show.slice(1), w: 1 }] }];
  }
  const all = rows.flatMap((r) => r.cells.flatMap((c) => c.ids));
  if (new Set(all).size !== all.length) fail("layout names a block twice");
  if (all.length > MAX_IN_VIEW) fail(`layout keeps at most ${MAX_IN_VIEW} blocks in view; the rest belong on the shelf`);
  return { template, rows };
}
export const layoutIds = (l) => (l?.rows || []).flatMap((r) => r.cells.flatMap((c) => c.ids));

// The ids a board op's layout names that won't be on the board once its remove and put happen (the tool refuses
// such a call, so the board ignores all of it too).
export function layoutMissing(b, op) {
  if (!op.layout) return [];
  const gone = op.remove.includes("all") ? new Set(b.blocks.filter((x) => !x.pin && !(x.kind === "ask" && x.status === "pending")).map((x) => x.id)) : new Set(op.remove);
  const there = new Set([...b.blocks.map((x) => x.id).filter((id) => !gone.has(id)), ...op.put.map((n) => n.id)]);
  return layoutIds(op.layout).filter((id) => !there.has(id));
}

const find = (b, id) => b.blocks.find((x) => x.id === id);
const touch = (b, x) => { x.rev = ++b.rev; return x; };

function add(b, block, top = false) {
  touch(b, block);
  block.born = ++b.seq;
  if (top) b.blocks.unshift(block); else b.blocks.push(block);
  return block;
}

function drop(b, pred, out) {
  b.blocks = b.blocks.filter((x) => { if (!pred(x)) return true; out.push(x); return false; });
}

// Apply one item. Returns { changed, removed } (removed: the blocks that left, so the server can close a scene
// or take a question set off the learner's screen).
export function apply(b, it) {
  const removed = [];
  const rev0 = b.rev;
  const key = `${it.t}:${it.id}`;
  const once = () => { if (b.seen[key]) return false; b.seen[key] = 1; return true; };
  switch (it.t) {
    case "turn": {
      if (!once()) break;
      b.turn++;
      b.reply = { turn: b.turn, user: it.user?.text || it.user?.images ? { text: String(it.user.text || ""), images: it.user.images || 0 } : null, parts: [], at: it.at };
      b.rev++;
      for (const id of [].concat(it.answers || [])) { const a = find(b, id); if (a) a.answeredTurn = b.turn; }   // the turn their answers start
      // question sets they've moved past: answered, skipped or superseded before this turn
      drop(b, (x) => x.kind === "ask" && !x.pin && x.status !== "pending" && (x.answeredTurn ?? x.turn) < b.turn, removed);
      break;
    }
    case "user": {   // their words (a message, or said on the screen): the reply card shows what the reply answers
      if (!once()) break;
      if (!it.text && !it.images?.length) break;
      b.reply.user = { text: String(it.text || ""), images: Array.isArray(it.images) ? it.images.length : Number(it.images) || 0 };
      b.rev++;
      break;
    }
    case "text": {
      if (it.streaming && !it.final) break;
      const text = String(it.text || "");
      const p = b.reply.parts.find((x) => x.id === it.id);
      if (p) { if (p.text !== text) { p.text = text; b.rev++; } break; }
      if (!once() || !text.trim()) break;
      b.reply.parts.push({ id: it.id, text, said: !!it.said });
      b.rev++;
      break;
    }
    case "ask": {
      const x = find(b, it.id);
      if (x) {
        if (x.kind !== "ask") break;
        for (const k of ["ask", "status", "answers", "results", "via", "onScreen", "moved"]) if (it[k] !== undefined) x[k] = it[k];
        if (x.status !== "pending" && x.answeredTurn === undefined && it.status) x.answeredTurn = b.turn;
        touch(b, x);
        break;
      }
      if (!it.ask || !once()) break;   // a status note for a set that has left the board, or a repeat
      // a newer set supersedes one still open from an earlier turn: that one can't be answered any more
      drop(b, (y) => y.kind === "ask" && y.status === "pending" && !y.legacy && y.turn < b.turn, removed);
      add(b, { id: it.id, kind: "ask", size: "half", pin: false, turn: b.turn, at: it.at, ask: it.ask, status: it.status || "pending",
        answers: it.answers, results: it.results, via: it.via, onScreen: it.onScreen, legacy: it.legacy });
      break;
    }
    case "scene": {
      const sc = it.scene;
      if (!sc || !once()) break;
      const target = sc.replaces && b.blocks.find((x) => x.kind === "scene" && (x.id === sc.replaces || x.calls?.includes(sc.replaces)));
      if (target) {   // it morphs the scene that's up
        target.scene = sc; target.calls = [...(target.calls || []), it.id]; target.turn = b.turn;   // updated now: this turn's
        if (it.predictions) target.predictions = { ...target.predictions, ...it.predictions };
        touch(b, target);
        break;
      }
      add(b, { id: it.id, kind: "scene", size: "half", pin: false, turn: b.turn, at: it.at, scene: sc, calls: [], predictions: it.predictions || {} });
      break;
    }
    case "predicted": {
      const x = b.blocks.find((y) => y.kind === "scene" && (y.id === it.id || y.calls?.includes(it.id)));
      if (!x) break;
      x.predictions = { ...x.predictions, [it.step]: { answer: it.answer, result: it.result } };
      touch(b, x);
      break;
    }
    case "show": {
      if (!it.show || !once()) break;
      add(b, { id: it.id, kind: "figure", size: it.show.kind === "html" ? "full" : "half", pin: false, turn: b.turn, at: it.at, show: it.show });
      break;
    }
    case "remove": {   // a question set the ask tool rejected
      drop(b, (x) => x.id === it.id, removed);
      break;
    }
    case "step": {   // a plan step became current: a new step turns the page
      if (!once() || it.step === undefined || String(it.step) === b.step) break;
      const before = b.step;
      b.step = String(it.step);
      if (before === null && !b.blocks.length) break;
      // (a set answered this turn stays for the tutor's reaction; it leaves on their next move like any answered set)
      drop(b, (x) => !x.pin && x.turn < b.turn && !(x.kind === "ask" && x.answeredTurn === b.turn), removed);
      b.layout = null;   // a fresh page: the app arranges it until the tutor says otherwise
      b.turned = { step: b.step, turn: b.turn, at: it.at, removed: removed.map((x) => ({ id: x.id, kind: x.kind, title: titleOf(x), pending: x.kind === "ask" && x.status === "pending" })) };
      b.rev++;
      break;
    }
    case "board-op": {   // the tutor's `board` tool
      if (!once()) break;
      let op;
      try { op = normalizeOp(it.op); } catch { break; }
      if (op.put.some((n) => { const x = find(b, n.id); return x && x.kind !== "note"; })) break;   // the tool refused it: none of it happens
      if (layoutMissing(b, op).length) break;   // (likewise)
      if (op.remove.includes("all")) drop(b, (x) => !x.pin && !(x.kind === "ask" && x.status === "pending"), removed);
      else drop(b, (x) => op.remove.includes(x.id), removed);
      for (const n of op.put) {
        const x = find(b, n.id);
        if (x) { Object.assign(x, { title: n.title, body: n.body, size: n.size, pin: n.pin || x.pin, turn: b.turn }); touch(b, x); continue; }
        add(b, { id: n.id, kind: "note", title: n.title, body: n.body, size: n.size, pin: n.pin, turn: b.turn, at: it.at }, n.place === "top");
      }
      for (const id of op.pin) { const x = find(b, id); if (x && !x.pin) { x.pin = true; touch(b, x); } }
      for (const id of op.unpin) { const x = find(b, id); if (x && x.pin) { x.pin = false; touch(b, x); } }
      if (op.layout) {
        b.rev++;
        // (seq: blocks born later are new to it; rev: what the learner opens later beats it, what they opened before doesn't)
        b.layout = op.layout.template === "auto" ? null : { ...op.layout, seq: b.seq, rev: b.rev };
        for (const id of layoutIds(op.layout)) { const x = find(b, id); if (x) { delete x.shelved; delete x.shown; } }   // the tutor's call now
      }
      break;
    }
    case "learner": {   // their own board actions: close, pin or unpin a block, fold it onto the shelf or open it, keep the reply as a note
      if (!once()) break;
      const x = it.target && find(b, it.target);
      const waiting = x?.kind === "ask" && x.status === "pending";
      if (it.op === "dismiss" && x && !waiting) drop(b, (y) => y === x, removed);
      else if ((it.op === "pin" || it.op === "unpin") && x) { x.pin = it.op === "pin"; touch(b, x); }
      else if (it.op === "shelve" && x && !waiting) { x.shelved = true; delete x.shown; touch(b, x); }
      else if (it.op === "show" && x) { delete x.shelved; touch(b, x); x.shown = b.rev; }
      else if (it.op === "keep" && String(it.text || "").trim()) {
        add(b, { id: it.id, kind: "note", title: str(it.title, 120) || "Kept", body: String(it.text).slice(0, 20000), size: "half", pin: true, turn: b.turn, at: it.at, kept: true });
        find(b, it.id).shown = b.rev;
      }
      break;
    }
    default: break;
  }
  return { changed: b.rev !== rev0 || removed.length > 0, removed };
}

const byAt = (a, b) => String(a.at || "").localeCompare(String(b.at || ""));

// The board for a lesson's history (oldest first) and the learner's own actions, merged by time.
// History items carry a question set's final state from the start; the live board saw it waiting until its answers
// came. So a set goes on as waiting and takes its final state when the turn its answers started (or, with no such
// turn, at the end).
export function fold(items, learnerOps = []) {
  const b = newBoard();
  const ops = [...learnerOps].sort(byAt);
  const finals = new Map();
  const settle = (id) => {
    const f = finals.get(id);
    if (!f) return;
    finals.delete(id);
    apply(b, { t: "ask", id, status: f.status, answers: f.answers, results: f.results, via: f.via, moved: f.moved });
  };
  let k = 0;
  for (const it of items) {
    while (k < ops.length && it.at && String(ops[k].at) <= String(it.at)) apply(b, ops[k++]);
    if (it.t === "ask" && it.ask && it.status && it.status !== "pending" && !it.legacy) {
      finals.set(it.id, it);
      apply(b, { ...it, status: "pending", answers: undefined, results: undefined, via: undefined, moved: undefined });
      continue;
    }
    apply(b, it);
    if (it.t === "turn") for (const id of [].concat(it.answers || [])) settle(id);
  }
  for (const id of [...finals.keys()]) settle(id);
  while (k < ops.length) apply(b, ops[k++]);
  return b;
}

// ---------- what's in view, and how it's arranged ----------

const waitingAsk = (x) => x.kind === "ask" && x.status === "pending";
const visual = (x) => x.kind === "scene" || x.kind === "figure";

// The arrangement the page paints: rows of cells side by side, each cell a stack of blocks, and the shelf (every
// block not in view). { by: "tutor" | "app", template, rows: [{ cells: [{ ids, w }] }], shelf: [id] }.
//
// The tutor's layout holds until something it doesn't account for has to be in view (a block put up after it, a
// question set waiting, a block the learner opened from the shelf); then the app arranges it, keeping in view what the
// layout had in view. The app's own choice:
//   - in view: what the tutor put up or changed in its latest turn, a question set waiting for answers or just answered,
//     and what the learner opened or kept. An answered question set folds away once the tutor puts up something after it.
//     Everything else folds onto the shelf: an older block stays one click away instead of taking half the room;
//   - the newest scene or figure gets the room with the rest beside it; two text blocks sit side by side; one fills it.
export function arrange(b) {
  const blocks = b.blocks, byId = new Map(blocks.map((x) => [x.id, x]));
  const done = (by, template, rows) => {
    const inView = new Set(rows.flatMap((r) => r.cells.flatMap((c) => c.ids)));
    return { by, template, rows, shelf: blocks.filter((x) => !inView.has(x.id)).map((x) => x.id) };
  };
  let held = new Set(), benched = () => false;
  const opened = (x) => !!x.shown && (!b.layout || x.shown > b.layout.rev);   // the learner opened it since the tutor's layout
  if (b.layout) {
    const named = new Set(layoutIds(b.layout));
    const rows = b.layout.rows.map((r) => ({ cells: r.cells.map((c) => ({ ...c, ids: c.ids.filter((id) => byId.has(id) && !byId.get(id).shelved) })).filter((c) => c.ids.length) }))
      .filter((r) => r.cells.length);
    const extra = blocks.filter((x) => !named.has(x.id) && (waitingAsk(x) || opened(x) || (x.born > b.layout.seq && !x.shelved)));
    if (!extra.length && rows.length) return done("tutor", b.layout.template, rows);
    held = new Set(rows.flatMap((r) => r.cells.flatMap((c) => c.ids)));
    benched = (x) => !named.has(x.id) && x.born <= b.layout.seq;   // what the tutor's layout put on the shelf stays there
  }
  const tutorTurn = Math.max(0, ...blocks.filter((x) => !x.kept).map((x) => x.turn || 0));
  const newest = Math.max(0, ...blocks.filter((x) => !x.kept).map((x) => x.born || 0));
  // (a set they just answered stays while the tutor reacts to it, unless the tutor has put up something after it)
  const fresh = (x) => x.turn === tutorTurn || (x.kind === "ask" && x.answeredTurn === b.turn);
  const live = (x) => waitingAsk(x) || opened(x) || (!x.shelved && (held.has(x.id) || (fresh(x) && !benched(x) && !(x.kind === "ask" && newest > x.born))));
  let view = blocks.filter(live);
  if (view.length > 4) {   // keep it readable: a waiting question set, then the newest
    const rank = (x) => (waitingAsk(x) ? 1e9 : 0) + (x.born || 0);
    const keep = new Set([...view].sort((p, q) => rank(q) - rank(p)).slice(0, 4).map((x) => x.id));
    view = view.filter((x) => keep.has(x.id));
  }
  if (!view.length) return done("app", "empty", []);
  const byBorn = (p, q) => (p.born || 0) - (q.born || 0);
  view.sort(byBorn);
  const visuals = view.filter(visual);
  const focus = visuals.at(-1) || view.find(waitingAsk) || view.at(-1);
  const rest = view.filter((x) => x !== focus).sort((p, q) => Number(waitingAsk(q)) - Number(waitingAsk(p)) || byBorn(p, q));
  const one = (x) => ({ ids: [x.id], w: 1 });
  if (!rest.length) return done("app", "focus", [{ cells: [one(focus)] }]);
  if (view.some((x) => x.kind === "note" && x.size === "full")) return done("app", "stack", [focus, ...rest].map((x) => ({ cells: [one(x)] })));
  if (view.length === 2 && !visuals.length) return done("app", "compare", [{ cells: view.map(one) }]);
  return done("app", "focus-aside", [{ cells: [{ ids: [focus.id], w: 2 }, { ids: rest.map((x) => x.id), w: 1 }] }]);
}

// What the page gets (and the tutor's tools read): everything but the bookkeeping, and the arrangement.
export function view(b) {
  const { seen, ...rest } = b;
  return { ...rest, arrangement: arrange(b) };
}

export function fromView(v) {
  const { arrangement, ...rest } = structuredClone(v);
  return { ...newBoard(), ...rest, seen: {} };
}

// The board as the tutor reads it: one line per block, oldest first, then how it's laid out.
export function listing(b) {
  if (!b.blocks.length) return "The board is empty.";
  const a = arrange(b), shelf = new Set(a.shelf);
  const line = (x) => {
    const kind = { note: "note", ask: "question set", scene: "scene", figure: "figure" }[x.kind];
    const state = x.kind === "ask" ? (x.status === "pending" ? "waiting for answers" : x.status === "answered" ? "answered" : "skipped")
      : x.kind === "note" && x.kept ? `kept by the learner` : "";
    const where = shelf.has(x.id) ? (x.shelved ? "on the shelf (the learner folded it)" : "on the shelf") : x.shown && !x.kept ? "in view (the learner opened it)" : "in view";
    return `- ${kind} \`${x.id}\`: ${titleOf(x)}${state ? ` · ${state}` : ""}${x.pin ? " · pinned" : ""} · ${where}`;
  };
  const cell = (c) => c.ids.map((id) => `\`${id}\``).join(" over ");
  const rows = a.rows.map((r) => r.cells.map(cell).join(" | ")).join("; then below: ");
  const how = a.template === "empty" ? "nothing in view" : `${a.template}${a.by === "tutor" ? " (yours)" : " (the app's choice)"}: ${rows}`;
  return `On the board now (oldest first):\n${b.blocks.map(line).join("\n")}\nLayout: ${how}.`;
}
