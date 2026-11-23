import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
        async execute(_id, _params, _signal, _update, ctx)
        {
            let value = workspaces.get(ctx.cwd);

            if (value === undefined)
            {
                value = readFileSync(path.join(ctx.cwd, "value.txt"), "utf8");
                workspaces.set(ctx.cwd, value);
            }

            const previousMarker = existsSync(path.join(ctx.cwd, "marker"));
            writeFileSync(path.join(ctx.cwd, "marker"), value);

            // Both test requests must enter their tools before either can finish.
            const barrier = process.env.PI_TEST_WORKSPACE_BARRIER;

            if (barrier !== undefined && (value === "first" || value === "second"))
            {
                writeFileSync(path.join(barrier, value), String(process.pid));
                const peer = path.join(barrier, value === "first" ? "second" : "first");
                const deadline = performance.now() + 5000;

                while (!existsSync(peer))
                {
                    if (performance.now() >= deadline)
                    {
                        throw new Error("The second Pi did not enter the workspace barrier");
                    }

                    await delay(20);
                }
            }

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({ pid: process.pid, cwd: ctx.cwd, value, previousMarker }),
                }],
                details: {},
            };
        },
    });
}
