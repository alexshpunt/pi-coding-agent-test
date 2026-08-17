import { stat } from "node:fs/promises";

import { LIVE_MODE_ENVIRONMENT } from "../runtime/constants.js";
import { startSharedRunnerHost } from "../shared-runner/host.js";
import { SynchronizedFrameExtractor } from "../terminal/synchronized-output.js";

import {
    configureTestCommandHostEnvironment,
    createTestCommandEnvironment,
    formatTestCommand,
    runTestCommand,
    type TestCommand,
    type TestCommandResult,
} from "./test-command.js";

const escape = String.fromCodePoint(27);
const ctrlCInputs = [
    String.fromCodePoint(3),
    `${escape}[99;5u`,
    `${escape}[99;5:1u`,
    `${escape}[99;5:2u`,
    `${escape}[99;5:3u`,
    `${escape}[27;5;99~`,
];
const hostTerminalReset = "\u001B[<100u\u001B[=0u\u001B[>4;0m\u001B[?2004l\u001B[?25h\u001B[0m";

export interface LiveCommandOptions extends TestCommand
{
    readonly cwd: string;
    readonly delayMs?: number;
    readonly streamProfile?: string;
    readonly pauseMs: number;
    readonly once: boolean;
}

export async function runLiveCommand(options: LiveCommandOptions): Promise<number>
{
    await requireDirectory(options.cwd, "Working directory");
    configureEnvironment(options);
    resetHostTerminal();

    const host = await startSharedRunnerHost();
    const stopController = new AbortController();
    const stopRequested = new Promise<void>((resolve) =>
    {
        stopController.signal.addEventListener("abort", () =>
        {
            resolve();
        }, { once: true });
    });
    let activeCommand: AbortController | undefined;
    let iteration = 1;
    const stop = (): void =>
    {
        if (stopController.signal.aborted)
        {
            // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit -- A second interrupt force-stops the CLI.
            process.exit(130);
        }

        stopController.abort();
        activeCommand?.abort();
    };
    const handleKeyboardInput = (data: Buffer | string): void =>
    {
        const input = Buffer.isBuffer(data) ? data.toString("utf8") : data;

        if (ctrlCInputs.some((sequence) => input.includes(sequence)))
        {
            process.kill(process.pid, "SIGINT");
        }
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    if (!options.once)
    {
        process.stdin.on("data", handleKeyboardInput);
        process.stdin.resume();
    }

    try
    {
        while (!stopController.signal.aborted)
        {
            renderHeading(iteration, options);
            refreshStreamSeed(iteration, options);
            const stderrFrameExtractor = new SynchronizedFrameExtractor();
            const stdoutFrameExtractor = new SynchronizedFrameExtractor();
            const commandController = new AbortController();
            const abortCommand = (): void =>
            {
                commandController.abort();
            };
            activeCommand = commandController;
            stopController.signal.addEventListener("abort", abortCommand, { once: true });

            let result: TestCommandResult;

            try
            {
                result = await runTestCommand({
                    ...options,
                    captureOutput: true,
                    environment: createTestCommandEnvironment(options.cwd),
                    onStderr: (output) =>
                    {
                        writeFrames(stderrFrameExtractor, output);
                    },
                    onStdout: (output) =>
                    {
                        writeFrames(stdoutFrameExtractor, output);
                    },
                    signal: commandController.signal,
                });
            }
            finally
            {
                stopController.signal.removeEventListener("abort", abortCommand);
                activeCommand = undefined;
            }

            if (result.exitCode !== 0)
            {
                printCommandFailure(options, result);
                return result.exitCode;
            }

            if (options.once)
            {
                return 0;
            }

            iteration += 1;
            await Promise.race([delay(options.pauseMs), stopRequested]);
        }

        return 0;
    }
    finally
    {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);

        if (!options.once)
        {
            process.stdin.off("data", handleKeyboardInput);
            process.stdin.pause();
        }

        await host.close();
        resetHostTerminal();
    }
}

function configureEnvironment(options: LiveCommandOptions): void
{
    process.env[LIVE_MODE_ENVIRONMENT] = "1";
    delete process.env.PI_INTEGRATION_TEST_DELTA_DELAY_MS;
    delete process.env.PI_INTEGRATION_TEST_STREAM_PROFILE;
    delete process.env.PI_INTEGRATION_TEST_STREAM_SEED;

    if (options.streamProfile === undefined)
    {
        process.env.PI_INTEGRATION_TEST_DELTA_DELAY_MS = String(options.delayMs);
    }
    else
    {
        process.env.PI_INTEGRATION_TEST_STREAM_PROFILE = options.streamProfile;
    }

    configureTestCommandHostEnvironment(options.cwd);
}

function refreshStreamSeed(iteration: number, options: LiveCommandOptions): void
{
    if (options.streamProfile !== undefined)
    {
        process.env.PI_INTEGRATION_TEST_STREAM_SEED = `${Date.now()}:${process.pid}:${iteration}`;
    }
}

function writeFrames(extractor: SynchronizedFrameExtractor, output: string): void
{
    for (const frame of extractor.write(output))
    {
        process.stdout.write(frame);
    }
}

function renderHeading(iteration: number, options: LiveCommandOptions): void
{
    process.stdout.write("\u001B[2J\u001B[H");
    process.stdout.write(`Pi test loop ${iteration}: ${formatTestCommand(options)}\n`);
    process.stdout.write(`Pacing: ${options.streamProfile ?? `${options.delayMs} ms per delta`}\n`);
}

function printCommandFailure(options: LiveCommandOptions, result: TestCommandResult): void
{
    resetHostTerminal();
    process.stderr.write(`Test command failed with exit code ${result.exitCode}: ${formatTestCommand(options)}\n`);

    if (result.stdout.length > 0)
    {
        process.stderr.write(`\nRunner stdout:\n${result.stdout}`);
    }

    if (result.stderr.length > 0)
    {
        process.stderr.write(`\nRunner stderr:\n${result.stderr}`);
    }

    if (!result.stdout.endsWith("\n") || !result.stderr.endsWith("\n"))
    {
        process.stderr.write("\n");
    }
}

async function requireDirectory(directory: string, label: string): Promise<void>
{
    const information = await stat(directory).catch(() =>
    {});

    if (!information?.isDirectory())
    {
        throw new Error(`${label} does not exist: ${directory}`);
    }
}

function resetHostTerminal(): void
{
    if (process.stdout.isTTY)
    {
        process.stdout.write(hostTerminalReset);
    }
}

function delay(milliseconds: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
