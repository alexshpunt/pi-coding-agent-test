import { writeFileSync } from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Record the real Pi and its parent so lifecycle tests can check both after command completion. */
export default function recordProcessOwner(pi: ExtensionAPI): void
{
    pi.on("before_agent_start", (_event, context) =>
    {
        writeFileSync(
            path.join(context.cwd, "pty-process.json"),
            JSON.stringify({ pid: process.pid, parentPid: process.ppid }),
        );
    });
}
