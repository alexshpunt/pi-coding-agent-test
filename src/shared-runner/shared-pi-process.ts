import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { type IDisposable } from "node-pty";

import {
    DEFAULT_MODEL,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_TUI_SIZE,
    HARNESS_READY_ENVIRONMENT,
} from "../runtime/constants.js";
import { type OwnedPty, spawnOwnedPty } from "../runtime/owned-pty.js";
import { resolvePiCommand } from "../runtime/pi-command.js";
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
const harnessExtension = fileURLToPath(new URL(`../harness/extension.${runtimeExtension}`, import.meta.url));
const startupGate = fileURLToPath(new URL("../runtime/shared-pi-startup-gate.mjs", import.meta.url));
const commandGatePreload = new URL("../runtime/shared-pi-command-gate.mjs", import.meta.url).href;
const commandGateEnvironment = "PI_INTEGRATION_SHARED_COMMAND_GATE";
const gatePathEnvironment = "PI_INTEGRATION_SHARED_GATE_PATH";
const targetNodeOptionsEnvironment = "PI_INTEGRATION_SHARED_TARGET_NODE_OPTIONS";
const missingNodeOptions = "__pi_integration_shared_no_node_options__";
const gracefulTerminationMs = 250;
const forcedTerminationMs = 1_000;

class TimeoutError extends Error
{
    public constructor(message: string)
    {
        super(message);
        this.name = "TimeoutError";
    }
}

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

/**
 * Stable identity of one shared Pi process configuration.
 * Two requests with equal keys reuse the same pooled Pi process.
 */
export function sharedRunnerConfigKey(options: PiIntegrationTestOptions): string
{
    return stableStringify({
        appendSystemPrompt: options.appendSystemPrompt ?? [],
        environment: options.environment ?? {},
        extensions: options.extensions ?? [],
        model: options.model ?? DEFAULT_MODEL,
        piCommand: options.piCommand ?? "pi",
        skills: options.skills ?? [],
        systemPrompt: options.systemPrompt ?? null,
        thinking: options.thinking ?? null,
    });
}

function stableStringify(value: unknown): string
{
    const sortObjectKeys = (_key: string, entry: unknown): unknown =>
    {
        if (entry !== null && typeof entry === "object" && !Array.isArray(entry))
        {
            const record = entry as Record<string, unknown>;

            return Object.fromEntries(
                Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
            );
        }

        return entry;
    };

    return JSON.stringify(value, sortObjectKeys);
}

function errorMessage(error: unknown): string
{
    if (error instanceof AggregateError)
    {
        return `${error.message}; ${error.errors.map(errorMessage).join("; ")}`;
    }

    return error instanceof Error ? error.message : String(error);
}

function usesCommandGate(command: string): boolean
{
    return command === process.execPath
        || /(?:^|[\\/])(?:node|nodejs|pi)(?:\.exe|\.cmd)?$/iu.test(command)
        || /\.(?:cjs|js|mjs)$/iu.test(command);
}

async function terminateOwnedPty(pi: OwnedPty, exit: Promise<number>): Promise<void>
{
    if (process.platform === "win32")
    {
        await pi.dispose();
        return;
    }

    const cleanupErrors: unknown[] = [];
    const pid = pi.pid;
    let gracefulTimeoutError: unknown;

    try
    {
        pi.kill("SIGTERM");
    }
    catch (error)
    {
        cleanupErrors.push(error);
    }

    const gracefulErrorIndex = cleanupErrors.length;

    try
    {
        await withTimeout(exit, gracefulTerminationMs, `owned Pi PID ${pid} graceful termination`);
    }
    catch (error)
    {
        if (error instanceof TimeoutError)
        {
            gracefulTimeoutError = error;
        }
        else
        {
            cleanupErrors.push(error);
        }
    }

    if (gracefulTimeoutError !== undefined)
    {
        let forcedTerminationSucceeded = false;
        let forcedExitConfirmed = false;

        try
        {
            forceTerminateOwnedPty(pi, pid);
            forcedTerminationSucceeded = true;
        }
        catch (error)
        {
            cleanupErrors.push(error);
        }

        try
        {
            await withTimeout(exit, forcedTerminationMs, `owned Pi PID ${pid} forced termination`);
            forcedExitConfirmed = true;
        }
        catch (error)
        {
            cleanupErrors.push(error);
        }

        if (!forcedTerminationSucceeded || !forcedExitConfirmed)
        {
            cleanupErrors.splice(gracefulErrorIndex, 0, gracefulTimeoutError);
        }
    }

    if (cleanupErrors.length === 1)
    {
        throw cleanupErrors[0];
    }

    if (cleanupErrors.length > 1)
    {
        throw new AggregateError(cleanupErrors, `Owned Pi PID ${pid} termination failed`);
    }
}

