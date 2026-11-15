// The lesson board's rules (lib/board.mjs): what goes on, what replaces what, and what leaves by itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as board from "../lib/board.mjs";

const ask = (id, extra = {}) => ({ t: "ask", id, status: "pending", ask: { purpose: "check", node: "1", questions: [{ n: 1, kind: "choice", prompt: "?", options: ["a", "b"] }] }, ...extra });
const ids = (b) => b.blocks.map((x) => x.id);
const put = (id, body, extra = {}) => ({ t: "board-op", id: `op-${id}-${body.length}`, op: { put: [{ id, body, ...extra }] } });

test("notes go on by id; the same id replaces in place; remove and pin by id", () => {
  const b = board.newBoard();
  board.apply(b, put("bands", "# SD bands\nunder 0.16 V: shutdown"));
  board.apply(b, put("pins", "BCLK D9"));
  board.apply(b, put("bands", "# SD bands\nunder 0.16 V: shutdown; 0.16-0.77 V: mix"));
  assert.deepEqual(ids(b), ["bands", "pins"]);
  assert.match(b.blocks[0].body, /mix/);
  assert.equal(board.titleOf(b.blocks[0]), "SD bands");
  board.apply(b, { t: "board-op", id: "o3", op: { pin: ["pins"], remove: ["bands"] } });
  assert.deepEqual(ids(b), ["pins"]);
  assert.equal(b.blocks[0].pin, true);
  board.apply(b, { t: "board-op", id: "o4", op: { put: [{ id: "top", body: "first", place: "top" }] } });
  assert.deepEqual(ids(b), ["top", "pins"]);
  board.apply(b, { t: "board-op", id: "o5", op: { remove: "all" } });
  assert.deepEqual(ids(b), ["pins"], "remove all keeps what's pinned");
});

test("the board tool's input is checked", () => {
  assert.throws(() => board.normalizeOp({}), /put, remove, pin, unpin or layout/);
  assert.throws(() => board.normalizeOp({ put: [{ body: "x" }] }), /give each note an id/);
  assert.throws(() => board.normalizeOp({ put: [{ id: "a b", body: "x" }] }), /id/);
  assert.throws(() => board.normalizeOp({ put: [{ id: "a", body: " " }] }), /body is empty/);
  assert.throws(() => board.normalizeOp({ put: [{ id: "a", body: "x", size: "huge" }] }), /half/);
  assert.deepEqual(board.normalizeOp({ remove: "all" }).remove, ["all"]);
  // a note never replaces a question set
  const b = board.newBoard();
  board.apply(b, ask("toolu_1"));
  board.apply(b, put("toolu_1", "hijack"));
  assert.equal(b.blocks[0].kind, "ask");
});

test("each turn starts the reply card over; it collects that turn's text, and repeats are no-ops", () => {
  const b = board.newBoard();
  board.apply(b, { t: "turn", id: "t1", user: { text: "why a pull-down?" } });
  board.apply(b, { t: "text", id: "m1:0", text: "", streaming: true });
  board.apply(b, { t: "text", id: "m1:0", text: "Because SD floats.", final: true });
  board.apply(b, { t: "text", id: "m1:1", text: "Look at the note.", final: true });
  board.apply(b, { t: "text", id: "m1:0", text: "Because SD floats.", final: true });
  assert.equal(b.reply.user.text, "why a pull-down?");
  assert.deepEqual(b.reply.parts.map((p) => p.text), ["Because SD floats.", "Look at the note."]);
  board.apply(b, { t: "turn", id: "t2" });
  assert.equal(b.reply.user, null);
  assert.equal(b.reply.parts.length, 0);
  board.apply(b, { t: "text", id: "m1:0", text: "Because SD floats.", final: true });   // an old line arriving again
  assert.equal(b.reply.parts.length, 0);
  const r = board.apply(b, { t: "turn", id: "t2" });
  assert.equal(r.changed, false);
});

test("an answered question set stays while the tutor reacts, and leaves when the learner moves on", () => {
  const b = board.newBoard();
  board.apply(b, { t: "turn", id: "t1" });
  board.apply(b, ask("q1"));
  board.apply(b, put("idea", "the idea"));
  board.apply(b, { t: "ask", id: "q1", status: "answered", answers: [{ choice: 0 }], results: [{ ok: true }] });
  board.apply(b, { t: "turn", id: "t2", answers: "q1" });   // their answers start the tutor's reaction
  assert.deepEqual(ids(b), ["q1", "idea"]);
  board.apply(b, { t: "text", id: "m2", text: "Right: and here's why it matters.", final: true });
  const r = board.apply(b, { t: "turn", id: "t3", user: { text: "ok, next" } });
  assert.deepEqual(ids(b), ["idea"], "the card goes; the note stays");
  assert.deepEqual(r.removed.map((x) => x.id), ["q1"]);
});

