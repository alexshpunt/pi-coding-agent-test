import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
    assistantMessage,
    getSystemPrompt,
    getToolExecution,
    PiIntegrationTest,
    PiRun,
    text,
    toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

// Both transports must run real tools and retain the same structured evidence.
test.each(
    [
        { transport: "tui", providerMode: "scripted" },
        { transport: "rpc", providerMode: "scripted" },
        { transport: "rpc", providerMode: "user" },
    ] as const,
)("runs mechanical edits over $transport with $providerMode", async ({ transport, providerMode }) =>
{
    const root = path.resolve(".agents/tmp/rpc-tests");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "workspace-"));
    const content = "A\u2028B\u2029C\u00a0—\n";
    try
    {
        const result = await new PiIntegrationTest({
            testName: `mechanical-${transport}-${providerMode}`,
            providerMode,
            // Exercise user-provider routing without a paid provider request.
            model: "scripted/scripted-model",
            artifactsDir: root,
            cwd,
            ...(transport === "rpc" ? { transport } : {}),
            isolateUserResources: true,
            tools: ["write"],
            conversation: [
                assistantMessage([
                    toolCall({ id: "write-file", name: "write", arguments: { path: "answer.txt", content } }),
                ], { stopReason: "toolUse" }),
                assistantMessage([text("Done")]),
            ],
        }).run("Write the requested file.");
        expect(await readFile(path.join(cwd, "answer.txt"), "utf8")).toBe(content);
        expect(getToolExecution(result, "write-file").isError).toBe(false);
        expect(getSystemPrompt(result).length).toBeGreaterThan(0);
        expect(result.state?.mode).toBe(transport);
        expect(result.providerRequests).toHaveLength(2);
        const reopened = await PiRun.open(result.artifacts.directory);
        expect(reopened.messages).toEqual(result.messages);
        expect(reopened.traceEvents).toEqual(result.traceEvents);

        const header = JSON.parse((await readFile(result.artifacts.run, "utf8")).split("\n")[0]!);
        expect(header.options.transport).toBe(transport);
        if (transport === "rpc")
        {
            expect(result.frameDelaysMs).toEqual([]);
            expect(result.tuiRenderedOutput).toBe("");
            expect(result.terminalOutput).toContain("\"type\":\"agent_settled\"");
        }
    }
    finally
    {
        await rm(cwd, { recursive: true, force: true });
    }
});
