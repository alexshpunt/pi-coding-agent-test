# Changelog

## 0.1.7 - 2026-11-09

- Merge the three Pi skills into one `pi-coding-agent-test` skill, so the package adds one description to the system prompt instead of three. The TUI inspection guide moved to `references/inspect-tui.md` inside it. The skills `using-pi-coding-agent-test`, `test-pi-coding-agent` and `inspect-interactive-tui-tests` no longer exist; anything that names them should name `pi-coding-agent-test`.

## 0.1.6 - 2026-11-08

- Add the `traceToolDetails` scenario setting. Set it to `false` to keep tool result `details` out of the trace when a test does not read them; large details, such as whole-file snapshots, otherwise cost CPU and memory in Pi and the harness on every tool call.

## 0.1.5 - 2026-11-07

- Build and test against Pi 1.5.0.
- Skip Pi's version check in harness runs unless the caller sets `PI_SKIP_VERSION_CHECK`, so a new Pi release no longer adds an update notice to the screen.
- Waiting for Pi to settle reads only new trace lines instead of re-reading the whole trace every 5 ms, so long sessions no longer spend most harness CPU parsing the trace.

## 0.1.4 - 2026-10-20

- Build and test against Pi 1.3.0; the harness no longer installs Pi AI 0.99.1 alongside a newer host.

## 0.1.3 - 2026-10-02

- Keep browser cleanup waiting for owned zombie processes even when Linux denies access to their executable identity.
- Preserve the exact process-generation checks and report when a parent must reap a retained zombie.

## 0.1.2 - 2026-10-02

- Add isolated browser fixtures with bounded cleanup and clean-package install checks.
- Add headless RPC scenarios, effective system prompt capture and custom terminal sizes.
- Pool shared Pi processes by configuration and preserve active tool selections.
- Keep partial run artifacts after failures and timeouts.
- Support Pi 0.99.1 raw rendering and reliable native Windows launch and complete PTY cleanup.
- Move development and CI releases to the public repository; publish the validated tarball through npm OIDC.

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
