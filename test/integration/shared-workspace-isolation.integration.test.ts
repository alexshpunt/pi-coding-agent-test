import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startSharedRunnerHost } from "../../dist/shared-runner/host.js";

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

test("runs compatible requests concurrently and evicts an idle Pi at the global limit", async () =>
{
    const previousLimit = process.env.PI_INTEGRATION_TEST_MAX_PI;
    const previousEndpoint = process.env.PI_INTEGRATION_TEST_RUNNER;
    const root = await mkdtemp(path.join(tmpdir(), "pi-test-pool-"));
    const pids = new Set<number>();
    process.env.PI_INTEGRATION_TEST_MAX_PI = "2";
    const host = await startSharedRunnerHost();

    try
    {
        const run = async (
            value: string,
            configuration = "original",
            isolateUserResources = false,
            source?: { cwd: string; name: string; },
        ): Promise<WorkspaceValue> =>
        {
            const cwd = source?.cwd ?? await mkdtemp(path.join(root, `${value}-`));
            await writeFile(path.join(cwd, "value.txt"), value);
            const result = await new PiIntegrationTest({
                testName: source?.name ?? value,
                cwd,
                artifactsDir: testArtifactsDir(import.meta.filename),
                extensions: [path.join(path.dirname(import.meta.filename), "fixtures/workspace-cache-extension.ts")],
                environment: { PI_TEST_WORKSPACE_BARRIER: root, PI_TEST_POOL_CONFIGURATION: configuration },
                isolateUserResources,
                tools: ["workspace_cache"],
                conversation: [
                    assistantMessage([
                        toolCall({ id: "cache", name: "workspace_cache", arguments: {} }),
                    ], { stopReason: "toolUse" }),
                    assistantMessage([text("Done")], source === undefined ? {} : { delayMs: 1000 }),
                ],
            }).run("Read the fixture value");
            expect(getToolExecution(result, "cache").isError).toBe(false);
            const data = JSON.parse(getToolResultText(result, "cache")) as WorkspaceValue;
            expect(data.value).toBe(value);
            if (source === undefined)
            {
                expect(data.previousMarker).toBe(false);
            }
            expect(await readFile(path.join(cwd, "marker"), "utf8")).toBe(value);
            pids.add(data.pid);
            return data;
        };

        const [first, second] = await Promise.allSettled([run("first"), run("second")]);
        expect(first.status).toBe("fulfilled");
        expect(second.status).toBe("fulfilled");
        expect(pids.size).toBe(2);
        const originalPids = [...pids];
        const workspace = await mkdtemp(path.join(root, "workspace-"));
        const alias = path.join(root, "alias");
        await symlink(workspace, alias, "junction");
        const aliasRuns = await Promise.all([
            run("aliased", "original", false, { cwd: workspace, name: "workspace" }),
            run("aliased", "original", false, { cwd: alias, name: "workspace-alias" }),
        ]);
        expect(aliasRuns.map(({ previousMarker }) => previousMarker).sort()).toEqual([false, true]);
        const reused = await run("reused");
        expect(originalPids).toContain(reused.pid);

        const replacement = await run("replacement", "different");
        expect(originalPids).not.toContain(replacement.pid);
        expect(originalPids.filter(isRunning)).toEqual([reused.pid]);

        const isolated = await run("isolated", "original", true);
        expect(isRunning(isolated.pid)).toBe(false);

        await host.close();
        expect([...pids].filter(isRunning)).toEqual([]);
        expect(process.env.PI_INTEGRATION_TEST_RUNNER).toBe(previousEndpoint);
    }
    finally
    {
        await host.close();
        await rm(root, { recursive: true, force: true });
        if (previousLimit === undefined)
        {
            delete process.env.PI_INTEGRATION_TEST_MAX_PI;
        }
        else
        {
            process.env.PI_INTEGRATION_TEST_MAX_PI = previousLimit;
        }
    }
});

function isRunning(pid: number): boolean
{
    try
    {
        return process.kill(pid, 0);
    }
    catch (error)
    {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        {
            throw error;
        }
        return false;
    }
}

interface WorkspaceValue
{
    readonly pid: number;
    readonly cwd: string;
    readonly value: string;
    readonly previousMarker: boolean;
}
