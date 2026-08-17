---
name: using-pi-coding-agent-test
description: >-
    Orient an agent before it writes or debugs tests with pi-coding-agent-test. Use this skill whenever a task
    involves real-Pi integration tests, extension behavior, tools, hooks, sessions, filesystem effects, streaming,
    terminal output, TUI inspection, or replay. First inspect the package's demonstration tests and the closest
    existing test, unless that orientation was already completed in this session. Then continue with the focused
    test-writing or interactive-inspection skill. Do not use it for unrelated unit tests or generic TypeScript work.
---

# Use pi-coding-agent-test

This is the shared orientation layer for the package's focused skills.

## First-use rule

Before writing or debugging a real-Pi test, check whether this orientation was already completed in the current
session. If not, do this once:

1. Locate the package repository's `test/examples/` directory. In a checkout it is `<repo>/test/examples`; in an installed
   package resolve `pi-coding-agent-test/package.json` and inspect the adjacent `test/examples/` directory.
2. Read the closest executable test and its fixture before designing a new scenario:
   - `evaluation-smoke.integration.test.ts` for the basic run, artifacts, and `PiRun` shape;
   - `extensions.integration.test.ts` for extensions, tools, and lifecycle;
   - `raw-tooling-renderer.integration.test.ts` for stable raw tool presentation;
   - `streaming.integration.test.ts` for scripted delivery;
   - `native-tui.integration.test.ts` for native terminal behavior;
   - `replay.integration.test.ts` for built-in tools and offline replay.
3. Read the closest existing test in the target repository. Treat the example and test as the usage contract; do not
   invent a new wrapper or copy a prose API table.
4. Record the pattern you selected and the observable contract you intend to protect.

Do not reread every demonstration test when one relevant test is enough. If no example matches, inspect the exported API and
then add the missing scenario as an executable test when it is reusable.

## Choose the focused workflow

- Writing or changing a real-Pi scenario: continue with `../test-pi-coding-agent/SKILL.md`.
- Inspecting timing, frames, native TUI, or a failed run interactively: continue with
  `../inspect-interactive-tui-tests/SKILL.md`.

The orientation skill explains where to start. The focused skills explain how to perform the work.
