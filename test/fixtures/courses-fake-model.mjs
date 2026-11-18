#!/usr/bin/env node
// A stand-in for one model call (TEACH_VISUALIZE_CMD) in the course tests: reads the prompt on stdin and answers in the
// shape the prompt asks for (a pre-test, a real exam turned into cards, a practice version, a grade). No model.
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const units = [...s.matchAll(/^Unit (\d+):/gm)].map((m) => Number(m[1]));
  if (/Write the pre-test/.test(s)) {
    const qs = units.flatMap((n) => [0, 1, 2].map((k) => ({ unit: n, kind: "choice", prompt: `Unit ${n} question ${k + 1}: which is right?`, options: ["The right one", "A misconception", "Another misconception"], answer: 0, why: "Because." })));
    return console.log(JSON.stringify({ questions: qs }));
  }
  if (/PRACTICE version/.test(s)) return console.log(JSON.stringify({ questions: [
    { kind: "choice", prompt: "Practice: Searle's Chinese Room is an argument against…", options: ["Strong AI", "Dualism", "Behaviorism"], answer: 0, points: 2, why: "Strong AI: running the right program is enough for understanding." },
    { kind: "text", prompt: "Practice: state the argument from illusion.", points: 6, model: "Premises about illusions → we see sense data." }] }));
  if (/real .* of a university course/.test(s)) return console.log(JSON.stringify({ questions: [
    { part: "Part I", kind: "choice", prompt: "Who wrote: 'the mind is to the brain as the program is to the hardware'?", options: ["Searle", "Turing", "Block"], answer: 2, points: 3 },
    { part: "Part II", kind: "choice", prompt: "True or false: Kripke's argument targets the identity theory.", options: ["True", "False"], answer: 0, points: 1 },
    { part: "Part III", kind: "text", prompt: "Explain Gertler's argument in a paragraph.", points: 4, model: "Conceivability of disembodiment → dualism." }], minutes: null, rules: "Course materials allowed." }));
  if (/strict teaching assistant/.test(s) && /"criteria"/.test(s)) return console.log(JSON.stringify({ criteria: [
    { criterion: "Reconstruction", points: 5, max: 8, comment: "Premise 2 isn't labelled." }, { criterion: "Faithful to the text", points: 3, max: 4, comment: "Close." },
    { criterion: "Explanation", points: 3, max: 4, comment: "Clear." }, { criterion: "Evaluation", points: 4, max: 8, comment: "No missing premise named." }, { criterion: "Clarity and form", points: 5, max: 6, comment: "Fine." }],
    summary: "A fair reconstruction; the evaluation stops short.", strengths: ["Clear prose"], problems: [{ quote: "so the room understands", issue: "Asserted, not argued.", fix: "Say which premise you reject." }], letter: "B-" }));
  if (/strict teaching assistant/.test(s)) { const ns = [...s.matchAll(/--- question (\d+) \((\d+) pts\)/g)]; return console.log(JSON.stringify({ answers: ns.map((m) => ({ n: Number(m[1]), points: Math.floor(Number(m[2]) / 2), comment: "Half there." })) })); }
  console.log("{}");
});
