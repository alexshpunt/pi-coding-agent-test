import { Type } from "@earendil-works/pi-ai";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** An extension used to make explicit loading and omission visible in a test. */
export default function optionalExtension(pi: ExtensionAPI): void
{
    pi.registerTool({
        name: "optional_probe",
        label: "Optional probe",
        description: "Return a marker from the explicitly loaded optional extension.",
        parameters: Type.Object({}),
        execute()
        {
            return Promise.resolve({
                content: [{ type: "text", text: "optional extension executed" }],
                details: { extension: "optional" },
            });
        },
    });

    pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\n[optional example extension is loaded]`,
    }));
}
