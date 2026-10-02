import { fork, spawn as spawnProcess } from "node:child_process";

import { spawn } from "node-pty";

import type { IPty, IPtyForkOptions } from "node-pty";

/** Terminal operations plus an awaited disposal of its Windows process owner. */
export interface OwnedPty extends Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit">
{
    readonly dispose: () => Promise<void>;
}

export type OwnerRequest =
    | {
        readonly type: "start";
        readonly command: string;
        readonly arguments: string[];
        readonly options: IPtyForkOptions;
    }
    | { readonly type: "write"; readonly data: string; };

export type OwnerResponse =
    | { readonly type: "ready"; readonly pid: number; }
    | { readonly type: "data"; readonly data: string; }
    | { readonly type: "exit"; readonly exitCode: number; readonly signal?: number; }
    | { readonly type: "error"; readonly message: string; };

/** Keep Windows constructor failures and PTY workers out of the caller's event loop. */
export async function spawnOwnedPty(
    command: string,
    arguments_: string[],
    options: IPtyForkOptions,
    timeoutMs: number,
): Promise<OwnedPty>
{
    if (process.platform !== "win32")
    {
        const terminal = spawn(command, arguments_, options);
        return Object.assign(terminal, {
            dispose: async (): Promise<void> =>
            {},
        });
    }

    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const owner = fork(new URL(`pty-owner.${extension}`, import.meta.url), [], {
        execArgv: [],
        env: { ...process.env, NODE_OPTIONS: "" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    owner.stderr?.on("data", (data: Buffer) =>
    {
        stderr = (stderr + data.toString()).slice(-8_192);
    });
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: { exitCode: number; signal?: number; }) => void>();
    const pendingData: string[] = [];
    let terminalExit: { exitCode: number; signal?: number; } | undefined;
    const lifecycle = { closed: false };
    const isClosed = (): boolean => lifecycle.closed;
    let disposePromise: Promise<void> | undefined;
    let readyResolve: (pid: number) => void = () =>
    {};
    let readyReject: (error: Error) => void = () =>
    {};
    const ready = new Promise<number>((resolve, reject) =>
    {
        readyResolve = resolve;
        readyReject = reject;
    });
    const ended = new Promise<void>((resolve) =>
    {
        owner.once("close", (code) =>
        {
            lifecycle.closed = true;
            readyReject(new Error(`PTY owner exited before startup (${code}): ${stderr}`));

            if (terminalExit === undefined)
            {
                terminalExit = { exitCode: code ?? 1 };

                for (const listener of exitListeners)
                {
                    listener(terminalExit);
                }
            }

            resolve();
        });
    });
    owner.once("error", readyReject);
    owner.on("message", (message: OwnerResponse) =>
    {
        switch (message.type)
        {
            case "ready":
            {
                readyResolve(message.pid);
                break;
            }
            case "error":
            {
                readyReject(new Error(`PTY startup failed for ${command}: ${message.message}`));
                void dispose().catch(readyReject);
                break;
            }
            case "data":
            {
                if (dataListeners.size === 0)
                {
                    pendingData.push(message.data);
                }
                else
                {
                    for (const listener of dataListeners)
                    {
                        listener(message.data);
                    }
                }

                break;
            }
            case "exit":
            {
                terminalExit = {
                    exitCode: message.exitCode,
                    ...(message.signal === undefined ? {} : { signal: message.signal }),
                };

                for (const listener of exitListeners)
                {
                    listener(terminalExit);
                }

                // Reap the owned tree, not only the owner: node-pty console helpers
                // can otherwise outlive it and keep inherited pipes open.
                void dispose().catch(readyReject);
                break;
            }
        }
    });

    function send(message: OwnerRequest): void
    {
        if (owner.connected)
        {
            owner.send(message);
        }
    }

    function dispose(): Promise<void>
    {
        disposePromise ??= (async () =>
        {
            if (isClosed())
            {
                return;
            }

            if (owner.pid !== undefined)
            {
                const killer = spawnProcess("taskkill.exe", ["/pid", String(owner.pid), "/t", "/f"], {
                    stdio: ["ignore", "ignore", "pipe"],
                    windowsHide: true,
                });
                let killError = "";
                killer.stderr.on("data", (data: Buffer) =>
                {
                    killError += data.toString();
                });
                const killed = new Promise<number | null>((resolve, reject) =>
                {
                    killer.once("error", reject);
                    killer.once("close", resolve);
                });

                try
                {
                    const code = await bounded(killed, 1_000, "PTY owner tree termination");

                    if (code !== 0)
                    {
                        throw new Error(
                            `PTY owner taskkill failed (${code}) for PID ${owner.pid}: ${killError}; owner exit=${owner.exitCode}, signal=${owner.signalCode}`,
                        );
                    }
                }
                finally
                {
                    if (killer.exitCode === null && killer.signalCode === null)
                    {
                        killer.kill();
                    }
                }
            }

            await bounded(ended, 1_000, "PTY owner shutdown");
        })();
        return disposePromise;
    }

    send({ type: "start", command, arguments: arguments_, options });

    try
    {
        const pid = await bounded(ready, timeoutMs, "PTY owner startup");
        return {
            pid,
            write: (data) =>
            {
                send({ type: "write", data: data.toString() });
            },
            kill: () =>
            {
                // IPty.kill is synchronous; dispose awaits this same cleanup and reports errors.
                void dispose().catch(readyReject);
            },
            onData: (listener) =>
            {
                dataListeners.add(listener);

                for (const data of pendingData.splice(0))
                {
                    listener(data);
                }

                return {
                    dispose: () =>
                    {
                        dataListeners.delete(listener);
                    },
                };
            },
            onExit: (listener) =>
            {
                exitListeners.add(listener);

                if (terminalExit !== undefined)
                {
                    listener(terminalExit);
                }

                return {
                    dispose: () =>
                    {
                        exitListeners.delete(listener);
                    },
                };
            },
            dispose,
        };
    }
    catch (error)
    {
        try
        {
            await dispose();
        }
        catch (cleanupError)
        {
            throw new AggregateError([error, cleanupError], "PTY startup and owner cleanup failed");
        }

        throw error;
    }
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T>
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
                    reject(new Error(`${label} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            }),
        ]);
    }
    finally
    {
        clearTimeout(timer);
    }
}
