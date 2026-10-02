import { type ChildProcess, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { Type } from "@earendil-works/pi-ai";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface DecisionState
{
    readonly port: number;
    readonly decision?: string;
}

const childTimeoutMs = 2_000;
const childTerminationTimeoutMs = 1_000;
const gracefulTerminationMs = 200;
const serverCloseTimeoutMs = 2_000;

/** Test-only generic application that waits for a decision submitted from a real browser page. */
export default function browserDecisionExtension(pi: ExtensionAPI): void
{
    pi.registerTool({
        name: "browser_decision",
        label: "Browser decision",
        description: "Open a local decision page and wait for its real form submission.",
        parameters: Type.Object({ id: Type.String() }),
        async execute(_toolCallId, parameters, signal, _onUpdate, context)
        {
            const stateFile = path.join(context.cwd, `browser-decision-${parameters.id}.json`);
            const executionSignal = signal ?? new AbortController().signal;
            let settleDecision: ((value: string) => void) | undefined;
            let rejectDecision: ((error: Error) => void) | undefined;
            const decision = new Promise<string>((resolve, reject) =>
            {
                settleDecision = resolve;
                rejectDecision = reject;
            });
            const server = createServer((request, response) =>
            {
                if (request.method === "GET" && request.url === "/")
                {
                    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                    response.end([
                        "<!doctype html><html><body>",
                        `<form method="post" action="/decision"><label>Decision <input name="decision" `,
                        `aria-label="decision-${parameters.id}"></label><button type="submit">Submit</button></form>`,
                        "</body></html>",
                    ].join(""));

                    return;
                }

                if (request.method === "POST" && request.url === "/decision")
                {
                    const chunks: Buffer[] = [];
                    request.on("data", (chunk: Buffer) => chunks.push(chunk));
                    request.on("end", () =>
                    {
                        const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
                        const value = body.get("decision") ?? "";
                        settleDecision?.(value);
                        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
                        response.end("accepted");
                    });

                    return;
                }

                response.writeHead(404);
                response.end("not found");
            });
            const abort = (): void =>
                rejectDecision?.(
                    executionSignal.reason instanceof Error ? executionSignal.reason : new Error("aborted"),
                );
            executionSignal.addEventListener("abort", abort, { once: true });

            try
            {
                await withTimeout(
                    new Promise<void>((resolve, reject) =>
                    {
                        server.once("error", reject);
                        server.listen(0, "127.0.0.1", resolve);
                    }),
                    2_000,
                    "decision server listen",
                );
                const address = server.address();

                if (address === null || typeof address === "string")
                {
                    throw new Error("Decision server did not bind a TCP port");
                }

                const state: DecisionState = { port: address.port };
                await writeFile(stateFile, `${JSON.stringify(state)}\n`, "utf8");
                const url = `http://127.0.0.1:${address.port}/`;
                await invokeApplicationOpener(url);
                const value = await decision;
                await writeFile(stateFile, `${JSON.stringify({ ...state, decision: value })}\n`, "utf8");

                return {
                    content: [{ type: "text", text: `Browser decision: ${value}` }],
                    details: { decision: value, port: address.port },
                };
            }
            finally
            {
                executionSignal.removeEventListener("abort", abort);
                await closeServer(server);
            }
        },
    });
}

async function invokeApplicationOpener(url: string): Promise<void>
{
    const explicit = process.env.BROWSER;
    const fallback = explicit === undefined || explicit.length === 0;
    const command = fallback ? defaultPlatformOpener() : explicit;
    const arguments_ = fallback && process.platform === "win32" ? ["/c", "start", "", url] : [url];

    await new Promise<void>((resolve, reject) =>
    {
        const child = spawn(command, arguments_, {
            detached: process.platform !== "win32",
            env: process.env,
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
        });
        const pid = child.pid;

        if (pid === undefined)
        {
            reject(new Error("Application opener did not provide an owned PID"));

            return;
        }

        let stderr = "";
        let settled = false;
        let timingOut = false;
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) =>
        {
            stderr += chunk;
        });
        const exited = new Promise<void>((resolve) =>
        {
            child.once("exit", () =>
            {
                resolve();
            });
        });
        const timer = setTimeout(() =>
        {
            if (settled || timingOut)
            {
                return;
            }

            timingOut = true;
            void terminateOwnedProcessTree(child, pid, exited).then(
                () =>
                {
                    settled = true;
                    reject(
                        new Error(
                            `Application opener exceeded ${childTimeoutMs}ms; terminated process tree for owned PID ${pid}. `
                                + `Captured stderr: ${boundedOutput(stderr)}`,
                        ),
                    );

                    return null;
                },
                (terminationError: unknown) =>
                {
                    settled = true;
                    reject(
                        new AggregateError(
                            [terminationError],
                            `Application opener exceeded ${childTimeoutMs}ms and owned PID ${pid} cleanup failed. `
                                + `Captured stderr: ${boundedOutput(stderr)}`,
                        ),
                    );

                    return null;
                },
            );
        }, childTimeoutMs);
        timer.unref();
        child.once("error", (error) =>
        {
            if (!settled && !timingOut)
            {
                settled = true;
                clearTimeout(timer);
                reject(error);
            }
        });
        child.once("close", (code) =>
        {
            if (settled || timingOut)
            {
                return;
            }

            settled = true;
            clearTimeout(timer);

            if (code === 0)
            {
                resolve();
            }
            else
            {
                reject(new Error(`Application browser fallback failed (${code ?? "signal"}): ${stderr.slice(0, 500)}`));
            }
        });
    });
}

