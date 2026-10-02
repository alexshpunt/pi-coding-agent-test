import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { PiIntegrationTestRuntimeArtifacts } from "../src/runtime/artifacts.js";
import type { SharedRunRequest } from "../src/shared-runner/protocol.js";

const ptyState = vi.hoisted(() => ({
    activeListenerCounts: [] as number[],
    disposeCounts: [] as number[],
    exitCodes: [] as number[],
    writes: [] as string[],
}));

vi.mock("node-pty", () => ({
    spawn: vi.fn(() =>
    {
        const exitCode = 71 + ptyState.exitCodes.length;
        const index = ptyState.exitCodes.push(exitCode) - 1;
        ptyState.disposeCounts[index] = 0;

        return {
            pid: 30_000 + index,
            kill: vi.fn(),
            onData: vi.fn(() => ({ dispose: vi.fn() })),
            onExit: vi.fn((listener: (event: { exitCode: number; }) => void) =>
            {
                ptyState.activeListenerCounts[index] = 1;
                const subscription = {
                    dispose: vi.fn(() =>
                    {
                        ptyState.disposeCounts[index] = (ptyState.disposeCounts[index] ?? 0) + 1;
                        ptyState.activeListenerCounts[index] = 0;
                    }),
                };
                listener({ exitCode });
                return subscription;
            }),
            write: vi.fn((data: string) => ptyState.writes.push(data)),
        };
    }),
}));

const { SharedPiProcess } = await import("../src/shared-runner/shared-pi-process.js");
const ownedDirectories: string[] = [];

afterEach(async () =>
{
    ptyState.activeListenerCounts.length = 0;
    ptyState.disposeCounts.length = 0;
    ptyState.exitCodes.length = 0;
    ptyState.writes.length = 0;
    await Promise.all(ownedDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("shared Pi synchronous startup exit", () =>
{
    test("captures a synchronous onExit registration callback and disposes its returned subscription", async () =>
    {
        const temporaryParent = path.join(process.cwd(), ".agents", "tmp");
        await mkdir(temporaryParent, { recursive: true });
        const root = await mkdtemp(path.join(temporaryParent, "ale44-shared-sync-exit-"));
        ownedDirectories.push(root);
        const runner = new SharedPiProcess();
        const sharedRootsBefore = await currentProcessSharedRoots();
        const failures: unknown[] = [];

        try
        {
            for (const requestId of ["synchronous-exit-first", "synchronous-exit-reuse"])
            {
                try
                {
                    await runner.run(makeRequest(root, requestId));
                }
                catch (error)
                {
                    failures.push(error);
                }
            }
        }
        finally
        {
            await runner.close().catch(() => undefined);
        }

        expect(failures).toHaveLength(2);
        for (const [index, failure] of failures.entries())
        {
            expect(describeError(failure)).toContain(
                `Shared Pi exited before becoming ready with code ${71 + index}`,
            );
            expect(describeError(failure)).not.toContain("subscription");
            expect(failure).not.toBeInstanceOf(ReferenceError);
        }
        expect(ptyState.writes).toEqual([]);
        expect(await currentProcessSharedRoots()).toEqual(sharedRootsBefore);
        expect.soft(ptyState.activeListenerCounts).toEqual([0, 0]);
        expect.soft(ptyState.disposeCounts).toEqual([1, 1]);
    });
});

function makeRequest(root: string, requestId: string): SharedRunRequest
{
    const runtimeDirectory = path.join(root, requestId);
    const runtime: PiIntegrationTestRuntimeArtifacts = {
        directory: runtimeDirectory,
        config: path.join(runtimeDirectory, "config.json"),
        sessionDirectory: path.join(runtimeDirectory, "session"),
        terminalOutput: path.join(runtimeDirectory, "terminal.log"),
        trace: path.join(runtimeDirectory, "trace.jsonl"),
        tuiRenderedOutput: path.join(runtimeDirectory, "tui-rendered.log"),
    };

    return {
        type: "run",
        token: "test-token",
        requestId,
        cwd: root,
        runtime,
        prompt: "must not be submitted to an already exited PTY",
        options: {
            testName: requestId,
            conversation: [],
            timeoutMs: 500,
        },
    };
}

async function currentProcessSharedRoots(): Promise<string[]>
{
    const prefix = `pi-integration-shared-${process.pid}-`;
    return (await readdir(path.join(process.cwd(), ".tmp")).catch(() => []))
        .filter((entry) => entry.startsWith(prefix))
        .sort();
}

function describeError(error: unknown): string
{
    if (error instanceof AggregateError)
    {
        return `${error.message} ${error.errors.map(describeError).join(" ")}`;
    }

    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
