import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { type IPty, spawn } from "node-pty";

import { createLiveTuiOutput } from "../terminal/live-output.js";
import { TuiRenderer } from "../terminal/renderer.js";
import { SynchronizedFrameExtractor } from "../terminal/synchronized-output.js";

import { DEFAULT_TUI_SIZE, HARNESS_CONFIG_ENVIRONMENT, HARNESS_TRACE_ENVIRONMENT } from "./constants.js";
import { createPiProcessArguments } from "./pi-process.js";
import { delay, readTrace, waitForAgentSettledTrace, waitForSettledTrace } from "./trace.js";

import type {
    PiIntegrationTestProviderMode,
    PiIntegrationTestThinkingLevel,
    TraceEvent,
    TuiSize,
} from "../scenario/types.js";

export interface InteractiveProcessOptions
{
    readonly cwd: string;
    readonly piCommand: string;
    readonly harnessExtension: string;
    readonly extensions: readonly string[];
    readonly skills?: readonly string[];
    readonly systemPrompt?: string;
    readonly appendSystemPrompt?: readonly string[];
    readonly model?: string;
    readonly sessionDir: string;
    readonly configPath: string;
    readonly tracePath: string;
    readonly tuiRenderedOutputPath: string;
    readonly terminalOutputPath: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly isolateUserResources: boolean;
    readonly prompt: string;
    readonly timeoutMs: number;
    readonly expectedProviderRequestCount: number;
    readonly providerMode: PiIntegrationTestProviderMode;
    readonly thinking?: PiIntegrationTestThinkingLevel;
}

export interface InteractiveProcessResult
{
    readonly frameDelaysMs: readonly number[];
    readonly terminalOutput: string;
    readonly tuiSize: TuiSize;
    readonly tuiRenderedOutput: string;
    readonly traceEvents: readonly TraceEvent[];
    readonly exitCode: number | null;
}

export async function runInteractiveProcess(options: InteractiveProcessOptions): Promise<InteractiveProcessResult>
{
    const pty = spawn(
        options.piCommand,
        createPiProcessArguments({
            extensions: options.extensions,
            harnessExtension: options.harnessExtension,
            isolateUserResources: options.isolateUserResources,
            ...(options.skills === undefined ? {} : { skills: options.skills }),
            ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
            ...(options.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: options.appendSystemPrompt }),
            ...(options.model === undefined ? {} : { model: options.model }),
            providerMode: options.providerMode,
            ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
            prompt: options.prompt,
            sessionDirectory: options.sessionDir,
        }),
        {
            cwd: options.cwd,
            ...DEFAULT_TUI_SIZE,
            name: "xterm-256color",
            env: {
                ...process.env,
                ...options.environment,
                [HARNESS_CONFIG_ENVIRONMENT]: options.configPath,
                [HARNESS_TRACE_ENVIRONMENT]: options.tracePath,
            },
            encoding: "utf8",
        },
    );
    const tuiRenderer = new TuiRenderer(DEFAULT_TUI_SIZE);
    const liveTuiOutput = createLiveTuiOutput();
    const frameExtractor = new SynchronizedFrameExtractor();
    const frameDelaysMs: number[] = [];
    let lastFrameAt: number | undefined;
    let terminalOutput = "";

    pty.onData((data) =>
    {
        terminalOutput += data;
        const frames = frameExtractor.write(data);

        if (frames.length > 0)
        {
            const now = performance.now();

            for (const _frame of frames)
            {
                frameDelaysMs.push(lastFrameAt === undefined ? 0 : Math.max(0, now - lastFrameAt));
                lastFrameAt = now;
            }
        }

        tuiRenderer.write(data);
        liveTuiOutput?.write(data);
    });

    const exit = waitForExit(pty);

    try
    {
        if (options.providerMode === "user")
        {
            await waitForAgentSettledTrace(options.tracePath, options.timeoutMs);
        }
        else
        {
            await waitForSettledTrace(
                options.tracePath,
                options.expectedProviderRequestCount,
                options.timeoutMs,
            );
        }

        await delay(50);
        pty.kill("SIGTERM");

        const exitCode = await exit;
        await liveTuiOutput?.flush();
        const tuiRenderedOutput = await writeTuiRenderedOutput(tuiRenderer, options.tuiRenderedOutputPath);
        await writeFile(options.terminalOutputPath, terminalOutput, "utf8");

        return {
            terminalOutput,
            frameDelaysMs,
            tuiRenderedOutput,
            tuiSize: DEFAULT_TUI_SIZE,
            traceEvents: await readTrace(options.tracePath),
            exitCode,
        };
    }
    catch (error)
    {
        pty.kill("SIGTERM");
        await exit.catch(() =>
        {});
        await liveTuiOutput?.flush().catch(() =>
        {});
        await writeFile(options.terminalOutputPath, terminalOutput, "utf8");
        await writeTuiRenderedOutput(tuiRenderer, options.tuiRenderedOutputPath).catch(() =>
        {});

        throw new Error(
            `Interactive Pi did not settle within ${options.timeoutMs}ms.\nTerminal output:\n${terminalOutput}\n${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
}

async function writeTuiRenderedOutput(renderer: TuiRenderer, outputPath: string): Promise<string>
{
    try
    {
        await renderer.flush();
        const renderedOutput = renderer.render();
        await writeFile(outputPath, renderedOutput, "utf8");
        return renderedOutput;
    }
    finally
    {
        renderer.dispose();
    }
}

function waitForExit(pty: IPty): Promise<number | null>
{
    return new Promise((resolve) =>
    {
        pty.onExit(({ exitCode }) =>
        {
            resolve(exitCode);
        });
    });
}
