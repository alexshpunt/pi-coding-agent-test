import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { createLiveTuiOutput } from "../terminal/live-output.js";
import { TuiRenderer } from "../terminal/renderer.js";
import { SynchronizedFrameExtractor } from "../terminal/synchronized-output.js";

import { DEFAULT_TUI_SIZE, HARNESS_CONFIG_ENVIRONMENT, HARNESS_TRACE_ENVIRONMENT } from "./constants.js";
import { spawnOwnedPty } from "./owned-pty.js";
import { resolvePiCommand } from "./pi-command.js";
import { createPiProcessArguments } from "./pi-process.js";
import { delay, readTrace, waitForAgentSettledTrace, waitForSettledTrace } from "./trace.js";

import type {
    PiIntegrationTestProviderMode,
    PiIntegrationTestThinkingLevel,
    TraceEvent,
    TuiSize,
} from "../scenario/types.js";
import type { IPty } from "node-pty";

export interface InteractiveProcessOptions
{
    readonly tuiSize?: TuiSize;
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
    const tuiSize = options.tuiSize ?? DEFAULT_TUI_SIZE;
    const launch = resolvePiCommand(
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
        { ...process.env, ...options.environment },
    );
    const pty = await spawnOwnedPty(
        launch.command,
        launch.arguments,
        {
            cwd: options.cwd,
            ...tuiSize,
            name: "xterm-256color",
            env: {
                ...process.env,
                ...options.environment,
                [HARNESS_CONFIG_ENVIRONMENT]: options.configPath,
                [HARNESS_TRACE_ENVIRONMENT]: options.tracePath,
            },
            ...(process.platform === "win32" ? {} : { encoding: "utf8" }),
        },
        options.timeoutMs,
    );
    const tuiRenderer = new TuiRenderer(tuiSize);
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
        await Promise.race([
            options.providerMode === "user"
                ? waitForAgentSettledTrace(options.tracePath, options.timeoutMs)
                : waitForSettledTrace(options.tracePath, options.expectedProviderRequestCount, options.timeoutMs),
            exit.then((code) =>
            {
                throw new Error(`Interactive Pi exited before settling with code ${code}`);
            }),
        ]);

        await delay(50);
        stopPty(pty);

        await pty.dispose();
        const exitCode = await exit;
        await liveTuiOutput?.flush();
        const tuiRenderedOutput = await writeTuiRenderedOutput(tuiRenderer, options.tuiRenderedOutputPath);
        await writeFile(options.terminalOutputPath, terminalOutput, "utf8");

        return {
            terminalOutput,
            frameDelaysMs,
            tuiRenderedOutput,
            tuiSize,
            traceEvents: await readTrace(options.tracePath),
            exitCode,
        };
    }
    catch (error)
    {
        stopPty(pty);
        await pty.dispose();
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
            { cause: error },
        );
    }
}

export function stopPty(pty: Pick<IPty, "kill">, platform: NodeJS.Platform = process.platform): void
{
    if (platform === "win32")
    {
        pty.kill();
        return;
    }

    pty.kill("SIGTERM");
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

function waitForExit(pty: Pick<IPty, "onExit">): Promise<number | null>
{
    return new Promise((resolve) =>
    {
        pty.onExit(({ exitCode }) =>
        {
            resolve(exitCode);
        });
    });
}
