import { access, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withInteractivePacing } from "../live/pacing.js";
import { getSharedRunnerEndpoint, runSharedIntegrationProcess } from "../shared-runner/client.js";

import {
    createIntegrationTestArtifacts,
    createIntegrationTestRuntimeArtifacts,
    prepareIntegrationTestArtifacts,
    removeIntegrationTestRuntimeArtifacts,
    writeIntegrationTestError,
    writePartialRunBundle,
    writeRunBundle,
} from "./artifacts.js";
import {
    DEFAULT_MODEL,
    DEFAULT_TIMEOUT_MS,
    RAW_TOOL_OUTPUT_ENVIRONMENT,
    RAW_TOOL_OUTPUT_READY_ENVIRONMENT,
} from "./constants.js";
import { runRpcProcess } from "./rpc-process.js";
import { PiRun } from "./run.js";
import { getSessionSnapshot } from "./trace.js";

import type { PiIntegrationTestOptions, PiIntegrationTestResult } from "../scenario/types.js";

const runtimeExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const harnessExtension = fileURLToPath(new URL(`../harness/extension.${runtimeExtension}`, import.meta.url));
const rawToolOutputPreload = new URL("../harness/raw-tool-output-preload.mjs", import.meta.url).href;

/**
 * Runs one scenario through a real Pi process using TUI (default) or RPC pipes.
 *
 * @example
 * ```ts
 * const run = await new PiIntegrationTest({
 *     testName: "read-file",
 *     cwd: workspace,
 *     tools: ["read"],
 *     conversation: [
 *         assistantMessage([toolCall({ id: "read-1", name: "read", arguments: { path: "README.md" } })], { stopReason: "toolUse" }),
 *         assistantMessage([text("Done")]),
 *     ],
 * }).run("Read README.md");
 * ```
 */
export class PiIntegrationTest
{
    /** Store a scenario configuration for a later call to {@link run}. */
    public constructor(private readonly options: PiIntegrationTestOptions)
    {
    }

