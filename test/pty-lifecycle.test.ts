import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

// Check the whole command, not just a settled response: leaked PTY workers keep it alive.
test.each(["native", "raw", "standalone", "invalid", "timeout"])(
    "finishes the harness command after %s",
    async (scenario) =>
    {
        const temporaryRoot = path.join(process.cwd(), ".tmp", "pty-lifecycle");
        await mkdir(temporaryRoot, { recursive: true });
        const root = await mkdtemp(path.join(temporaryRoot, `${scenario}-`));
        const child = spawn(process.execPath, [
            "dist/cli.mjs",
            "run",
            "--",
            process.execPath,
            "test/fixtures/pty-lifecycle.mjs",
            scenario,
            root,
        ], { stdio: "pipe", env: process.env });
        let output = "";
        child.stdout.on("data", (data: Buffer) =>
        {
            output += data.toString();
        });
        child.stderr.on("data", (data: Buffer) =>
        {
            output += data.toString();
        });
        let timedOut = false;
        const timer = setTimeout(() =>
        {
            timedOut = true;
            if (process.platform === "win32" && child.pid !== undefined)
            {
                spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
            }
            else
            {
                child.kill("SIGKILL");
            }
        }, 15_000);

        let failure: unknown;
        try
        {
            const code = await new Promise<number | null>((resolve, reject) =>
            {
                child.once("error", reject);
                child.once("close", resolve);
            });
            expect(timedOut, output).toBe(false);
            expect(code, output).toBe(0);
            if (scenario !== "invalid")
            {
                const marker = JSON.parse(await readFile(path.join(root, "workspace/pty-process.json"), "utf8")) as {
                    pid: number;
                    parentPid: number;
                };
                expect(() => process.kill(marker.pid, 0), `Pi PID ${marker.pid} survived: ${output}`).toThrow();
                expect(() => process.kill(marker.parentPid, 0), `Owner PID ${marker.parentPid} survived: ${output}`)
                    .toThrow();
            }
            expect(output).toContain(
                scenario === "invalid" || scenario === "timeout" ? "EXPECTED_FAILURE" : "EXPECTED_RESULT",
            );
        }
        catch (error)
        {
            failure = error;
            throw error;
        }
        finally
        {
            clearTimeout(timer);
            try
            {
                await rm(root, { recursive: true, force: true });
            }
            catch (cleanupError)
            {
                throw new AggregateError(
                    [failure, cleanupError],
                    `Lifecycle ${scenario} failed: ${String(failure)}; cleanup: ${String(cleanupError)}\n${output}`,
                );
            }
        }
    },
    20_000,
);
