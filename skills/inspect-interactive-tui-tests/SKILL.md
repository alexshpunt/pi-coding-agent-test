---
name: inspect-interactive-tui-tests
description: Inspect how Pi Coding Agent tool renderers look and change over time. Run deterministic cases live with pi-test or reconstruct recorded terminal frames with pi-test replay. Use this skill whenever a person or agent needs visual inspection, intermediate frames, timing, or interaction details. Do not use it for normal automated verification, CI, or a full integration suite.
---

# Inspect Interactive Pi TUI Tests

Before debugging, read [`../using-pi-coding-agent-test/SKILL.md`](../using-pi-coding-agent-test/SKILL.md) unless its first-use orientation is already complete in this session. Read `native-tui.integration.test.ts` for native presentation or `replay.integration.test.ts` for recorded frames before choosing commands.

This skill is for interactive inspection and frame-level debugging, not for designing a new scenario.

Use `pi-test` in two modes:

- Run `live` to execute one deterministic test case and watch the real Pi TUI;
- Replay the terminal record in `run.jsonl` to inspect the exact PTY stream already recorded by a completed run.

A live run executes tools again. A replay never starts Pi or executes tools.

## Watch one case live

Pass one selected case to its normal test runner after `--`:

```bash
pi-test live \
  --stream-profile gpt-5.6-sol-xhigh \
  --pause-ms 2000 \
  -- \
  vitest run /absolute/path/to/test.integration.test.ts \
  -t "shows the real replacement as a stable compact diff panel" \
  --config /absolute/path/to/vitest.integration.config.mjs
```

The command can use any Node.js test runner. Use that runner's own file and case-selection flags. `pi-test` keeps Pi alive and repeats the complete command until `Ctrl+C`; it stops on the first failure.

The shared runner reuses a compatible Pi process. Every iteration still creates a fresh Pi session.

Use `gemini-3.5-flash` when a faster stream is more useful than the default profile. Use `--delay-ms 17` only when every delta should have one fixed delay; do not combine it with `--stream-profile`.

## Capture one run

Use `--once` when the terminal output is not being watched continuously or when an agent will inspect the artifacts:

```bash
pi-test live \
  --once \
  --stream-profile gpt-5.6-sol-xhigh \
  -- \
  vitest run /absolute/path/to/test.integration.test.ts \
  -t "shows the real replacement as a stable compact diff panel" \
  --config /absolute/path/to/vitest.integration.config.mjs
```

Read `artifactsDir` and `testName` from the selected case, then use that exact stable directory. Do not guess from the newest run when several agents or test processes may be active:

```bash
ARTIFACT_DIR="/absolute/artifactsDir/sanitized-testName"
test -f "$ARTIFACT_DIR/run.jsonl"
printf '%s\n' "$ARTIFACT_DIR"
```

## Index the recorded frames

Reconstruct every synchronized frame from the terminal record in `run.jsonl`:

```bash
FRAME_DIR="${TMPDIR:-/tmp}/pi-test-frames/current-case"
pi-test replay "$ARTIFACT_DIR" --output "$FRAME_DIR"
```

This writes:

- `index.tsv` — one searchable row per synchronized frame;
- `final.txt` — the final reconstructed terminal screen.

The index records the frame number, stream offset, changed rows and visible changed text. It does not duplicate every full screen.

Search for a tool header, filename, code fragment, cursor or status text:

```bash
grep -n -E 'replace stable\.txt|latest visible|Working' "$FRAME_DIR/index.tsv"
```

The first column is the frame number. Inspect nearby numbers to understand how a transition developed.

## Save exact frames

Request individual frames or ranges:

```bash
pi-test replay "$ARTIFACT_DIR" \
  --output "$FRAME_DIR" \
  --frames 27,31,35-38
```

The command recreates the output directory and writes files such as:

```text
frame-000027.txt
frame-000031.txt
frame-000035.txt
```

Read the same line range from neighboring frames. Compare the panel, cursor, spinner, header and surrounding context. Do not infer a visual transition from `index.tsv` alone.

## Play a recorded run

Play the reconstructed frames in the current terminal:

```bash
pi-test replay "$ARTIFACT_DIR" \
  --output "$FRAME_DIR" \
  --play \
  --frame-delay-ms 80
```

Playback uses recorded frame delays when available. Use `--speed` to slow down or accelerate a recording; older bundles without timing metadata use a fixed delay.

Use live mode when timing and feel must be realistic. Use replay when the exact recorded output must not change.

## Verify the final frame

The replay and the integration result must agree on the final screen:

```bash
cmp "$FRAME_DIR/final.txt" "$ARTIFACT_DIR/tui-rendered.log"
```

A zero exit code means both paths reconstructed the same final terminal state.

## Inspect supporting artifacts

Use each file for its own question:

- `run.jsonl` — canonical bundle with inputs, trace, terminal stream, tools, messages and session;
- `tui-rendered.log` — final readable screen only;

Connect a visible frame to behavior by searching `index.tsv`, then inspect nearby `trace` records or the matching tool call ID in `run.jsonl`.

## Avoid These Mistakes

- Live mode is manual inspection, not normal CI verification.
- A changed stream profile can expose different timing-sensitive behavior.
- Only the Pi process is reused; each iteration gets a fresh session.
- Every run replaces the normal artifacts for the same `testName`.
- `tui-rendered.log` cannot show intermediate states.
- A replay frame is one synchronized terminal flush, not one tool call.
- Older fixed-speed replays cannot reproduce timing when the bundle has no timing metadata.
