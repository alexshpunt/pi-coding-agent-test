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
- The raw renderer, the default, shows stable tool names, arguments, results and ordering. Set `rawMode: false` for native layout, progressive output, spinners and status. Assert data and presentation from the same run.
- Use `chunks`, `delayMs`, `deltaDelaysMs`, `argumentsJson`, `contentIndex`, `argumentSnapshots` or `includeEnd` only when partial delivery or timing is the contract. Let a real extension abort on its own.
- By default, scripted tool arguments stream in chunks of 1024 UTF-16 code units. If `delayMs`, `deltaDelaysMs` or `argumentSnapshots` is set without `chunks`, they stream by Unicode character instead; set `chunks` explicitly to choose another schedule.

## Run and debug

```bash
pi-test run -- vitest run --config vitest.integration.config.ts
```

The wrapper reuses a compatible Pi process, but every case gets a fresh session and workspace. Run the test command directly when startup or process isolation is the contract.

Artifacts go to `.tmp/test-runs` or `artifactsDir`: `error.log` for startup failures, `run.jsonl` for the full trace, terminal stream and session, and `tui-rendered.log` for the final screen. For intermediate frames, timing or watching a case live, read [inspect-tui.md](references/inspect-tui.md).
