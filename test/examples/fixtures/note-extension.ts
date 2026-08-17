import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Type } from "@earendil-works/pi-ai";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A small extension that has a real filesystem effect and a structured result. */
export default function noteExtension(pi: ExtensionAPI): void
{
    pi.registerTool({
        name: "save_note",
        label: "Save note",
        description: "Save a short note in the current workspace.",
        parameters: Type.Object({
            title: Type.String(),
            body: Type.String(),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx)
        {
            const note = { title: params.title, body: params.body };
            await writeFile(path.join(ctx.cwd, "note.json"), `${JSON.stringify(note, null, 2)}\n`);

            return {
                content: [{ type: "text", text: `Saved note: ${params.title}` }],
                details: { file: "note.json", note },
            };
        },
    });

    pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\n[save_note example extension is loaded]`,
    }));
}
