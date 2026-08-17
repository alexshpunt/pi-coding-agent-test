import { connect as connectSocket, type Socket } from "node:net";

import {
    SHARED_RUNNER_ENVIRONMENT,
    type SharedRunInput,
    type SharedRunnerEndpoint,
    type SharedRunRequest,
    type SharedRunResponse,
} from "./protocol.js";

import type { InteractiveProcessResult } from "../runtime/interactive-process.js";

let requestSequence = 0;

export function getSharedRunnerEndpoint(): SharedRunnerEndpoint | undefined
{
    const value = process.env[SHARED_RUNNER_ENVIRONMENT];

    if (value === undefined)
    {
        return undefined;
    }

    try
    {
        const endpoint = JSON.parse(value) as Partial<SharedRunnerEndpoint>;

        if (
            typeof endpoint.host !== "string"
            || typeof endpoint.port !== "number"
            || typeof endpoint.token !== "string"
        )
        {
            throw new TypeError("invalid endpoint shape");
        }

        return endpoint as SharedRunnerEndpoint;
    }
    catch (error)
    {
        throw new Error(
            `Invalid ${SHARED_RUNNER_ENVIRONMENT}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

export async function runSharedIntegrationProcess(input: SharedRunInput): Promise<InteractiveProcessResult>
{
    const endpoint = getSharedRunnerEndpoint();

    if (endpoint === undefined)
    {
        throw new Error("Shared Pi runner is not configured");
    }

    const requestId = `${process.pid}-${requestSequence++}`;
    const socket = await connect(endpoint);
    const request: SharedRunRequest = {
        type: "run",
        token: endpoint.token,
        requestId,
        ...input,
    };

    return new Promise<InteractiveProcessResult>((resolve, reject) =>
    {
        let buffer = "";
        let settled = false;

        const finish = (callback: () => void): void =>
        {
            if (settled)
            {
                return;
            }

            settled = true;
            socket.destroy();
            callback();
        };

        socket.setEncoding("utf8");
        socket.on("data", (chunk) =>
        {
            buffer += chunk.toString("utf8");
            const newline = buffer.indexOf("\n");

            if (newline === -1)
            {
                return;
            }

            const line = buffer.slice(0, newline);
            finish(() =>
            {
                try
                {
                    const response = JSON.parse(line) as SharedRunResponse;

                    if (response.requestId !== requestId)
                    {
                        reject(new Error(`Shared Pi runner returned an unexpected request ID: ${response.requestId}`));
                    }
                    else if (response.error !== undefined)
                    {
                        reject(new Error(response.error));
                    }
                    else if (response.result === undefined)
                    {
                        reject(new Error("Shared Pi runner returned no result"));
                    }
                    else
                    {
                        resolve(response.result);
                    }
                }
                catch (error)
                {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            });
        });
        socket.on("error", (error) =>
        {
            finish(() =>
            {
                reject(error);
            });
        });
        socket.on("close", () =>
        {
            if (!settled)
            {
                finish(() =>
                {
                    reject(new Error("Shared Pi runner closed the connection"));
                });
            }
        });
        socket.write(`${JSON.stringify(request)}\n`);
    });
}

function connect(endpoint: SharedRunnerEndpoint): Promise<Socket>
{
    return new Promise((resolve, reject) =>
    {
        const socket = connectSocket(endpoint.port, endpoint.host);
        socket.once("connect", () =>
        {
            resolve(socket);
        });
        socket.once("error", reject);
    });
}