function forceTerminateOwnedPty(pi: OwnedPty, pid: number): void
{
    try
    {
        process.kill(-pid, "SIGKILL");
    }
    catch (error)
    {
        const code = (error as NodeJS.ErrnoException).code;

        if (code !== "ESRCH")
        {
            throw error;
        }
    }

    try
    {
        pi.kill("SIGKILL");
    }
    catch (error)
    {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        {
            throw error;
        }
    }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T>
{
    let timer: NodeJS.Timeout | undefined;

    try
    {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) =>
            {
                timer = setTimeout(() =>
                {
                    reject(new TimeoutError(`${label} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
                timer.unref();
            }),
        ]);
    }
    finally
    {
        if (timer !== undefined)
        {
            clearTimeout(timer);
        }
    }
}

export class SharedPiProcess
{
    private liveTuiOutput: LiveTuiOutput | undefined;
    private pi: OwnedPty | undefined;
    private piExit: Promise<number> | undefined;
    private piExitSubscription: IDisposable | undefined;
    private processGeneration = 0;
    private piExited = false;
    private renderer: TuiRenderer | undefined;
    private sharedRoot: string | undefined;
    private terminalOutput = "";
    private frameExtractor: SynchronizedFrameExtractor | undefined;
    private frameTimestamps: number[] = [];
    private workspaceRoot: string | undefined;
    private closePromise: Promise<void> | undefined;

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

        let result: InteractiveProcessResult | undefined;
        let runError: unknown;
        let runFailed = false;

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

            result = {
                terminalOutput,
                frameDelaysMs,
                tuiSize: DEFAULT_TUI_SIZE,
                tuiRenderedOutput,
                traceEvents: await readTrace(request.runtime.trace),
                exitCode: null,
            };
        }
        catch (error)
        {
            runFailed = true;
            runError = error;
        }

        const cleanupErrors: unknown[] = [];

        try
        {
            await rm(requestFile, { force: true });
        }
        catch (error)
        {
            cleanupErrors.push(error);
        }

        try
        {
            await syncWorkspace(workspaceRoot, request.cwd, workspaceSnapshot);
        }
        catch (error)
        {
            cleanupErrors.push(error);
        }

        if (runFailed)
        {
            try
            {
                await this.close();
            }
            catch (error)
            {
                cleanupErrors.push(error);
            }
        }

        if (runFailed)
        {
            if (cleanupErrors.length === 0)
            {
                throw runError;
            }

            throw new AggregateError(
                [runError, ...cleanupErrors],
                `Shared Pi request failed; cleanup also failed: ${errorMessage(runError)}; ${
                    cleanupErrors
                        .map(errorMessage)
                        .join("; ")
                }`,
            );
        }

        if (cleanupErrors.length > 0)
        {
            if (cleanupErrors.length === 1)
            {
                throw cleanupErrors[0];
            }

            throw new AggregateError(cleanupErrors, "Shared Pi request cleanup failed");
        }

        return result!;
    }

    public close(): Promise<void>
    {
        if (this.closePromise !== undefined)
        {
            return this.closePromise;
        }

        const closePromise = this.closeProcess();
        const trackedClosePromise = closePromise.finally(() =>
        {
            if (this.closePromise === trackedClosePromise)
            {
                this.closePromise = undefined;
            }
        });
        this.closePromise = trackedClosePromise;
        return trackedClosePromise;
    }

    private async closeProcess(): Promise<void>
    {
        const pi = this.pi;
        const piExit = this.piExit;
        const cleanupErrors: unknown[] = [];

        this.pi = undefined;
        this.processGeneration += 1;

        if (pi !== undefined)
        {
            try
            {
                await terminateOwnedPty(pi, piExit ?? Promise.resolve(0));
            }
            catch (error)
            {
                cleanupErrors.push(error);
            }
        }

        try
        {
            await this.liveTuiOutput?.flush();
        }
        catch (error)
        {
            cleanupErrors.push(error);
        }

        try
        {
            this.renderer?.dispose();
        }
        catch (error)
        {
            cleanupErrors.push(error);
        }

        try
        {
            if (this.sharedRoot !== undefined)
            {
                await rm(this.sharedRoot, { recursive: true, force: true });
            }
        }
        catch (error)
        {
            cleanupErrors.push(error);
        }
        finally
        {
            if (this.piExited)
            {
                this.piExitSubscription?.dispose();
                this.piExitSubscription = undefined;
            }

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

        if (cleanupErrors.length === 1)
        {
            throw cleanupErrors[0];
        }

        if (cleanupErrors.length > 1)
        {
            throw new AggregateError(cleanupErrors, "Shared Pi process cleanup failed");
        }
    }

    private async ensureProcess(request: SharedRunRequest): Promise<void>
    {
        if (this.pi !== undefined)
        {
            if (!this.piExited)
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

        this.sharedRoot = root;
        this.workspaceRoot = workspaceRoot;

        try
        {
            await Promise.all([
                mkdir(sessionDirectory, { recursive: true }),
                mkdir(workspaceRoot, { recursive: true }),
            ]);
            const startupGatePath = path.join(root, "startup-gate");
            await writeFile(startupGatePath, "hold\n", "utf8");
            await writeFile(readyPath, "", "utf8");
            const generation = ++this.processGeneration;
            const piArguments = createPiProcessArguments({
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
            });
            const targetNodeOptions = configuration.environment.NODE_OPTIONS ?? process.env.NODE_OPTIONS;
            const nodeCommand = usesCommandGate(configuration.piCommand);
            const commandUsesGate = nodeCommand;
            const targetEnvironment = {
                ...process.env,
                ...configuration.environment,
                [HARNESS_READY_ENVIRONMENT]: readyPath,
            };
            const bootstrapEnvironment = {
                ...targetEnvironment,
                NODE_OPTIONS: undefined,
                [gatePathEnvironment]: startupGatePath,
                [targetNodeOptionsEnvironment]: targetNodeOptions ?? missingNodeOptions,
            };
            const directCommandEnvironment = {
                ...targetEnvironment,
                NODE_OPTIONS: `${targetNodeOptions === undefined ? "" : `${targetNodeOptions} `}--import=${
                    JSON.stringify(commandGatePreload)
                }`,
                [commandGateEnvironment]: commandGatePreload,
                [gatePathEnvironment]: startupGatePath,
                [targetNodeOptionsEnvironment]: targetNodeOptions ?? missingNodeOptions,
            };
            const spawnEnvironment = nodeCommand
                ? commandUsesGate ? directCommandEnvironment : targetEnvironment
                : bootstrapEnvironment;
            const launch = resolvePiCommand(
                nodeCommand ? configuration.piCommand : process.execPath,
                nodeCommand
                    ? piArguments
                    : [
                        startupGate,
                        startupGatePath,
                        JSON.stringify({ arguments: piArguments, command: configuration.piCommand }),
                    ],
                spawnEnvironment,
            );
            const pi = await spawnOwnedPty(
                launch.command,
                launch.arguments,
                {
                    cwd: workspaceRoot,
                    ...DEFAULT_TUI_SIZE,
                    name: "xterm-256color",
                    ...(process.platform === "win32" ? {} : { encoding: "utf8" }),
                    env: spawnEnvironment,
                },
                request.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            );

            // Register the exit listener before publishing the process. A replacement
            // can exit before the readiness file is written, so no event can be lost
            // between spawn and the readiness race below.
            this.piExit = new Promise((resolve) =>
            {
                const subscriptionHolder: { value?: IDisposable; } = {};
                const deliveryState = { delivered: false };
                let subscriptionDisposed = false;
                const disposeSubscription = (): void =>
                {
                    const subscription = subscriptionHolder.value;

                    if (subscription === undefined || subscriptionDisposed)
                    {
                        return;
                    }

                    const activeSubscription = subscription;
                    subscriptionDisposed = true;

                    try
                    {
                        activeSubscription.dispose();
                    }
                    catch
                    {
                        // Exit listeners are best-effort cleanup after the process has exited.
                    }
                    finally
                    {
                        if (this.piExitSubscription === activeSubscription)
                        {
                            this.piExitSubscription = undefined;
                        }
                    }
                };
                const returnedSubscription = pi.onExit(({ exitCode }) =>
                {
                    deliveryState.delivered = true;
                    resolve(exitCode);

                    if (this.pi === pi && this.processGeneration === generation)
                    {
                        this.piExited = true;
                    }

                    disposeSubscription();
                });
                subscriptionHolder.value = returnedSubscription;
                this.piExitSubscription = returnedSubscription;

                if (deliveryState.delivered)
                {
                    disposeSubscription();
                }
            });
            this.pi = pi;
            this.piExited = false;
            this.renderer = new TuiRenderer(DEFAULT_TUI_SIZE);
            this.liveTuiOutput = createLiveTuiOutput();
            this.frameExtractor = new SynchronizedFrameExtractor();
            this.frameTimestamps = [];
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

            // Release the bootstrap only after the PTY exit observer is installed.
            await rm(startupGatePath, { force: true });

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
            let cleanupError: unknown;

            try
            {
                await this.close();
            }
            catch (closeError)
            {
                cleanupError = closeError;
            }

            if (cleanupError !== undefined)
            {
                throw new AggregateError(
                    [error, cleanupError],
                    `Shared Pi initialization failed; cleanup also failed: ${errorMessage(error)}`,
                );
            }

            throw error;
        }
    }
}
