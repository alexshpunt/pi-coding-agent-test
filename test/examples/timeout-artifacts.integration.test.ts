import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { assistantMessage, getToolExecution, PiIntegrationTest, PiRun, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("retains completed and unfinished calls on timeout, then runs another scenario", async () =>
{
    const root = path.resolve(".agents/tmp/timeout-tests");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "workspace-"));
    const options = {
        cwd,
        artifactsDir: cwd,
        transport: "rpc" as const,
        isolateUserResources: true,
        tools: ["write", "bash"],
    };
    try
    {
        await expect(new PiIntegrationTest({
            ...options,
            testName: "timeout",
            timeoutMs: 5000,
            conversation: [
                assistantMessage([
                    toolCall({
                        id: "completed",
                        name: "write",
                        arguments: { path: "answer.txt", content: "retained\n" },
                    }),
                ], { stopReason: "toolUse" }),
                assistantMessage([
                    toolCall({
                        id: "unfinished",
                        name: "bash",
                        arguments: { command: "echo $$ > child.pid; sleep 60" },
                    }),
                ], { stopReason: "toolUse" }),
                assistantMessage([text("Done")]),
            ],
        }).run("Write then wait.")).rejects.toThrow("did not settle");
        const reopened = await PiRun.open(path.join(cwd, "timeout"));
        expect(getToolExecution(reopened, "completed").isError).toBe(false);
        expect(
            reopened.traceEvents.some(event =>
                event.type === "tool_execution_start" && JSON.stringify(event).includes("unfinished")
            ),
        ).toBe(true);
        expect(
            reopened.traceEvents.some(event =>
                event.type === "tool_execution_end" && JSON.stringify(event).includes("unfinished")
            ),
        ).toBe(false);
        expect(reopened.traceEvents.some(event => event.type === "agent_settled")).toBe(false);
        const records = (await readFile(reopened.artifacts.run, "utf8")).trim().split("\n").map(line =>
            JSON.parse(line)
        );
        const summary = records.find(record => record.kind === "summary");
        expect(summary).toMatchObject({ partial: true, status: "timeout", exitCode: null });
        expect(summary.endedMonotonicMs).toBeGreaterThan(summary.startedMonotonicMs);
        expect(records[0].prompt).toBe("Write then wait.");
        expect(reopened.traceEvents.find(event => event.type === "agent_start")?.activeTools).toEqual([
            "write",
            "bash",
        ]);
        const times = reopened.traceEvents.map(event => event.monotonicMs);
        expect(times.every(time => typeof time === "number")).toBe(true);
        expect(times).toEqual([...times].sort((a, b) => Number(a) - Number(b)));
        expect(await readFile(path.join(cwd, "answer.txt"), "utf8")).toBe("retained\n");
        const pid = Number(await readFile(path.join(cwd, "child.pid"), "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
        const next = await new PiIntegrationTest({
            ...options,
            testName: "next",
            conversation: [assistantMessage([text("Done")])],
        }).run("Finish.");
        expect(next.traceEvents.some(event => event.type === "agent_settled")).toBe(true);
    }
    finally
    {
        await rm(cwd, { recursive: true, force: true });
    }
}, 20000);
