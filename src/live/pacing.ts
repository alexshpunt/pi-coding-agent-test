import { chunkString } from "../scenario/chunks.js";

import type { AssistantContentBlock, PiIntegrationTestOptions, ToolCallBlock } from "../scenario/types.js";

const streamProfiles: Readonly<Record<string, StreamProfile>> = {
    "gpt-5.6-sol-xhigh": {
        charactersPerToken: 4,
        firstDeltaLatencyMs: { min: 170, max: 330 },
        outputTokensPerSecond: 68,
        packetLatencyMs: { min: 12, max: 36 },
        speedJitter: 0.18,
    },
    "gemini-3.5-flash": {
        charactersPerToken: 4,
        firstDeltaLatencyMs: { min: 170, max: 330 },
        outputTokensPerSecond: 280,
        packetLatencyMs: { min: 12, max: 36 },
        speedJitter: 0.18,
    },
};
const defaultStreamProfile = "gpt-5.6-sol-xhigh";

interface NumberRange
{
    readonly min: number;
    readonly max: number;
}

interface StreamProfile
{
    readonly charactersPerToken: number;
    readonly firstDeltaLatencyMs: NumberRange;
    readonly outputTokensPerSecond: number;
    readonly packetLatencyMs: NumberRange;
    readonly speedJitter: number;
}

interface StreamSchedule
{
    readonly chunks: readonly string[];
    readonly delaysMs: readonly number[];
}

type Random = () => number;
type GeneratedTextField = "content" | "text";

export function withInteractivePacing(
    options: PiIntegrationTestOptions,
    environment: NodeJS.ProcessEnv = process.env,
): PiIntegrationTestOptions
{
    const fixedDelay = environment.PI_INTEGRATION_TEST_DELTA_DELAY_MS;
    const explicitProfile = environment.PI_INTEGRATION_TEST_STREAM_PROFILE;

    if (fixedDelay !== undefined && explicitProfile !== undefined)
    {
        throw new TypeError(
            "PI_INTEGRATION_TEST_DELTA_DELAY_MS and PI_INTEGRATION_TEST_STREAM_PROFILE cannot be used together",
        );
    }

    const profileName = explicitProfile
        ?? (fixedDelay === undefined && environment.PI_INTEGRATION_TEST_LIVE === "1"
            ? defaultStreamProfile
            : undefined);

    if (profileName !== undefined)
    {
        const profile = getStreamProfile(profileName);
        const seed = environment.PI_INTEGRATION_TEST_STREAM_SEED ?? `${Date.now()}:${Math.random()}`;
        return withStreamProfile(options, profile, createRandom(seed));
    }

    if (fixedDelay === undefined)
    {
        return options;
    }

    return withFixedDelay(options, parseFixedDelay(fixedDelay));
}

function withStreamProfile(
    options: PiIntegrationTestOptions,
    profile: StreamProfile,
    random: Random,
): PiIntegrationTestOptions
{
    return {
        ...options,
        rawMode: false,
        conversation: (options.conversation ?? []).map((message) => ({
            ...message,
            delayMs: message.delayMs === 0 ? 0 : randomInteger(profile.firstDeltaLatencyMs, random),
            blocks: message.blocks.map((block) => withProfiledBlock(block, profile, random)),
        })),
    };
}

function withProfiledBlock(
    block: AssistantContentBlock,
    profile: StreamProfile,
    random: Random,
): AssistantContentBlock
{
    if (block.delayMs === 0)
    {
        return block;
    }

    if (block.type === "toolCall")
    {
        const progressiveBlock = withProfiledGeneratedText(block, profile, random);

        if (progressiveBlock !== undefined)
        {
            return progressiveBlock;
        }
    }

    const value = block.type === "text"
        ? block.text
        : block.argumentsJson ?? JSON.stringify(block.arguments ?? {});
    const schedule = block.chunks === undefined
        ? scheduleValue(value, profile, random)
        : scheduleExistingChunks(chunkString(value, block.chunks), profile, random);

    return withSchedule(block, schedule);
}

