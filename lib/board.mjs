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

export const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SIZES = ["half", "full"];
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const fail = (m) => { throw new Error(m); };
const PURPOSE = { probe: "Probe", check: "Check", review: "Review", setup: "Setup", approve: "Your call", practice: "Practice" };

export function newBoard() {
  return { rev: 0, turn: 0, step: null, blocks: [], reply: { turn: 0, user: null, parts: [] }, turned: null, seen: {} };
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
  const op = { put, remove: ids(inp.remove, "remove"), pin: ids(inp.pin, "pin"), unpin: ids(inp.unpin, "unpin") };
  if (!op.put.length && !op.remove.length && !op.pin.length && !op.unpin.length) fail("say what to change: put, remove, pin or unpin");
  return op;
}

const find = (b, id) => b.blocks.find((x) => x.id === id);
const touch = (b, x) => { x.rev = ++b.rev; return x; };

function add(b, block, top = false) {
  touch(b, block);
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
      b.turned = { step: b.step, turn: b.turn, at: it.at, removed: removed.map((x) => ({ id: x.id, kind: x.kind, title: titleOf(x), pending: x.kind === "ask" && x.status === "pending" })) };
      b.rev++;
      break;
    }
    case "board-op": {   // the tutor's `board` tool
      if (!once()) break;
      let op;
      try { op = normalizeOp(it.op); } catch { break; }
      if (op.put.some((n) => { const x = find(b, n.id); return x && x.kind !== "note"; })) break;   // the tool refused it: none of it happens
      if (op.remove.includes("all")) drop(b, (x) => !x.pin && !(x.kind === "ask" && x.status === "pending"), removed);
      else drop(b, (x) => op.remove.includes(x.id), removed);
      for (const n of op.put) {
        const x = find(b, n.id);
        if (x) { Object.assign(x, { title: n.title, body: n.body, size: n.size, pin: n.pin || x.pin, turn: b.turn }); touch(b, x); continue; }
        add(b, { id: n.id, kind: "note", title: n.title, body: n.body, size: n.size, pin: n.pin, turn: b.turn, at: it.at }, n.place === "top");
      }
      for (const id of op.pin) { const x = find(b, id); if (x && !x.pin) { x.pin = true; touch(b, x); } }
      for (const id of op.unpin) { const x = find(b, id); if (x && x.pin) { x.pin = false; touch(b, x); } }
      break;
    }
    case "learner": {   // their own board actions: close a block, pin or unpin one, keep the reply as a note
      if (!once()) break;
      const x = it.target && find(b, it.target);
      if (it.op === "dismiss" && x && !(x.kind === "ask" && x.status === "pending")) drop(b, (y) => y === x, removed);
      else if ((it.op === "pin" || it.op === "unpin") && x) { x.pin = it.op === "pin"; touch(b, x); }
      else if (it.op === "keep" && String(it.text || "").trim()) {
        add(b, { id: it.id, kind: "note", title: str(it.title, 120) || "Kept", body: String(it.text).slice(0, 20000), size: "half", pin: true, turn: b.turn, at: it.at, kept: true });
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

// What the page gets (and the tutor's tools read): everything but the bookkeeping.
export function view(b) {
  const { seen, ...rest } = b;
  return rest;
}

export function fromView(v) {
  return { ...newBoard(), ...structuredClone(v), seen: {} };
}

// The board as the tutor reads it: one line per block, oldest first.
export function listing(b) {
  if (!b.blocks.length) return "The board is empty.";
  const line = (x) => {
    const kind = { note: "note", ask: "question set", scene: "scene", figure: "figure" }[x.kind];
    const state = x.kind === "ask" ? (x.status === "pending" ? "waiting for answers" : x.status === "answered" ? "answered" : "skipped")
      : x.kind === "note" && x.kept ? `kept by the learner` : "";
    return `- ${kind} \`${x.id}\`: ${titleOf(x)}${state ? ` · ${state}` : ""}${x.pin ? " · pinned" : ""}${x.size === "full" ? " · full width" : ""}`;
  };
  return `On the board now (oldest first):\n${b.blocks.map(line).join("\n")}`;
}
