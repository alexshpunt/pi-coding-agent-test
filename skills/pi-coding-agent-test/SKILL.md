---
name: pi-coding-agent-test
description: Use when writing or debugging tests of behavior that crosses a real Pi process, such as extensions, tools, hooks, sessions, streaming or terminal output.
---

# Test with a real Pi

Use a real-Pi test only when the behavior crosses Pi. Keep pure parsing and transformation checks in unit tests.

## Start from an example

Read the closest executable example in the package's `test/examples/` (in an installed package, next to `pi-coding-agent-test/package.json`) and the closest existing test in the target repository. Follow that pattern instead of inventing a wrapper:

- `evaluation-smoke.integration.test.ts`: a basic run, artifacts and the `PiRun` shape;
- `extensions.integration.test.ts`: extensions, tools and lifecycle;
- `raw-tooling-renderer.integration.test.ts`: stable raw tool output;
- `streaming.integration.test.ts`: scripted streaming;
- `native-tui.integration.test.ts`: native terminal behavior;
- `replay.integration.test.ts`: built-in tools and offline replay.

## Write one deterministic scenario

Assert an observable Pi effect, such as a file, tool result, trace event, session state or terminal output, not just that the scripted provider was called.

```ts
const result = await new PiIntegrationTest({
    testName: "extension-tool",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: workspace,
    extensions: [extensionPath],
    tools: ["my_tool"],
    conversation: [
        assistantMessage([
            toolCall({ id: "call-1", name: "my_tool", arguments: { value: "expected" } }),
        ], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
    ],
}).run("Use my tool");

expect(getToolExecution(result, "call-1").isError).toBe(false);
expect(getToolResultText(result, "call-1")).toContain("expected");
```

- Give each test its own workspace and clean it up. Pass every extension and active tool explicitly.
- The prompt is a real user message. Each `conversation` item is returned only when Pi asks for another response; Pi still runs the agent loop, extensions, tools, hooks, session and TUI.
- Assert data with `getToolExecution(s)`, `getToolResultText`, `getToolExecutionResult`, `getToolExecutionDetails`, `getToolCallNames`, `getSystemPrompt`, `getProviderSystemPrompt`, `result.traceEvents`, `result.providerRequests`, `result.messages`, `result.state` and `result.exitCode`.
- For load tests or tools with large `details` that the test does not read, set `traceToolDetails: false`; `getToolExecutionDetails` then returns `undefined`.
- `timeoutMs` (default 30 s) bounds the whole run, not one call: raise it for a long scripted call, and raise the vitest timeout too. A run that ends at 30 s with no result hit this, not the tool under test. The same limit bounds the start of the shared Pi: on a loaded machine a large extension can take longer to load, and the run fails with `Shared Pi did not become ready within 30000ms`. Check the load before you debug the test; rerun when it drops.
- A peer process that must write files while a tool call runs has to start inside the run, from the scripted call with the `bash` tool and `background: true`. Starting it in the test process does nothing: the test's own event loop stalls while Pi runs.
- The raw renderer, the default, shows stable tool names, arguments, results and ordering. Set `rawMode: false` for native layout, progressive output, spinners and status. Assert data and presentation from the same run.
- Use `chunks`, `delayMs`, `deltaDelaysMs`, `argumentsJson`, `contentIndex`, `argumentSnapshots` or `includeEnd` only when partial delivery or timing is the contract. Let a real extension abort on its own.
- By default, scripted tool arguments stream in chunks of 1024 UTF-16 code units. If `delayMs`, `deltaDelaysMs` or `argumentSnapshots` is set without `chunks`, they stream by Unicode character instead; set `chunks` explicitly to choose another schedule.

## Run and debug

```bash
pi-test run -- vitest run --config vitest.integration.config.ts
```

The wrapper reuses a compatible Pi process, but every case gets a fresh session and workspace. Run the test command directly when startup or process isolation is the contract.

The shared process runs each case in a copy of its `cwd` under `.tmp/pi-integration-shared-*/workspace` and copies the changes back after the run. Paths in tool results and traces name that copy, so compare them relative to the workspace or by file name, not against the test's `cwd`.

Use cwd-relative paths in `environment` for mutable fixtures inside `cwd`. Environment values are not remapped to the copy: an absolute path can modify the original fixture, then be overwritten when the staged workspace is copied back.

The shared Pi loads extensions once, in an empty workspace, before any case files are copied in. An extension that reads a case file while it loads crashes the shared Pi, and the run fails with `Shared Pi exited before becoming ready with code 1`. Read case files in a session or agent hook, such as `before_agent_start`.

Artifacts go to `.tmp/test-runs` or `artifactsDir`: `error.log` for startup failures, `run.jsonl` for the full trace, terminal stream and session, and `tui-rendered.log` for the final screen. For intermediate frames, timing or watching a case live, read [inspect-tui.md](references/inspect-tui.md).
