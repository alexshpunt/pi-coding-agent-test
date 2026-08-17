import { describe, expect, it } from "vitest";

import {
    emitMessageUpdateEvents,
    generateToolCallEvents,
    type MessageUpdateEvent,
} from "../src/scenario/tool-call-events.js";

describe("tool-call event generator", () =>
{
    it("generates start, raw deltas, and end events", () =>
    {
        const argumentsJson = "{\"path\":\"file.ts\",\"text\":\"new\"}";
        const events = generateToolCallEvents({
            id: "call-1",
            name: "edit",
            argumentsJson,
            chunks: { kind: "explicit", chunks: ["{\"path\":", "\"file.ts\",", "\"text\":\"new\"}"] },
        });

        expect(events).toEqual([
            {
                type: "toolcall_start",
                contentIndex: 0,
                partial: { content: [{ type: "toolCall", id: "call-1", name: "edit" }] },
            },
            { type: "toolcall_delta", contentIndex: 0, delta: "{\"path\":" },
            { type: "toolcall_delta", contentIndex: 0, delta: "\"file.ts\"," },
            { type: "toolcall_delta", contentIndex: 0, delta: "\"text\":\"new\"}" },
            {
                type: "toolcall_end",
                contentIndex: 0,
                toolCall: {
                    type: "toolCall",
                    id: "call-1",
                    name: "edit",
                    arguments: { path: "file.ts", text: "new" },
                },
            },
        ]);
    });

    it("supports incomplete calls without emitting toolcall_end", () =>
    {
        const events = generateToolCallEvents({
            id: "call-2",
            name: "edit",
            argumentsJson: "{\"path\":\"file.ts\"",
            chunks: { kind: "fixed", size: 4 },
            includeEnd: false,
        });

        expect(events.at(-1)).toEqual({ type: "toolcall_delta", contentIndex: 0, delta: "\"" });
        expect(events.every((event) => event.type !== "toolcall_end")).toBe(true);
    });

    it("emits only the events supplied by the caller", async () =>
    {
        const events = generateToolCallEvents({
            id: "call-3",
            name: "edit",
            argumentsJson: "{}",
            chunks: { kind: "characters" },
        });
        const received: MessageUpdateEvent[] = [];
        const ctx = { signal: undefined };

        await emitMessageUpdateEvents(events.slice(0, 2), (event, receivedContext) =>
        {
            expect(receivedContext).toBe(ctx);
            received.push(event);
        }, ctx);

        expect(received).toHaveLength(2);
        expect(received.map((event) => event.assistantMessageEvent.type)).toEqual([
            "toolcall_start",
            "toolcall_delta",
        ]);

        await emitMessageUpdateEvents(events.slice(2), (event) =>
        {
            received.push(event);
        }, ctx);

        expect(received.map((event) => event.assistantMessageEvent.type)).toEqual([
            "toolcall_start",
            "toolcall_delta",
            "toolcall_delta",
            "toolcall_end",
        ]);
    });
    it("emits an unfinished quoted JSON value without inventing an end event", async () =>
    {
        const argumentsJson = "{\"path\":\"src/file.ts\",\"text\":\"unfinished";
        const events = generateToolCallEvents({
            id: "call-unfinished",
            name: "edit",
            argumentsJson,
            chunks: {
                kind: "explicit",
                chunks: ["{\"path\":\"", "src/file.ts", "\",\"text\":\"", "unfinished"],
            },
            includeEnd: false,
        });
        const deltas: string[] = [];
        const receivedTypes: string[] = [];

        await emitMessageUpdateEvents(events.slice(0, 3), async ({ assistantMessageEvent }) =>
        {
            await Promise.resolve();
            receivedTypes.push(assistantMessageEvent.type);
            if (assistantMessageEvent.type === "toolcall_delta")
            {
                deltas.push(assistantMessageEvent.delta);
            }
        }, undefined);

        await emitMessageUpdateEvents(events.slice(3), ({ assistantMessageEvent }) =>
        {
            receivedTypes.push(assistantMessageEvent.type);
            if (assistantMessageEvent.type === "toolcall_delta")
            {
                deltas.push(assistantMessageEvent.delta);
            }
        }, undefined);

        expect(deltas.join(""))
            .toBe(argumentsJson);
        expect(receivedTypes).toEqual([
            "toolcall_start",
            "toolcall_delta",
            "toolcall_delta",
            "toolcall_delta",
            "toolcall_delta",
        ]);
        expect(events.every((event) => event.type !== "toolcall_end")).toBe(true);
    });

    it("keeps escaped quotes, newlines, and Unicode intact through a complete call", async () =>
    {
        const argumentsJson = "{\"text\":\"line\\n\\\"quoted\\\"\",\"path\":\"файл.ts\"}";
        const events = generateToolCallEvents({
            id: "call-escaped",
            name: "write",
            argumentsJson,
            chunks: { kind: "fixed", size: 3 },
        });
        const received: MessageUpdateEvent[] = [];

        await emitMessageUpdateEvents(events, async (event) =>
        {
            await Promise.resolve();
            received.push(event);
        }, undefined);

        const end = received.at(-1)!.assistantMessageEvent;
        expect(end).toEqual({
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: {
                type: "toolCall",
                id: "call-escaped",
                name: "write",
                arguments: { text: "line\n\"quoted\"", path: "файл.ts" },
            },
        });
        expect(
            received
                .slice(1, -1)
                .map((event) => event.assistantMessageEvent)
                .filter((event) => event.type === "toolcall_delta")
                .map((event) => event.delta)
                .join(""),
        )
            .toBe(argumentsJson);
    });

    it("preserves a non-zero content index in every event", () =>
    {
        const events = generateToolCallEvents({
            id: "call-indexed",
            name: "edit",
            argumentsJson: "{}",
            contentIndex: 2,
            chunks: { kind: "explicit", chunks: ["{}"] },
        });

        expect(events[0]).toEqual({
            type: "toolcall_start",
            contentIndex: 2,
            partial: {
                content: [
                    { type: "text", text: "" },
                    { type: "text", text: "" },
                    { type: "toolCall", id: "call-indexed", name: "edit" },
                ],
            },
        });
        expect(events.every((event) => event.contentIndex === 2)).toBe(true);
    });

    it("stops emitting when the handler fails", async () =>
    {
        const events = generateToolCallEvents({
            id: "call-failing-handler",
            name: "edit",
            argumentsJson: "{}",
            chunks: { kind: "characters" },
        });
        const receivedTypes: string[] = [];

        await expect(emitMessageUpdateEvents(events, async ({ assistantMessageEvent }) =>
        {
            receivedTypes.push(assistantMessageEvent.type);
            if (assistantMessageEvent.type === "toolcall_delta")
            {
                throw new Error("handler stopped the stream");
            }
        }, undefined)).rejects.toThrow("handler stopped the stream");

        expect(receivedTypes).toEqual(["toolcall_start", "toolcall_delta"]);
    });

    it("rejects malformed complete arguments and invalid content indexes", () =>
    {
        expect(() =>
            generateToolCallEvents({
                id: "call-malformed",
                name: "edit",
                argumentsJson: "{\"text\":\"unfinished",
                chunks: { kind: "fixed", size: 2 },
            })
        ).toThrow();

        expect(() =>
            generateToolCallEvents({
                id: "call-array",
                name: "edit",
                argumentsJson: "[]",
                chunks: { kind: "explicit", chunks: ["[]"] },
            })
        ).toThrow("Tool call arguments must be a JSON object");

        expect(() =>
            generateToolCallEvents({
                id: "call-negative-index",
                name: "edit",
                argumentsJson: "{}",
                contentIndex: -1,
                chunks: { kind: "explicit", chunks: ["{}"] },
            })
        ).toThrow("Tool call content index must be a non-negative integer");

        expect(() =>
            generateToolCallEvents({
                id: "call-fractional-index",
                name: "edit",
                argumentsJson: "{}",
                contentIndex: 1.5,
                chunks: { kind: "explicit", chunks: ["{}"] },
            })
        ).toThrow("Tool call content index must be a non-negative integer");
    });
});
