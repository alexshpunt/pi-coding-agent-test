import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Type } from "@earendil-works/pi-ai";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Exercise raw arguments, progressive results and metadata hidden by native rendering. */
export default function rawPayloadExtension(pi: ExtensionAPI): void
{
    pi.registerTool({
        name: "raw_failure",
        label: "Raw failure",
        description: "Return a real tool execution failure for raw diagnostics.",
        parameters: Type.Object({}),
        execute()
        {
            return Promise.reject(new Error("RAW_FAILURE_MARKER"));
        },
    });
    pi.registerTool({
        name: "raw_payload",
        label: "Raw payload",
        description: "Save a debug payload and return a short summary with full internal details.",
        parameters: Type.Object({ payload: Type.Any() }),
        async execute(toolCallId, params, _signal, onUpdate, ctx)
        {
            await writeFile(path.join(ctx.cwd, "payload.json"), JSON.stringify(params));
            onUpdate?.({
                content: [{ type: "text", text: "RAW_PROGRESS_MARKER" }],
                details: { phase: "progress", internal: "PROGRESS_DETAILS_ONLY_MARKER" },
            });
            await new Promise((resolve) => setTimeout(resolve, 100));
            return {
                content: [{ type: "text", text: "Payload saved" }],
                details: {
                    toolCallId,
                    internal: "FINAL_DETAILS_ONLY_MARKER",
                    received: params,
                },
            };
        },
        renderCall()
        {
            throw new Error("Raw mode must bypass the custom call renderer");
        },
        renderResult()
        {
            throw new Error("Raw mode must bypass the custom result renderer");
        },
    });
}
