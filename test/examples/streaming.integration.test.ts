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

afterEach(async () =>
{
    await Promise.all(workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("replays streamed text and partial tool-call JSON through real Pi", async () =>
{
    const workspace = await mkdtemp(path.join(tmpdir(), "pi-coding-agent-test-streaming-example-"));
    workspaces.push(workspace);

    const content = "Streaming writes are still real tool calls.\n";
    const result = await new PiIntegrationTest({
        testName: "streaming-tool-call",
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd: workspace,
        tools: ["write"],
        conversation: [
            assistantMessage([
                text("I will write the file in chunks.", {
                    chunks: { kind: "fixed", size: 5 },
                    delayMs: 1,
                }),
                toolCall({
                    id: "streamed-write",
                    name: "write",
                    argumentsJson: JSON.stringify({ path: "streamed.txt", content }),
                    chunks: { kind: "fixed", size: 4 },
                    delayMs: 1,
                }),
            ], { stopReason: "toolUse" }),
            assistantMessage([text("The streamed write completed.", { chunks: { kind: "characters" } })]),
        ],
    }).run("Write a file while streaming the response and tool arguments");

    expect(await readFile(path.join(workspace, "streamed.txt"), "utf8")).toBe(content);
    expect(getToolExecution(result, "streamed-write").isError).toBe(false);
    expect(getToolResultText(result, "streamed-write")).toContain("streamed.txt");
    expect(result.traceEvents.some((event) => event.type === "message_update")).toBe(true);
    expect(result.traceEvents.some((event) => event.type === "tool_execution_end")).toBe(true);
});
