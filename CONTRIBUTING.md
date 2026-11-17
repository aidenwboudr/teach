# Contributing

Thanks for helping. Teach is small on purpose: Node built-ins only, one page of plain JavaScript, no build step.
Please keep it that way.

## Before you open a PR

- `npm test` and `npm run check` pass (CI runs both on Linux, macOS and Windows, on Node 22 and the current Node).
- Anything that differs between Linux, macOS and Windows goes through `lib/platform.mjs` (or takes the platform as
  an option), with a test that fakes the other platforms: CI runs all three, but you probably only have one.
- New behavior has a test in `test/` where it can (the tests use throwaway data and fake `claude`/`codex`/`chalk`
  commands; none needs a model, a network or a screen).
- A change to how a tutor CLI is started or read (`lib/providers/`) keeps every provider working: check the CLI's
  current docs for its flags, and test against its real output format (`test/providers.test.mjs`).
- Anything environment-specific (a path, a host, a tool only you have) is a `TEACH_*` setting with a sensible
  default, documented in the README's settings table, not hardcoded.
- Prompts and tool descriptions talk about "the learner" (or `TEACH_LEARNER`), never a specific person.
- Changes to `skill/SKILL.md` keep the method intact: probe first, a fact-checked dependency plan, one step per
  message, a check after each step, no advancing on a miss.
- Don't commit personal data: no real learner profiles, topic logs or screenshots of them. Use `examples/demo`.
- Don't paste text or code from the projects listed under Credits in the README: learnharness is AGPL-3.0 and
  `amosblomqvist/learn` has no license.

## Reporting bugs

Open an issue with what you did, what you expected and what happened, plus the server log
(`journalctl --user -u teach` on Linux, `~/.local/state/teach/server.log` on macOS and Windows, or the terminal
running `teach serve`), the tutor CLI's log (`~/.local/state/teach/claude.log`, `codex.log` or `gemini.log`) and which
`TEACH_PROVIDER` you use.
Check them for anything private first.

By contributing you agree your work is released under the MIT License.
