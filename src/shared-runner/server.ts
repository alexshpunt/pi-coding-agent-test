import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

import { SharedPiProcess } from "./shared-pi-process.js";

import type { SharedRunnerEndpoint, SharedRunRequest, SharedRunResponse } from "./protocol.js";

interface SharedRunner
{
    readonly endpoint: SharedRunnerEndpoint;
    readonly close: () => Promise<void>;
}

let runner: SharedRunner | undefined;

export async function startSharedRunner(): Promise<{
    readonly endpoint: SharedRunnerEndpoint;
    readonly teardown: () => Promise<void>;
}>
{
    if (runner !== undefined)
    {
        return { endpoint: runner.endpoint, teardown: runner.close };
    }

    const sharedPi = new SharedPiProcess();
    const token = randomBytes(24).toString("hex");
    let requestQueue = Promise.resolve();

    const server = createServer((socket) =>
    {
        handleConnection(socket, (request) =>
        {
            requestQueue = requestQueue.then(async () =>
            {
                try
                {
                    const result = await executeRequest(request, token, sharedPi);
                    sendResponse(socket, { requestId: request.requestId, result });
                }
                catch (error)
                {
                    sendResponse(socket, {
                        requestId: request.requestId,
                        error: error instanceof Error ? error.stack ?? error.message : String(error),
                    });
                }

                return;
            });
        });
    });
    const endpoint = await listen(server, token);

    const cancelLiveOutput = (): void =>
    {
        sharedPi.cancelLiveOutput();
    };
    process.on("SIGINT", cancelLiveOutput);
    process.on("SIGTERM", cancelLiveOutput);

    let closed = false;
    const close = async (): Promise<void> =>
    {
        if (closed)
        {
            return;
        }

        closed = true;
        runner = undefined;
        process.off("SIGINT", cancelLiveOutput);
        process.off("SIGTERM", cancelLiveOutput);

        try
        {
            await sharedPi.close();
        }
        finally
        {
            await closeServer(server);
        }
    };

    runner = { endpoint, close };
    return { endpoint, teardown: close };
}

function handleConnection(socket: Socket, enqueue: (request: SharedRunRequest) => void): void
{
    let buffer = "";

    socket.on("data", (chunk) =>
    {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");

        if (newline === -1)
        {
            return;
        }

        const line = buffer.slice(0, newline);

        try
        {
            const value: unknown = JSON.parse(line);

            if (!isSharedRunRequest(value))
            {
                throw new TypeError("Invalid shared Pi runner request shape");
            }

            enqueue(value);
        }
        catch (error)
        {
            sendResponse(socket, {
                requestId: "unknown",
                error: error instanceof Error ? error.stack ?? error.message : String(error),
            });
        }
    });
}

async function executeRequest(
    request: SharedRunRequest,
    token: string,
    sharedPi: SharedPiProcess,
)
{
    if (request.token !== token)
    {
        throw new Error("Invalid shared Pi runner request");
    }

    return sharedPi.run(request);
}

function sendResponse(socket: Socket, response: SharedRunResponse): void
{
    if (!socket.destroyed)
    {
        socket.end(`${JSON.stringify(response)}\n`);
    }
}

function listen(server: Server, token: string): Promise<SharedRunnerEndpoint>
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

            resolve({
                host: "127.0.0.1",
                port: address.port,
                token,
            });
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
