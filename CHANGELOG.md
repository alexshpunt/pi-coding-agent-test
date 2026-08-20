# Changelog

## 0.1.1 - 2026-08-20

- Add explicit skills and system prompt settings to real Pi test scenarios.

## 0.1.0 - 2026-08-17

- Added deterministic real-process testing for Pi extensions, tools, hooks, sessions, filesystem effects, and terminal output.
- Added scripted-provider scenarios with realistic streaming, partial tool calls, structured assertions, and fresh-session isolation.
- Added standalone and shared Pi process runners with workspace staging and artifact capture.
- Added the runner-independent `pi-test run`, `pi-test live`, and `pi-test replay` commands.
- Added raw/native TUI capture, terminal-frame replay, stable run artifacts, and bundled Pi testing skills.
- Added executable examples covering custom extensions, explicit tool selection, runtime lifecycle, streaming, and native TUI behavior.
- Added focused documentation guides for scenarios, extensions, CLI usage, artifacts, troubleshooting, development, and release.
- Fixed scripted provider registration for shared Pi processes and validated the release against the declared Pi compatibility range.
- Fixed the npm package file list so private local-registry publishing helpers are excluded from the public tarball.
