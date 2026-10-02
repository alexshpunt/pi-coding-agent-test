import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, DEFAULT_TUI_SIZE } from "./constants.js";
import { isRunTimeout } from "./timeout-error.js";
import { getSessionSnapshot, readTrace } from "./trace.js";

import type {
    PiIntegrationTestArtifacts,
    PiIntegrationTestOptions,
    PiIntegrationTestResult,
} from "../scenario/types.js";

export interface PiIntegrationTestRuntimeArtifacts
{
    readonly directory: string;
    readonly config: string;
    readonly sessionDirectory: string;
    readonly terminalOutput: string;
    readonly trace: string;
    readonly tuiRenderedOutput: string;
}

interface PrepareArtifactsInput
{
    readonly artifacts: PiIntegrationTestArtifacts;
    readonly runtime: PiIntegrationTestRuntimeArtifacts;
    readonly options: PiIntegrationTestOptions;
}

interface RunBundleRecord
{
    readonly kind: string;
    readonly [key: string]: unknown;
}

export function createIntegrationTestArtifacts(options: PiIntegrationTestOptions): PiIntegrationTestArtifacts
{
    const testName = sanitizeTestName(options.testName);
    const root = path.resolve(options.artifactsDir ?? path.join(process.cwd(), ".tmp", "test-runs"));
    const directory = path.join(root, testName);

    return {
        directory,
        error: path.join(directory, "error.log"),
        run: path.join(directory, "run.jsonl"),
        tuiRenderedOutput: path.join(directory, "tui-rendered.log"),
    };
}

export function createIntegrationTestRuntimeArtifacts(
    artifacts: PiIntegrationTestArtifacts,
): PiIntegrationTestRuntimeArtifacts
{
    const directory = path.join(artifacts.directory, ".runtime");

    return {
        directory,
        config: path.join(directory, "config.json"),
        sessionDirectory: path.join(directory, "session"),
        terminalOutput: path.join(directory, "terminal.log"),
        trace: path.join(directory, "trace.jsonl"),
        tuiRenderedOutput: artifacts.tuiRenderedOutput,
    };
}

export async function prepareIntegrationTestArtifacts(input: PrepareArtifactsInput): Promise<void>
{
    const { artifacts, options, runtime } = input;

    await rm(artifacts.directory, { recursive: true, force: true });
    await mkdir(runtime.sessionDirectory, { recursive: true });
    await writeJson(runtime.config, {
        conversation: options.conversation ?? [],
        providerMode: options.providerMode ?? "scripted",
        tools: options.tools,
    });
    await Promise.all([
        writeFile(runtime.trace, "", "utf8"),
        writeFile(artifacts.tuiRenderedOutput, "", "utf8"),
    ]);
}

