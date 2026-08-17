import { describe, expect, it } from "vitest";

import { withInteractivePacing } from "../src/live/pacing.js";
import { assistantMessage, type PiIntegrationTestOptions, text, toolCall } from "../src/scenario/types.js";

describe("interactive stream pacing", () =>
{
    it("streams generated code at a variable model rate with network latency", () =>
    {
        const generatedText = Array.from(
            { length: 80 },
            (_, index) => `const value${index} = await loadValue(${index});`,
        ).join("\n");
        const arguments_ = {
            path: "profiled.ts",
            start: "1#AAAA",
            text: generatedText,
        };
        const options: PiIntegrationTestOptions = {
            testName: "profiled-stream",
            conversation: [
                assistantMessage([
                    toolCall({ id: "profiled-replace", name: "replace", arguments: arguments_ }),
                    text("done", { delayMs: 0 }),
                ], { stopReason: "toolUse" }),
            ],
        };

        const paced = withInteractivePacing(options, {
            PI_INTEGRATION_TEST_LIVE: "1",
            PI_INTEGRATION_TEST_STREAM_SEED: "stable-test-seed",
        });
        const message = paced.conversation?.[0];

        if (message === undefined)
        {
            throw new Error("Expected a paced conversation message");
        }
        const block = message.blocks[0]!;

        expect(message.delayMs).toBeGreaterThanOrEqual(170);
        expect(message.delayMs).toBeLessThanOrEqual(330);
        expect(message.blocks[1]).toEqual(text("done", { delayMs: 0 }));
        expect(block.type).toBe("toolCall");

        if (block.type !== "toolCall" || block.chunks?.kind !== "explicit")
        {
            throw new Error("Expected an explicitly chunked tool call");
        }

        const delays = block.deltaDelaysMs ?? [];
        const snapshots = block.argumentSnapshots ?? [];
        const durationSeconds = delays.reduce((total, delayMs) => total + delayMs, 0) / 1000;
        const estimatedTokens = block.chunks.chunks.join("").length / 4;

        expect(block.chunks.chunks.join("")).toBe(JSON.stringify(arguments_));
        expect(delays).toHaveLength(block.chunks.chunks.length);
        expect(snapshots).toHaveLength(block.chunks.chunks.length);
        expect(new Set(delays).size).toBeGreaterThan(10);
        expect(delays.every((delayMs) => delayMs >= 12 && delayMs <= 36)).toBe(true);
        expect(estimatedTokens / durationSeconds).toBeGreaterThan(55);
        expect(estimatedTokens / durationSeconds).toBeLessThan(85);
        expect(snapshots.some((snapshot) => snapshot.text === "")).toBe(true);
        expect(snapshots.some((snapshot) =>
            typeof snapshot.text === "string"
            && snapshot.text.length > 0
            && snapshot.text.length < generatedText.length
        )).toBe(true);
        expect(snapshots.at(-1)).toEqual(arguments_);
    });
});
