import {
    type Api,
    type AssistantMessage,
    type AssistantMessageEventStream,
    type Context,
    createAssistantMessageEventStream,
    type Model,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { chunkString } from "../scenario/chunks.js";

import type { AssistantContentBlock, AssistantMessageScenario } from "../scenario/types.js";

interface DeltaClock
{
    nextAt: number;
}

export function streamScenario(
    model: Model<Api>,
    _context: Context,
    scenario: AssistantMessageScenario,
    options?: SimpleStreamOptions,
): AssistantMessageEventStream
{
    const stream = createAssistantMessageEventStream();
    const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: scenario.stopReason ?? "stop",
        timestamp: Date.now(),
    };

    void emitScenario(stream, output, scenario, options?.signal);
    return stream;
}

async function emitScenario(
    stream: AssistantMessageEventStream,
    output: AssistantMessage,
    scenario: AssistantMessageScenario,
    signal: AbortSignal | undefined,
): Promise<void>
{
    try
    {
        if (scenario.delayMs !== undefined && scenario.delayMs > 0)
        {
            await delay(scenario.delayMs);
        }

        if (signal?.aborted)
        {
            output.stopReason = "aborted";
            output.errorMessage = "Stream aborted";
            stream.push({ type: "error", reason: "aborted", error: output });
            stream.end();
            return;
        }

        stream.push({ type: "start", partial: output });

        for (const block of scenario.blocks)
        {
            if (!await emitBlock(stream, output, block, signal))
            {
                output.stopReason = "aborted";
                output.errorMessage = "Stream aborted";
                stream.push({ type: "error", reason: "aborted", error: output });
                stream.end();
                return;
            }
        }

        output.stopReason = scenario.stopReason ?? "stop";
        stream.push({
            type: "done",
            reason: output.stopReason,
            message: output,
        });
        stream.end();
    }
    catch (error)
    {
        output.stopReason = signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
    }
}

async function emitBlock(
    stream: AssistantMessageEventStream,
    output: AssistantMessage,
    block: AssistantContentBlock,
    signal: AbortSignal | undefined,
): Promise<boolean>
{
    if (signal?.aborted)
    {
        return false;
    }

    if (block.type === "text")
    {
        const contentIndex = output.content.length;
        output.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex, partial: output });

        const textDeltas = chunkString(block.text, block.chunks ?? { kind: "characters" });
        validateDeltaDelays(block, textDeltas.length);
        const textClock = createDeltaClock(block);

        for (const [deltaIndex, delta] of textDeltas.entries())
        {
            await waitForDelta(block, deltaIndex, textClock);

            if (signal?.aborted)
            {
                return false;
            }

            const content = output.content[contentIndex];

            if (content?.type !== "text")
            {
                throw new Error("Text block disappeared from assistant output");
            }

            content.text += delta;
            stream.push({ type: "text_delta", contentIndex, delta, partial: output });

            if (signal?.aborted)
            {
                return false;
            }
        }

        if (signal?.aborted)
        {
            return false;
        }

        stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
        return true;
    }

    const contentIndex = block.contentIndex ?? output.content.length;

    while (output.content.length <= contentIndex)
    {
        output.content.push({ type: "text", text: "" });
    }

    const argumentsJson = block.argumentsJson ?? JSON.stringify(block.arguments ?? {});
    const toolBlock = { type: "toolCall" as const, id: block.id, name: block.name, arguments: {} };
    output.content[contentIndex] = toolBlock;
    stream.push({ type: "toolcall_start", contentIndex, partial: output });

    let partialArguments = "";

    const argumentDeltas = chunkString(argumentsJson, block.chunks ?? { kind: "characters" });
    validateDeltaDelays(block, argumentDeltas.length);
    const argumentClock = createDeltaClock(block);

    for (const [deltaIndex, delta] of argumentDeltas.entries())
    {
        await waitForDelta(block, deltaIndex, argumentClock);

        if (signal?.aborted)
        {
            return false;
        }

        partialArguments += delta;

        const snapshot = block.argumentSnapshots?.[deltaIndex];

        if (snapshot === undefined)
        {
            try
            {
                const parsed: unknown = JSON.parse(partialArguments);

                if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
                {
                    toolBlock.arguments = parsed;
                }
            }
            catch
            {
                // Partial JSON is expected while a real provider is streaming arguments.
            }
        }
        else
        {
            toolBlock.arguments = { ...snapshot };
        }

        stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });

        if (signal?.aborted)
        {
            return false;
        }
    }

    if (signal?.aborted)
    {
        return false;
    }

    if (block.includeEnd !== false)
    {
        const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
        toolBlock.arguments = parsed;
        stream.push({
            type: "toolcall_end",
            contentIndex,
            toolCall: { type: "toolCall", id: block.id, name: block.name, arguments: parsed },
            partial: output,
        });
    }

    return true;
}

function validateDeltaDelays(block: AssistantContentBlock, deltaCount: number): void
{
    const delays = block.deltaDelaysMs;

    if (delays === undefined)
    {
        return;
    }

    if (delays.length !== deltaCount)
    {
        throw new Error(
            `deltaDelaysMs must contain one delay for each delta: expected ${deltaCount}, received ${delays.length}`,
        );
    }

    if (delays.some((value) => !Number.isSafeInteger(value) || value < 0))
    {
        throw new Error("deltaDelaysMs must contain only non-negative safe integers");
    }
}

function deltaDelay(block: AssistantContentBlock, deltaIndex: number): number
{
    return block.deltaDelaysMs?.[deltaIndex] ?? block.delayMs ?? 1;
}

function createDeltaClock(block: AssistantContentBlock): DeltaClock | undefined
{
    return block.deltaDelaysMs === undefined ? undefined : { nextAt: performance.now() };
}

async function waitForDelta(
    block: AssistantContentBlock,
    deltaIndex: number,
    clock: DeltaClock | undefined,
): Promise<void>
{
    const waitMs = deltaDelay(block, deltaIndex);

    if (clock === undefined)
    {
        await delay(waitMs);
        return;
    }

    clock.nextAt += waitMs;
    await delay(clock.nextAt - performance.now());
}

function delay(milliseconds: number | undefined): Promise<void>
{
    if (milliseconds === undefined || milliseconds <= 0)
    {
        return Promise.resolve();
    }

    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
