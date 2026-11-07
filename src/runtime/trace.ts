import { cp, open, readFile } from "node:fs/promises";
import path from "node:path";

import { RunTimeoutError } from "./timeout-error.js";

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
    const started = performance.now();
    const tail = new TraceTail(tracePath);

    while (performance.now() - started < timeoutMs)
    {
        if (complete(await tail.poll()))
        {
            return;
        }

        await delay(5);
    }

    throw new RunTimeoutError(timeoutMessage);
}

/**
 * Reads a growing JSONL trace incrementally.
 *
 * Each poll reads only the bytes appended since the previous one and parses every complete line
 * once, so waiting on a large trace costs time proportional to the new events, not the whole file.
 * A line without its trailing newline stays pending until a later poll completes it.
 */
export class TraceTail
{
    private readonly events: TraceEvent[] = [];
    private offset = 0;
    private pending = Buffer.alloc(0);

    public constructor(private readonly file: string)
    {
    }

    /** Return every complete event written so far. */
    public async poll(): Promise<readonly TraceEvent[]>
    {
        const handle = await open(this.file, "r");

        try
        {
            const { size } = await handle.stat();

            if (size < this.offset)
            {
                // The file was replaced or truncated; start over from its beginning.
                this.events.length = 0;
                this.offset = 0;
                this.pending = Buffer.alloc(0);
            }

            if (size > this.offset)
            {
                const chunk = Buffer.alloc(size - this.offset);
                const { bytesRead } = await handle.read(chunk, 0, chunk.length, this.offset);
                this.offset += bytesRead;
                this.consume(chunk.subarray(0, bytesRead));
            }
        }
        finally
        {
            await handle.close();
        }

        return this.events;
    }

    private consume(chunk: Buffer): void
    {
        const data = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
        let start = 0;

        for (let end = data.indexOf(0x0A, start); end !== -1; end = data.indexOf(0x0A, start))
        {
            const line = data.toString("utf8", start, end).trim();
            start = end + 1;

            if (line.length > 0)
            {
                this.events.push(JSON.parse(line) as TraceEvent);
            }
        }

        this.pending = Buffer.from(data.subarray(start));
    }
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
