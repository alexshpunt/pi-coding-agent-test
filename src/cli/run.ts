import { stat } from "node:fs/promises";

import { startSharedRunnerHost } from "../shared-runner/host.js";

import {
    configureTestCommandHostEnvironment,
    createTestCommandEnvironment,
    runTestCommand,
    type TestCommand,
} from "./test-command.js";

export interface RunCommandOptions extends TestCommand
{
    readonly cwd: string;
}

export async function runRunCommand(options: RunCommandOptions): Promise<number>
{
    await requireDirectory(options.cwd);

    configureTestCommandHostEnvironment(options.cwd);
    const host = await startSharedRunnerHost();
    const stopController = new AbortController();
    const stop = (): void =>
    {
        stopController.abort();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    try
    {
        const result = await runTestCommand({
            ...options,
            captureOutput: false,
            environment: createTestCommandEnvironment(options.cwd),
            signal: stopController.signal,
        });
        return result.exitCode;
    }
    finally
    {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await host.close();
    }
}

async function requireDirectory(directory: string): Promise<void>
{
    const information = await stat(directory).catch(() =>
    {});

    if (!information?.isDirectory())
    {
        throw new Error(`Working directory does not exist: ${directory}`);
    }
}
