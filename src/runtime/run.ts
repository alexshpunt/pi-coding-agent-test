import { readFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_TUI_SIZE } from "./constants.js";
import { getSessionSnapshot } from "./trace.js";

import type {
    PiIntegrationTestArtifacts,
    PiIntegrationTestResult,
    PiIntegrationTestState,
    TraceEvent,
    TuiSize,
} from "../scenario/types.js";

interface BundleRecord
{
    readonly kind?: unknown;
    readonly [key: string]: unknown;
}

/** A completed real-Pi run, whether it was just executed or opened from disk. */
export class PiRun implements PiIntegrationTestResult
{
    private constructor(
        private readonly data: PiIntegrationTestResult,
        private readonly bundleHeader: unknown,
        private readonly sessionData: string | undefined,
    )
    {
    }

    /**
     * Wrap a just-completed result in the persistent run interface.
     *
     * @param result Structural result returned by the integration process.
     * @param session Optional native session JSONL captured by the runner.
     */
    public static fromResult(result: PiIntegrationTestResult, session?: string): PiRun
    {
        return new PiRun(result, null, session);
    }

    /** Open a saved run directory or its `run.jsonl` bundle without starting Pi.
     *
     * @param input Run directory or path to a `run.jsonl` file.
     * @throws If the bundle or its JSON records cannot be read.
     */
    public static async open(input: string): Promise<PiRun>
    {
        const runFile = input.endsWith(".jsonl") ? path.resolve(input) : path.join(path.resolve(input), "run.jsonl");
        const directory = path.dirname(runFile);
        const contents = await readFile(runFile, "utf8");
        const records = contents
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as BundleRecord);
        const header = records.find((record) => record.kind === "header");
        const summary = records.find((record) => record.kind === "summary");
        const terminalRecord = records.find((record) => record.kind === "terminal");
        const sessionRecord = records.find((record) => record.kind === "session");
        const traceEvents = records
            .filter((record) => record.kind === "trace" && isRecord(record.event))
            .map((record) => record.event as TraceEvent);
        const snapshot = getSessionSnapshot(traceEvents);
        const renderedPath = path.join(directory, "tui-rendered.log");
        const rendered = await readFile(renderedPath, "utf8").catch(() => "");

        const state = isRecord(summary?.state)
            ? summary.state as unknown as PiIntegrationTestState
            : snapshot?.state;
        const tuiSize = isTuiSize(summary?.tuiSize) ? summary.tuiSize : DEFAULT_TUI_SIZE;
        const frameDelaysMs = isNumberArray(summary?.frameDelaysMs) ? summary.frameDelaysMs : [];
        const result: PiIntegrationTestResult = {
            artifacts: createArtifacts(directory),
            frameDelaysMs,
            exitCode: summary?.exitCode === null || typeof summary?.exitCode === "number" ? summary.exitCode : null,
            messages: snapshot?.messages ?? [],
            providerRequests: traceEvents.filter((event) => event.type === "provider_request"),
            state,
            terminalOutput: isRecord(terminalRecord) && typeof terminalRecord.data === "string"
                ? terminalRecord.data
                : "",
            traceEvents,
            tuiRenderedOutput: rendered,
            tuiSize,
        };

        return new PiRun(
            result,
            header,
            isRecord(sessionRecord) && typeof sessionRecord.data === "string" ? sessionRecord.data : undefined,
        );
    }

    /** Public artifact paths written for this run. */
    public get artifacts(): PiIntegrationTestArtifacts
    {
        return this.data.artifacts;
    }

    /** Delay before each synchronized terminal frame, in milliseconds. */
    public get frameDelaysMs(): readonly number[]
    {
        return this.data.frameDelaysMs;
    }

    /** Exit status of a standalone Pi process, or `null` for shared-runner cases. */
    public get exitCode(): number | null
    {
        return this.data.exitCode;
    }

    /** Messages reconstructed from the final session branch. */
    public get messages(): readonly unknown[]
    {
        return this.data.messages;
    }

    /** Provider requests captured during the run. */
    public get providerRequests(): readonly TraceEvent[]
    {
        return this.data.providerRequests;
    }

    /** Final Pi session and runtime state, when captured. */
    public get state(): PiIntegrationTestState | undefined
    {
        return this.data.state;
    }

    /** Exact PTY output, including ANSI and terminal control sequences. */
    public get terminalOutput(): string
    {
        return this.data.terminalOutput;
    }

    /** Ordered events emitted by the harness. */
    public get traceEvents(): readonly TraceEvent[]
    {
        return this.data.traceEvents;
    }

    /** Final readable terminal screen after rendering the PTY stream. */
    public get tuiRenderedOutput(): string
    {
        return this.data.tuiRenderedOutput;
    }

    /** PTY dimensions used for the run. */
    public get tuiSize(): TuiSize
    {
        return this.data.tuiSize;
    }

    /** The captured run header, when this run was opened from a bundle. */
    public get header(): unknown
    {
        return this.bundleHeader;
    }

    /** The native Pi session JSONL, when the run persisted one. */
    public get session(): string | undefined
    {
        return this.sessionData;
    }
}

function createArtifacts(directory: string): PiIntegrationTestArtifacts
{
    return {
        directory,
        error: path.join(directory, "error.log"),
        run: path.join(directory, "run.jsonl"),
        tuiRenderedOutput: path.join(directory, "tui-rendered.log"),
    };
}

function isRecord(value: unknown): value is Record<string, unknown>
{
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown): value is readonly number[]
{
    return Array.isArray(value) && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function isTuiSize(value: unknown): value is TuiSize
{
    return isRecord(value)
        && Number.isSafeInteger(value.cols)
        && Number(value.cols) > 0
        && Number.isSafeInteger(value.rows)
        && Number(value.rows) > 0;
}
