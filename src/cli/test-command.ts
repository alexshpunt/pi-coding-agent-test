import { type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import spawnProcess from "cross-spawn";

export interface TestCommand
{
    readonly executable: string;
    readonly arguments: readonly string[];
}

export interface TestCommandResult
{
    readonly exitCode: number;
    readonly stderr: string;
    readonly stdout: string;
}

export interface TestCommandOptions extends TestCommand
{
    readonly captureOutput: boolean;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly onStdout?: (output: string) => void;
    readonly onStderr?: (output: string) => void;
    readonly signal?: AbortSignal;
}

export function createTestCommandEnvironment(cwd: string): NodeJS.ProcessEnv
{
    const environment = { ...process.env };
    const packageRoot = path.resolve(import.meta.dirname, "../..");
    environment.PATH = [
        ...new Set([
            path.join(cwd, "node_modules", ".bin"),
            path.join(packageRoot, "node_modules", ".bin"),
            ...(environment.PATH ?? "").split(path.delimiter),
        ]),
    ].filter((entry) => entry.length > 0).join(path.delimiter);
    delete environment.VSCODE_INSPECTOR_OPTIONS;

    if (environment.NODE_OPTIONS?.includes("ms-vscode.js-debug") === true)
    {
        delete environment.NODE_OPTIONS;
    }

    return environment;
}

export function configureTestCommandHostEnvironment(cwd: string): void
{
    const environment = createTestCommandEnvironment(cwd);
    process.env.PATH = environment.PATH;
    delete process.env.VSCODE_INSPECTOR_OPTIONS;

    if (environment.NODE_OPTIONS === undefined)
    {
        delete process.env.NODE_OPTIONS;
    }
    else
    {
        process.env.NODE_OPTIONS = environment.NODE_OPTIONS;
    }
}

export function formatTestCommand(command: TestCommand): string
{
    return [command.executable, ...command.arguments]
        .map((argument) => (/\s/u.test(argument) ? JSON.stringify(argument) : argument))
        .join(" ");
}

export function runTestCommand(options: TestCommandOptions): Promise<TestCommandResult>
{
    const child = spawnProcess(options.executable, options.arguments, {
        cwd: options.cwd,
        env: options.environment,
        stdio: options.captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    return waitForCommand(child, options);
}

function waitForCommand(child: ChildProcess, options: TestCommandOptions): Promise<TestCommandResult>
{
    return new Promise((resolve, reject) =>
    {
        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");
        let stdout = "";
        let stderr = "";

        const appendStdout = (output: string): void =>
        {
            stdout += output;
            options.onStdout?.(output);
        };

        const appendStderr = (output: string): void =>
        {
            stderr += output;
            options.onStderr?.(output);
        };
        const stop = (): void =>
        {
            if (child.exitCode === null && child.signalCode === null)
            {
                child.kill("SIGTERM");
            }
        };
        const cleanup = (): void =>
        {
            options.signal?.removeEventListener("abort", stop);
        };

        child.stdout?.on("data", (chunk: Buffer) =>
        {
            appendStdout(stdoutDecoder.write(chunk));
        });
        child.stderr?.on("data", (chunk: Buffer) =>
        {
            appendStderr(stderrDecoder.write(chunk));
        });
        child.once("error", (error) =>
        {
            cleanup();
            reject(error);
        });
        child.once("close", (exitCode, signal) =>
        {
            appendStdout(stdoutDecoder.end());
            appendStderr(stderrDecoder.end());
            cleanup();
            resolve({
                exitCode: exitCode ?? signalExitCode(signal),
                stderr,
                stdout,
            });
        });

        if (options.signal?.aborted === true)
        {
            stop();
        }
        else
        {
            options.signal?.addEventListener("abort", stop, { once: true });
        }
    });
}

function signalExitCode(signal: NodeJS.Signals | null): number
{
    if (signal === null)
    {
        return 1;
    }

    return 128 + osConstants.signals[signal];
}