export async function writeRunBundle(
    artifacts: PiIntegrationTestArtifacts,
    runtime: PiIntegrationTestRuntimeArtifacts,
    cwd: string,
    options: PiIntegrationTestOptions,
    prompt: string,
    result: PiIntegrationTestResult,
    outcome: { status: "settled" | "timeout" | "error"; startedMonotonicMs: number; endedMonotonicMs: number; },
): Promise<void>
{
    const session = await readSession(runtime.sessionDirectory);
    const header: RunBundleRecord = {
        kind: "header",
        version: 2,
        cwd,
        prompt,
        options: {
            extensions: options.extensions ?? [],
            skills: options.skills ?? [],
            systemPrompt: options.systemPrompt,
            appendSystemPrompt: options.appendSystemPrompt ?? [],
            isolateUserResources: options.isolateUserResources ?? false,
            model: options.model ?? (options.providerMode === "user" ? null : DEFAULT_MODEL),
            piCommand: options.piCommand ?? "pi",
            providerMode: options.providerMode ?? "scripted",
            transport: options.transport ?? "tui",
            rawMode: options.rawMode ?? options.providerMode !== "user",
            thinking: options.thinking ?? null,
            timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            tools: options.tools,
            conversation: options.conversation ?? [],
        },
    };
    const records: RunBundleRecord[] = [header];

    for (const event of result.traceEvents)
    {
        records.push({ kind: "trace", event });
    }

    records.push({ kind: "terminal", data: result.terminalOutput });
    records.push({
        kind: "summary",
        ...outcome,
        partial: outcome.status !== "settled",
        exitCode: result.exitCode,
        state: result.state === undefined ? undefined : { ...result.state, sessionFile: undefined },
        tuiSize: result.tuiSize,
        frameDelaysMs: result.frameDelaysMs,
    });

    if (session !== undefined)
    {
        records.push({ kind: "session", data: session });
    }

    await writeFile(artifacts.run, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

/** Save completed trace records on failure, retaining the raw tail for diagnosis. */
export async function writePartialRunBundle(
    artifacts: PiIntegrationTestArtifacts,
    runtime: PiIntegrationTestRuntimeArtifacts,
    cwd: string,
    options: PiIntegrationTestOptions,
    prompt: string,
    error: unknown,
    startedMonotonicMs: number,
): Promise<void>
{
    await copyFile(runtime.trace, path.join(artifacts.directory, "partial-trace.jsonl"));
    const traceEvents = await readTrace(runtime.trace, true);
    const snapshot = getSessionSnapshot(traceEvents);
    const terminalOutput = await readFile(runtime.terminalOutput, "utf8").catch(() => "");
    const tuiRenderedOutput = await readFile(artifacts.tuiRenderedOutput, "utf8").catch(() => "");
    await writeRunBundle(artifacts, runtime, cwd, options, prompt, {
        artifacts,
        traceEvents,
        providerRequests: traceEvents.filter((event) => event.type === "provider_request"),
        messages: snapshot?.messages ?? [],
        state: snapshot?.state,
        terminalOutput,
        tuiRenderedOutput,
        tuiSize: DEFAULT_TUI_SIZE,
        frameDelaysMs: [],
        exitCode: null,
    }, {
        status: isRunTimeout(error) ? "timeout" : "error",
        startedMonotonicMs,
        endedMonotonicMs: Number(process.hrtime.bigint()) / 1e6,
    });
}

export async function writeIntegrationTestError(
    artifacts: PiIntegrationTestArtifacts,
    error: unknown,
): Promise<void>
{
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await writeFile(artifacts.error, `${message}\n`, "utf8");
}

export async function removeIntegrationTestRuntimeArtifacts(
    runtime: PiIntegrationTestRuntimeArtifacts,
): Promise<void>
{
    await rm(runtime.directory, { recursive: true, force: true });
}

/**
 * Return a stable artifact group for an integration test source file.
 *
 * Pass `import.meta.filename` (or the test runner's equivalent). The source file must
 * be inside `process.cwd()` so the returned path cannot escape the artifact root.
 */
export function testArtifactsDir(
    testPath: string | undefined,
    root = path.join(process.cwd(), ".tmp", "test-runs"),
): string
{
    if (testPath === undefined)
    {
        throw new Error("Cannot determine the current integration test file");
    }

    const relativePath = path.relative(process.cwd(), path.resolve(testPath));

    if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath))
    {
        throw new Error(`Integration test file must be inside ${process.cwd()}: ${testPath}`);
    }

    return path.join(path.resolve(root), relativePath);
}

async function readSession(directory: string): Promise<string | undefined>
{
    const entries = await readdir(directory).catch(() => [] as string[]);
    const sessionFile = entries.find((entry) => entry.endsWith(".jsonl"));

    return sessionFile === undefined ? undefined : readFile(path.join(directory, sessionFile), "utf8");
}

function sanitizeTestName(value: string): string
{
    const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

    if (sanitized.length === 0 || sanitized === "." || sanitized === "..")
    {
        throw new Error(`Invalid integration test name: ${value}`);
    }

    return sanitized;
}

async function writeJson(file: string, value: unknown): Promise<void>
{
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
