#!/usr/bin/env node
// The `teach` MCP server: the tools a tutor session inside the Teach app uses to drive the interface.
// Claude Code starts it over stdio (see engine.mjs); TEACH_TOPIC names the topic this session teaches.
// It speaks just enough MCP (initialize, tools/list, tools/call) and has no dependencies.
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as ops from "./lib/ops.mjs";
import { getTopic } from "./lib/store.mjs";
import { Learner } from "./lib/paths.mjs";
import * as review from "./lib/review.mjs";
import { CHALK, ROUTE_TTL, takeInbox, chalk, speakSeconds, toast, panel, reviewPanel, reviewGood, screenable } from "./lib/screen.mjs";

const TOPIC = process.env.TEACH_TOPIC;
const SCREEN = process.env.TEACH_SCREEN === "1";   // screen mode: say + watch (chalk's own MCP server adds look/draw/clear)
const md = "Markdown; math as LaTeX in $…$ or $$…$$ (rendered with KaTeX)";
const CHALK_HOME = path.dirname((() => { try { return fs.realpathSync(CHALK); } catch { return CHALK; } })());
const SCENE_DOC = path.join(CHALK_HOME, "scene.md");
// the stage needs chalk's scene host; without it (an older chalk) the tutor isn't offered the scene tool
const STAGE = fs.existsSync(process.env.TEACH_SCENEHOST || path.join(CHALK_HOME, "scenehost.py"));

