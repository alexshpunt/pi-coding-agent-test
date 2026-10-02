import fs from "node:fs";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { SharedPiProcess } from "../src/shared-runner/shared-pi-process.js";

import type { PiIntegrationTestRuntimeArtifacts } from "../src/runtime/artifacts.js";
import type { SharedRunRequest } from "../src/shared-runner/protocol.js";

const ownedDirectories: string[] = [];
const initializationFailureCommand = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "shared-runner-initialization-failure.mjs",
);

afterEach(async () =>
{
    await Promise.all(ownedDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("shared Pi process failures", () =>
{
    test("cleans a shared root when ready-file initialization fails before PTY spawn", async () =>
    {
        const root = await makeOwnedDirectory("ale44-shared-pre-pty-");
        const workspace = path.join(root, "workspace");
        const runtimeDirectory = path.join(root, "runtime");
        const spawnMarker = path.join(root, "unexpected-pty.pid");
        await Promise.all([mkdir(workspace), mkdir(runtimeDirectory), chmod(initializationFailureCommand, 0o755)]);
        const runtime: PiIntegrationTestRuntimeArtifacts = {
            directory: runtimeDirectory,
            config: path.join(runtimeDirectory, "config.json"),
            sessionDirectory: path.join(runtimeDirectory, "session"),
            terminalOutput: path.join(runtimeDirectory, "terminal.log"),
            trace: path.join(runtimeDirectory, "trace.jsonl"),
            tuiRenderedOutput: path.join(runtimeDirectory, "tui-rendered.log"),
        };
        await Promise.all([
            mkdir(runtime.sessionDirectory),
            writeFile(runtime.config, "{}\n", "utf8"),
            writeFile(runtime.trace, "", "utf8"),
        ]);
        const request = (requestId: string): SharedRunRequest => ({
            type: "run",
            token: "test-token",
            requestId,
            cwd: workspace,
            runtime,
            prompt: "never submitted",
            options: {
                testName: requestId,
                piCommand: initializationFailureCommand,
                environment: { ALE44_INITIALIZATION_FAILURE_PID: spawnMarker },
                conversation: [],
                timeoutMs: 2_000,
            },
        });
        const runner = new CleanupFailingSharedPiProcess();
        const sharedRootsBefore = await currentProcessSharedRoots();
        const originalWriteFile = fs.promises.writeFile;
        let readyWriteAttempts = 0;
        const failures: unknown[] = [];

        fs.promises.writeFile = async (
            file,
            ...arguments_: Parameters<typeof originalWriteFile> extends [unknown, ...infer Rest] ? Rest : never
        ) =>
        {
            if (path.basename(String(file)) === "ready.json")
            {
                readyWriteAttempts += 1;
                throw new Error(`intentional ready-file initialization failure ${readyWriteAttempts}`);
            }

            return await originalWriteFile(file, ...arguments_);
        };
        syncBuiltinESMExports();

        try
        {
            for (const requestId of ["pre-pty-ready-failure", "reusable-after-ready-failure"])
            {
                try
                {
                    await runner.run(request(requestId));
                }
                catch (error)
                {
                    failures.push(error);
                }
            }
        }
        finally
        {
            fs.promises.writeFile = originalWriteFile;
            syncBuiltinESMExports();
            await runner.close().catch(() => undefined);
        }

        expect(readyWriteAttempts).toBe(2);
        expect(failures).toHaveLength(2);
        for (const [index, failure] of failures.entries())
        {
            expect(failure).toBeInstanceOf(AggregateError);
            const errors = (failure as AggregateError).errors;
            expect(errors).toHaveLength(2);
            expect(describeError(errors[0])).toContain(`intentional ready-file initialization failure ${index + 1}`);
            expect(describeError(errors[1])).toContain("intentional shared cleanup failure");
        }
        await expect(access(spawnMarker)).rejects.toThrow();
        expect(await currentProcessSharedRoots()).toEqual(sharedRootsBefore);
    });

    test("keeps initialization failure first when process cleanup also fails", async () =>
    {
        const root = await makeOwnedDirectory("ale44-shared-initialization-");
        const workspace = path.join(root, "workspace");
        const runtimeDirectory = path.join(root, "runtime");
        const pidPath = path.join(root, "initialization-child.pid");
        await Promise.all([mkdir(workspace), mkdir(runtimeDirectory), chmod(initializationFailureCommand, 0o755)]);
        const runtime: PiIntegrationTestRuntimeArtifacts = {
            directory: runtimeDirectory,
            config: path.join(runtimeDirectory, "config.json"),
            sessionDirectory: path.join(runtimeDirectory, "session"),
            terminalOutput: path.join(runtimeDirectory, "terminal.log"),
            trace: path.join(runtimeDirectory, "trace.jsonl"),
            tuiRenderedOutput: path.join(runtimeDirectory, "tui-rendered.log"),
        };
        await Promise.all([
            mkdir(runtime.sessionDirectory),
            writeFile(runtime.config, "{}\n", "utf8"),
            writeFile(runtime.trace, "", "utf8"),
        ]);
        const request: SharedRunRequest = {
            type: "run",
            token: "test-token",
            requestId: "initialization-and-cleanup-failure",
            cwd: workspace,
            runtime,
            prompt: "never submitted",
            options: {
                testName: "initialization-and-cleanup-failure",
                piCommand: initializationFailureCommand,
                environment: { ALE44_INITIALIZATION_FAILURE_PID: pidPath },
                conversation: [],
                timeoutMs: 2_000,
            },
        };
        const runner = new CleanupFailingSharedPiProcess();

        const sharedRootsBefore = await currentProcessSharedRoots();
        let failure: unknown;

        try
        {
            await runner.run(request);
        }
        catch (error)
        {
            failure = error;
        }

        expect(failure).toBeInstanceOf(AggregateError);
        const errors = (failure as AggregateError).errors;
        expect(errors).toHaveLength(2);
        expect(describeError(errors[0])).toContain("Shared Pi exited before becoming ready with code 41");
        expect(describeError(errors[1])).toContain("intentional shared cleanup failure");
        expect(describeError(failure)).toContain("Shared Pi exited before becoming ready with code 41");
        expect(describeError(failure)).toContain("intentional shared cleanup failure");

        const childPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
        expect(processExists(childPid)).toBe(false);
        expect(await currentProcessSharedRoots()).toEqual(sharedRootsBefore);
    });
});

class CleanupFailingSharedPiProcess extends SharedPiProcess
{
    public override async close(): Promise<void>
    {
        await super.close();
        throw new Error("intentional shared cleanup failure");
    }
}

async function makeOwnedDirectory(prefix: string): Promise<string>
{
    const directory = await mkdtemp(path.join(tmpdir(), prefix));
    ownedDirectories.push(directory);
    return directory;
}

async function currentProcessSharedRoots(): Promise<string[]>
{
    const prefix = `pi-integration-shared-${process.pid}-`;
    return (await readdir(path.join(process.cwd(), ".tmp")).catch(() => []))
        .filter((entry) => entry.startsWith(prefix))
        .sort();
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

function describeError(error: unknown): string
{
    if (error instanceof AggregateError)
    {
        return `${error.message} ${error.errors.map(describeError).join(" ")}`;
    }
    if (error instanceof Error)
    {
        return `${error.message} ${describeError(error.cause)}`;
    }

    return String(error ?? "");
}
