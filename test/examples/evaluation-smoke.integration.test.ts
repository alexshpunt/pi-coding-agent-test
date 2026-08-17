import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    assistantMessage,
    getToolExecution,
    getToolResultText,
    PiIntegrationTest,
    PiRun,
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

test("runs a deterministic evaluation-style filesystem scenario", async () =>
{
    const workspace = await mkdtemp(path.join(tmpdir(), "pi-coding-agent-test-example-"));
    workspaces.push(workspace);

    const result = await new PiIntegrationTest({
        testName: "evaluation-smoke",
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd: workspace,
        tools: ["write", "read"],
        conversation: [
            assistantMessage([
                toolCall({
                    id: "write-answer",
                    name: "write",
                    arguments: {
                        path: "answer.txt",
                        content: "The real Pi tool wrote this file.\n",
                    },
                }),
            ], { stopReason: "toolUse" }),
            assistantMessage([
                toolCall({
                    id: "read-answer",
                    name: "read",
                    arguments: { path: "answer.txt" },
                }),
            ], { stopReason: "toolUse" }),
            assistantMessage([text("The evaluation task is complete.")]),
        ],
    }).run("Write an answer file, read it back, and report completion");

    expect(await readFile(path.join(workspace, "answer.txt"), "utf8"))
        .toBe("The real Pi tool wrote this file.\n");
    expect(getToolExecution(result, "write-answer").isError).toBe(false);
    expect(getToolExecution(result, "read-answer").isError).toBe(false);
    expect(getToolResultText(result, "read-answer")).toContain("The real Pi tool wrote this file.");
    expect(result.traceEvents.some((event) => event.type === "agent_settled")).toBe(true);
    const reopened = await PiRun.open(result.artifacts.directory);
    expect(reopened.tuiRenderedOutput).toBe(result.tuiRenderedOutput);
    expect(reopened.terminalOutput).toBe(result.terminalOutput);
    expect(reopened.traceEvents).toHaveLength(result.traceEvents.length);
    expect(reopened.messages).toHaveLength(result.messages.length);
    expect(reopened.frameDelaysMs).toEqual(result.frameDelaysMs);
    expect((await readdir(result.artifacts.directory)).sort()).toEqual([
        "run.jsonl",
        "tui-rendered.log",
    ]);
});
