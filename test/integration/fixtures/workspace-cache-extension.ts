import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Type } from "typebox";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const workspaces = new Map<string, string>();

export default function workspaceCacheExtension(pi: ExtensionAPI): void
{
    pi.on("session_shutdown", async (_event, ctx) =>
    {
        const delayFile = path.join(ctx.cwd, "shutdown-delay.txt");

        if (existsSync(delayFile))
        {
            writeFileSync(path.join(ctx.cwd, "shutdown-started"), "started");
            await new Promise((resolve) => setTimeout(resolve, Number(readFileSync(delayFile, "utf8"))));
        }
    });

    pi.registerTool({
        name: "workspace_cache",
        label: "Workspace cache",
        description: "Read a value through a workspace-scoped cache.",
        parameters: Type.Object({}),
        execute(_id, _params, _signal, _update, ctx)
        {
            let value = workspaces.get(ctx.cwd);

            if (value === undefined)
            {
                value = readFileSync(path.join(ctx.cwd, "value.txt"), "utf8");
                workspaces.set(ctx.cwd, value);
            }

            const previousMarker = existsSync(path.join(ctx.cwd, "marker"));
            writeFileSync(path.join(ctx.cwd, "marker"), value);

            return Promise.resolve({
                content: [{
                    type: "text",
                    text: JSON.stringify({ pid: process.pid, cwd: ctx.cwd, value, previousMarker }),
                }],
                details: {},
            });
        },
    });
}
