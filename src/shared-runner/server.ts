import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";

import { SharedPiProcess, sharedRunnerConfigKey } from "./shared-pi-process.js";

import type { SharedRunnerEndpoint, SharedRunRequest, SharedRunResponse } from "./protocol.js";

const capEnvironment = "PI_INTEGRATION_TEST_MAX_PI";
const maxPiCeiling = 30;
const memoryReserve = 2 * 1024 ** 3;
const memoryPerPi = 768 * 1024 ** 2;

interface PoolSlot
{
    readonly key: string;
    readonly pi: SharedPiProcess;
}

interface PendingRun
{
    readonly request: SharedRunRequest;
    readonly workspace: string;
    readonly key: string;
    readonly socket: Socket;
    readonly controller: AbortController;
}

interface SharedRunner
{
    readonly endpoint: SharedRunnerEndpoint;
    readonly teardown: () => Promise<void>;
}

export async function startSharedRunner(live = false): Promise<SharedRunner>
{
    const maxPi = live ? 1 : sharedRunnerLimit();
    const pool = new SharedPiPool(maxPi);
    const token = randomBytes(24).toString("hex");
    const sockets = new Set<Socket>();
    const server = createServer((socket) =>
    {
        sockets.add(socket);
        socket.once("close", () =>
        {
            sockets.delete(socket);
        });
        socket.on("error", () => socket.destroy());
        handleConnection(socket, (request) =>
        {
            if (request.token !== token)
            {
                throw new Error("Invalid shared Pi runner request");
            }

            void pool.enqueue(socket, request).catch((error: unknown) =>
            {
                sendError(socket, request.requestId, error);
            });
        });
    });
    const endpoint = await listen(server, token, maxPi);
    const cancelLiveOutput = (): void =>
    {
        pool.cancelLiveOutput();
    };
    process.on("SIGINT", cancelLiveOutput);
    process.on("SIGTERM", cancelLiveOutput);

    let closing: Promise<void> | undefined;
    return {
        endpoint,
        teardown: () =>
        {
            closing ??= (async () =>
            {
                process.off("SIGINT", cancelLiveOutput);
                process.off("SIGTERM", cancelLiveOutput);
                const serverClosed = closeServer(server);

                for (const socket of sockets)
                {
                    socket.destroy();
                }

                await Promise.all([serverClosed, pool.close()]);
            })();
            return closing;
        },
    };
}

function sharedRunnerLimit(): number
{
    const value = process.env[capEnvironment];
    const requested = value === undefined ? maxPiCeiling : Number(value);

    if ((value !== undefined && !/^\d+$/u.test(value)) || !Number.isSafeInteger(requested) || requested < 1)
    {
        throw new Error(`${capEnvironment} must be a positive integer`);
    }

    const available = process.availableMemory();
    const memoryLimit = Math.max(1, Math.floor((available - memoryReserve) / memoryPerPi));
    return Math.min(requested, maxPiCeiling, memoryLimit);
}

class SharedPiPool
{
    // A slot counts until its Pi has exited, including while evicting or cleaning up.
    private occupied = 0;
    private readonly idle: PoolSlot[] = [];
    private readonly pending: PendingRun[] = [];
    private readonly active = new Map<string, { task: Promise<void>; controller: AbortController; }>();
    private readonly running = new Set<SharedPiProcess>();
    private closed = false;
    private readonly retiring = new Map<Promise<number>, unknown>();

    public constructor(private readonly limit: number)
    {
    }

    public async enqueue(socket: Socket, request: SharedRunRequest): Promise<void>
    {
        const workspace = await realpath(request.cwd);

        if (socket.destroyed)
        {
            return;
        }

        if (this.closed)
        {
            sendError(socket, request.requestId, new Error("Shared Pi pool is closed"));
            return;
        }

        const controller = new AbortController();
        const pending = {
            request: { ...request, cwd: workspace },
            workspace,
            key: sharedRunnerConfigKey(request.options),
            socket,
            controller,
        };
        this.pending.push(pending);
        socket.once("close", () =>
        {
            const index = this.pending.indexOf(pending);

            if (index !== -1)
            {
                this.pending.splice(index, 1);
            }

            controller.abort();
        });
        this.dispatch();
    }

    public cancelLiveOutput(): void
    {
        for (const pi of this.running)
        {
            pi.cancelLiveOutput();
        }
    }

    public async close(): Promise<void>
    {
        this.closed = true;
        this.pending.length = 0;
        this.cancelLiveOutput();

        for (const { controller } of this.active.values())
        {
            controller.abort();
        }

        await Promise.all([...this.active.values()].map(({ task }) => task));
        const cleanup = await Promise.allSettled(this.idle.splice(0).map((slot) => this.dispose(slot)));
        const errors = [
            ...new Set([
                ...this.retiring.values(),
                ...cleanup.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []),
            ]),
        ];

