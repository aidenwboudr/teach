#!/usr/bin/env node
// The `teach` MCP server: the tools a tutor session inside the Teach app uses to drive the interface.
// The tutor's CLI starts it over stdio (Claude Code, Codex or Gemini CLI; see lib/engine.mjs and lib/providers/);
// TEACH_TOPIC names the topic this session teaches.
// It speaks just enough MCP (initialize, tools/list, tools/call) and has no dependencies.
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import * as ops from "./lib/ops.mjs";
import { getTopic, getRuntime, topicDir } from "./lib/store.mjs";
import { Learner, LEARNING } from "./lib/paths.mjs";
import { renderFigure } from "./lib/figure-render.mjs";
import { checkFigureFile, checkHtml, checkScene } from "./lib/figures.mjs";
import { inside } from "./lib/platform.mjs";
import * as review from "./lib/review.mjs";
import * as board from "./lib/board.mjs";
import { fileTools, callFile } from "./lib/files.mjs";
import { renderDoc, describe as describeDoc } from "./lib/doc.mjs";
import { layoutFor } from "./lib/actions.mjs";
import { prefs as voicePrefs } from "./lib/voice.mjs";
import { CHALK, ROUTE_TTL, takeInbox, chalk, speakSeconds, toast, panel, reviewPanel, reviewGood, screenable, isLive, OFF_SCREEN, staleCards, noteCheck } from "./lib/screen.mjs";

const TOPIC = process.env.TEACH_TOPIC;
// The screen tools (say, watch, review, screen; chalk's own MCP server adds look/draw/clear): there when chalk is. They
// work while the lesson is on the learner's screen (their "On my screen" switch, or a stretch the tutor started with `screen`).
const SCREEN = process.env.TEACH_SCREEN === "1";
const live = () => SCREEN && isLive(getTopic(TOPIC), getRuntime(TOPIC));
// A restricted tutor on Codex or Gemini CLI reads and writes through tools here (lib/files.mjs), under this policy.
const FILES = (() => { try { return JSON.parse(process.env.TEACH_FILES || "null"); } catch { return null; } })();
const md = "Markdown; math as LaTeX in $…$ or $$…$$ (rendered with KaTeX)";
const CHALK_HOME = path.dirname((() => { try { return fs.realpathSync(CHALK); } catch { return CHALK; } })());
const SCENE_DOC = path.join(CHALK_HOME, "scene.md");
// the stage needs chalk's scene host; without it (an older chalk) the tutor isn't offered the scene tool
const STAGE = fs.existsSync(process.env.TEACH_SCENEHOST || path.join(CHALK_HOME, "scenehost.py"));

