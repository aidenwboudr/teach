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
  assert.throws(() => board.normalizeOp({}), /put, remove, pin or unpin/);
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
  assert.match(board.listing(b), /question set `q1`: Check · step 1 · answered\n- note `idea`: v2/);
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
