import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    assistantMessage,
    getToolExecution,
    PiIntegrationTest,
    testArtifactsDir,
    text,
    toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("replays each shared native scenario without another run's terminal state", async () =>
{
    const workspace = await mkdtemp(path.join(tmpdir(), "pi-shared-replay-"));

    try
    {
        for (const name of ["first", "second"])
        {
            const result = await new PiIntegrationTest({
                testName: `shared-replay-${name}`,
                artifactsDir: testArtifactsDir(import.meta.filename),
                cwd: workspace,
                rawMode: false,
                tools: ["write"],
                conversation: [
                    assistantMessage([
                        toolCall({
                            id: `write-${name}`,
                            name: "write",
                            arguments: { path: `${name}.txt`, content: `${name}-value\n` },
                        }),
                    ], { stopReason: "toolUse" }),
                    assistantMessage([text(`${name}-complete`)]),
                ],
            }).run(`Write ${name}.txt`);

            expect(result.exitCode).toBeNull();
            expect(getToolExecution(result, `write-${name}`).isError).toBe(false);
            expect(await readFile(path.join(workspace, `${name}.txt`), "utf8")).toBe(`${name}-value\n`);
            expect(result.tuiRenderedOutput).toContain(`${name}-complete`);

            const records = (await readFile(result.artifacts.run, "utf8")).trim().split("\n")
                .map((line) => JSON.parse(line) as { kind: string; data?: string; initialState?: string; });
            const terminal = records.find((record) => record.kind === "terminal");
            expect(terminal?.data).toBe(result.terminalOutput);
            expect(terminal?.initialState).toEqual(expect.any(String));

            const frames = path.join(result.artifacts.directory, "frames");
            execFileSync(process.execPath, [
                path.join(process.cwd(), "dist", "cli.mjs"),
                "replay",
                result.artifacts.directory,
                "--output",
                frames,
            ], { encoding: "utf8", timeout: 10_000 });
            expect(await readFile(path.join(frames, "final.txt"), "utf8")).toBe(result.tuiRenderedOutput);
        }
    }
    finally
    {
        await rm(workspace, { recursive: true, force: true });
    }
});
