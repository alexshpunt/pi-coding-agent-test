import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";

import {
    HARNESS_CONFIG_ENVIRONMENT,
    HARNESS_READY_ENVIRONMENT,
    HARNESS_TRACE_ENVIRONMENT,
    LIVE_MODE_ENVIRONMENT,
    RAW_TOOL_OUTPUT_ENVIRONMENT,
    RAW_TOOL_OUTPUT_READY_ENVIRONMENT,
} from "../runtime/constants.js";

import { streamScenario } from "./message-stream.js";

import type { PiIntegrationTestOptions, TraceEvent } from "../scenario/types.js";
import type { SharedRequestFile } from "../shared-runner/protocol.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface HarnessConfig
{
    conversation: readonly NonNullable<PiIntegrationTestOptions["conversation"]>[number][];
    providerMode: NonNullable<PiIntegrationTestOptions["providerMode"]>;
    tools?: PiIntegrationTestOptions["tools"];
    traceToolDetails?: boolean;
}

const configPath = process.env[HARNESS_CONFIG_ENVIRONMENT];
const tracePath = process.env[HARNESS_TRACE_ENVIRONMENT];
const readyPath = process.env[HARNESS_READY_ENVIRONMENT];
let config = configPath === undefined ? undefined : JSON.parse(readFileSync(configPath, "utf8")) as HarnessConfig;
let traceFile = tracePath;
let readyWritten = false;
let sequence = 0;
let providerRequest = 0;
let activeCwd: string | undefined;

function trace(type: string, value: Record<string, unknown> = {}): void
{
    if (traceFile === undefined)
    {
        return;
    }

    const event: TraceEvent = {
        type,
        sequence: sequence++,
        timestamp: Date.now(),
        monotonicMs: Number(process.hrtime.bigint()) / 1e6,
        ...value,
    };
    const replacer = config?.traceToolDetails === false ? withoutToolDetails : undefined;
    appendFileSync(traceFile, JSON.stringify(event, replacer) + "\n", "utf8");
}

/** Drop `details` from tool results and tool result messages, which carry it next to `content` or `toolCallId`. */
function withoutToolDetails(this: unknown, key: string, value: unknown): unknown
{
    if (
        key === "details" && typeof this === "object" && this !== null
        && (Array.isArray((this as { content?: unknown; }).content) || "toolCallId" in this)
    )
    {
        return undefined;
    }

    return value;
}

function tracePiEvent(type: string, event: unknown): void
{
    trace(type, { event });
}

function isToolSelectionObject(
    value: PiIntegrationTestOptions["tools"],
): value is { include?: readonly string[]; exclude?: readonly string[]; }
{
    return typeof value === "object" && !Array.isArray(value);
}