const TOOLS = [
  {
    name: "ask",
    description: "Show the learner a set of questions as an interactive card in the lesson (probes, step checks, setup questions, plan approval, practice). " +
      "Returns at once: END YOUR TURN right after calling it. Their answers arrive as your next user message, starting '[Answers to question set …]', already graded when you gave answer keys. " +
      "Give every graded question an answer key and a one-line `why`: the app reveals right/wrong and the why the moment they submit, so you don't have to. " +
      "Graded choice options are shuffled by the app, so refer to options by their text, never by letter or position. Never re-ask a set that is still waiting; it stays on screen.",
    inputSchema: {
      type: "object", required: ["questions"],
      properties: {
        purpose: { type: "string", enum: ["probe", "check", "review", "setup", "approve", "practice"], description: "probe = map their edge; check = test the step just taught; setup = context questions (no 'I don't know'); approve = 'does this plan look right?'" },
        node: { type: "string", description: "Plan step id this set checks (for check/practice)" },
        intro: { type: "string", description: `One line above the questions (${md})` },
        box: { type: "array", items: { type: "number" }, description: "Screen mode: [x, y, w, h] in the last screenshot's px of what the questions are about (the code line, the button). The card pops up on their screen beside it." },
        questions: {
          type: "array", minItems: 1, maxItems: 8,
          items: {
            type: "object", required: ["prompt"],
            properties: {
              kind: { type: "string", enum: ["choice", "multi", "text", "number", "order", "task"], description: "choice = one option (default); multi = several; text = they write (predictions, explanations, paragraphs); number = numeric answer with unit; order = put options in order (give them in the CORRECT order, the app shuffles); task = a hands-on instruction they do outside the app, then answer Done or Stuck" },
              prompt: { type: "string", description: md },
              options: { type: "array", items: { type: "string" }, description: `choice/multi: 2-6 options; every distractor a real misconception (${md}). order: the items in correct order.` },
              answer: { description: "Answer key. choice: 0-based index of the right option; multi: array of indices; number: the value" },
              tolerance: { type: "number", description: "number: allowed absolute error (default 1%)" },
              unit: { type: "string", description: "number: unit shown next to the input, e.g. μC" },
              why: { type: "string", description: `Shown right after they submit: why the right answer is right, or the misconception the tempting distractor carries (one or two sentences, ${md})` },
              idk: { type: "boolean", description: "Offer 'I don't know' (default true for choice/multi/number, except setup/approve sets)" },
              own: { type: "boolean", description: "choice: let them answer in their own words instead (default true)" },
              minutes: { type: "number", description: "text: show a countdown (timed writing, exam pacing)" },
              words: { type: "number", description: "text: target length, shown with the word count" },
              placeholder: { type: "string" },
              image: { type: "string", description: "Absolute path of an image to show with the question (a circuit, a graph, a screenshot)" },
            },
          },
        },
      },
    },
  },
  {
    name: "update",
    description: "Update the topic shown in the app's sidebar and home page: title, goal, why, course, deadline, status, phase, the knowledge map, fact-check notes, sources, and `next` (the one-line resume note: where it stopped and what comes next; keep it current, it is what the next session starts from).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short topic title, e.g. 'Physics II Exam 2'" },
        goal: { type: "string", description: "What they can do at the end, one sentence" },
        why: { type: "string", enum: ["class", "exam", "homework", "project", "skill", "curiosity", "writing"] },
        course: { type: "string" },
        deadline: { type: "string", description: "YYYY-MM-DD (exam/due date) or '' to clear" },
        status: { type: "string", enum: ["active", "paused", "done", "archived"] },
        phase: { type: "string", enum: ["frame", "probe", "plan", "teach", "review", "close"] },
        next: { type: "string" },
        integrity: { type: "string", description: "Academic-integrity note when the material is graded, e.g. 'graded homework: parallel problems only'" },
        map: { type: "array", description: "The knowledge map (replaces it): one entry per strand", items: { type: "object", required: ["strand"], properties: { strand: { type: "string" }, has: { type: "string", description: "hardest thing they reliably have" }, missing: { type: "string", description: "easiest thing they don't have yet" }, misconception: { type: "string" } } } },
        facts_add: { type: "array", items: { type: "string" }, description: "Fact-check corrections and conventions the teaching must respect (appended)" },
        sources_add: { type: "array", items: { type: "object", properties: { label: { type: "string" }, path: { type: "string" }, url: { type: "string" } } } },
      },
    },
  },
  {
    name: "plan",
    description: "Set the dependency plan (replaces it; step statuses are kept for ids that stay). Each node is ONE reasoning step, small enough for one message, in teaching order. The app draws it as the progress list in the sidebar.",
    inputSchema: {
      type: "object", required: ["nodes"],
      properties: {
        nodes: { type: "array", items: { type: "object", required: ["id", "title"], properties: {
          id: { type: "string", description: "Short stable id, e.g. '1', '2', '3a'" }, title: { type: "string" },
          detail: { type: "string", description: "One line on what the step covers" }, deps: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["todo", "current", "done", "shaky", "skipped"] }, result: { type: "string" }, note: { type: "string" } } } },
      },
    },
  },
  {
    name: "step",
    description: "Mark progress on one plan step: 'current' when you start teaching it, 'done' (with the check result like '2/2') when they pass its check, 'shaky' when they passed only after a re-teach or still wobbles.",
    inputSchema: {
      type: "object", required: ["id"],
      properties: { id: { type: "string" }, status: { type: "string", enum: ["todo", "current", "done", "shaky", "skipped"] }, result: { type: "string", description: "e.g. '2/2', '1/3 → re-taught → 2/2'" }, note: { type: "string", description: "What they showed, or what was shaky" } },
    },
  },
  {
    name: "cards",
    description: "Add review items to the topic's deck (spaced-repetition review and drills in the app's Review tab). Add each check question you asked as an mcq right after they answer, and key facts as cards. Exam topics: also traps (their real mistakes), recall items, timelines (order) and essay outlines (outline).",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object", required: ["type"], properties: {
          type: { type: "string", enum: ["card", "mcq", "recall", "trap", "order", "outline"] },
          group: { type: "string", description: "Group key (sub-topic), e.g. 'capacitors'" }, node: { type: "string", description: "Plan step id" },
          front: { type: "string" }, back: { type: "string" },
          prompt: { type: "string" }, options: { type: "array", items: { type: "string" } }, answer: { description: "mcq: index of the right option; recall: the answer text" }, why: { type: "string" },
          accept: { type: "string", description: "recall: case-insensitive regex that accepts a typed answer" },
          wrong: { type: "string", description: "trap: the tempting wrong statement" }, right: { type: "string", description: "trap: the correct version" },
          title: { type: "string" }, items: { type: "array", description: "order: [{label, text}] in correct order", items: { type: "object" } },
          minutes: { type: "number" }, sections: { type: "array", description: "outline: [{title, minutes, keywords: [{label, pattern}]}]", items: { type: "object" } },
        } } },
        groups: { type: "object", description: "Group key → display name" },
        checks: { type: "array", description: "Writing checks for paragraph drills: [{pattern (regex), message, unless (regex)}]", items: { type: "object" } },
      },
    },
  },
  {
    name: "show",
    description: "Show a figure or an interactive page inline in the lesson: an image/SVG you drew (path), or a self-contained HTML page (html) for a simulator, interactive plot or drill. HTML runs sandboxed (scripts allowed, no network); keep it self-contained. For a plain picture you can also write ![caption](/abs/path.png) in your message.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, path: { type: "string", description: "Absolute path to .png/.svg/.jpg/.html" }, html: { type: "string" }, name: { type: "string", description: "File name for html (saved to the topic's figures/)" }, height: { type: "number" }, caption: { type: "string" } },
    },
  },
  {
    name: "scene",
    description: "Put a live scene on the stage of the Teach window's workspace: an animated, interactive board (chalk's scene engine, the 3Blue1Brown look) " +
      "with real TeX, plots that follow sliders, circuits with moving current, steps behind Next. It is the workspace for topics with no app of their own " +
      "(a physics idea, a filter, a proof): they drag, toggle and step through it the way they'd use an editor for code. " +
      `The spec format is chalk's: read ${SCENE_DOC} before your first scene. ` +
      "`predict` turns steps into predict-then-reveal: Next into that step stays locked until they commit an answer on the stage; then the step plays, " +
      "their answer is graded, and it arrives as your next message ('[Stage] …'). With a predict gate on the next step, END YOUR TURN after calling this, like ask. " +
      "To change the scene that's up (new values, one more object), call it again with `replaces` set to the earlier call's id: it morphs instead of starting over.",
    inputSchema: {
      type: "object", required: ["scene"],
      properties: {
        scene: { type: "object", description: "The scene spec (title, size, params, let, objects, steps), as in chalk's scene format" },
        predict: { type: "array", description: "Prediction gates", items: { type: "object", required: ["step", "prompt"], properties: {
          step: { type: "number", description: "0-based index of the step that waits for their prediction (the reveal)" },
          prompt: { type: "string", description: `What to predict (${md})` },
          kind: { type: "string", enum: ["choice", "number"], description: "choice (default) or number" },
          options: { type: "array", items: { type: "string" } }, answer: { description: "choice: 0-based index; number: the value" },
          tolerance: { type: "number" }, unit: { type: "string" }, why: { type: "string", description: "Shown after the reveal: why it comes out that way" } } } },
        replaces: { type: "string", description: "Tool-call id of the scene this one updates in place" },
      },
    },
  },
];

