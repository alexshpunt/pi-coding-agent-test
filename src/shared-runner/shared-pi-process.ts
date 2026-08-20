import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { type IPty, spawn } from "node-pty";

import {
    DEFAULT_MODEL,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_TUI_SIZE,
    HARNESS_READY_ENVIRONMENT,
} from "../runtime/constants.js";
import { createPiProcessArguments } from "../runtime/pi-process.js";
import {
    copySessionFileFromTrace,
    delay,
    readTrace,
    waitForNonEmptyFile,
    waitForSettledTrace,
} from "../runtime/trace.js";
import { createLiveTuiOutput, type LiveTuiOutput } from "../terminal/live-output.js";
import { TuiRenderer } from "../terminal/renderer.js";
import { SynchronizedFrameExtractor } from "../terminal/synchronized-output.js";

import { stageWorkspace, syncWorkspace } from "./workspace.js";

import type { SharedRequestFile, SharedRunRequest } from "./protocol.js";
import type { InteractiveProcessResult } from "../runtime/interactive-process.js";
import type { PiIntegrationTestOptions } from "../scenario/types.js";

const runtimeExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const harnessExtension = new URL(`../harness/extension.${runtimeExtension}`, import.meta.url).pathname;

interface ActiveConfiguration
{
    readonly extensions: readonly string[];
    readonly skills: readonly string[];
    readonly systemPrompt: string | undefined;
    readonly appendSystemPrompt: readonly string[];
    readonly thinking: PiIntegrationTestOptions["thinking"];
    readonly piCommand: string;
    readonly model: string;
    readonly environment: NodeJS.ProcessEnv;
}

export class SharedPiProcess
{
    private activeConfiguration: ActiveConfiguration | undefined;
    private liveTuiOutput: LiveTuiOutput | undefined;
    private pi: IPty | undefined;
    private piExit: Promise<number> | undefined;
    private piExited = false;
    private renderer: TuiRenderer | undefined;
    private sharedRoot: string | undefined;
    private terminalOutput = "";
    private frameExtractor: SynchronizedFrameExtractor | undefined;
    private frameTimestamps: number[] = [];
    private workspaceRoot: string | undefined;

    public cancelLiveOutput(): void
    {
        this.liveTuiOutput?.cancel();
    }

    public async run(request: SharedRunRequest): Promise<InteractiveProcessResult>
    {
        await this.ensureProcess(request);

        const workspaceRoot = this.workspaceRoot;
        const renderer = this.renderer;

        if (
            this.pi === undefined || workspaceRoot === undefined || renderer === undefined
        )
        {
            throw new Error("Shared Pi runner is not initialized");
        }

        const workspaceSnapshot = await stageWorkspace(request.cwd, workspaceRoot);

        const terminalOffset = this.terminalOutput.length;
        const frameTimestampOffset = this.frameTimestamps.length;
        const runStartedAt = performance.now();

        const requestFile = path.join(workspaceRoot, `.pi-integration-request-${request.requestId}.json`);
        const requestData: SharedRequestFile = {
            prompt: request.prompt,
            configPath: request.runtime.config,
            tracePath: request.runtime.trace,
        };

        await writeFile(requestFile, `${JSON.stringify(requestData)}\n`, "utf8");

        try
        {
            this.pi.write(`/pi-integration-test ${requestFile}\r`);
            await waitForSettledTrace(
                request.runtime.trace,
                request.options.conversation?.length ?? 0,
                request.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            );
            await delay(50);
            await this.liveTuiOutput?.flush();
            await renderer.flush();

            const terminalOutput = this.terminalOutput.slice(terminalOffset);
            const tuiRenderedOutput = renderer.render();
            const frameTimestamps = this.frameTimestamps.slice(frameTimestampOffset);
            const frameDelaysMs = frameTimestamps.map((timestamp, index) =>
                Math.max(0, timestamp - (index === 0 ? runStartedAt : frameTimestamps[index - 1]!))
            );

            await Promise.all([
                writeFile(request.runtime.tuiRenderedOutput, tuiRenderedOutput, "utf8"),
                writeFile(request.runtime.terminalOutput, terminalOutput, "utf8"),
            ]);
            await copySessionFileFromTrace(request.runtime, request.runtime.trace);

            return {
                terminalOutput,
                frameDelaysMs,
                tuiSize: DEFAULT_TUI_SIZE,
                tuiRenderedOutput,
                traceEvents: await readTrace(request.runtime.trace),
                exitCode: null,
            };
        }
        finally
        {
            await rm(requestFile, { force: true });
            await syncWorkspace(workspaceRoot, request.cwd, workspaceSnapshot);
        }
    }