function withProfiledGeneratedText(
    block: ToolCallBlock,
    profile: StreamProfile,
    random: Random,
): ToolCallBlock | undefined
{
    const arguments_ = block.arguments ?? parseToolCallArguments(block.argumentsJson);
    const generated = arguments_ === undefined ? undefined : generatedText(arguments_);

    if (arguments_ === undefined || generated === undefined || generated.value.length === 0)
    {
        return undefined;
    }

    const argumentsJson = JSON.stringify(arguments_);
    const marker = `"${generated.field}":"`;
    const markerStart = argumentsJson.indexOf(marker);

    if (markerStart === -1)
    {
        return undefined;
    }

    const contentStart = markerStart + marker.length;
    const encodedText = JSON.stringify(generated.value).slice(1, -1);
    const contentEnd = contentStart + encodedText.length;

    if (argumentsJson[contentEnd] !== "\"")
    {
        return undefined;
    }

    const prefix = scheduleValue(argumentsJson.slice(0, contentStart), profile, random);
    const content = scheduleValue(generated.value, profile, random);
    const suffix = scheduleValue(argumentsJson.slice(contentEnd), profile, random);
    const encodedContentChunks = content.chunks.map(encodeJsonStringContent);

    if (encodedContentChunks.join("") !== encodedText)
    {
        throw new Error("Profiled generated text must preserve its JSON encoding");
    }

    const emptyArguments = { ...arguments_, [generated.field]: "" };
    const argumentSnapshots: Readonly<Record<string, unknown>>[] = prefix.chunks.map(
        (_chunk, index) => index === prefix.chunks.length - 1 ? emptyArguments : {},
    );
    let streamedText = "";

    for (const chunk of content.chunks)
    {
        streamedText += chunk;
        argumentSnapshots.push({ ...arguments_, [generated.field]: streamedText });
    }

    for (const _chunk of suffix.chunks)
    {
        argumentSnapshots.push(arguments_);
    }

    const chunks = [...prefix.chunks, ...encodedContentChunks, ...suffix.chunks];
    const delaysMs = [...prefix.delaysMs, ...content.delaysMs, ...suffix.delaysMs];
    const {
        arguments: discardedArguments,
        argumentSnapshots: discardedSnapshots,
        chunks: discardedChunks,
        delayMs: discardedDelay,
        deltaDelaysMs: discardedDeltaDelays,
        ...blockWithoutPacing
    } = block;
    void discardedArguments;
    void discardedSnapshots;
    void discardedChunks;
    void discardedDelay;
    void discardedDeltaDelays;

    return {
        ...blockWithoutPacing,
        argumentsJson,
        chunks: { kind: "explicit", chunks },
        deltaDelaysMs: delaysMs,
        argumentSnapshots,
    };
}

function withSchedule<T extends AssistantContentBlock>(block: T, schedule: StreamSchedule): T
{
    const {
        chunks: discardedChunks,
        delayMs: discardedDelay,
        deltaDelaysMs: discardedDeltaDelays,
        ...blockWithoutPacing
    } = block;
    void discardedChunks;
    void discardedDelay;
    void discardedDeltaDelays;

    return {
        ...blockWithoutPacing,
        chunks: { kind: "explicit", chunks: schedule.chunks },
        deltaDelaysMs: schedule.delaysMs,
    } as T;
}

function scheduleValue(value: string, profile: StreamProfile, random: Random): StreamSchedule
{
    const characters = unicodeCharacters(value);
    const chunks: string[] = [];
    const delaysMs: number[] = [];
    const charactersPerSecond = profile.outputTokensPerSecond * profile.charactersPerToken;
    let offset = 0;

    while (offset < characters.length)
    {
        const delayMs = randomInteger(profile.packetLatencyMs, random);
        const speed = 1 + ((random() * 2) - 1) * profile.speedJitter;
        const size = Math.max(1, Math.round(charactersPerSecond * delayMs * speed / 1000));
        chunks.push(characters.slice(offset, offset + size).join(""));
        delaysMs.push(delayMs);
        offset += size;
    }

    return { chunks, delaysMs };
}

function scheduleExistingChunks(
    chunks: readonly string[],
    profile: StreamProfile,
    random: Random,
): StreamSchedule
{
    const charactersPerSecond = profile.outputTokensPerSecond * profile.charactersPerToken;
    const delaysMs = chunks.map((chunk) =>
    {
        const speed = 1 + ((random() * 2) - 1) * profile.speedJitter;
        return Math.max(1, Math.round(unicodeCharacters(chunk).length * 1000 / charactersPerSecond / speed));
    });

    return { chunks, delaysMs };
}

function withFixedDelay(options: PiIntegrationTestOptions, delayMs: number): PiIntegrationTestOptions
{
    return {
        ...options,
        rawMode: false,
        conversation: (options.conversation ?? []).map((message) => ({
            ...message,
            blocks: message.blocks.map((block) => withFixedBlockPacing(block, delayMs)),
        })),
    };
}

