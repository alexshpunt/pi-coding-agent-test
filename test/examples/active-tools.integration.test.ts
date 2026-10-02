import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, PiIntegrationTest, testArtifactsDir, text } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("all preserves default active tools and explicit selections can enable inactive tools", async () =>
{
    const parent = path.resolve(".agents/tmp/active-tools");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(path.join(parent, "run-"));
    try
    {
        const selections = [undefined, "all", { exclude: ["bash"] }, ["grep", "ls"]] as const;
        const observed: string[][] = [];
        for (const [index, tools] of selections.entries())
        {
            const cwd = path.join(root, String(index));
            await mkdir(cwd);
            await new PiIntegrationTest({
                testName: `active-tools-${index}`,
                artifactsDir: testArtifactsDir(import.meta.filename),
                cwd,
                transport: "rpc",
                rawMode: false,
                ...(tools === undefined ? {} : { tools }),
                extensions: [path.join(path.dirname(import.meta.filename), "fixtures/active-tools-extension.ts")],
                conversation: [assistantMessage([text("Done")])],
            }).run("Finish without using tools.");
            observed.push(JSON.parse(await readFile(path.join(cwd, "active-tools.json"), "utf8")) as string[]);
        }
        expect(observed[0]).toContain("bash");
        expect(observed[0]).not.toContain("grep");
        expect(observed[0]).not.toContain("ls");
        expect(observed[1]).toEqual(observed[0]);
        expect(observed[2]).toEqual(observed[0]!.filter(name => name !== "bash"));
        expect(observed[3]).toEqual(["grep", "ls"]);
    }
    finally
    {
        await rm(root, { recursive: true, force: true });
    }
});