async function terminateOwnedProcessTree(
    child: ChildProcess,
    pid: number,
    exited: Promise<void>,
): Promise<void>
{
    const deadline = Date.now() + childTerminationTimeoutMs;

    const cleanupErrors: unknown[] = [];

    try
    {
        if (process.platform === "win32")
        {
            await runTaskkill(pid, deadline);
        }
        else
        {
            signalOwnedProcessGroup(pid, "SIGTERM");
            await waitForOwnedProcessGroup(pid, Math.min(deadline, Date.now() + gracefulTerminationMs));

            if (ownedProcessGroupExists(pid))
            {
                signalOwnedProcessGroup(pid, "SIGKILL");
            }

            if (!await waitForOwnedProcessGroup(pid, deadline))
            {
                throw new Error(`Timed out terminating application opener tree for owned PID ${pid}`);
            }
        }
    }
    catch (error)
    {
        cleanupErrors.push(error);
    }

    try
    {
        await beforeDeadline(exited, deadline, `application opener PID ${pid} exit`);
    }
    catch (error)
    {
        cleanupErrors.push(error);
    }

    if (child.exitCode === null && child.signalCode === null)
    {
        cleanupErrors.push(new Error(`Application opener PID ${pid} did not report exit after tree termination`));
    }

    if (cleanupErrors.length > 0)
    {
        throw new AggregateError(cleanupErrors, `Application opener PID ${pid} process-tree termination failed`);
    }
}

async function runTaskkill(pid: number, deadline: number): Promise<void>
{
    const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
    });
    let stderr = "";
    taskkill.stderr.setEncoding("utf8");
    taskkill.stderr.on("data", (chunk: string) => stderr += chunk);
    const closed = new Promise<void>((resolve) =>
    {
        taskkill.once("close", () =>
        {
            resolve();
        });
    });
    const completed = new Promise<void>((resolve, reject) =>
    {
        taskkill.once("error", reject);
        taskkill.once("close", (code) =>
        {
            if (code === 0)
            {
                resolve();
            }
            else
            {
                reject(
                    new Error(`taskkill failed for owned PID ${pid} (${code ?? "signal"}): ${boundedOutput(stderr)}`),
                );
            }
        });
    });
    const taskkillDeadline = Math.min(deadline, Date.now() + Math.floor(childTerminationTimeoutMs / 2));

    try
    {
        await beforeDeadline(completed, taskkillDeadline, `taskkill for application opener PID ${pid}`);
    }
    catch (error)
    {
        if (taskkill.exitCode === null && taskkill.signalCode === null && taskkill.pid !== undefined)
        {
            taskkill.kill("SIGKILL");

            try
            {
                await beforeDeadline(closed, deadline, `taskkill process for application opener PID ${pid} exit`);
            }
            catch (closeError)
            {
                throw new AggregateError(
                    [error, closeError],
                    `taskkill cleanup failed for application opener PID ${pid}`,
                );
            }
        }

        throw error;
    }
}

function signalOwnedProcessGroup(pid: number, signal: NodeJS.Signals): void
{
    try
    {
        process.kill(-pid, signal);
    }
    catch (error)
    {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        {
            throw error;
        }
    }
}

function ownedProcessGroupExists(pid: number): boolean
{
    try
    {
        process.kill(-pid, 0);

        return true;
    }
    catch (error)
    {
        if ((error as NodeJS.ErrnoException).code === "ESRCH")
        {
            return false;
        }

        throw error;
    }
}

async function waitForOwnedProcessGroup(pid: number, deadline: number): Promise<boolean>
{
    while (ownedProcessGroupExists(pid))
    {
        if (Date.now() >= deadline)
        {
            return false;
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    return true;
}

async function beforeDeadline<T>(promise: Promise<T>, deadline: number, label: string): Promise<T>
{
    const remainingMs = deadline - Date.now();

    if (remainingMs <= 0)
    {
        throw new Error(`${label} exceeded the ${childTerminationTimeoutMs}ms termination bound`);
    }

    let timer: NodeJS.Timeout | undefined;

    try
    {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) =>
            {
                timer = setTimeout(
                    () =>
                    {
                        reject(new Error(`${label} exceeded the ${childTerminationTimeoutMs}ms termination bound`));
                    },
                    remainingMs,
                );
                timer.unref();
            }),
        ]);
    }
    finally
    {
        if (timer !== undefined)
        {
            clearTimeout(timer);
        }
    }
}

function boundedOutput(output: string): string
{
    return JSON.stringify(output.slice(-500));
}

function defaultPlatformOpener(): string
{
    if (process.platform === "win32")
    {
        return "cmd.exe";
    }

    if (process.platform === "darwin")
    {
        return "open";
    }

    return "xdg-open";
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void>
{
    if (!server.listening)
    {
        return;
    }

    await withTimeout(
        new Promise<void>((resolve, reject) =>
        {
            server.close((error) =>
            {
                if (error === undefined)
                {
                    resolve();
                }
                else
                {
                    reject(error);
                }
            });
        }),
        serverCloseTimeoutMs,
        "decision server close",
    );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T>
{
    let timer: NodeJS.Timeout | undefined;

    try
    {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) =>
            {
                timer = setTimeout(() =>
                {
                    reject(new Error(`${label} exceeded ${timeoutMs}ms`));
                }, timeoutMs);
                timer.unref();
            }),
        ]);
    }
    finally
    {
        if (timer !== undefined)
        {
            clearTimeout(timer);
        }
    }
}