const SCREEN_TOOLS = [
  {
    name: "say",
    description: "Say this out loud on the learner's computer (a natural voice through the speakers) and show it in the lesson. Screen mode's narration: " +
      "one or two short spoken sentences per call (under ~30 words), plain words, no Markdown, no LaTeX, no symbols read aloud. " +
      "Returns at once while the voice plays, so draw the matching mark in the same breath (call screen_draw alongside). Lines queue; they never talk over each other.",
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  },
  {
    name: "watch",
    description: "Wait for the learner to act on their screen, then get the screen back. Returns when something on screen changed and held still (with roughly where), " +
      "when they say something (the app's composer or Super+/; you get their words), or at the timeout. " +
      "Call it after say/screen_draw have gone out (not in parallel with them). Then check what they did on the returned screenshot and respond.",
    inputSchema: {
      type: "object",
      properties: {
        expect: { type: "string", description: "What you're waiting for them to do, in a few words (shown in the app), e.g. 'open the Layers panel'" },
        timeout: { type: "number", description: "Seconds to wait (default 90, max 300). On a timeout, offer a hint." },
        settle: { type: "number", description: "Seconds the screen has to hold still before it counts (default 1.2; ~4 when they're typing something longer)" },
      },
    },
  },
  {
    name: "review",
    description: "Run spaced review on their screen: this topic's due review cards pop up one at a time as panels they answer there " +
      "(flashcards and traps: reveal, then Again/Good; multiple choice grades itself). Grades go into the same review schedule as the app's Review tab. " +
      "Blocks until they're through them (or walk away), then returns how each went. Use it for the short review at the start of a continued session.",
    inputSchema: { type: "object", properties: { count: { type: "number", description: "How many due items (default 3, max 8)" } } },
  },
];