const TOOLS = [
  {
    name: "ask",
    description: "Show the learner a set of questions as an interactive card on the lesson board (probes, step checks, setup questions, plan approval, practice). " +
      "Returns at once: END YOUR TURN right after calling it. Their answers arrive as your next user message, starting '[Answers to question set …]', already graded when you gave answer keys. " +
      "Give every graded question an answer key and a one-line `why`: the app reveals right/wrong and the why the moment they submit, so you don't have to. " +
      "Graded choice options are shuffled by the app, so refer to options by their text, never by letter or position. Never re-ask a set that is still waiting; it stays on screen.",
    inputSchema: {
      type: "object", required: ["questions"],
      properties: {
        purpose: { type: "string", enum: ["probe", "check", "review", "setup", "approve", "practice", "break"], description: "probe = map their edge; check = test the step just taught; setup = context questions (no 'I don't know'); approve = 'does this plan look right?'; " +
          "break = offer a stop at a natural break: give `intro` (where the session stands) and one question whose prompt says why here is a good place (no options: the app writes them: Stop here for today, Do step <finish> and then stop when you give `finish`, Keep going). A stop they pick ends the session exactly as the app's Stop for today button does: you get its '[Teach app] pause' message." },
        finish: { type: "string", description: "break: the plan step id worth finishing before stopping (a short one, e.g. the next step); adds 'Do step <id> and then stop'" },
        node: { type: "string", description: "Plan step id this set checks (for check/practice)" },
        intro: { type: "string", description: `One line above the questions (${md})` },
        box: { type: "array", items: { type: "number" }, description: "Screen mode: [x, y, w, h] in the last screenshot's px of what the questions are about (the code line, the button). The card pops up on their screen beside it." },
        questions: {
          type: "array", minItems: 1, maxItems: 8, description: "break: one question, the prompt only",
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
        allowance: { type: "object", description: "What the exam allows the learner to bring, when you know it (the course's own rule, with where it says so): kind sheet (with paper letter|a4|half-letter|index-3x5|index-4x6, sheets, sides 1|2), none (closed notes), open, or unknown. Sizes the note-sheet action.",
          properties: { kind: { type: "string", enum: ["sheet", "none", "open", "unknown"] }, paper: { type: "string" }, sheets: { type: "number" }, sides: { type: "number" }, text: { type: "string", description: "the rule in the course's words" }, source: { type: "string", description: "where it says so" } } },
        suggest: { type: "array", description: "At the end of a session: the end-of-session actions that fit best, best first, each with a one-line why the learner sees on its button. The app shows them as a grid; nothing is made until the learner clicks one. Kinds: sheet (note/study sheet PDF), worksheet (problems + key PDF), practice (timed test in Teach), session (a review or next session on their calendar), cards (flashcards), quickref (bench/reference card), assignment (practice on their own), notes (lesson notes PDF).",
          items: { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: ["sheet", "worksheet", "practice", "session", "cards", "quickref", "assignment", "notes"] }, why: { type: "string" } } } },
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
        scope: { type: "array", description: "For an exam: its official scope, one entry per line of the scope sheet (review slide, exam page, syllabus), checked one level down. " +
          "For each line, open the lecture(s) that taught it and list every sub-topic they teach, with the plan step(s) that cover it. A heading hides sub-topics " +
          "(\"Polarization\" = polarizer chains AND polarization by reflection / Brewster's angle). The plan is refused while a sub-topic has no step and no `skip` reason. " +
          "Kept across re-plans (pass it again to change it); [] records that no scope was published.",
          items: { type: "object", required: ["line", "taught_in", "subtopics"], properties: {
            line: { type: "string", description: "The scope line in the course's words, e.g. 'Polarization 5-10 pts'" },
            source: { type: "string", description: "Where the scope says so (file or page)" },
            taught_in: { type: "array", items: { type: "string" }, description: "The lecture(s)/reading that taught this line, as files you opened, e.g. 'lectures/L28-Polarization.pdf'" },
            subtopics: { type: "array", items: { type: "object", required: ["name"], properties: {
              name: { type: "string", description: "One thing the lecture teaches, e.g. 'Brewster angle: reflected light polarized parallel to the surface'" },
              nodes: { type: "array", items: { type: "string" }, description: "Plan step ids that cover it" },
              skip: { type: "string", description: "Why it isn't taught (e.g. 'instructor: not on Exam 3'); leave out when a step covers it" } } } } } } },
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
    description: "Add review items to the topic's deck (spaced-repetition review and drills in the app's Review tab). Only when the learner asked for them: the Flashcards action (\"[Teach app] action cards\") or their own request. Don't bank cards as you teach. Item types: card, mcq, recall, trap (their real mistakes), order (timelines), outline (essay keyword skeletons).",
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
    description: "Put a figure or an interactive page on the lesson board as its own block: an SVG you drew (path), or a self-contained HTML page (html) for a simulator, interactive plot or drill. HTML runs sandboxed (scripts allowed, no network); keep it self-contained. A picture inside a note works too: ![caption](/abs/path.svg) in its body. " +
      "Figures follow the figure contract (skill/figures.md): the app themes them (dark ground, chalk's colours, KaTeX), so no background, colour codes or fonts of their own, and no matplotlib/plotly output; a figure that breaks it is refused with the reasons.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, path: { type: "string", description: "Absolute path to .png/.svg/.jpg/.html" }, html: { type: "string" }, name: { type: "string", description: "File name for html (saved to the topic's figures/)" }, height: { type: "number" }, caption: { type: "string" } },
    },
  },
  {
    name: "render",
    description: "Render an SVG you drew the way the board shows it (themed by the app, on a card, math typeset) and look at it: the PNG comes back in the result, with a list of problems (labels past the frame, on each other or on a line; colour codes, fonts, a background). Fix the SVG and render again until there are none and it's right, then show the SVG. " +
      "The SVG must be in the learning folder (normally the topic's figures/); the PNG is written next to it.",
    inputSchema: {
      type: "object", required: ["svg"],
      properties: { svg: { type: "string", description: "Path of the .svg: absolute, or relative to the topic folder (e.g. figures/rc.svg)" } },
    },
  },
  {
    name: "scene",
    description: "Put a live scene on the lesson board as its own block: an animated, interactive canvas (chalk's scene engine, the 3Blue1Brown look) " +
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

// The end-of-session actions (lib/actions.mjs): the tutor makes one only when the app says the learner clicked it.
TOOLS.push({
  name: "document",
  description: "Render a Markdown file in the topic folder (math as LaTeX, images by absolute path) into a print-ready PDF, and see every page. " +
    "For an end-of-session action pass `for` (sheet, worksheet, worksheet-key, quickref, assignment, notes): the page size, page budget, columns and font come from what the learner chose, " +
    "and the font shrinks to fit the budget when it's on \"as big as fits\". The result says whether it fits, the font it used, and problems to fix (math that doesn't parse, something too wide, an image that didn't load), with the pages as images. " +
    "Fix the Markdown and render again until it fits and looks right. Directives, one per line: `::: break` (next column/page), `::: space 1.5in`, `::: lines 6` (ruled), `::: box 1in` (answer box). Task lists (`- [ ]`) print as checkboxes.",
  inputSchema: {
    type: "object", required: ["source"],
    properties: {
      source: { type: "string", description: "The .md file: relative to the topic folder (e.g. out/sheet.md) or absolute inside it" },
      for: { type: "string", enum: ["sheet", "worksheet", "worksheet-key", "quickref", "assignment", "notes"], description: "The action it's for: its layout and budget are the learner's" },
      layout: { type: "object", description: "Without `for`: style sheet|doc, paper, pages (budget), columns, font (pt or \"auto\"), title. With `for`: only columns may change.",
        properties: { style: { type: "string" }, paper: { type: "string" }, pages: { type: "number" }, columns: { type: "number" }, font: {}, title: { type: "string" } } },
    },
  },
}, {
  name: "deliver",
  description: "Finish an end-of-session action the app asked you to make (\"[Teach app] action …\"): marks it made, so its button turns from grey to ready and opens what you made. " +
    "PDFs you rendered with document for it are attached already; name any other file in `files`. Call it once the thing is right, then reply with one short line.",
  inputSchema: {
    type: "object", required: ["kind", "summary"],
    properties: {
      kind: { type: "string", enum: ["sheet", "worksheet", "practice", "cards", "quickref", "assignment", "notes"] },
      summary: { type: "string", description: "One line shown on the button, e.g. '1 sheet, both sides, 7.4 pt' or '6/8 in 20 min'" },
      files: { type: "array", items: { type: "string" }, description: "Other files it made, relative to the topic folder" },
    },
  },
});

// The board, the lesson page's workspace (lib/board.mjs). Its notes are the tutor's lasting explanations.
TOOLS.push({
  name: "board",
  description: "Change the lesson board, the learner's workspace. The page has no chat log: your reply text shows over their composer only until their next move, " +
    "so anything they'll want to look at for longer goes on the board as a note: the explanation of the step you're on, a worked example, a table, the formula they'll use, " +
    "a pin map or checklist they build up over the lesson. A note whose id is already on the board is replaced in place: keep one evolving note, not near-copies. " +
    "remove takes block ids (notes, and question sets, scenes and figures by the id the listing shows) or \"all\" (every unpinned block except a question set still waiting). " +
    "pin keeps a block when the next plan step turns the page. " +
    "layout decides what's in view and how it sits (see the layout field); without one the app arranges it: what you put up or changed in your latest turn is in view, " +
    "the newest scene or figure gets the room with the rest beside it, and older blocks fold onto the shelf (a one-line chip the learner can open). " +
    "Returns what's on the board, where each block is and the layout.",
  inputSchema: {
    type: "object",
    properties: {
      put: { type: "array", description: "Notes to add, or to replace by id", items: { type: "object", required: ["id", "body"], properties: {
        id: { type: "string", description: "Your short name for it, e.g. 'sd-bands' (letters, digits, - _ . :)" },
        title: { type: "string", description: "Shown in the note's head" },
        body: { type: "string", description: md },
        size: { type: "string", enum: ["half", "full"], description: "half (default) sits beside another block on a wide screen; full takes the board's width (wide tables, long derivations)" },
        pin: { type: "boolean", description: "Keep it across plan steps (reference they'll need again)" },
        place: { type: "string", enum: ["end", "top"], description: "Where a new note goes (default: after the others)" } } } },
      remove: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string", enum: ["all"] }], description: "Block ids to take off the board, or \"all\"" },
      pin: { type: "array", items: { type: "string" }, description: "Block ids to keep across plan steps" },
      unpin: { type: "array", items: { type: "string" } },
      layout: {
        description: "What's in view and how it's arranged, until you set another, a new plan step starts, or something you didn't place has to come into view " +
          "(then the app arranges it, keeping what you had in view). Every block you don't show folds onto the shelf. Templates: " +
          "focus (one block gets the room: a scene to work in, a long derivation), focus-aside (show[0] gets the room, the rest stack beside it: a scene with the note or check about it), " +
          "compare (side by side, equal: two figures, before and after, their answer next to the worked one), stack (one under another, full width: a wide table over its explanation), " +
          "custom (your own rows), auto (back to the app's choice). Ids are the ones the listing shows; anything you put in the same call counts.",
        anyOf: [
          { type: "string", enum: ["auto"] },
          { type: "object", properties: {
            template: { type: "string", enum: ["auto", "focus", "focus-aside", "compare", "stack", "custom"] },
            show: { type: "array", items: { type: "string" }, description: "Block ids to keep in view, the main one first (all templates but custom)" },
            rows: { type: "array", description: "custom: rows top to bottom; each row is a list of cells side by side (up to 4); a cell is a block id, or a list of ids stacked in it. e.g. [[\"scene-id\", [\"note-a\", \"check-id\"]], [\"table\"]]", items: { type: "array" } },
            widths: { type: "array", description: "custom: relative widths per row, e.g. [[2, 1], [1]] (default equal)", items: { type: "array", items: { type: "number" } } } } },
        ],
      },
    },
  },
});

// The board as the server has it now (the server applied this call's change from the stream already, or is about
// to; the change is applied here too, which is a no-op when it already happened).
// One request to the Teach server (TEACH_SERVER: its socket or URL). Resolves to the parsed reply, or null.
function server(p, body, ms = 3000) {
  const SERVER = process.env.TEACH_SERVER || "";
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    const finish = (txt) => { clearTimeout(timer); try { resolve(JSON.parse(txt)); } catch { resolve(null); } };
    if (!SERVER) return finish("");
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { Host: "localhost", ...(data ? { "Content-Type": "application/json", "X-Teach": "1" } : {}) };
    if (SERVER.startsWith("/")) {
      const req = http.request({ socketPath: SERVER, path: p, method: data ? "POST" : "GET", headers }, (res) => {
        let d = ""; res.setEncoding("utf8"); res.on("data", (c) => { d += c; }); res.on("end", () => finish(d));
      });
      req.on("error", () => finish(""));
      req.end(data || undefined);
    } else {
      const { Host, ...rest } = headers;
      fetch(SERVER + p, data ? { method: "POST", headers: rest, body: data } : {}).then((r) => r.text()).then(finish, () => finish(""));
    }
  });
}
const readBoard = async () => { const v = (await server(`/api/topics/${TOPIC}/board`))?.board; return v ? board.fromView(v) : null; };
const withBoard = async (text, change) => {
  const b = await readBoard();
  if (!b) return text;
  if (change) board.apply(b, change);
  return `${text}\n${board.listing(b)}`;
};

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
    name: "screen",
    description: "Move the lesson onto the learner's actual screen for the step(s) that are about something there, or back to the Teach board. " +
      "You decide, the way you lay out the board: go to the screen when the step is about something on their computer (a program's window or menus, " +
      "a datasheet or schematic open there, the code in their editor, a terminal) and doing it there is the learning; stay on the board for ideas with " +
      "nothing on screen to point at (use notes, figures and scenes). Before calling it, say why in one short line of reply text. " +
      "The app may refuse (their screen is locked or asleep, they're typing in Teach, they asked to stay on the board): then the result says why; teach it on the board. " +
      "Once it's live, follow the screen guide's loop (screen_look first). When the screen part is done: one spoken wrap-up line, screen_clear, then call this with to: \"board\". " +
      "If they say to stay on the board (or stop using their screen), call it with to: \"board\" and stay: true.",
    inputSchema: {
      type: "object", required: ["to"],
      properties: {
        to: { type: "string", enum: ["screen", "board"] },
        why: { type: "string", description: "screen: what you'll do there, a few words they see on the switch (e.g. 'find Pin Planner in Quartus')" },
        stay: { type: "boolean", description: "board: they asked to stay on the board for this topic; you won't move it to their screen again" },
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

// The `screen` tool: the server weighs it (lib/screen.mjs liveDecision: chalk, their screen locked or asleep, typing in
// Teach, "stay on the board") and makes the switch; the tutor gets the outcome in words.
async function moveTo(args) {
  const to = args.to === "board" ? "board" : args.to === "screen" ? "screen" : null;
  if (!to) throw new Error('to must be "screen" or "board"');
  const r = await server(`/api/topics/${TOPIC}/live`, { to, why: String(args.why || "").slice(0, 120), stay: !!args.stay, by: "tutor" }, 30e3);
  if (!r) return { error: "The Teach server didn't answer, so nothing changed. Carry on where the lesson is." };
  return r.ok ? r.text : { error: `Not now: ${r.reason}` };
}

// While a line plays on their computer, the server knows (and the page's microphone, if it's on, doesn't take the
// tutor's own voice from the speakers for their answer). Lines queue in chalk, so "speaking" lasts until the last ends.
let saying = 0, sayingSecs = 0;
function say(args) {
  const text = String(args.text || "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("text is empty");
  if (!voicePrefs(getTopic(TOPIC)).narrate.screen) return "Narration on their screen is off (they turned it off in Teach): the words show only in the Teach window. Put anything they have to act on on their screen as a label or card.";
  const secs = speakSeconds(text);
  const p = chalk(["say", text]);
  if (p) {
    saying++; sayingSecs += secs + 3;   // (+3: making the audio)
    server(`/api/topics/${TOPIC}/speaking`, { on: true, seconds: sayingSecs });
    p.on("exit", () => { sayingSecs = Math.max(0, sayingSecs - secs - 3); if (--saying === 0) { sayingSecs = 0; server(`/api/topics/${TOPIC}/speaking`, { on: false }); } });
  }
  return `Speaking (about ${secs} s).`;
}

async function call(name, args, id) {
  if (!TOPIC) throw new Error("TEACH_TOPIC is not set; this server only runs inside the Teach app");
  if (SCREEN && name === "screen") return moveTo(args);
  if (SCREEN && ["watch", "say", "review"].includes(name) && !live()) return { error: OFF_SCREEN };
  if (SCREEN && name === "watch") return watch(args, id);
  if (SCREEN && name === "say") return say(args);
  if (SCREEN && name === "review") return reviewOnScreen(args, id);
  if (FILES && fileTools(FILES).some((t) => t.name === name)) return callFile(FILES, name, args);
  switch (name) {
    case "ask": {
      const a = ops.normalizeAsk(args);  // validate only; the app reads the call from the stream and shows it
      const onScreen = live();
      if (onScreen && screenable(a)) return "Shown on their screen as a card they answer there (beside your box, if you gave one) and in Teach. End your turn now; their answers arrive as your next message.";
      return "Shown to the learner" + (onScreen ? " in the Teach window only (pictures and ordering questions don't go on the screen): tell them out loud there's a question in Teach" : "") + ". End your turn now; their answers arrive as your next message.";
    }
    case "update": ops.update(TOPIC, args); return "Updated.";
    case "plan": { const t = ops.plan(TOPIC, args); return [`Plan set: ${t.plan.length} steps.`, ops.scopeSummary(t)].filter(Boolean).join(" "); }
    case "board": {
      const op = board.normalizeOp(args);
      const b = await readBoard();
      for (const n of op.put) {
        const wall = noteCheck(n);
        if (wall) throw new Error(wall);
        const x = b?.blocks.find((y) => y.id === n.id);
        if (x && x.kind !== "note") throw new Error(`"${n.id}" is a ${x.kind === "ask" ? "question set" : x.kind} on the board; give the note an id of its own`);
      }
      const missing = b ? board.layoutMissing(b, op) : [];   // a layout names blocks on the board, or ones this call puts there
      if (missing.length) throw new Error(`layout: ${missing.map((id) => `"${id}"`).join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} on the board. Nothing changed. ${board.listing(b)}`);
      if (!b) return "Done (the board couldn't be read back just now).";
      board.apply(b, { t: "board-op", id: "here", op: args });
      return `Done.\n${board.listing(b)}`;
    }
    case "step": {
      const t = ops.step(TOPIC, args);
      const i = t.plan.findIndex((x) => x.id === String(args.id)), n = t.plan[i];
      if (live() && ["done", "shaky", "current"].includes(args.status)) {   // a tiny toast on their screen: where the plan stands
        const done = t.plan.filter((x) => x.status === "done").length;
        toast(args.status === "current" ? `Step ${i + 1} of ${t.plan.length} · ${n.title}` : `Step ${i + 1} ${args.status === "done" ? "done" : "shaky, we'll come back"} · ${done} of ${t.plan.length}`,
          args.status === "done" ? "green" : args.status === "shaky" ? "yellow" : "blue");
      }
      if (live() && ["done", "shaky", "skipped", "current"].includes(args.status)) {   // the step moved on: its cards come down
        const stale = staleCards(getRuntime(TOPIC).screenCards, t.plan.find((x) => x.status === "current")?.id);
        if (stale.length) chalk(["remove", ...stale]);
      }
      if (args.status !== "current") return `Step ${n.id} is ${n.status}.`;
      const b = await readBoard();
      if (!b) return `Step ${n.id} is current.`;
      board.apply(b, { t: "step", id: "here", step: n.id });   // a no-op when the server turned the page already
      const gone = b.turned?.step === n.id && b.turned.turn === b.turn ? b.turned.removed : [];   // (this turn's page turn only)
      return `Step ${n.id} is current.${gone.length ? ` The board turned the page; these left: ${gone.map((x) => `${x.title}${x.pending ? " (unanswered: it counts as skipped)" : ""}`).join("; ")}.` : ""}\n${board.listing(b)}`;
    }
    case "render": {
      const svg = path.resolve(topicDir(TOPIC), String(args.svg || ""));
      if (!/\.svg$/i.test(svg) || !fs.existsSync(svg)) throw new Error(`no SVG at ${svg}`);
      if (!inside(svg, LEARNING)) throw new Error(`render works on SVGs in the learning folder (${LEARNING}); save it in the topic's figures/ first`);
      const r = await renderFigure(svg);
      const said = r.problems.length
        ? `Rendered as the board shows it: ${r.png}\nProblems to fix (show refuses a figure with the first kind, and the learner sees the rest):\n- ${r.problems.join("\n- ")}\nFix them in the SVG and render again (skill/figures.md has the contract).`
        : `Rendered as the board shows it: ${r.png}\nNo problems found. Still look: labels, signs, directions, proportions.`;
      return [{ type: "text", text: said }, { type: "image", data: fs.readFileSync(r.png).toString("base64"), mimeType: "image/png" }];
    }
    case "cards": { const r = ops.cards(TOPIC, args); return `Added ${r.added} item(s); the deck has ${r.total}.`; }
    case "document": return documentTool(args);
    case "deliver": { ops.deliver(TOPIC, { kind: args.kind, summary: args.summary, files: args.files }); return "Delivered: its button is ready. Reply with one short line."; }
    case "show": {
      // a figure has to look like part of the app (skill/figures.md): no white box, colour codes, fonts, plot defaults
      const file = args.path && path.resolve(String(args.path));
      const problems = args.html ? checkHtml(String(args.html))
        : file && fs.existsSync(file) && (!/\.png$/i.test(file) || file.split(path.sep).includes("figures")) ? checkFigureFile(file) : [];
      if (problems.length) throw new Error(`Not shown: this figure wouldn't match the app's theme.\n- ${problems.join("\n- ")}\nFix it to the figure contract (skill/figures.md next to SKILL.md), check it with render, then show it again.`);
      ops.normalizeShow(TOPIC, args);
      return withBoard("On the board.");
    }
    case "scene": {
      const sc = ops.normalizeScene(args);   // validate only; the app reads the call from the stream and puts it up
      const bad = checkScene(sc.scene);
      if (bad.length) throw new Error(`Not shown: fix the scene first.\n- ${bad.join("\n- ")}`);
      return withBoard(`On the board in Teach${sc.predict.length ? `. Step ${sc.predict[0].step + 1} waits for their prediction: end your turn now; it arrives as your next message` : ""}.` +
        (live() ? " Tell them out loud it's in the Teach window." : ""));
    }
    default: throw new Error(`unknown tool ${name}`);
  }
}

const FILE_LABELS = { "worksheet": "Worksheet", "worksheet-key": "Answer key", sheet: "Sheet", quickref: "Card", assignment: "Practice", notes: "Notes" };

async function documentTool(args) {
  const t = getTopic(TOPIC), dir = topicDir(TOPIC);
  const src = path.resolve(dir, String(args.source || ""));
  if (!src.startsWith(dir + path.sep) || !/\.md$/i.test(src) || !fs.existsSync(src)) throw new Error(`no Markdown file at ${src} (it must be a .md in the topic folder, ${dir})`);
  let layout = args.layout || {}, kind = null;
  if (args.for) {
    kind = args.for === "worksheet-key" ? "worksheet" : String(args.for);
    const o = t.outputs?.[kind];
    if (!o?.settings) throw new Error(`nothing is being made for "${args.for}": render without \`for\`, or wait for the app's "[Teach app] action" message`);
    layout = { ...layoutFor(args.for, o.settings, t), ...(Number(args.layout?.columns) ? { columns: Number(args.layout.columns) } : {}) };
  }
  const r = await renderDoc(src, src.replace(/\.md$/i, ".pdf"), layout);
  if (kind) {
    const o = getTopic(TOPIC).outputs[kind];
    const files = (o.files || []).filter((f) => f.path !== r.pdf);
    files.push({ label: FILE_LABELS[args.for] || "PDF", path: r.pdf, pages: r.pages, fits: r.fits });
    files.sort((a, b) => (a.label === "Answer key") - (b.label === "Answer key"));
    ops.setOutput(TOPIC, kind, { files, progress: `${r.pages} page${r.pages === 1 ? "" : "s"} rendered${r.fits ? "" : ", doesn't fit yet"}` });
  }
  const imgs = r.previews.slice(0, 6).map((f) => ({ type: "image", data: fs.readFileSync(f).toString("base64"), mimeType: "image/png" }));
  return [{ type: "text", text: `${describeDoc(r)}\nPDF: ${r.pdf}` }, ...imgs];
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
    reply({ tools: [...tools, ...(SCREEN ? SCREEN_TOOLS : []), ...fileTools(FILES)] });
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
