import { describe, expect, it } from "vitest";

import { getSystemPrompt } from "../src/runtime/result-accessors.js";

import type { PiIntegrationTestInspection } from "../src/runtime/result-accessors.js";

describe("getSystemPrompt", () =>
{
    it("falls back to the scripted provider request in older traces", () =>
    {
        const result: PiIntegrationTestInspection = {
            messages: [],
            providerRequests: [{
                type: "provider_request",
                sequence: 1,
                timestamp: 1,
                systemPrompt: "legacy captured prompt",
            }],
            traceEvents: [{
                type: "agent_start",
                sequence: 0,
                timestamp: 0,
                event: { type: "agent_start" },
            }],
        };

        expect(getSystemPrompt(result)).toBe("legacy captured prompt");
    });
});