const running = new Map();   // request id → abort(), for watch calls the client cancels

async function watch(args, id) {
  // They may have said something between two watches (the app queued it here): answer that first.
  const early = takeInbox(TOPIC);
  if (early.length) return [{ type: "text", text: `${Learner} said (while you were busy): ${early.map((t) => `“${t}”`).join(" then ")}` }];
  const timeout = Math.min(300, Math.max(5, Number(args.timeout) || 90));
  const settle = Math.min(10, Math.max(0.6, Number(args.settle) || 1.2));
  const route = JSON.stringify({ to: "teach", slug: TOPIC, title: getTopic(TOPIC)?.title || TOPIC, ttl: ROUTE_TTL });
  const child = spawn(CHALK, ["watch", "--json", "--timeout", String(timeout), "--settle", String(settle), "--route", route],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ } };
  return await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearInterval(poll); running.delete(id); resolve(v); };
    const poll = setInterval(() => {
      const said = takeInbox(TOPIC);
      if (said.length) { stop(); finish([{ type: "text", text: `${Learner} said: ${said.map((t) => `“${t}”`).join(" then ")}\n(Call screen_look if you need to see what they mean.)` }]); }
    }, 250);
    running.set(id, () => { stop(); finish([{ type: "text", text: "Stopped." }]); });
    child.on("error", (e) => finish({ error: `chalk isn't available: ${e.message}` }));
    child.on("close", (code) => {
      if (done) return;
      let r;
      try { r = JSON.parse(out); } catch { return finish({ error: `couldn't watch the screen (chalk exit ${code}): ${(err || out).trim().slice(-300) || "no output"}. Is the computer with the screen reachable?` }); }
      const [w, h] = r.size || [0, 0];
      const lead = r.reason === "screen"
        ? `The screen changed after ${r.waited} s${r.where ? `, mostly around [${r.where.join(", ")}]` : ""}. The screen now (${w}x${h} px, give screen_draw boxes in these pixels):`
        : `Nothing changed on their screen in ${r.waited} s. The screen now (${w}x${h} px):`;
      let png = null;
      try { png = fs.readFileSync(r.shot).toString("base64"); } catch { /* text only */ }
      finish([{ type: "text", text: lead }, ...(png ? [{ type: "image", data: png, mimeType: "image/png" }] : [])]);
    });
  });
}

async function reviewOnScreen(args, id) {
  const n = Math.min(8, Math.max(1, Number(args.count) || 3));
  const items = review.queue({ slug: TOPIC }).slice(0, n);
  if (!items.length) return "Nothing in this topic's deck is due for review right now.";
  const tag = `teach-review-${Date.now()}`;
  const lines = [];
  let good = 0, stop = false, cur = null;
  running.set(id, () => { stop = true; cur?.cancel(); });
  try {
    for (const [i, item] of items.entries()) {
      if (stop) break;
      const key = `${TOPIC}/${item.id}`, since = review.lastSeen()[key];
      const what = item.front || item.prompt || item.wrong || item.title || item.id;
      if (since && Date.now() - since < 60e3) { lines.push(`- "${String(what).slice(0, 80)}": graded in the Teach app just now`); continue; }
      cur = panel(reviewPanel(item, i, items.length, tag));
      // graded in the app's Review tab while it's up here: take it down, it's done
      let elsewhere = false;
      const poll = setInterval(() => { if (review.lastSeen()[key] !== since) { elsewhere = true; cur.cancel(); } }, 1000);
      const r = await cur.done;
      clearInterval(poll);
      if (elsewhere) { lines.push(`- "${String(what).slice(0, 80)}": graded in the Teach app`); continue; }
      const ok = reviewGood(item, r);
      if (r.status === "error") return { error: `couldn't put review cards on their screen: ${r.error}. Is the computer with the screen reachable?` };
      if (ok === null) { lines.push(`- "${String(what).slice(0, 80)}": ${r.status === "dismissed" ? "closed" : "not answered"}`); break; }
      review.gradeItem(TOPIC, item.id, ok);
      if (ok) good++;
      lines.push(`- "${String(what).slice(0, 80)}": ${ok ? "good" : "again (missed it)"}`);
    }
  } finally { running.delete(id); }
  chalk(["remove", tag]);
  const graded = lines.filter((l) => /good|again/.test(l)).length;
  if (graded) toast(`Review done · ${good} of ${graded} good`, good === graded ? "green" : "yellow");
  return `Review on their screen (${graded} graded, ${good} good; the schedule is updated):\n${lines.join("\n")}`;
}

