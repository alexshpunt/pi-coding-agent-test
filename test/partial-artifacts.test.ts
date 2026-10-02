import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
    createIntegrationTestArtifacts,
    createIntegrationTestRuntimeArtifacts,
    prepareIntegrationTestArtifacts,
    writePartialRunBundle,
} from "../src/runtime/artifacts.js";
import { RunTimeoutError } from "../src/runtime/timeout-error.js";

test("partial bundles keep the raw incomplete tail without inventing a completed event", async () =>
{
    const root = path.resolve(".agents/tmp/partial-artifacts");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, "case-"));
    try
    {
        const options = { testName: "partial", artifactsDir: directory, conversation: [] };
        const artifacts = createIntegrationTestArtifacts(options);
        const runtime = createIntegrationTestRuntimeArtifacts(artifacts);
        await prepareIntegrationTestArtifacts({ artifacts, runtime, options });
        const raw = "{\"type\":\"agent_start\",\"sequence\":0,\"timestamp\":10}\n{\"type\":";
        await writeFile(runtime.trace, raw);
        await writePartialRunBundle(
            artifacts,
            runtime,
            directory,
            options,
            "prompt",
            new RunTimeoutError("deadline"),
            1,
        );
        expect(await readFile(path.join(artifacts.directory, "partial-trace.jsonl"), "utf8")).toBe(raw);
        const records = (await readFile(artifacts.run, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        expect(records.filter(record => record.kind === "trace")).toHaveLength(1);
        expect(records.find(record => record.kind === "summary")).toMatchObject({
            partial: true,
            status: "timeout",
            exitCode: null,
        });
        await writeFile(runtime.trace, "{broken}\n{\"type\":\"agent_start\"}\n");
        await expect(writePartialRunBundle(artifacts, runtime, directory, options, "prompt", new Error("bad trace"), 1))
            .rejects.toThrow();
    }
    finally
    {
        await rm(directory, { recursive: true, force: true });
    }
});
