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

test("runs the real Pi terminal at the requested narrow size", async () =>
{
    const workspace = await mkdtemp(path.join(tmpdir(), "pi-coding-agent-test-native-tui-example-"));
    workspaces.push(workspace);

    const result = await new PiIntegrationTest({
        testName: "narrow-tui",
        tuiSize: { cols: 40, rows: 50 },
        ...(process.env.PI_COMMAND === undefined ? {} : { piCommand: process.env.PI_COMMAND }),
        isolateUserResources: true,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd: workspace,
        rawMode: false,
        tools: ["write"],
        conversation: [
            assistantMessage([
                toolCall({
                    id: "native-write",
                    name: "write",
                    arguments: { path: "native.txt", content: "native renderer example\n" },
                }),
            ], { stopReason: "toolUse" }),
            assistantMessage([text("The native tool renderer completed.")]),
        ],
    }).run("Write a file and preserve the native Pi tool presentation");

    expect(await readFile(path.join(workspace, "native.txt"), "utf8")).toBe("native renderer example\n");
    expect(getToolExecution(result, "native-write").isError).toBe(false);
    expect(result.tuiSize).toEqual({ cols: 40, rows: 50 });
    expect(getToolResultText(result, "native-write")).toContain("native.txt");
    expect(result.tuiRenderedOutput).toContain("native.txt");
    expect(result.tuiRenderedOutput).toContain("native renderer example");
});
