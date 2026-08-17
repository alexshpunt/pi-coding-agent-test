import { type ChunkSpec, chunkString } from "./chunks.js";

/** Input used to create a realistic sequence of streamed tool-call events. */
export interface ToolCallInput
{
    /** Stable tool-call identifier. */
    readonly id: string;

    /** Registered Pi tool name. */
    readonly name: string;

    /** Complete serialized JSON object streamed as tool arguments. */
    readonly argumentsJson: string;

    /** Assistant content index. Defaults to zero. */
    readonly contentIndex?: number;

    /** How `argumentsJson` is divided into deltas. */
    readonly chunks: ChunkSpec;

    /** Set to `false` to omit the final `toolcall_end` event. */
    readonly includeEnd?: boolean;
}

/** Minimal partial tool-call block exposed with a start event. */
export interface PartialToolCallBlock
{
    /** Pi assistant content discriminator. */
    readonly type: "toolCall";

    /** Stable tool-call identifier. */
    readonly id: string;

    /** Registered Pi tool name. */
    readonly name: string;
}

/** First event in a streamed tool call. */
export interface ToolCallStartEvent
{
    /** Pi provider event discriminator. */
    readonly type: "toolcall_start";

    /** Assistant content index that receives the tool call. */
    readonly contentIndex: number;

    /** Minimal assistant content available when streaming starts. */
    readonly partial: {
        readonly content: readonly (PartialToolCallBlock | { readonly type: "text"; readonly text: string; })[];
    };
}

/** One serialized argument delta in a streamed tool call. */
export interface ToolCallDeltaEvent
{
    /** Pi provider event discriminator. */
    readonly type: "toolcall_delta";

    /** Assistant content index being updated. */
    readonly contentIndex: number;

    /** Next serialized argument fragment. */
    readonly delta: string;
}

/** Final event containing parsed tool arguments. */
export interface ToolCallEndEvent
{
    /** Pi provider event discriminator. */
    readonly type: "toolcall_end";

    /** Assistant content index containing the completed tool call. */
    readonly contentIndex: number;

    /** Complete tool call passed to Pi. */
    readonly toolCall: {
        readonly type: "toolCall";
        readonly id: string;
        readonly name: string;
        readonly arguments: Readonly<Record<string, unknown>>;
    };
}

/** Start, delta, or end event for one streamed tool call. */
export type ToolCallEvent = ToolCallStartEvent | ToolCallDeltaEvent | ToolCallEndEvent;

/** Minimal Pi `message_update` shape used by low-level extension tests. */
export interface MessageUpdateEvent
{
    /** Stream event carried by the update. */
    readonly assistantMessageEvent: ToolCallEvent;
}

/** Handler compatible with tests that feed generated updates into extension logic. */
export type MessageUpdateHandler<TContext = unknown> = (
    event: MessageUpdateEvent,
    context: TContext,
) => void | Promise<void>;

/** Generate the exact start/delta/end sequence for a streamed tool call. */
export function generateToolCallEvents(input: ToolCallInput): ToolCallEvent[]
{
    const contentIndex = input.contentIndex ?? 0;

    if (!Number.isInteger(contentIndex) || contentIndex < 0)
    {
        throw new Error("Tool call content index must be a non-negative integer");
    }

    const content: (PartialToolCallBlock | { type: "text"; text: string; })[] = Array.from(
        { length: contentIndex + 1 },
        () => ({ type: "text" as const, text: "" }),
    );
    content[contentIndex] = { type: "toolCall", id: input.id, name: input.name };

    const events: ToolCallEvent[] = [
        {
            type: "toolcall_start",
            contentIndex,
            partial: { content },
        },
        ...chunkString(input.argumentsJson, input.chunks).map((delta) => ({
            type: "toolcall_delta" as const,
            contentIndex,
            delta,
        })),
    ];

    if (input.includeEnd !== false)
    {
        events.push({
            type: "toolcall_end",
            contentIndex,
            toolCall: {
                type: "toolCall",
                id: input.id,
                name: input.name,
                arguments: parseArguments(input.argumentsJson),
            },
        });
    }

    return events;
}

/** Deliver generated events to a handler in order and await each handler invocation. */
export async function emitMessageUpdateEvents<TContext>(
    events: Iterable<ToolCallEvent>,
    handler: MessageUpdateHandler<TContext>,
    context: TContext,
): Promise<void>
{
    for (const assistantMessageEvent of events)
    {
        await handler({ assistantMessageEvent }, context);
    }
}

function parseArguments(argumentsJson: string): Record<string, unknown>
{
    const parsed: unknown = JSON.parse(argumentsJson);

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    {
        throw new Error("Tool call arguments must be a JSON object");
    }

    return parsed as Record<string, unknown>;
}