test("a newer question set supersedes one still open from an earlier turn", () => {
  const b = board.newBoard();
  board.apply(b, { t: "turn", id: "t1" });
  board.apply(b, ask("q1"));
  board.apply(b, ask("q2"));                    // same turn: both stay
  assert.deepEqual(ids(b), ["q1", "q2"]);
  board.apply(b, { t: "turn", id: "t2", user: { text: "skip that" } });
  const r = board.apply(b, ask("q3"));
  assert.deepEqual(ids(b), ["q3"]);
  assert.deepEqual(r.removed.map((x) => x.id), ["q1", "q2"]);
});

test("a new plan step turns the page: earlier turns' blocks leave unless pinned; this turn's stay", () => {
  const b = board.newBoard();
  board.apply(b, { t: "turn", id: "t1" });
  board.apply(b, { t: "step", id: "s3", step: "3" });
  board.apply(b, { t: "scene", id: "sc1", scene: { title: "Bridge-tied outputs", scene: {}, predict: [] } });
  board.apply(b, ask("q-practice"));
  board.apply(b, put("pinmap", "D9 BCLK", { pin: true }));
  board.apply(b, { t: "turn", id: "t2", user: { text: "done" } });
  board.apply(b, put("buttons", "Buttons straddle the gap"));   // added before the step call in the same turn
  const r = board.apply(b, { t: "step", id: "s4", step: "4" });
  assert.deepEqual(ids(b), ["pinmap", "buttons"]);
  assert.deepEqual(r.removed.map((x) => x.id).sort(), ["q-practice", "sc1"]);
  assert.deepEqual(b.turned.removed.find((x) => x.id === "q-practice"), { id: "q-practice", kind: "ask", title: "Check · step 1", pending: true });
  // the same step again (a re-teach) doesn't clear anything
  board.apply(b, { t: "turn", id: "t3" });
  board.apply(b, { t: "step", id: "s4b", step: "4" });
  assert.deepEqual(ids(b), ["pinmap", "buttons"]);
});

test("a scene called with replaces morphs the one that's up; predictions land on it", () => {
  const b = board.newBoard();
  board.apply(b, { t: "scene", id: "sc1", scene: { title: "RC", scene: { v: 1 }, predict: [] } });
  board.apply(b, { t: "scene", id: "sc2", scene: { title: "RC, 10x", scene: { v: 2 }, predict: [], replaces: "sc1" } });
  board.apply(b, { t: "scene", id: "sc3", scene: { title: "RC, 100x", scene: { v: 3 }, predict: [], replaces: "sc2" } });
  assert.deepEqual(ids(b), ["sc1"]);
  assert.equal(b.blocks[0].scene.title, "RC, 100x");
  board.apply(b, { t: "predicted", id: "sc1", step: 1, answer: { choice: 1 }, result: { ok: true } });
  assert.equal(b.blocks[0].predictions[1].result.ok, true);
});

test("the learner closes, pins and keeps; a pending card can't be closed", () => {
  const b = board.newBoard();
  board.apply(b, { t: "turn", id: "t1" });
  board.apply(b, ask("q1"));
  board.apply(b, put("n1", "note"));
  board.apply(b, { t: "text", id: "m1", text: "A reply worth keeping.", final: true });
  board.apply(b, { t: "learner", id: "l1", op: "dismiss", target: "q1" });
  board.apply(b, { t: "learner", id: "l2", op: "dismiss", target: "n1" });
  board.apply(b, { t: "learner", id: "l3", op: "keep", text: b.reply.parts[0].text });
  assert.deepEqual(ids(b), ["q1", "l3"]);
  assert.equal(b.blocks[1].pin, true);
  assert.equal(b.blocks[1].kept, true);
});

