---
name: test-pi-coding-agent
description: >-
    Write or change deterministic real-Pi integration tests with pi-coding-agent-test. Use this skill whenever
    behavior crosses Pi's real extension loader, agent loop, tools, hooks, sessions, filesystem, streaming, or
    terminal boundary. Before writing code, read using-pi-coding-agent-test/SKILL.md and the closest executable example
    unless that orientation was already completed in this session. Do not use it for isolated parser/unit tests or
    interactive visual inspection of an existing recording.
---

# Write real-Pi tests

Before this skill, read [`../using-pi-coding-agent-test/SKILL.md`](../using-pi-coding-agent-test/SKILL.md) unless its
first-use orientation is already complete in this session. Start from the closest example, then adapt its smallest
working pattern.

## Define the contract

State the real behavior the test protects before writing the scenario. Use a real-process test only when the contract
crosses Pi. Keep pure parsing, chunking, and transformation checks in unit tests.

The test should prove observable Pi behavior, not merely that the scripted provider received the planned response.
Prefer a file effect, tool result, trace event, session state, or terminal output assertion.

## Build one deterministic scenario

1. Create an isolated workspace owned and cleaned up by the test.
2. Set `testName` and `artifactsDir: testArtifactsDir(import.meta.filename)`.
3. Pass every required extension and active tool explicitly.
4. Script only the assistant responses needed to drive the real agent.
5. Run `new PiIntegrationTest(options).run(prompt)`.
6. Assert the resulting Pi effect.

Use the public builders rather than hand-writing provider event payloads:

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

The initial prompt is a real user message. Each `conversation` item is returned only when Pi requests another
provider response. Pi still runs the agent loop, extension handlers, tools, hooks, session, filesystem, and TUI.

## Select assertions

Use structured accessors for data contracts:

- `getToolCallNames`, `getToolExecution`, `getToolExecutions`;
- `getToolResultText`, `getToolExecutionResult`, `getToolExecutionDetails`;
- `getProviderSystemPrompt`, `result.traceEvents`, `result.providerRequests`;
- `result.messages`, `result.state`, and `result.exitCode`.

Use external effects when they are the contract: file contents, directories, diagnostics, generated resources, tool
ordering, session state, or final terminal text.

## Select rendering deliberately

Use the default raw renderer for stable tool names, arguments, results, errors, and ordering. Set `rawMode: false` for
native renderer layout, progressive output, compact/expanded views, cursor, spinners, and status behavior. Assert
structured results and terminal presentation from the same run; do not run a second scenario for the other renderer.

## Model streaming only when needed

Use `chunks`, `delayMs`, `deltaDelaysMs`, `argumentsJson`, `contentIndex`, `argumentSnapshots`, or `includeEnd` only
when partial delivery or timing is part of the contract. Let a real extension abort naturally; do not put an artificial
abort action in the scripted conversation.

## Run and debug

Run the suite through the shared wrapper when process startup is not the behavior under test:

```bash
pi-test run -- vitest run --config vitest.integration.config.ts
```

A compatible Pi process may be reused, but every case receives a fresh session, workspace, prompt, and artifacts. Run
the test command directly when startup, environment inheritance, or process isolation is the contract.

Artifacts are grouped under `.tmp/test-runs` or the configured `artifactsDir`:

- `error.log` for startup/execution failures;
- `run.jsonl` for the canonical trace, terminal stream, messages, tools, and session;
- `tui-rendered.log` for the final readable screen.

For intermediate frames, timing, or native TUI debugging, continue with
[`../inspect-interactive-tui-tests/SKILL.md`](../inspect-interactive-tui-tests/SKILL.md) instead of adding ad-hoc logging.
