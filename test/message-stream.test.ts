import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { streamScenario } from "../src/harness/message-stream.js";
import type { ToolCallBlock } from "../src/scenario/types.js";

const model = { api: "openai-completions", provider: "test", id: "test" } as Model<Api>;

async function streamToolCall(block: ToolCallBlock)
{
    const events = [];
    for await (const event of streamScenario(model, {} as Context, { blocks: [block], stopReason: "toolUse" }))
    {
        events.push(event);
    }
    return events;
}

describe("scripted tool argument streaming", () =>
{
    it("defaults to bounded chunks and preserves the complete arguments", async () =>
    {
        const argumentsJson = JSON.stringify({ content: "x".repeat(4096) });
        const events = await streamToolCall({ type: "toolCall", id: "call", name: "write", argumentsJson });
        const deltas = events.flatMap((event) => event.type === "toolcall_delta" ? [event.delta] : []);
        expect(deltas.join("")).toBe(argumentsJson);
        expect(deltas).toHaveLength(Math.ceil(argumentsJson.length / 1024));
        const end = events.find((event) => event.type === "toolcall_end");
        expect(end?.toolCall.arguments).toEqual(JSON.parse(argumentsJson));
    });

    it("keeps character chunks for explicitly timed or snapshot streams", async () =>
    {
        for (const options of [
            { delayMs: 0 },
            { deltaDelaysMs: [0, 0] },
            { argumentSnapshots: [{}, {}] },
        ])
        {
            const events = await streamToolCall({ type: "toolCall", id: "call", name: "write", argumentsJson: "{}", ...options });
            expect(events.flatMap((event) => event.type === "toolcall_delta" ? [event.delta] : [])).toEqual(["{", "}"]);
        }
    });

    it("respects explicit chunking with timing", async () =>
    {
        const events = await streamToolCall({
            type: "toolCall", id: "call", name: "write", argumentsJson: "{}",
            chunks: { kind: "explicit", chunks: ["{}"] }, deltaDelaysMs: [0],
        });
        expect(events.flatMap((event) => event.type === "toolcall_delta" ? [event.delta] : [])).toEqual(["{}"]);
    });
});
