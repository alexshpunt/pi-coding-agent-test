import { type ChildProcess, spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assistantMessage, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

const workspaces: string[] = [];

const resistantScenario = path.join(
    process.cwd(),
    "test",
    "integration",
    "fixtures",
    "shared-runner-resistant-scenario.mjs",
);
const resistantPiCommand = path.join(
    process.cwd(),
    "test",
    "integration",
    "fixtures",
    "shared-runner-resistant-pi.mjs",
);
const staleExitScenario = path.join(
    process.cwd(),
    "test",
    "integration",
    "fixtures",
    "shared-runner-stale-exit-scenario.mjs",
);
const staleExitPreload = path.join(
    process.cwd(),
    "test",
    "integration",
    "fixtures",
    "shared-runner-stale-exit-preload.cjs",
);
const staleExitPiCommand = path.join(
    process.cwd(),
    "test",
    "integration",
    "fixtures",
    "shared-runner-stale-exit-pi.sh",
);
const lifecycleBoundMs = 20_000;

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

    test.skipIf(process.platform === "win32")(
        "bounds and escalates SIGTERM-resistant teardown before recovering the same queue",
        async () =>
        {
            const root = await mkdtemp(path.join(tmpdir(), "ale44-resistant-contract-"));
            const scenarioRoot = path.join(root, "scenario");
            const resultPath = path.join(root, "result.json");
            const scenarioPidPath = path.join(root, "scenario.pid");
            workspaces.push(root);
            await Promise.all([mkdir(scenarioRoot), chmod(resistantPiCommand, 0o755)]);
            const startedAt = Date.now();
            let result: OwnedProcessResult;

            try
            {
                result = await runOwnedProcess(process.execPath, [resistantScenario], {
                    ...process.env,
                    ALE44_RESISTANT_PI_COMMAND: resistantPiCommand,
                    ALE44_RESISTANT_SCENARIO_RESULT: resultPath,
                    ALE44_RESISTANT_SCENARIO_PID: scenarioPidPath,
                    ALE44_RESISTANT_SCENARIO_ROOT: scenarioRoot,
                }, lifecycleBoundMs);
            }
            finally
            {
                await forceKillRecordedPid(path.join(scenarioRoot, "state", "launch-1.pid"));
                await removeScenarioSharedRoots(scenarioPidPath);
            }

            expect(Date.now() - startedAt).toBeLessThan(lifecycleBoundMs);
            expect(result.stderr).toBe("");
            expect(result.code).toBe(0);
            const evidence = JSON.parse(await readFile(resultPath, "utf8")) as {
                armedPhase: { count: number; phase: string; pid: number; };
                firstError: string;
                firstPid: number;
                launchCount: number;
                readyPhase: { count: number; phase: string; pid: number; };
                secondError: string;
                signals: string;
            };
            expect(evidence.firstError).toContain("Trace did not settle after provider request 0");
            expect(evidence.armedPhase).toEqual({ count: 1, phase: "resistant-armed", pid: evidence.firstPid });
            expect(evidence.readyPhase).toEqual({ count: 1, phase: "ready-released", pid: evidence.firstPid });
            expect(evidence.signals).toContain("SIGTERM");
            expect(evidence.launchCount).toBeGreaterThanOrEqual(2);
            expect(evidence.secondError).toContain("Shared Pi exited before becoming ready with code 42");
            expect(processExists(evidence.firstPid)).toBe(false);
            await expect(access(scenarioRoot)).rejects.toThrow();
        },
        lifecycleBoundMs + 5_000,
    );

    test.skipIf(process.platform === "win32")(
        "ignores an obsolete PTY exit after a healthy same-key replacement",
        async () =>
        {
            const root = await mkdtemp(path.join(tmpdir(), "ale44-stale-exit-contract-"));
            const scenarioRoot = path.join(root, "scenario");
            const stateRoot = path.join(scenarioRoot, "state");
            const resultPath = path.join(root, "result.json");
            const scenarioPidPath = path.join(root, "scenario.pid");
            const releasePath = path.join(stateRoot, "release-old-pty");
            workspaces.push(root);
            await Promise.all([mkdir(scenarioRoot), chmod(staleExitPiCommand, 0o755)]);
            const startedAt = Date.now();
            let result: OwnedProcessResult;

            try
            {
                result = await runOwnedProcess(process.execPath, [staleExitScenario], {
                    ...process.env,
                    ALE44_STALE_EXIT_RELEASE: releasePath,
                    ALE44_STALE_EXIT_STATE: stateRoot,
                    ALE44_STALE_PI_COMMAND: staleExitPiCommand,
                    ALE44_STALE_PRELOAD: staleExitPreload,
                    ALE44_STALE_REAL_PI_COMMAND: "pi",
                    ALE44_STALE_SCENARIO_PID: scenarioPidPath,
                    ALE44_STALE_SCENARIO_RESULT: resultPath,
                    ALE44_STALE_SCENARIO_ROOT: scenarioRoot,
                    NODE_OPTIONS: appendNodeRequire(process.env.NODE_OPTIONS, staleExitPreload),
                }, lifecycleBoundMs);
            }
            finally
            {
                await writeFile(releasePath, "release\n", "utf8").catch(() => undefined);
                await new Promise((resolve) => setTimeout(resolve, 50));
                for (const name of ["old-pty.pid", "launch-1.pid", "launch-2.pid", "launch-3.pid"])
                {
                    await forceKillRecordedPid(path.join(stateRoot, name));
                }
                await removeScenarioSharedRoots(scenarioPidPath);
            }

            expect(Date.now() - startedAt).toBeLessThan(lifecycleBoundMs);
            expect(result.stderr).toBe("");
            expect(result.code).toBe(0);
            const evidence = JSON.parse(await readFile(resultPath, "utf8")) as {
                attempts: string;
                firstError: string;
                launchCount: number;
                oldPid: number;
                replacementPid: number;
            };
            expect(evidence.firstError).toMatch(/timed out|timeout/u);
            expect(evidence.attempts).toContain("SIGTERM");
            expect(evidence.attempts).toContain("SIGKILL");
            expect(evidence.launchCount).toBe(2);
            expect(processExists(evidence.oldPid)).toBe(false);
            expect(processExists(evidence.replacementPid)).toBe(false);
            await expect(access(scenarioRoot)).rejects.toThrow();
        },
        lifecycleBoundMs + 5_000,
    );
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

function appendNodeRequire(nodeOptions: string | undefined, preload: string): string
{
    const option = `--require=${JSON.stringify(preload)}`;
    return nodeOptions?.trim() ? `${nodeOptions} ${option}` : option;
}

interface OwnedProcessResult
{
    readonly code: number | null;
    readonly stderr: string;
    readonly stdout: string;
}

async function runOwnedProcess(
    command: string,
    arguments_: readonly string[],
    environment: NodeJS.ProcessEnv,
    timeoutMs: number,
): Promise<OwnedProcessResult>
{
    return await new Promise((resolve, reject) =>
    {
        const child = spawn(command, arguments_, {
            detached: process.platform !== "win32",
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        const pid = child.pid;

        if (pid === undefined)
        {
            reject(new Error("Failed to obtain the lifecycle scenario PID"));
            return;
        }

        let stderr = "";
        let stdout = "";
        let settled = false;
        child.stderr.setEncoding("utf8");
        child.stdout.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => stderr += chunk);
        child.stdout.on("data", (chunk: string) => stdout += chunk);
        const timer = setTimeout(() =>
        {
            if (settled)
            {
                return;
            }

            settled = true;
            void terminateScenario(child, pid).finally(() =>
            {
                reject(
                    new Error(
                        `Shared teardown scenario exceeded ${timeoutMs}ms. stdout=${
                            JSON.stringify(stdout.slice(-500))
                        } `
                            + `stderr=${JSON.stringify(stderr.slice(-500))}`,
                    ),
                );
            });
        }, timeoutMs);
        timer.unref();
        child.once("error", (error) =>
        {
            if (!settled)
            {
                settled = true;
                clearTimeout(timer);
                reject(error);
            }
        });
        child.once("close", (code) =>
        {
            if (!settled)
            {
                settled = true;
                clearTimeout(timer);
                resolve({ code, stderr, stdout });
            }
        });
    });
}

async function terminateScenario(child: ChildProcess, pid: number): Promise<void>
{
    signalScenario(pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 250));

    if (child.exitCode === null && child.signalCode === null)
    {
        signalScenario(pid, "SIGKILL");
    }
}

function signalScenario(pid: number, signal: NodeJS.Signals): void
{
    try
    {
        process.kill(process.platform === "win32" ? pid : -pid, signal);
    }
    catch (error)
    {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        {
            throw error;
        }
    }
}

async function forceKillRecordedPid(pidPath: string): Promise<void>
{
    const value = await readFile(pidPath, "utf8").catch(() => undefined);

    if (value === undefined)
    {
        return;
    }

    const pid = Number.parseInt(value, 10);

    if (processExists(pid))
    {
        process.kill(pid, "SIGKILL");
        await waitForProcessExit(pid, 1_000);
    }
}

async function removeScenarioSharedRoots(scenarioPidPath: string): Promise<void>
{
    const value = await readFile(scenarioPidPath, "utf8").catch(() => undefined);

    if (value === undefined)
    {
        return;
    }

    const prefix = `pi-integration-shared-${Number.parseInt(value, 10)}-`;
    const sharedDirectory = path.join(process.cwd(), ".tmp");
    const ownedRoots = (await readdir(sharedDirectory).catch(() => []))
        .filter((entry) => entry.startsWith(prefix));
    await Promise.all(ownedRoots.map((entry) =>
        rm(path.join(sharedDirectory, entry), {
            recursive: true,
            force: true,
        })
    ));
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void>
{
    const deadline = Date.now() + timeoutMs;

    while (processExists(pid))
    {
        if (Date.now() >= deadline)
        {
            throw new Error(`Test-owned PID ${pid} did not exit within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function processExists(pid: number): boolean
{
    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch
    {
        return false;
    }
}