        if (errors.length > 0)
        {
            throw new AggregateError(errors, "Shared Pi pool cleanup failed");
        }
    }

    private dispatch(): void
    {
        while (!this.closed)
        {
            if (this.occupied >= this.limit && this.idle.length === 0)
            {
                if (this.retiring.size === this.limit)
                {
                    const error = new AggregateError(this.retiring.values(), "All shared Pi slots are awaiting exit");

                    for (const run of this.pending.splice(0))
                    {
                        sendError(run.socket, run.request.requestId, error);
                    }
                }

                return;
            }

            // A staged workspace is copied back as a tree. Serialize jobs whose
            // source trees overlap, including aliases resolved before enqueueing.
            const index = this.pending.findIndex(({ workspace }) =>
                ![...this.active.keys()].some((active) =>
                    containsWorkspace(active, workspace) || containsWorkspace(workspace, active)
                )
            );
            const next = this.pending[index];

            if (next === undefined)
            {
                return;
            }

            this.pending.splice(index, 1);

            const reusable = this.idle.findLastIndex(({ key }) => key === next.key);
            // Prefer a warm match; otherwise grow the pool before evicting the oldest idle process.
            const idleIndex = reusable === -1 && this.occupied >= this.limit ? 0 : reusable;
            const slot = idleIndex === -1 ? undefined : this.idle.splice(idleIndex, 1)[0];

            if (slot === undefined)
            {
                this.occupied += 1;
            }

            const task = this.execute(next, slot).finally(() =>
            {
                this.active.delete(next.workspace);
                this.dispatch();
            });
            this.active.set(next.workspace, { task, controller: next.controller });
        }
    }

    private async execute(job: PendingRun, previous: PoolSlot | undefined): Promise<void>
    {
        const { request, key, socket, controller: { signal } } = job;
        let slot = previous;
        let response: SharedRunResponse;

        try
        {
            if (previous !== undefined && previous.key !== key)
            {
                slot = undefined;
                await this.dispose(previous);
            }

            signal.throwIfAborted();

            slot ??= { key, pi: new SharedPiProcess() };
            this.running.add(slot.pi);
            const result = await slot.pi.run(request, signal);

            if (request.options.isolateUserResources === true || signal.aborted)
            {
                // The client deletes its per-scenario agent directory after the response.
                const finished = slot;
                slot = undefined;
                await this.dispose(finished);
                this.occupied -= 1;
            }
            else
            {
                this.running.delete(slot.pi);
                this.idle.push(slot);
            }

            response = { requestId: request.requestId, result };
        }
        catch (error)
        {
            if (slot !== undefined)
            {
                await this.dispose(slot).catch(() =>
                {
                    // Keep the scenario error; dispose retains any slot still awaiting exit.
                });
            }

            this.occupied -= 1;
            sendError(socket, request.requestId, error);
            return;
        }

        sendResponse(socket, response);
    }

    private async releaseAfterExit(exit: Promise<number>): Promise<void>
    {
        await exit;
        this.retiring.delete(exit);
        this.occupied -= 1;
        this.dispatch();
    }

    private async dispose(slot: PoolSlot): Promise<void>
    {
        try
        {
            await slot.pi.close();
        }
        catch (error)
        {
            const exit = slot.pi.unconfirmedExit;

            if (exit !== undefined)
            {
                // Keep this capacity reserved until the obsolete PTY actually exits.
                this.occupied += 1;
                this.retiring.set(exit, error);
                void this.releaseAfterExit(exit);
            }

            throw error;
        }
        finally
        {
            this.running.delete(slot.pi);
        }
    }
}

function containsWorkspace(root: string, candidate: string): boolean
{
    const relative = path.relative(root, candidate);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function handleConnection(socket: Socket, enqueue: (request: SharedRunRequest) => void): void
{
    let buffer = "";
    socket.setEncoding("utf8");

    const receive = (chunk: string): void =>
    {
        buffer += chunk;
        const newline = buffer.indexOf("\n");

        if (newline === -1)
        {
            return;
        }

        socket.off("data", receive);

        try
        {
            const value: unknown = JSON.parse(buffer.slice(0, newline));

            if (!isSharedRunRequest(value))
            {
                throw new TypeError("Invalid shared Pi runner request shape");
            }

            enqueue(value);
        }
        catch (error)
        {
            sendError(socket, "unknown", error);
        }
    };
    socket.on("data", receive);
}

function sendError(socket: Socket, requestId: string, error: unknown): void
{
    sendResponse(socket, {
        requestId,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
}

function sendResponse(socket: Socket, response: SharedRunResponse): void
{
    if (!socket.destroyed)
    {
        socket.end(`${JSON.stringify(response)}\n`);
    }
}

function listen(server: Server, token: string, maxPi: number): Promise<SharedRunnerEndpoint>
{
    return new Promise((resolve, reject) =>
    {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: 0 }, () =>
        {
            const address = server.address();

            if (address === null || typeof address === "string")
            {
                reject(new Error("Shared Pi runner did not receive a TCP address"));
                return;
            }

            resolve({ host: "127.0.0.1", port: address.port, token, maxPi });
        });
    });
}

function closeServer(server: Server): Promise<void>
{
    return new Promise((resolve, reject) =>
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
    });
}

function isSharedRunRequest(value: unknown): value is SharedRunRequest
{
    return isRecord(value)
        && value.type === "run"
        && typeof value.requestId === "string"
        && typeof value.token === "string"
        && typeof value.cwd === "string"
        && isRecord(value.runtime)
        && typeof value.runtime.config === "string"
        && typeof value.runtime.trace === "string"
        && typeof value.runtime.sessionDirectory === "string"
        && typeof value.runtime.terminalOutput === "string"
        && typeof value.runtime.tuiRenderedOutput === "string"
        && isRecord(value.options)
        && Array.isArray(value.options.conversation)
        && typeof value.prompt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown>
{
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