function say(args) {
  const text = String(args.text || "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("text is empty");
  if (getTopic(TOPIC)?.settings.voice === false) return "Voice is off (turned off in Teach): the words show only in the Teach window. Put anything they have to act on on their screen as a label or card.";
  chalk(["say", text]);
  return `Speaking (about ${speakSeconds(text)} s).`;
}

async function call(name, args, id) {
  if (!TOPIC) throw new Error("TEACH_TOPIC is not set; this server only runs inside the Teach app");
  if (SCREEN && name === "watch") return watch(args, id);
  if (SCREEN && name === "say") return say(args);
  if (SCREEN && name === "review") return reviewOnScreen(args, id);
  switch (name) {
    case "ask": {
      const a = ops.normalizeAsk(args);  // validate only; the app reads the call from the stream and shows it
      if (SCREEN && screenable(a)) return "Shown on their screen as a card they answer there (beside your box, if you gave one) and in Teach. End your turn now; their answers arrive as your next message.";
      return "Shown to the learner" + (SCREEN ? " in the Teach window only (pictures and ordering questions don't go on the screen): tell them out loud there's a question in Teach" : "") + ". End your turn now; their answers arrive as your next message.";
    }
    case "update": ops.update(TOPIC, args); return "Updated.";
    case "plan": { const t = ops.plan(TOPIC, args); return `Plan set: ${t.plan.length} steps.`; }
    case "step": {
      const t = ops.step(TOPIC, args);
      const i = t.plan.findIndex((x) => x.id === String(args.id)), n = t.plan[i];
      if (SCREEN && ["done", "shaky", "current"].includes(args.status)) {   // a tiny toast on their screen: where the plan stands
        const done = t.plan.filter((x) => x.status === "done").length;
        toast(args.status === "current" ? `Step ${i + 1} of ${t.plan.length} · ${n.title}` : `Step ${i + 1} ${args.status === "done" ? "done" : "shaky, we'll come back"} · ${done} of ${t.plan.length}`,
          args.status === "done" ? "green" : args.status === "shaky" ? "yellow" : "blue");
      }
      return `Step ${n.id} is ${n.status}.`;
    }
    case "cards": { const r = ops.cards(TOPIC, args); return `Added ${r.added} item(s); the deck has ${r.total}.`; }
    case "show": { ops.normalizeShow(TOPIC, args); return "Shown."; }
    case "scene": {
      const sc = ops.normalizeScene(args);   // validate only; the app reads the call from the stream and puts it up
      return `On the stage in Teach${sc.predict.length ? `. Step ${sc.predict[0].step + 1} waits for their prediction: end your turn now; it arrives as your next message` : ""}.` +
        (SCREEN ? " Tell them out loud it's in the Teach window." : "");
    }
    default: throw new Error(`unknown tool ${name}`);
  }
}

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  const fail = (text) => reply({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });
  if (m.method === "initialize") {
    reply({ protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "teach", version: "1" } });
  } else if (m.method === "tools/list") {
    const tools = STAGE ? TOOLS : TOOLS.filter((t) => t.name !== "scene");
    reply({ tools: SCREEN ? [...tools, ...SCREEN_TOOLS] : tools });
  } else if (m.method === "tools/call") {
    try {
      const r = await call(m.params.name, m.params.arguments || {}, m.id);
      if (r?.error) fail(r.error);
      else reply({ content: Array.isArray(r) ? r : [{ type: "text", text: r }] });
    } catch (e) {
      fail(e.message);
    }
  } else if (m.method === "notifications/cancelled") {
    running.get(m.params?.requestId)?.();
  } else if (m.id !== undefined) {
    reply({});
  }
});
