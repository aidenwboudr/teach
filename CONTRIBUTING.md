# Contributing

Thanks for helping. Teach is small on purpose: Node built-ins only, one page of plain JavaScript, no build step.
Please keep it that way.

## Before you open a PR

- `npm test` and `npm run check` pass (CI runs both on Node 22 and the current Node).
- New behavior has a test in `test/` where it can (the tests use throwaway data and fake `claude`/`chalk`
  commands; none needs a model, a network or a screen).
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
(`journalctl --user -u teach` or the terminal running `node server.mjs`) and `~/.local/state/teach/claude.log`.
Check them for anything private first.

By contributing you agree your work is released under the MIT License.
