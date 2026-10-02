import { writeFileSync } from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function registerActiveTools(pi: ExtensionAPI): void
{
    pi.on("before_agent_start", (_event, ctx) =>
    {
        writeFileSync(path.join(ctx.cwd, "active-tools.json"), JSON.stringify(pi.getActiveTools()));
    });
}
