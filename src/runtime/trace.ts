import { cp, readFile } from "node:fs/promises";
import path from "node:path";

import type { PiIntegrationTestRuntimeArtifacts } from "./artifacts.js";
import type { PiIntegrationTestState, TraceEvent } from "../scenario/types.js";

export interface SessionSnapshot
{
    readonly messages: readonly unknown[];
    readonly state: PiIntegrationTestState | undefined;
}

function parseTrace(value: string, allowPartialLine = false): TraceEvent[]
{
    const lines = value.trim().split("\n").filter(Boolean);
    const events: TraceEvent[] = [];

    for (const [index, line] of lines.entries())
    {
        try
        {
            events.push(JSON.parse(line) as TraceEvent);
        }
        catch (error)
        {
            if (allowPartialLine && index === lines.length - 1)
            {
                break;
            }

            throw error;
        }
    }

    return events;
}

export async function readTrace(file: string, allowPartialLine = false): Promise<TraceEvent[]>
{
    return parseTrace(await readFile(file, "utf8"), allowPartialLine);
}

export async function waitForSettledTrace(
    tracePath: string,
    expectedProviderRequestCount: number,
    timeoutMs: number,
): Promise<void>
{
    await waitForTrace(tracePath, timeoutMs, (events) =>
    {
        const providerRequests = events.filter((event) => event.type === "provider_request");

        if (providerRequests.length < expectedProviderRequestCount)
        {
            return false;
        }

        const lastProviderRequest = providerRequests.at(-1);
        return events.some((event) =>
            event.type === "agent_settled"
            && (lastProviderRequest === undefined || event.sequence > lastProviderRequest.sequence)
        );
    }, `Trace did not settle after provider request ${expectedProviderRequestCount}`);
}

/** Wait for the settlement event belonging to a real user-provider agent run. */
export async function waitForAgentSettledTrace(tracePath: string, timeoutMs: number): Promise<void>
{
    await waitForTrace(tracePath, timeoutMs, (events) =>
    {
        const agentStart = events.find((event) => event.type === "agent_start");
        return agentStart !== undefined
            && events.some((event) => event.type === "agent_settled" && event.sequence > agentStart.sequence);
    }, "Trace did not settle after the real agent started");
}

async function waitForTrace(
    tracePath: string,
    timeoutMs: number,
    complete: (events: readonly TraceEvent[]) => boolean,
    timeoutMessage: string,
): Promise<void>
{
    const started = Date.now();

    while (Date.now() - started < timeoutMs)
    {
        if (complete(await readTrace(tracePath, true)))
        {
            return;
        }

        await delay(5);
    }

    throw new Error(timeoutMessage);
}

export function getSessionSnapshot(traceEvents: readonly TraceEvent[]): SessionSnapshot | undefined
{
    const snapshot = traceEvents.toReversed().find((event) => event.type === "session_snapshot");

    if (snapshot === undefined || !Array.isArray(snapshot.messages))
    {
        return undefined;
    }

    return {
        messages: snapshot.messages,
        state: isIntegrationTestState(snapshot.state) ? snapshot.state : undefined,
    };
}

export async function copySessionFileFromTrace(
    runtime: PiIntegrationTestRuntimeArtifacts,
    tracePath: string,
): Promise<void>
{
    const traceEvents = await readTrace(tracePath);
    const snapshot = traceEvents.toReversed().find((event) => event.type === "session_snapshot");
    const state = snapshot?.state;
    const sessionFile = isRecord(state) ? state.sessionFile : undefined;

    if (typeof sessionFile === "string")
    {
        await cp(sessionFile, path.join(runtime.sessionDirectory, path.basename(sessionFile)), { force: true });
    }
}

export async function waitForNonEmptyFile(filePath: string, timeoutMs: number): Promise<void>
{
    const started = Date.now();

    while (Date.now() - started < timeoutMs)
    {
        try
        {
            const contents = await readFile(filePath, "utf8");

            if (contents.trim().length > 0)
            {
                return;
            }
        }
        catch
        {
            // The producer may not have created the startup file yet.
        }

        await delay(10);
    }

    throw new Error(`Shared Pi did not become ready within ${timeoutMs}ms`);
}

export function delay(milliseconds: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isIntegrationTestState(value: unknown): value is PiIntegrationTestState
{
    return isRecord(value)
        && typeof value.mode === "string"
        && typeof value.cwd === "string"
        && typeof value.isIdle === "boolean"
        && typeof value.hasPendingMessages === "boolean"
        && typeof value.sessionId === "string";
}

function isRecord(value: unknown): value is Record<string, unknown>
{
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
