import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { expect, test } from "vitest";

test.runIf(process.env.PI_INTEGRATION_TEST_RUNNER !== undefined)(
    "shared Pi gives each fixture a distinct workspace identity without restarting",
    async () =>
    {
        const first = await mkdtemp(path.join(tmpdir(), "pi-test-workspace-first-"));
        const second = await mkdtemp(path.join(tmpdir(), "pi-test-workspace-second-"));

        try
        {
            await writeFile(path.join(first, "value.txt"), "first");
            await writeFile(path.join(second, "value.txt"), "second");
            const run = (cwd: string, name: string) =>
                new PiIntegrationTest({
                    testName: name,
                    cwd,
                    artifactsDir: testArtifactsDir(import.meta.filename),
                    extensions: [
                        path.join(path.dirname(import.meta.filename), "fixtures/workspace-cache-extension.ts"),
                    ],
                    tools: ["workspace_cache"],
                    conversation: [
                        assistantMessage([
                            toolCall({ id: "cache", name: "workspace_cache", arguments: {} }),
                        ], { stopReason: "toolUse" }),
                        assistantMessage([text("Done")]),
                    ],
                }).run("Read the cached workspace value");
            const firstRun = await run(first, "workspace-identity-first");
            const secondRun = await run(second, "workspace-identity-second");
            expect(getToolExecution(firstRun, "cache").isError).toBe(false);
            expect(getToolExecution(secondRun, "cache").isError).toBe(false);
            const firstValue = JSON.parse(getToolResultText(firstRun, "cache")) as WorkspaceValue;
            const secondValue = JSON.parse(getToolResultText(secondRun, "cache")) as WorkspaceValue;
            expect(firstValue.value).toBe("first");
            expect(secondValue.value).toBe("second");
            expect(secondValue.pid).toBe(firstValue.pid);
            expect(secondValue.cwd).not.toBe(firstValue.cwd);
            expect(firstRun.state?.cwd).toBe(firstValue.cwd);
            expect(secondRun.state?.cwd).toBe(secondValue.cwd);
            expect(firstValue.previousMarker).toBe(false);
            expect(secondValue.previousMarker).toBe(false);
            expect(await readFile(path.join(first, "marker"), "utf8")).toBe("first");
            expect(await readFile(path.join(second, "marker"), "utf8")).toBe("second");
            await expect(access(firstValue.cwd)).rejects.toMatchObject({ code: "ENOENT" });
            await expect(access(secondValue.cwd)).rejects.toMatchObject({ code: "ENOENT" });
        }
        finally
        {
            await rm(first, { recursive: true, force: true });
            await rm(second, { recursive: true, force: true });
        }
    },
);

test.runIf(process.env.PI_INTEGRATION_TEST_RUNNER !== undefined)(
    "shared shutdown uses the remaining scenario timeout",
    async () =>
    {
        const workspace = await mkdtemp(path.join(tmpdir(), "pi-test-shutdown-budget-"));
        const options = {
            cwd: workspace,
            artifactsDir: testArtifactsDir(import.meta.filename),
            extensions: [path.join(path.dirname(import.meta.filename), "fixtures/workspace-cache-extension.ts")],
            tools: [],
        };

        try
        {
            await new PiIntegrationTest({
                ...options,
                testName: "shutdown-budget-warmup",
                conversation: [assistantMessage([text("Warm")])],
            }).run("Warm the shared Pi");
            await writeFile(path.join(workspace, "shutdown-delay.txt"), "1300");

            await expect(new PiIntegrationTest({
                ...options,
                testName: "shutdown-budget",
                timeoutMs: 2000,
                conversation: [assistantMessage([text("Done")], { delayMs: 1300 })],
            }).run("Finish within the scenario budget")).rejects.toThrow();
            expect(await readFile(path.join(workspace, "shutdown-started"), "utf8")).toBe("started");
        }
        finally
        {
            await rm(workspace, { recursive: true, force: true });
        }
    },
);

interface WorkspaceValue
{
    readonly pid: number;
    readonly cwd: string;
    readonly value: string;
    readonly previousMarker: boolean;
}
