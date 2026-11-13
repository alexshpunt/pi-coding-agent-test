import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assistantMessage, getToolExecution, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("a scripted tool call with 100 KB of arguments finishes within the default timeout", async () =>
{
    const workspace = await mkdtemp(path.join(tmpdir(), "pi-large-arguments-"));
    const content = "x".repeat(100_000);

    try
    {
        const result = await new PiIntegrationTest({
            testName: "large-tool-arguments",
            artifactsDir: testArtifactsDir(import.meta.filename),
            cwd: workspace,
            rawMode: false,
            tools: ["write"],
            conversation: [
                assistantMessage([
                    toolCall({ id: "large-write", name: "write", arguments: { path: "large.txt", content } }),
                ], { stopReason: "toolUse" }),
                assistantMessage([text("Done")]),
            ],
        }).run("Write the file");

        expect(getToolExecution(result, "large-write").isError).toBe(false);
        expect(await readFile(path.join(workspace, "large.txt"), "utf8")).toBe(content);
    }
    finally
    {
        await rm(workspace, { recursive: true, force: true });
    }
});
