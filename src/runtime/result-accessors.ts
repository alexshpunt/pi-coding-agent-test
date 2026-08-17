import { contentText, type ToolResultMessage } from "@earendil-works/pi-ai";

import type { PiIntegrationTestResult, TraceEvent } from "../scenario/types.js";

/** Minimal result fields accepted by the public assertion helpers. */
export type PiIntegrationTestInspection = Pick<
    PiIntegrationTestResult,
    "messages" | "providerRequests" | "traceEvents"
>;

/** Final `tool_execution_end` data selected from the ordered harness trace. */
export interface ToolExecutionTrace
{
    /** Whether Pi finalized the execution as an error. */
    readonly isError?: boolean;

    /** Real tool result recorded by Pi. */
    readonly result?: unknown;

    /** Stable tool-call identifier. */
    readonly toolCallId: string;

    /** Registered tool name, when present in the event. */
    readonly toolName?: string;

    /** Additional event fields added by compatible Pi versions. */
    readonly [key: string]: unknown;
}

/** Return tool names in the order Pi emitted `tool_call` events. */
export function getToolCallNames(result: PiIntegrationTestInspection): readonly string[]
{
    return result.traceEvents.flatMap((event) =>
    {
        const payload = event.event;
        return event.type === "tool_call"
                && isRecord(payload)
                && typeof payload.toolName === "string"
            ? [payload.toolName]
            : [];
    });
}

/** Return the latest real tool-result message, optionally restricted to one call ID. */
export function getToolResultMessage<TDetails = unknown>(
    result: PiIntegrationTestInspection,
    toolCallId?: string,
): ToolResultMessage<TDetails>
{
    const message = result.messages.toReversed().find((value) =>
        isToolResultMessage(value)
        && (toolCallId === undefined || value.toolCallId === toolCallId)
    );

    if (message === undefined)
    {
        const suffix = toolCallId === undefined ? "" : ` for ${toolCallId}`;
        throw new TypeError(`The integration run did not produce a tool result${suffix}`);
    }

    return message as ToolResultMessage<TDetails>;
}

/** Flatten text content from the latest matching real tool-result message. */
export function getToolResultText(result: PiIntegrationTestInspection, toolCallId?: string): string
{
    return contentText(getToolResultMessage(result, toolCallId).content);
}

/** Return the system prompt captured before the first real provider request. */
export function getProviderSystemPrompt(result: PiIntegrationTestInspection, requestIndex = 0): string
{
    const prompt = result.providerRequests.at(requestIndex)?.systemPrompt;

    if (typeof prompt !== "string")
    {
        throw new TypeError(`Provider request ${requestIndex} did not expose its system prompt`);
    }

    return prompt;
}

/** Return every finalized tool execution in trace order. */
export function getToolExecutions(result: PiIntegrationTestInspection): readonly ToolExecutionTrace[]
{
    return result.traceEvents.flatMap((event) =>
    {
        const payload = event.event;

        if (
            event.type !== "tool_execution_end"
            || !isRecord(payload)
            || typeof payload.toolCallId !== "string"
        )
        {
            return [];
        }

        return [{
            toolCallId: payload.toolCallId,
            ...(typeof payload.toolName === "string" ? { toolName: payload.toolName } : {}),
            ...(typeof payload.isError === "boolean" ? { isError: payload.isError } : {}),
            ...("result" in payload ? { result: payload.result } : {}),
        }];
    });
}

/** Return one finalized tool execution or throw when Pi did not emit it. */
export function getToolExecution(
    result: PiIntegrationTestInspection,
    toolCallId: string,
): ToolExecutionTrace
{
    const execution = getToolExecutions(result).find((candidate) => candidate.toolCallId === toolCallId);

    if (execution === undefined)
    {
        throw new TypeError(`The integration trace did not expose a tool execution for ${toolCallId}`);
    }

    return execution;
}

/** Return the real result attached to one finalized tool execution. */
export function getToolExecutionResult(
    result: PiIntegrationTestInspection,
    toolCallId: string,
): unknown
{
    return getToolExecution(result, toolCallId).result;
}

/** Return `result.details` from a finalized execution when the result is an object. */
export function getToolExecutionDetails(execution: ToolExecutionTrace): unknown
{
    return isRecord(execution.result) ? execution.result.details : undefined;
}

/** Flatten text from the last message sent with a recorded provider request. */
export function getProviderRequestLastMessageText(request: TraceEvent): string
{
    if (!Array.isArray(request.messages))
    {
        return "";
    }

    for (const message of request.messages.toReversed())
    {
        if (!isRecord(message))
        {
            continue;
        }

        if (typeof message.content === "string")
        {
            return message.content;
        }

        if (Array.isArray(message.content))
        {
            const text = message.content
                .filter(isRecord)
                .map((block) => typeof block.text === "string" ? block.text : "")
                .join("\n");

            if (text.length > 0)
            {
                return text;
            }
        }
    }

    return "";
}

function isToolResultMessage(value: unknown): value is ToolResultMessage<unknown>
{
    return isRecord(value)
        && value.role === "toolResult"
        && typeof value.toolCallId === "string"
        && typeof value.toolName === "string"
        && Array.isArray(value.content)
        && typeof value.isError === "boolean"
        && typeof value.timestamp === "number";
}

function isRecord(value: unknown): value is Record<string, unknown>
{
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
