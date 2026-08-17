import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assistantMessage, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

const workspaces: string[] = [];

const firstWorkspace = await mkdtemp(path.join(tmpdir(), "pi-coding-agent-test-shared-first-"));
const secondWorkspace = await mkdtemp(path.join(tmpdir(), "pi-coding-agent-test-shared-second-"));
workspaces.push(firstWorkspace, secondWorkspace);
await writeFile(path.join(firstWorkspace, "value.txt"), "first-workspace", "utf8");
await writeFile(path.join(secondWorkspace, "value.txt"), "second-workspace", "utf8");

afterAll(async () =>
{
    await Promise.all(workspaces.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("shared Pi runner", () =>
{
    test("runs scripted scenarios in the shared process", async () =>
    {
        const first = await runScenario("shared-first", firstWorkspace);
        const second = await runScenario("shared-second", secondWorkspace);

        expect(first.tuiRenderedOutput).toContain("first-workspace");
        expect(second.tuiRenderedOutput).toContain("second-workspace");
        expect(first.traceEvents.some((event) => event.type === "agent_settled")).toBe(true);
        expect(second.traceEvents.some((event) => event.type === "agent_settled")).toBe(true);
    });
});

function runScenario(testName: string, cwd: string): ReturnType<PiIntegrationTest["run"]>
{
    return new PiIntegrationTest({
        testName,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        tools: ["read"],
        conversation: [
            assistantMessage([
                toolCall({
                    id: `${testName}-read`,
                    name: "read",
                    arguments: { path: path.join(cwd, "value.txt") },
                }),
            ], { stopReason: "toolUse" }),
            assistantMessage([text("Done")]),
        ],
    }).run("Read the value and finish");
}
