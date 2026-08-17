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