    public async close(): Promise<void>
    {
        const pi = this.pi;
        const piExit = this.piExit;

        this.pi = undefined;

        if (pi !== undefined && !this.piExited)
        {
            try
            {
                pi.kill("SIGTERM");
            }
            catch
            {
                // The child may have exited between the state check and the signal.
            }
        }

        await piExit;
        await this.liveTuiOutput?.flush();
        this.renderer?.dispose();

        if (this.sharedRoot !== undefined)
        {
            await rm(this.sharedRoot, { recursive: true, force: true });
        }

        this.activeConfiguration = undefined;
        this.liveTuiOutput = undefined;
        this.piExit = undefined;
        this.piExited = false;
        this.renderer = undefined;
        this.sharedRoot = undefined;
        this.terminalOutput = "";
        this.frameExtractor = undefined;
        this.frameTimestamps = [];
        this.workspaceRoot = undefined;
    }

    private async ensureProcess(request: SharedRunRequest): Promise<void>
    {
        if (this.pi !== undefined)
        {
            if (this.matchesConfiguration(request.options))
            {
                return;
            }

            await this.close();
        }

        const root = path.join(
            process.cwd(),
            ".tmp",
            `pi-integration-shared-${process.pid}-${randomBytes(6).toString("hex")}`,
        );
        const workspaceRoot = path.join(root, "workspace");
        const sessionDirectory = path.join(root, "session");
        const readyPath = path.join(root, "ready.json");
        const configuration: ActiveConfiguration = {
            extensions: request.options.extensions ?? [],
            skills: request.options.skills ?? [],
            systemPrompt: request.options.systemPrompt,
            appendSystemPrompt: request.options.appendSystemPrompt ?? [],
            thinking: request.options.thinking,
            piCommand: request.options.piCommand ?? "pi",
            model: request.options.model ?? DEFAULT_MODEL,
            environment: request.options.environment ?? {},
        };

        this.activeConfiguration = configuration;
        this.sharedRoot = root;
        this.workspaceRoot = workspaceRoot;

        await Promise.all([
            mkdir(sessionDirectory, { recursive: true }),
            mkdir(workspaceRoot, { recursive: true }),
        ]);
        await writeFile(readyPath, "", "utf8");

        try
        {
            const pi = spawn(
                configuration.piCommand,
                createPiProcessArguments({
                    extensions: configuration.extensions,
                    skills: configuration.skills,
                    ...(configuration.systemPrompt === undefined ? {} : { systemPrompt: configuration.systemPrompt }),
                    appendSystemPrompt: configuration.appendSystemPrompt,
                    harnessExtension,
                    isolateUserResources: false,
                    model: configuration.model,
                    providerMode: "scripted",
                    ...(configuration.thinking === undefined ? {} : { thinking: configuration.thinking }),
                    sessionDirectory,
                }),
                {
                    cwd: workspaceRoot,
                    ...DEFAULT_TUI_SIZE,
                    name: "xterm-256color",
                    encoding: "utf8",
                    env: {
                        ...process.env,
                        ...configuration.environment,
                        [HARNESS_READY_ENVIRONMENT]: readyPath,
                    },
                },
            );

            this.pi = pi;
            this.piExited = false;
            this.renderer = new TuiRenderer(DEFAULT_TUI_SIZE);
            this.liveTuiOutput = createLiveTuiOutput();
            this.frameExtractor = new SynchronizedFrameExtractor();
            this.frameTimestamps = [];
            this.piExit = new Promise((resolve) =>
            {
                pi.onExit(({ exitCode }) =>
                {
                    this.piExited = true;
                    resolve(exitCode);
                });
            });
            pi.onData((data) =>
            {
                this.terminalOutput += data;
                const frames = this.frameExtractor?.write(data) ?? [];

                if (frames.length > 0)
                {
                    const timestamp = performance.now();
                    this.frameTimestamps.push(...frames.map(() => timestamp));
                }

                this.renderer?.write(data);
                this.liveTuiOutput?.write(data);
            });

            await Promise.race([
                waitForNonEmptyFile(readyPath, request.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
                this.piExit.then((exitCode) =>
                {
                    throw new Error(`Shared Pi exited before becoming ready with code ${exitCode}`);
                }),
            ]);
        }
        catch (error)
        {
            await this.close();
            throw error;
        }
    }

    private matchesConfiguration(options: PiIntegrationTestOptions): boolean
    {
        const active = this.activeConfiguration;

        return active !== undefined
            && JSON.stringify(options.extensions ?? []) === JSON.stringify(active.extensions)
            && JSON.stringify(options.skills ?? []) === JSON.stringify(active.skills)
            && options.systemPrompt === active.systemPrompt
            && JSON.stringify(options.appendSystemPrompt ?? []) === JSON.stringify(active.appendSystemPrompt)
            && (options.piCommand ?? "pi") === active.piCommand
            && (options.model ?? DEFAULT_MODEL) === active.model
            && options.thinking === active.thinking
            && JSON.stringify(options.environment ?? {}) === JSON.stringify(active.environment);
    }
}