function withFixedBlockPacing(block: AssistantContentBlock, delayMs: number): AssistantContentBlock
{
    if (block.delayMs === 0)
    {
        return block;
    }

    const { deltaDelaysMs: discardedDeltaDelays, ...blockWithoutDeltaDelays } = block;
    void discardedDeltaDelays;
    const pacedBlock = { ...blockWithoutDeltaDelays, delayMs } as AssistantContentBlock;
    return pacedBlock.type === "toolCall" ? withFixedProgressiveText(pacedBlock) : pacedBlock;
}

function withFixedProgressiveText(block: ToolCallBlock): ToolCallBlock
{
    const arguments_ = block.arguments ?? parseToolCallArguments(block.argumentsJson);
    const generated = arguments_ === undefined ? undefined : generatedText(arguments_);

    if (arguments_ === undefined || generated === undefined || generated.value.length === 0)
    {
        return block;
    }

    const argumentsJson = JSON.stringify(arguments_);
    const marker = `"${generated.field}":"`;
    const contentStart = argumentsJson.indexOf(marker) + marker.length;
    const textDeltas = Array.from(generated.value, encodeJsonStringContent);
    const contentEnd = contentStart + textDeltas.join("").length;

    if (contentStart < marker.length || argumentsJson[contentEnd] !== "\"")
    {
        return block;
    }

    let streamedText = "";
    const argumentSnapshots: Readonly<Record<string, unknown>>[] = [
        { ...arguments_, [generated.field]: streamedText },
    ];

    for (const character of generated.value)
    {
        streamedText += character;
        argumentSnapshots.push({ ...arguments_, [generated.field]: streamedText });
    }

    argumentSnapshots.push(arguments_);

    const { arguments: discardedArguments, ...blockWithoutArguments } = block;
    void discardedArguments;

    return {
        ...blockWithoutArguments,
        argumentsJson,
        chunks: {
            kind: "explicit",
            chunks: [
                argumentsJson.slice(0, contentStart),
                ...textDeltas,
                argumentsJson.slice(contentEnd),
            ],
        },
        argumentSnapshots,
    };
}

function generatedText(arguments_: Readonly<Record<string, unknown>>): {
    readonly field: GeneratedTextField;
    readonly value: string;
} | undefined
{
    if (typeof arguments_.text === "string")
    {
        return { field: "text", value: arguments_.text };
    }

    return typeof arguments_.content === "string"
        ? { field: "content", value: arguments_.content }
        : undefined;
}

function parseToolCallArguments(value: string | undefined): Record<string, unknown> | undefined
{
    if (value === undefined)
    {
        return undefined;
    }

    try
    {
        const parsed: unknown = JSON.parse(value);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : undefined;
    }
    catch
    {
        return undefined;
    }
}

function getStreamProfile(name: string): StreamProfile
{
    const profile = streamProfiles[name];

    if (profile === undefined)
    {
        throw new TypeError(
            `Unknown PI_INTEGRATION_TEST_STREAM_PROFILE: ${name}. Supported profiles: ${
                Object.keys(streamProfiles).join(", ")
            }`,
        );
    }

    return profile;
}

function parseFixedDelay(value: string): number
{
    if (!/^\d+$/u.test(value))
    {
        throw new TypeError(`PI_INTEGRATION_TEST_DELTA_DELAY_MS must be a non-negative integer, received: ${value}`);
    }

    const delayMs = Number(value);

    if (!Number.isSafeInteger(delayMs))
    {
        throw new TypeError(`PI_INTEGRATION_TEST_DELTA_DELAY_MS is too large: ${value}`);
    }

    return delayMs;
}

function randomInteger(range: NumberRange, random: Random): number
{
    return Math.floor(random() * (range.max - range.min + 1)) + range.min;
}

function createRandom(seed: string): Random
{
    let state = 2166136261;

    for (const character of seed)
    {
        state ^= character.codePointAt(0) ?? 0;
        state = Math.imul(state, 16777619);
    }

    return () =>
    {
        state += 0x6D2B79F5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function encodeJsonStringContent(value: string): string
{
    return JSON.stringify(value).slice(1, -1);
}

function unicodeCharacters(value: string): string[]
{
    const characters: string[] = [];

    for (const character of value)
    {
        characters.push(character);
    }

    return characters;
}
