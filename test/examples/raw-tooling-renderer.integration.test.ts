import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    assistantMessage,
    getToolExecution,
    getToolResultText,
    PiIntegrationTest,
    testArtifactsDir,
    text,
    toolCall,
} from "pi-coding-agent-test";
import { afterEach, expect, test } from "vitest";

const workspaces: string[] = [];
const extensionPath = path.join(path.dirname(import.meta.filename), "fixtures", "note-extension.ts");

afterEach(async () =>
{
    await Promise.all(workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("demonstrates the stable raw tool renderer", async () =>
{
    const workspace = await mkdtemp(path.join(tmpdir(), "pi-coding-agent-test-raw-tooling-example-"));
    workspaces.push(workspace);

    const result = await new PiIntegrationTest({
        testName: "raw-tooling-renderer",
        ...(process.env.PI_COMMAND === undefined ? {} : { piCommand: process.env.PI_COMMAND }),
        isolateUserResources: true,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd: workspace,
        extensions: [extensionPath],
        rawMode: true,
        tools: ["save_note"],
        conversation: [
            assistantMessage([
                toolCall({
                    id: "raw-save-note",
                    name: "save_note",
                    arguments: { title: "Raw renderer", body: "Stable tool output" },
                }),
            ], { stopReason: "toolUse" }),
            assistantMessage([text("The raw tool render completed.")]),
        ],
    }).run("Save a note and show the stable raw tool output");

    expect(JSON.parse(await readFile(path.join(workspace, "note.json"), "utf8"))).toEqual({
        title: "Raw renderer",
        body: "Stable tool output",
    });
    expect(getToolExecution(result, "raw-save-note").isError).toBe(false);
    expect(getToolResultText(result, "raw-save-note")).toContain("Saved note: Raw renderer");
    expect(result.tuiRenderedOutput).toContain("tool_call:");
    expect(result.tuiRenderedOutput).toContain("\"name\": \"save_note\"");
    expect(result.tuiRenderedOutput).toContain("\"title\": \"Raw renderer\"");
    expect(result.tuiRenderedOutput).toContain("tool_call_result: Saved note: Raw renderer");
});

test("shows complete payloads and internal result metadata in raw TUI", async () =>
{
    const workspace = await mkdtemp(path.join(tmpdir(), "pi-coding-agent-test-raw-payload-"));
    workspaces.push(workspace);
    const payload = {
        nested: { enabled: false, count: 0, values: [null, "quoted \"value\"", "кириллица"] },
        longText: Array.from({ length: 100 }, (_, index) => `RAW_LINE_${index}`).join("\n"),
        tail: "RAW_PAYLOAD_END_MARKER",
    };
    const result = await new PiIntegrationTest({
        testName: "raw-full-payload",
        ...(process.env.PI_COMMAND === undefined ? {} : { piCommand: process.env.PI_COMMAND }),
        isolateUserResources: true,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd: workspace,
        extensions: [path.join(path.dirname(import.meta.filename), "fixtures", "raw-payload-extension.ts")],
        rawMode: true,
        tools: ["raw_payload"],
        conversation: [
            assistantMessage([
                toolCall({ id: "raw-payload-call", name: "raw_payload", arguments: { payload } }),
            ], { stopReason: "toolUse" }),
            assistantMessage([text("Raw payload complete")]),
        ],
    }).run("Save the full payload and show all debug details");

    expect(JSON.parse(await readFile(path.join(workspace, "payload.json"), "utf8"))).toEqual({ payload });
    expect(getToolExecution(result, "raw-payload-call").isError).toBe(false);
    expect(result.tuiRenderedOutput).toContain("FINAL_DETAILS_ONLY_MARKER");
    expect(result.tuiRenderedOutput).toContain("\"toolCallId\": \"raw-payload-call\"");
    expect(result.tuiRenderedOutput).toContain("\"isError\": false");
    expect(result.tuiRenderedOutput).toContain("\"isPartial\": false");
    const compactScreen = result.tuiRenderedOutput.replaceAll(/\s+/gu, "");
    expect(compactScreen).toContain(JSON.stringify(payload.longText));
    expect(compactScreen).toContain("\"enabled\":false");
    expect(compactScreen).toContain("\"count\":0");
    expect(result.tuiRenderedOutput).toContain("RAW_PAYLOAD_END_MARKER");
    expect(result.terminalOutput).toContain("PROGRESS_DETAILS_ONLY_MARKER");
    expect(result.terminalOutput).toContain("RAW_PROGRESS_MARKER");
});

test("shows tool execution errors in the raw result envelope", async () =>
{
    const workspace = await mkdtemp(path.join(tmpdir(), "pi-coding-agent-test-raw-error-"));
    workspaces.push(workspace);
    const result = await new PiIntegrationTest({
        testName: "raw-error-payload",
        ...(process.env.PI_COMMAND === undefined ? {} : { piCommand: process.env.PI_COMMAND }),
        isolateUserResources: true,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd: workspace,
        extensions: [path.join(path.dirname(import.meta.filename), "fixtures", "raw-payload-extension.ts")],
        rawMode: true,
        tools: ["raw_failure"],
        conversation: [
            assistantMessage([
                toolCall({ id: "raw-failure-call", name: "raw_failure", arguments: {} }),
            ], { stopReason: "toolUse" }),
            assistantMessage([text("Failure captured")]),
        ],
    }).run("Fail a tool and show the raw error");

    expect(getToolExecution(result, "raw-failure-call").isError).toBe(true);
    expect(getToolResultText(result, "raw-failure-call")).toContain("RAW_FAILURE_MARKER");
    expect(result.tuiRenderedOutput).toContain("RAW_FAILURE_MARKER");
    expect(result.tuiRenderedOutput).toContain("\"isError\": true");
    expect(result.tuiRenderedOutput).toContain("\"toolCallId\": \"raw-failure-call\"");
});