function isToolNameArray(value: PiIntegrationTestOptions["tools"]): value is readonly string[]
{
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function getMessages(branch: readonly unknown[]): unknown[]
{
    return branch.flatMap((entry) =>
    {
        if (typeof entry !== "object" || entry === null || (entry as { type?: unknown; }).type !== "message")
        {
            return [];
        }

        return [(entry as { message: unknown; }).message];
    });
}

function createWorkspaceSession(ctx: ExtensionCommandContext, file: string, cwd: string): void
{
    const header = ctx.sessionManager.getHeader();

    if (header === null)
    {
        throw new Error("Cannot create a scenario session without a session header");
    }

    // A header-only session gives Pi the cwd without carrying previous session entries.
    writeFileSync(
        file,
        JSON.stringify({
            type: header.type,
            version: header.version,
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            cwd,
        }) + "\n",
        { flag: "wx" },
    );
}

export default function registerHarness(pi: ExtensionAPI): void
{
    if (
        process.env[RAW_TOOL_OUTPUT_ENVIRONMENT] === "1"
        && process.env[RAW_TOOL_OUTPUT_READY_ENVIRONMENT] !== "1"
    )
    {
        throw new Error("Raw tool output preload did not initialize in the Pi process");
    }

    pi.on("session_start", (_event, ctx) =>
    {
        ctx.ui.setToolsExpanded(process.env[LIVE_MODE_ENVIRONMENT] !== "1");

        const selection = config?.tools;

        if (selection === undefined)
        {
            if (readyPath !== undefined && !readyWritten)
            {
                appendFileSync(readyPath, `${JSON.stringify({ readyAt: Date.now() })}\n`, "utf8");
                readyWritten = true;
            }

            return;
        }

        const allTools = (pi.getAllTools() as { name: string; }[]).map((tool) => tool.name);
        const sessionTools = pi.getActiveTools();

        const objectSelection = isToolSelectionObject(selection) ? selection : undefined;
        const includedTools = objectSelection?.include;
        const activeTools = selection === "all"
            ? sessionTools
            : isToolNameArray(selection)
            ? [...selection]
            : includedTools === undefined
            ? sessionTools
            : allTools.filter((name) => includedTools.includes(name));
        const excludedTools = objectSelection?.exclude;
        const filteredTools = excludedTools === undefined
            ? activeTools
            : activeTools.filter((name) => !excludedTools.includes(name));
        pi.setActiveTools(filteredTools);
        trace("tools_configured", { activeTools: filteredTools });
    });

    pi.on("tool_call", (event) =>
    {
        tracePiEvent("tool_call", event);
    });

    pi.on("tool_result", (event) =>
    {
        tracePiEvent("tool_result", event);
    });

    pi.on("tool_execution_start", (event) =>
    {
        tracePiEvent("tool_execution_start", event);

        if (activeCwd !== undefined && process.cwd() !== activeCwd)
        {
            process.chdir(activeCwd);
        }
    });

    pi.on("tool_execution_update", (event) =>
    {
        tracePiEvent("tool_execution_update", event);
    });

    pi.on("tool_execution_end", (event) =>
    {
        tracePiEvent("tool_execution_end", event);
    });

    pi.on("message_update", (event) =>
    {
        tracePiEvent("message_update", event);
    });

    pi.on("message_start", (event) =>
    {
        tracePiEvent("message_start", event);
    });

    pi.on("message_end", (event) =>
    {
        tracePiEvent("message_end", event);
    });

    pi.on("turn_start", (event) =>
    {
        tracePiEvent("turn_start", event);
    });

    pi.on("turn_end", (event) =>
    {
        tracePiEvent("turn_end", event);
    });

    pi.on("agent_start", (event, ctx) =>
    {
        trace("agent_start", { event, systemPrompt: ctx.getSystemPrompt(), activeTools: pi.getActiveTools() });
    });

    pi.on("agent_end", (event) =>
    {
        tracePiEvent("agent_end", event);
    });

    pi.on("agent_settled", (_event, ctx) =>
    {
        try
        {
            const branch = ctx.sessionManager.getBranch();
            const contextEntries = ctx.sessionManager.buildContextEntries();
            const messages = getMessages(branch);
            const model = ctx.model === undefined
                ? undefined
                : { provider: ctx.model.provider, id: ctx.model.id };
            const state = {
                mode: ctx.mode,
                cwd: ctx.cwd,
                isIdle: ctx.isIdle(),
                hasPendingMessages: ctx.hasPendingMessages(),
                sessionId: ctx.sessionManager.getSessionId(),
                sessionFile: ctx.sessionManager.getSessionFile(),
                leafId: ctx.sessionManager.getLeafId(),
                model,
                thinkingLevel: pi.getThinkingLevel(),
                contextUsage: ctx.getContextUsage(),
            };
            trace("session_snapshot", { branch, contextEntries, messages, state });
        }
        catch (error)
        {
            trace("session_snapshot_error", {
                error: error instanceof Error ? error.message : String(error),
            });
        }

        tracePiEvent("agent_settled", _event);
    });

    pi.registerCommand("pi-integration-test", {
        description: "Run one integration scenario in a fresh Pi session",
        handler: async (args, ctx) =>
        {
            const requestPath = args.trim();
            const request = JSON.parse(readFileSync(requestPath, "utf8")) as SharedRequestFile;
            config = JSON.parse(readFileSync(request.configPath, "utf8")) as HarnessConfig;
            traceFile = request.tracePath;
            sequence = 0;
            providerRequest = 0;

            createWorkspaceSession(ctx, request.sessionPath, request.cwd);

            await ctx.switchSession(request.sessionPath, {
                withSession: async (newContext) =>
                {
                    activeCwd = newContext.cwd;

                    if (process.cwd() !== activeCwd)
                    {
                        process.chdir(activeCwd);
                    }

                    await newContext.sendUserMessage(request.prompt);
                },
            });
        },
    });

    pi.registerCommand("pi-integration-test-finish", {
        description: "Finish a shared scenario before synchronizing its workspace",
        handler: async (args, ctx) =>
        {
            const requestPath = args.trim();
            const request = JSON.parse(readFileSync(requestPath, "utf8")) as SharedRequestFile;
            const idleSession = `${request.sessionPath}.idle`;
            createWorkspaceSession(ctx, idleSession, request.idleCwd);
            await ctx.switchSession(idleSession, {
                withSession: (idleContext) =>
                {
                    activeCwd = idleContext.cwd;
                    process.chdir(activeCwd);
                    appendFileSync(`${requestPath}.finished`, "finished\n", "utf8");

                    return Promise.resolve();
                },
            });
        },
    });

    pi.registerProvider("scripted", {
        name: "Scripted integration-test provider",
        baseUrl: "http://pi-coding-agent-test.invalid",
        apiKey: "poc",
        api: "openai-completions",
        models: [{
            id: "scripted-model",
            name: "Scripted integration-test model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
        }],
        streamSimple: (model, context, options) =>
        {
            const request = providerRequest;
            const scenario = config?.conversation[request];

            if (!options?.signal?.aborted)
            {
                providerRequest += 1;
            }

            trace("provider_request", {
                request,
                messageCount: context.messages.length,
                messages: context.messages,
                systemPrompt: getCurrentSystemPrompt(context.messages),
            });

            if (!scenario)
            {
                throw new Error(`No scripted response for provider request ${request}`);
            }

            return streamScenario(model, context, scenario, options);
        },
    });
}