test("fold rebuilds the board from the history and the learner's actions, merged by time", () => {
  const T = (m) => `2026-11-11T05:${String(m).padStart(2, "0")}:00.000Z`;
  const items = [
    { t: "turn", id: "t1", at: T(0), user: { text: "start" } },
    { t: "step", id: "s1", step: "1", at: T(1) },
    { t: "board-op", id: "b1", op: { put: [{ id: "idea", body: "v1" }] }, at: T(2) },
    { ...ask("q1"), status: "answered", at: T(3) },
    { t: "turn", id: "t2", answers: "q1", at: T(5) },
    { t: "text", id: "x", text: "Right.", at: T(6) },
    { t: "board-op", id: "b2", op: { put: [{ id: "idea", body: "v2" }] }, at: T(8) },
  ];
  const b = board.fold(items, [{ t: "learner", id: "l1", op: "dismiss", target: "idea", at: T(7) }]);
  // closed at :07, then the tutor put a new version at :08: it's back
  assert.deepEqual(ids(b), ["q1", "idea"]);
  assert.equal(b.blocks[1].body, "v2");
  assert.deepEqual(b.reply.parts.map((p) => p.text), ["Right."]);
  // (the note came back after the answered set, so the set folds onto the shelf)
  assert.match(board.listing(b), /question set `q1`: Check · step 1 · answered · on the shelf\n- note `idea`: v2 · in view\nLayout: focus \(the app's choice\): `idea`\./);
  // view → fromView keeps the blocks and drops the bookkeeping
  const copy = board.fromView(JSON.parse(JSON.stringify(board.view(b))));
  assert.deepEqual(ids(copy), ids(b));
  assert.deepEqual(copy.seen, {});
});

test("a note or scene the tutor updates this turn counts as this turn's (a page turn keeps it)", () => {
  const b = board.newBoard();
  board.apply(b, { t: "turn", id: "t1" });
  board.apply(b, put("explain", "v1"));
  board.apply(b, { t: "scene", id: "sc1", scene: { title: "RC", scene: {}, predict: [] } });
  board.apply(b, { t: "turn", id: "t2" });
  board.apply(b, put("explain", "v2, rewritten"));
  board.apply(b, { t: "scene", id: "sc2", scene: { title: "RC 2", scene: {}, predict: [], replaces: "sc1" } });
  board.apply(b, { t: "step", id: "s2", step: "2" });
  assert.deepEqual(ids(b), ["explain", "sc1"]);
});

test("a set answered this turn stays through the tutor's reaction even if it starts the next step", () => {
  const b = board.newBoard();
  board.apply(b, { t: "turn", id: "t1" });
  board.apply(b, ask("q1"));
  board.apply(b, { t: "ask", id: "q1", status: "answered" });
  board.apply(b, { t: "turn", id: "t2", answers: ["q1"] });
  board.apply(b, { t: "step", id: "s2", step: "2" });
  assert.deepEqual(ids(b), ["q1"]);
  board.apply(b, { t: "turn", id: "t3" });
  assert.deepEqual(ids(b), []);
});

test("the page-turn record names its turn, so a later same-step call doesn't report it again", () => {
  const b = board.newBoard();
  board.apply(b, { t: "turn", id: "t1" });
  board.apply(b, put("probe", "probe notes"));
  board.apply(b, { t: "turn", id: "t2" });
  board.apply(b, { t: "step", id: "s1", step: "1" });
  assert.equal(b.turned.turn, 2);
  board.apply(b, { t: "turn", id: "t3" });
  board.apply(b, { t: "step", id: "s1b", step: "1" });
  assert.equal(b.turned.turn, 2, "nothing turned in turn 3");
});

test("a board op that would overwrite a question set with a note applies none of its changes", () => {
  const b = board.newBoard();
  board.apply(b, put("old", "x"));
  board.apply(b, ask("q1"));
  board.apply(b, { t: "board-op", id: "bad", op: { remove: ["old"], put: [{ id: "q1", body: "hijack" }] } });
  assert.deepEqual(ids(b), ["old", "q1"]);
});

test("a rebuilt board keeps a set that was answered later on the board until the learner moves on after it", () => {
  const T = (m) => `2026-11-11T06:${String(m).padStart(2, "0")}:00.000Z`;
  // history items carry their final status from the start: answered at :05, after an unrelated message at :03
  const items = [
    { t: "turn", id: "t1", at: T(0) },
    { ...ask("q1"), status: "answered", answers: [{ choice: 0 }], results: [{ ok: true }], at: T(1) },
    { t: "turn", id: "t2", at: T(3), user: { text: "wait, what's a pull-down?" } },
    { t: "user", id: "u2", text: "wait, what's a pull-down?", at: T(3) },
    { t: "turn", id: "t3", answers: "q1", at: T(5) },
  ];
  let b = board.fold(items);
  assert.deepEqual(ids(b), ["q1"]);
  assert.equal(b.blocks[0].status, "answered");
  b = board.fold([...items, { t: "turn", id: "t4", at: T(7) }]);
  assert.deepEqual(ids(b), []);
});

// ---------- what's in view, and how it's arranged ----------

const scene = (id) => ({ t: "scene", id, scene: { title: "PDM", objects: [{}] } });
const lay = (b) => { const a = board.arrange(b); return { by: a.by, template: a.template, rows: a.rows.map((r) => r.cells.map((c) => c.ids)), shelf: a.shelf }; };

test("the app's layout: an answered set folds away once a newer block is up; the newest scene gets the room", () => {
  const b = board.newBoard();
  board.apply(b, { t: "turn", id: "t1" });
  board.apply(b, ask("approve"));
  board.apply(b, { t: "turn", id: "t2", answers: "approve" });
  board.apply(b, { t: "ask", id: "approve", status: "answered", answers: [{ choice: 0 }] });
  assert.deepEqual(lay(b), { by: "app", template: "focus", rows: [[["approve"]]], shelf: [] }, "just answered: it stays while the tutor reacts");
  board.apply(b, { t: "step", id: "s1", step: "1" });
  board.apply(b, scene("sc"));
  assert.deepEqual(lay(b), { by: "app", template: "focus", rows: [[["sc"]]], shelf: ["approve"] }, "the scene alone gets the room; the stale card is on the shelf");
  // a note and a waiting check in the same turn: the scene keeps the room, the check then the note stack beside it
  board.apply(b, put("idea", "PDM is a density"));
  board.apply(b, ask("check"));
  assert.deepEqual(lay(b), { by: "app", template: "focus-aside", rows: [[["sc"], ["check", "idea"]]], shelf: ["approve"] });
  // next turn, the tutor only talks: what it put up last stays in view
  board.apply(b, { t: "turn", id: "t3", answers: "check" });
  board.apply(b, { t: "ask", id: "check", status: "answered", answers: [{ choice: 1 }] });
  assert.deepEqual(lay(b).rows, [[["sc"], ["idea", "check"]]]);
  // the turn after, it puts up one new note: that's what's in view now, the rest are a click away
  board.apply(b, { t: "turn", id: "t4" });
  board.apply(b, put("why", "Because the filter averages"));
  // (the answered sets left the board when the learner moved on, as before)
  assert.deepEqual(lay(b), { by: "app", template: "focus", rows: [[["why"]]], shelf: ["sc", "idea"] });
});

test("two text blocks sit side by side; a full-width note stacks; at most four are in view", () => {
  const b = board.newBoard();
  board.apply(b, { t: "turn", id: "t1" });
  board.apply(b, put("idea", "x"));
  board.apply(b, ask("q"));
  assert.deepEqual(lay(b), { by: "app", template: "compare", rows: [[["idea"], ["q"]]], shelf: [] });
  board.apply(b, put("table", "wide", { size: "full" }));
  assert.equal(lay(b).template, "stack");
  assert.deepEqual(lay(b).rows, [[["q"]], [["idea"]], [["table"]]], "the waiting set leads");
  for (const id of ["n1", "n2", "n3"]) board.apply(b, put(id, "x"));
  const a = lay(b);
  assert.equal(a.rows.flat().flat().length, 4);
  assert.ok(a.rows.flat().flat().includes("q"), "a waiting set is always in view");
  assert.deepEqual(a.shelf, ["idea", "table"]);
});

test("the tutor's layout: templates, the shelf, and when it gives way", () => {
  const b = board.newBoard();
  board.apply(b, { t: "turn", id: "t1" });
  board.apply(b, scene("sc"));
  board.apply(b, put("a", "x"));
  board.apply(b, put("old", "x"));
  board.apply(b, { t: "board-op", id: "L1", op: { put: [{ id: "b", body: "y" }], layout: { template: "compare", show: ["a", "b"] } } });
  assert.deepEqual(lay(b), { by: "tutor", template: "compare", rows: [[["a"], ["b"]]], shelf: ["sc", "old"] });
  assert.match(board.listing(b), /scene `sc`: PDM · on the shelf[\s\S]*Layout: compare \(yours\): `a` \| `b`\./);
  // updating a note it shows keeps the layout; the learner folds one: the layout shows the rest
  board.apply(b, put("a", "x2"));
  board.apply(b, { t: "learner", id: "l1", op: "shelve", target: "b" });
  assert.deepEqual(lay(b).rows, [[["a"]]]);
  // the learner opens one from the shelf: the app arranges it, keeping what the layout had in view
  board.apply(b, { t: "learner", id: "l2", op: "show", target: "sc" });
  assert.deepEqual(lay(b), { by: "app", template: "focus-aside", rows: [[["sc"], ["a"]]], shelf: ["old", "b"] });
  // a new layout names b again: the tutor's call wins over the fold
  board.apply(b, { t: "board-op", id: "L2", op: { layout: { template: "custom", rows: [["sc", ["a", "b"]]], widths: [[3, 2]] } } });
  assert.deepEqual(lay(b), { by: "tutor", template: "custom", rows: [[["sc"], ["a", "b"]]], shelf: ["old"] });
  assert.equal(board.arrange(b).rows[0].cells[0].w, 3);
  // a question set it didn't place has to be seen: the app takes over, keeping the layout's blocks in view
  board.apply(b, ask("q"));
  assert.deepEqual(lay(b), { by: "app", template: "focus-aside", rows: [[["sc"], ["q", "a", "b"]]], shelf: ["old"] });
  board.apply(b, { t: "board-op", id: "L3", op: { layout: { template: "focus-aside", show: ["q", "sc"] } } });
  assert.deepEqual(lay(b).rows, [[["q"], ["sc"]]]);
  // "auto" hands it back; a page turn does too
  board.apply(b, { t: "board-op", id: "L4", op: { layout: "auto" } });
  assert.equal(board.arrange(b).by, "app");
  board.apply(b, { t: "board-op", id: "L5", op: { layout: { template: "focus", show: ["sc"] } } });
  board.apply(b, { t: "turn", id: "t2" });
  board.apply(b, { t: "step", id: "s2", step: "2" });
  assert.equal(b.layout, null);
});

test("the layout field is checked", () => {
  const L = (layout) => board.normalizeOp({ layout });
  assert.deepEqual(L("auto").layout, { template: "auto" });
  assert.equal(L({ show: ["a", "b"] }).layout.template, "focus-aside");
  assert.equal(L({ rows: [["a"]] }).layout.template, "custom");
  assert.throws(() => L({ template: "grid" }), /one of auto, focus/);
  assert.throws(() => L({ template: "focus", show: ["a", "b"] }), /focus-aside/);
  assert.throws(() => L({ template: "compare" }), /needs show/);
  assert.throws(() => L({ template: "custom" }), /needs rows/);
  assert.throws(() => L({ template: "stack", show: ["a", "a"] }), /twice/);
  assert.throws(() => L({ template: "stack", show: ["a b"] }), /isn't a block id/);
  assert.throws(() => L({ template: "custom", rows: [["a", "b", "c", "d", "e"]] }), /at most 4/);
  assert.throws(() => L({ template: "stack", show: ["a", "b", "c", "d", "e", "f", "g"] }), /at most 6/);
  // a layout naming a block that isn't there: the tool refuses it, so the board ignores all of the call
  const b = board.newBoard();
  board.apply(b, put("a", "x"));
  board.apply(b, { t: "board-op", id: "bad", op: { put: [{ id: "b", body: "y" }], layout: { template: "compare", show: ["a", "ghost"] } } });
  assert.deepEqual(ids(b), ["a"]);
  assert.equal(b.layout, null);
  assert.deepEqual(board.layoutMissing(b, board.normalizeOp({ put: [{ id: "c", body: "z" }], remove: ["a"], layout: { show: ["a", "c"] } })), ["a"]);
});

test("a pending question set can't be folded; the arrangement rides along in the view, not in a rebuilt board", () => {
  const b = board.newBoard();
  board.apply(b, ask("q"));
  board.apply(b, { t: "learner", id: "l1", op: "shelve", target: "q" });
  assert.deepEqual(lay(b).rows, [[["q"]]]);
  const v = board.view(b);
  assert.equal(v.arrangement.template, "focus");
  assert.equal(board.fromView(v).arrangement, undefined);
});

test("what the learner opened before the tutor's layout doesn't override it; what they open after does", () => {
  const b = board.newBoard();
  board.apply(b, { t: "turn", id: "t1" });
  board.apply(b, put("a", "x"));
  board.apply(b, put("b", "y"));
  board.apply(b, { t: "learner", id: "k1", op: "keep", text: "your reply", at: "z" });
  board.apply(b, { t: "board-op", id: "L1", op: { layout: { template: "focus", show: ["a"] } } });
  assert.deepEqual(lay(b), { by: "tutor", template: "focus", rows: [[["a"]]], shelf: ["b", "k1"] });
  board.apply(b, { t: "learner", id: "s1", op: "show", target: "b" });
  assert.deepEqual(lay(b), { by: "app", template: "compare", rows: [[["a"], ["b"]]], shelf: ["k1"] });
});