    /**
     * Send the initial user prompt to Pi and wait until the real agent settles.
     *
     * The run recreates its stable artifact directory and throws after writing `error.log`
     * when Pi cannot start, the scripted conversation is exhausted, or the timeout expires.
     * Failed runs also retain a partial `run.jsonl` and the raw trace. Its summary marks
     * `status: timeout | error` and `partial: true`; it is never a successful settlement.
     * If bundling fails, the raw runtime directory is kept instead of deleting evidence.
     */
    public async run(prompt: string): Promise<PiRun>
    {
        const startedMonotonicMs = Number(process.hrtime.bigint()) / 1e6;
        let bundleWritten = false;
        const cwd = this.options.cwd ?? process.cwd();
        const providerMode = this.options.providerMode ?? "scripted";
        const conversation = this.options.conversation ?? [];

        if (providerMode === "scripted" && this.options.conversation === undefined)
        {
            throw new Error("Scripted integration tests require a conversation");
        }

        const interactiveOptions = providerMode === "scripted" && this.options.transport !== "rpc"
            ? withInteractivePacing(this.options)
            : this.options;
        const rawMode = this.options.transport !== "rpc"
            && (interactiveOptions.rawMode ?? providerMode === "scripted");
        const runtimeOptions: PiIntegrationTestOptions = {
            ...interactiveOptions,
            conversation,
            providerMode,
            rawMode,
            environment: {
                ...interactiveOptions.environment,
                NODE_OPTIONS: appendNodeImport(
                    interactiveOptions.environment?.NODE_OPTIONS ?? process.env.NODE_OPTIONS,
                ),
                [RAW_TOOL_OUTPUT_ENVIRONMENT]: rawMode ? "1" : "0",
                [RAW_TOOL_OUTPUT_READY_ENVIRONMENT]: "0",
            },
        };
        const artifacts = createIntegrationTestArtifacts(this.options);
        const runtime = createIntegrationTestRuntimeArtifacts(artifacts);
        const useStandaloneRunner = this.options.tuiSize !== undefined
            || this.options.transport === "rpc"
            || providerMode === "user"
            || getSharedRunnerEndpoint() === undefined
            || isSameOrDescendant(cwd, artifacts.directory);
        await prepareIntegrationTestArtifacts({ artifacts, runtime, options: runtimeOptions });

        let isolatedAgentDirectory: string | undefined;

        try
        {
            isolatedAgentDirectory = runtimeOptions.isolateUserResources === true
                ? await createIsolatedAgentDirectory(runtimeOptions.environment?.PI_CODING_AGENT_DIR)
                : undefined;
            const processOptions: PiIntegrationTestOptions = isolatedAgentDirectory === undefined
                ? runtimeOptions
                : {
                    ...runtimeOptions,
                    environment: {
                        ...runtimeOptions.environment,
                        PI_CODING_AGENT_DIR: isolatedAgentDirectory,
                    },
                };
            let runStandalone = runRpcProcess;

            if (useStandaloneRunner && processOptions.transport !== "rpc")
            {
                const { runInteractiveProcess } = await import("./interactive-process.js");
                runStandalone = runInteractiveProcess;
            }

            const processResult = useStandaloneRunner
                ? await runStandalone({
                    cwd,
                    piCommand: processOptions.piCommand ?? "pi",
                    ...(processOptions.tuiSize === undefined ? {} : { tuiSize: processOptions.tuiSize }),
                    harnessExtension,
                    extensions: processOptions.extensions ?? [],
                    ...(processOptions.skills === undefined ? {} : { skills: processOptions.skills }),
                    ...(processOptions.systemPrompt === undefined
                        ? {}
                        : { systemPrompt: processOptions.systemPrompt }),
                    ...(processOptions.appendSystemPrompt === undefined
                        ? {}
                        : { appendSystemPrompt: processOptions.appendSystemPrompt }),
                    isolateUserResources: processOptions.isolateUserResources ?? false,
                    ...(processOptions.model === undefined
                        ? (providerMode === "scripted" ? { model: DEFAULT_MODEL } : {})
                        : { model: processOptions.model }),
                    providerMode,
                    ...(processOptions.thinking === undefined ? {} : { thinking: processOptions.thinking }),
                    sessionDir: runtime.sessionDirectory,
                    configPath: runtime.config,
                    tracePath: runtime.trace,
                    tuiRenderedOutputPath: artifacts.tuiRenderedOutput,
                    terminalOutputPath: runtime.terminalOutput,
                    ...(processOptions.environment === undefined
                        ? {}
                        : { environment: processOptions.environment }),
                    prompt,
                    timeoutMs: processOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                    expectedProviderRequestCount: conversation.length,
                })
                : await runSharedIntegrationProcess({
                    cwd,
                    runtime,
                    options: processOptions,
                    prompt,
                });
            const traceEvents = processResult.traceEvents;
            const snapshot = getSessionSnapshot(traceEvents);
            const result: PiIntegrationTestResult = {
                artifacts,
                frameDelaysMs: processResult.frameDelaysMs,
                tuiRenderedOutput: processResult.tuiRenderedOutput,
                tuiSize: processResult.tuiSize,
                terminalOutput: processResult.terminalOutput,
                traceEvents,
                providerRequests: traceEvents.filter((event) => event.type === "provider_request"),
                messages: snapshot?.messages ?? [],
                state: snapshot?.state,
                exitCode: processResult.exitCode,
            };

            await writeRunBundle(artifacts, runtime, cwd, runtimeOptions, prompt, result, {
                status: "settled",
                startedMonotonicMs,
                endedMonotonicMs: Number(process.hrtime.bigint()) / 1e6,
            });
            bundleWritten = true;
            return PiRun.fromResult(result);
        }
        catch (error)
        {
            await writeIntegrationTestError(artifacts, error);

            try
            {
                await writePartialRunBundle(artifacts, runtime, cwd, runtimeOptions, prompt, error, startedMonotonicMs);
                bundleWritten = true;
            }
            catch (artifactError)
            {
                throw new AggregateError(
                    [error, artifactError],
                    "Pi failed; raw runtime artifacts retained because bundling failed",
                );
            }

            throw error;
        }
        finally
        {
            if (isolatedAgentDirectory !== undefined)
            {
                await rm(isolatedAgentDirectory, { recursive: true, force: true });
            }

            if (bundleWritten)
            {
                await removeIntegrationTestRuntimeArtifacts(runtime);
            }
        }
    }
}

async function createIsolatedAgentDirectory(configuredSourceDirectory?: string): Promise<string>
{
    const directory = await mkdtemp(path.join(tmpdir(), "pi-integration-agent-"));
    const sourceDirectory = configuredSourceDirectory
        ?? process.env.PI_CODING_AGENT_DIR
        ?? path.join(homedir(), ".pi", "agent");

    try
    {
        for (const name of ["auth.json", "models.json", "models-store.json"])
        {
            const source = path.join(sourceDirectory, name);

            try
            {
                await access(source);
                await symlink(source, path.join(directory, name), "file");
            }
            catch (error)
            {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                {
                    throw error;
                }
            }
        }

        return directory;
    }
    catch (error)
    {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
}

function isSameOrDescendant(parent: string, candidate: string): boolean
{
    const relativePath = path.relative(path.resolve(parent), path.resolve(candidate));
    return relativePath === ""
        || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

function appendNodeImport(nodeOptions: string | undefined): string
{
    const preloadOption = `--import=${rawToolOutputPreload}`;

    if (nodeOptions?.includes(preloadOption) === true)
    {
        return nodeOptions;
    }

    return nodeOptions === undefined || nodeOptions.length === 0
        ? preloadOption
        : `${nodeOptions} ${preloadOption}`;
}
