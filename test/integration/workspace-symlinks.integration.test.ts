import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    assistantMessage,
    getToolExecution,
    getToolResultText,
    PiIntegrationTest,
    testArtifactsDir,
    text,
    toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

// POSIX links do not require the extra Windows symlink privilege.
test.skipIf(process.platform === "win32")("shared workspaces preserve relative and broken symlink objects", async () =>
{
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-coding-agent-test-workspace-links-"));

    try
    {
        await writeFile(path.join(cwd, "data"), "before");
        await symlink("data", path.join(cwd, "relative"));
        await symlink("missing", path.join(cwd, "broken"));
        await mkdir(path.join(cwd, "nested"));
        await symlink("../data", path.join(cwd, "nested/relative"));
        await symlink("absent", path.join(cwd, "nested/broken"));
        await symlink("nested", path.join(cwd, "directory-link"));
        const script = [
            "const fs = require('node:fs');",
            "const before = { relative: fs.readlinkSync('relative'), broken: fs.readlinkSync('broken') };",
            "fs.renameSync('relative', 'moved');",
            "fs.symlinkSync('data', 'created');",
            "fs.symlinkSync('absent', 'new-broken');",
            "fs.writeFileSync('data', 'after');",
            "console.log(JSON.stringify(before));",
        ].join(" ");
        const run = await new PiIntegrationTest({
            testName: "shared-workspace-symlinks",
            artifactsDir: testArtifactsDir(import.meta.filename),
            cwd,
            isolateUserResources: true,
            tools: ["bash"],
            conversation: [
                assistantMessage([
                    toolCall({
                        id: "change-links",
                        name: "bash",
                        arguments: { command: `node -e ${JSON.stringify(script)}` },
                    }),
                ], { stopReason: "toolUse" }),
                assistantMessage([text("Done")]),
            ],
        }).run("Inspect and change symlink objects in the shared workspace");

        expect(run.exitCode).toBeNull();
        expect(getToolExecution(run, "change-links").isError).toBe(false);
        expect(JSON.parse(getToolResultText(run, "change-links"))).toEqual({ relative: "data", broken: "missing" });
        for (
            const [name, target] of Object.entries({
                moved: "data",
                created: "data",
                broken: "missing",
                "new-broken": "absent",
                "nested/relative": "../data",
                "nested/broken": "absent",
                "directory-link": "nested",
            })
        )
        {
            expect((await lstat(path.join(cwd, name))).isSymbolicLink()).toBe(true);
            expect(await readlink(path.join(cwd, name))).toBe(target);
        }
        await expect(lstat(path.join(cwd, "relative"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(path.join(cwd, "data"), "utf8")).toBe("after");
        expect(await readFile(path.join(cwd, "moved"), "utf8")).toBe("after");
        expect(await readFile(path.join(cwd, "directory-link/relative"), "utf8")).toBe("after");
    }
    finally
    {
        await rm(cwd, { recursive: true, force: true });
    }
});
