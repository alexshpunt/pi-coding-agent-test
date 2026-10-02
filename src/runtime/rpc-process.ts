import { writeFile } from "node:fs/promises";
import path from "node:path";

import spawnProcess from "cross-spawn";

import { DEFAULT_TUI_SIZE, HARNESS_CONFIG_ENVIRONMENT, HARNESS_TRACE_ENVIRONMENT } from "./constants.js";
import { createPiProcessArguments } from "./pi-process.js";
import { RunTimeoutError } from "./timeout-error.js";
import { readTrace } from "./trace.js";

import type { InteractiveProcessOptions, InteractiveProcessResult } from "./interactive-process.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Run a fresh Pi over JSONL pipes. Settlement, not a prompt acknowledgement, completes the run. */
export async function runRpcProcess(options: InteractiveProcessOptions): Promise<InteractiveProcessResult>
{
    const { prompt, ...processOptions } = options;
    const child = spawnProcess(options.piCommand, [
        ...createPiProcessArguments({
            ...processOptions,
            sessionDirectory: options.sessionDir,
        }),
        "--mode",
        "rpc",
    ], {
        cwd: options.cwd,
        stdio: "pipe",

        detached: process.platform !== "win32",
        env: {
            ...process.env,
            ...options.environment,
            [HARNESS_CONFIG_ENVIRONMENT]: options.configPath,
            [HARNESS_TRACE_ENVIRONMENT]: options.tracePath,
        },
    }) as ChildProcessWithoutNullStreams;

    function signalChild(signal: NodeJS.Signals): void
    {
        try
        {
            if (process.platform !== "win32" && child.pid !== undefined)
            {
                process.kill(-child.pid, signal);
            }
            else
            {
                child.kill(signal);
            }
        }
        catch (error)
        {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            {
                throw error;
            }
        }
    }

    let stdout = "";
    let stderr = "";
    let pending = "";
    let stopping = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const completion = deferred<boolean>();
    const closed = deferred<number | null>();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) =>
    {
        stderr += data;
    });
    child.on("error", (error) =>
    {
        completion.reject(error);
    });
    child.stdin.on("error", (error) =>
    {
        completion.reject(error);
    });
    child.on("close", (code, signal) =>
    {
        closed.resolve(code);

        if (!stopping)
        {
            completion.reject(new Error(`RPC Pi exited before settlement (${code ?? signal})`));
        }
    });
    child.stdout.on("data", (data: string) =>
    {
        stdout += data;
        pending += data;
        let newline: number;

        while ((newline = pending.indexOf("\n")) !== -1)
        {
            const line = pending.slice(0, newline).trim();
            pending = pending.slice(newline + 1);

            if (line.length === 0)
            {
                continue;
            }

            try
            {
                const event = JSON.parse(line) as {
                    type?: string;
                    success?: boolean;
                    error?: string;
                    method?: string;
                };

                if (event.type === "response" && event.success === false)
                {
                    completion.reject(new Error(`RPC command failed: ${event.error}`));
                }

                if (
                    event.type === "extension_ui_request"
                    && ["select", "confirm", "input", "editor"].includes(event.method ?? "")
                )
                {
                    completion.reject(new Error(`RPC scenario requires an unsupported UI dialog: ${event.method}`));
                }

                if (event.type === "agent_settled")
                {
                    completion.resolve(true);
                }
            }
            catch (error)
            {
                completion.reject(new Error(`Invalid RPC output: ${line}`, { cause: error }));
            }
        }
    });
    const timer = setTimeout(
        () =>
        {
            completion.reject(new RunTimeoutError(`RPC Pi did not settle within ${options.timeoutMs}ms`));
        },
        options.timeoutMs,
    );
    child.stdin.write(`${JSON.stringify({ id: "scenario", type: "prompt", message: prompt })}\n`);

    try
    {
        await completion.promise;
        const traceEvents = await readTrace(options.tracePath);

        if (!traceEvents.some((event) => event.type === "agent_settled"))
        {
            throw new Error("RPC Pi settled without a harness settlement snapshot");
        }

        if (
            options.providerMode === "scripted"
            && traceEvents.filter((event) => event.type === "provider_request").length
                < options.expectedProviderRequestCount
        )
        {
            throw new Error("RPC Pi settled before consuming the scripted conversation");
        }

        stopping = true;
        signalChild("SIGTERM");
        killTimer = setTimeout(() =>
        {
            signalChild("SIGKILL");
        }, 1000);
        const exitCode = await closed.promise;
        return {
            traceEvents,
            exitCode,
            terminalOutput: stdout,
            tuiRenderedOutput: "",
            frameDelaysMs: [],
            tuiSize: DEFAULT_TUI_SIZE,
        };
    }
    catch (error)
    {
        throw new Error(`RPC Pi failed.\n${stderr}\n${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
        });
    }
    finally
    {
        clearTimeout(timer);

        if (!stopping)
        {
            stopping = true;
            signalChild("SIGTERM");
            killTimer = setTimeout(() =>
            {
                signalChild("SIGKILL");
            }, 1000);
            await closed.promise;
        }

        clearTimeout(killTimer);
        await writeFile(options.terminalOutputPath, stdout, "utf8");
        await writeFile(path.join(path.dirname(options.tuiRenderedOutputPath), "rpc-stderr.log"), stderr, "utf8");
        await writeFile(path.join(path.dirname(options.tuiRenderedOutputPath), "rpc-stdout.jsonl"), stdout, "utf8");
    }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void; }
{
    let accept!: (value: T) => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) =>
    {
        accept = resolve;
        fail = reject;
    });
    return { promise, resolve: accept, reject: fail };
}
