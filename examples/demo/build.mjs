// Rebuild the demo topics in examples/demo/topics from this script (node examples/demo/build.mjs), through the
// same code the tutor's tools use, so they always match the app's format.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
process.env.TEACH_DATA = here;
process.env.TEACH_STATE = fs.mkdtempSync("/tmp/teach-demo-state-");
fs.rmSync(path.join(here, "topics"), { recursive: true, force: true });
fs.mkdirSync(path.join(here, "topics"), { recursive: true });
const store = await import("../../lib/store.mjs");
const ops = await import("../../lib/ops.mjs");

const bayes = store.createTopic({ slug: "bayes-theorem", title: "Bayes' theorem", phase: "teach" });
ops.update(bayes.slug, {
  goal: "Work out the chance someone has a condition given a positive test, and explain why it's often low.",
  why: "exam", course: "Intro statistics", deadline: "2026-12-10",
  next: "Step 4: natural frequencies. Start from the 1-in-100 table and ask for a prediction before the reveal.",
  map: [
    { strand: "Conditional probability", has: "P(A|B) from a two-way table", missing: "turning it around (P(B|A))", misconception: "P(A|B) = P(B|A) when the wording is long" },
    { strand: "Base rates", has: "percent of a population", missing: "why a rare condition drags the answer down" },
    { strand: "Algebra with fractions", has: "solid" },
  ],
  facts_add: ["Sensitivity = P(positive | condition); specificity = P(negative | no condition). The textbook writes P(+|D)."],
  sources_add: [{ label: "OpenIntro Statistics, section 3.2", url: "https://www.openintro.org/book/os/" }],
});
ops.plan(bayes.slug, { nodes: [
  { id: "1", title: "Conditional probability from a table", detail: "P(A|B) = the A share of the B row", status: "done", result: "2/2" },
  { id: "2", title: "P(A|B) is not P(B|A)", detail: "same table, read the other way", status: "shaky", result: "1/2 → re-taught with a tree → 2/2" },
  { id: "3", title: "Base rates", detail: "how many people have it before any test", status: "done", result: "2/2" },
  { id: "4", title: "Natural frequencies", detail: "1,000 people through the test, as counts", status: "current" },
  { id: "5", title: "Bayes' theorem as a formula", detail: "the counts, written with P()", deps: ["4"] },
  { id: "6", title: "Why a positive test can still mean 'probably not'", detail: "explain it in two sentences", deps: ["5"] },
] });
ops.cards(bayes.slug, {
  groups: { cond: "Conditional probability", bayes: "Bayes" },
  items: [
    { type: "card", group: "cond", node: "1", front: "P(A|B) in words", back: "Of the cases where B happened, the share where A happened too." },
    { type: "mcq", group: "cond", node: "2", prompt: "A test is 90% sensitive. Which is 90%?", options: ["P(positive | condition)", "P(condition | positive)", "P(positive)"], answer: 0, why: "Sensitivity is about people who have it: how often they test positive." },
    { type: "trap", group: "cond", node: "2", wrong: "If the test is 90% accurate, a positive means a 90% chance you have it.", right: "That depends on the base rate: with a rare condition most positives are false positives." },
    { type: "recall", group: "bayes", node: "3", prompt: "1 in 100 people have the condition. Out of 1,000 people, how many have it?", answer: "10", accept: "^\\s*10\\s*$" },
  ],
});

const rc = store.createTopic({ slug: "rc-circuit-transients", title: "RC circuit transients", phase: "plan", status: "paused" });
ops.update(rc.slug, {
  goal: "Solve for the capacitor voltage after a switch closes, from the differential equation.",
  why: "class", course: "Intro circuits", next: "Plan approved up to step 3; start with KCL at the capacitor node.",
  map: [{ strand: "KVL/KCL", has: "series and parallel resistors", missing: "writing KCL at a node with a capacitor" }, { strand: "Exponentials", has: "e^x graph", missing: "time constants" }],
});
ops.plan(rc.slug, { nodes: [
  { id: "1", title: "A capacitor's current: i = C dv/dt" }, { id: "2", title: "KCL at the capacitor node" },
  { id: "3", title: "The first-order ODE and its solution" }, { id: "4", title: "Initial and final conditions" },
] });

for (const slug of [bayes.slug, rc.slug]) fs.rmSync(path.join(here, "topics", slug, "files"), { recursive: true, force: true });
fs.writeFileSync(path.join(here, "topics", bayes.slug, "log.md"), `# Bayes' theorem

## Session 1
- Probe: 7 questions. Has P(A|B) from a table; flips it when the wording is long; base rates fuzzy.
- Step 1 (conditional probability from a table): 2/2.
- Step 2 (P(A|B) vs P(B|A)): first check wrong (took sensitivity for the chance of having it). Re-taught with
  a tree of 100 people; second check 2/2. Marked shaky.
- Step 3 (base rates): 2/2.
- Stopped before step 4. Next: natural frequencies with 1,000 people, prediction first.
`);
console.log("demo topics written to", path.join(here, "topics"));
