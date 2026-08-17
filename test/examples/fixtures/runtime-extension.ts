import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Type } from "@earendil-works/pi-ai";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Registers and selects a tool from a real session_start handler. */
export default function runtimeExtension(pi: ExtensionAPI): void
{
    pi.on("session_start", (event, ctx) =>
    {
        pi.registerTool({
            name: "runtime_echo",
            label: "Runtime echo",
            description: "Echo text from a tool registered during session_start.",
            parameters: Type.Object({ message: Type.String() }),
            execute(_toolCallId, params)
            {
                return Promise.resolve({
                    content: [{ type: "text", text: `[runtime] ${params.message}` }],
                    details: {
                        activeTools: pi.getActiveTools(),
                        sessionStartReason: event.reason,
                    },
                });
            },
        });

        pi.setActiveTools(["runtime_echo"]);
        ctx.ui.setStatus("runtime-example", "runtime_echo active");
    });

    pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\n[runtime extension configured this session]`,
    }));

    pi.on("session_shutdown", async (event, ctx) =>
    {
        await writeFile(
            path.join(ctx.cwd, "runtime-lifecycle.json"),
            `${JSON.stringify({ reason: event.reason, activeTools: pi.getActiveTools() }, null, 2)}\n`,
        );
    });
}
