import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

interface CliResult
{
    readonly status: number | null;
    readonly stderr: string;
    readonly stdout: string;
}

afterEach(async () =>
{
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) =>
            rm(directory, {
                recursive: true,
                force: true,
            })
        ),
    );
});

describe("pi-test CLI", () =>
{
    it("describes its public commands", () =>
    {
        const result = runCli(["--help"]);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("pi-test run");
        expect(result.stdout).toContain("pi-test live");
        expect(result.stdout).toContain("pi-test replay");
    });

    it("rejects an unknown command", () =>
    {
        const result = runCli(["unknown"]);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Unknown command: unknown");
    });

    it("rejects conflicting live pacing options", () =>
    {
        const result = runCli([
            "live",
            "--stream-profile",
            "gpt-5.6-sol-xhigh",
            "--delay-ms",
            "10",
            "--",
            process.execPath,
            "-e",
            "",
        ]);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("--stream-profile and --delay-ms cannot be used together");
    });

    it("runs any child command with its arguments, cwd, and shared Pi endpoint", async () =>
    {
        const cwd = await createTemporaryDirectory();
        const script = [
            "const result = {",
            "    args: process.argv.slice(1),",
            "    cwd: process.cwd(),",
            "    shared: process.env.PI_INTEGRATION_TEST_RUNNER !== undefined,",
            "};",
            "process.stdout.write(JSON.stringify(result));",
        ].join("\n");
        const result = runCli([
            "run",
            "--cwd",
            cwd,
            "--",
            process.execPath,
            "-e",
            script,
            "first",
            "two words",
            "--runner-option",
        ]);

        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            args: ["first", "two words", "--runner-option"],
            cwd,
            shared: true,
        });
    });

    it("preserves the child command exit status", () =>
    {
        const result = runCli(["run", "--", process.execPath, "-e", "process.exit(7);"]);

        expect(result.status).toBe(7);
    });

    it("shows Pi frames without successful runner noise in live mode", () =>
    {
        const beginFrame = "\u001B[?2026h";
        const endFrame = "\u001B[?2026l";
        const script = [
            "process.stdout.write(Buffer.from('cnVubmVyIG5vaXNl', 'base64').toString('utf8') + '\\n');",
            "process.stderr.write(Buffer.from('cnVubmVyIHdhcm5pbmc=', 'base64').toString('utf8') + '\\n');",
            "const state = JSON.stringify({",
            "    delay: process.env.PI_INTEGRATION_TEST_DELTA_DELAY_MS,",
            "    live: process.env.PI_INTEGRATION_TEST_LIVE,",
            "    shared: process.env.PI_INTEGRATION_TEST_RUNNER !== undefined,",
            "});",
            `process.stderr.write(${JSON.stringify(beginFrame)} + state + ${JSON.stringify(endFrame)});`,
        ].join("\n");
        const result = runCli([
            "live",
            "--once",
            "--delay-ms",
            "0",
            "--",
            process.execPath,
            "-e",
            script,
        ]);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(beginFrame);
        expect(result.stdout).toContain("\"delay\":\"0\"");
        expect(result.stdout).toContain("\"live\":\"1\"");
        expect(result.stdout).toContain("\"shared\":true");
        expect(result.stdout).not.toContain("runner noise");
        expect(result.stderr).not.toContain("runner warning");
    });

    it("prints captured runner output when a live command fails", () =>
    {
        const script = [
            "process.stdout.write(Buffer.from('cnVubmVyIGZhaWx1cmUgb3V0cHV0', 'base64').toString('utf8') + '\\n');",
            "process.stderr.write(Buffer.from('cnVubmVyIGZhaWx1cmUgZXJyb3I=', 'base64').toString('utf8') + '\\n');",
            "process.exit(9);",
        ].join("\n");
        const result = runCli(["live", "--once", "--", process.execPath, "-e", script]);

        expect(result.status).toBe(9);
        expect(result.stderr).toContain("runner failure output");
        expect(result.stderr).toContain("runner failure error");
    });

    it("reconstructs indexed and selected terminal frames", async () =>
    {
        const fixture = await createReplayFixture();
        const output = path.join(fixture, "frames");
        const result = runCli(["replay", fixture, "--output", output, "--frames", "1-2"]);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("Indexed 2 synchronized frames");
        expect(await readFile(path.join(output, "index.tsv"), "utf8")).toContain("2\t");
        expect(await readFile(path.join(output, "frame-000001.txt"), "utf8")).toContain("first frame");
        expect(await readFile(path.join(output, "frame-000002.txt"), "utf8")).toContain("second frame");
        expect(await readFile(path.join(output, "final.txt"), "utf8")).toContain("second frame");
    });

    it("plays reconstructed frames with an explicit fixed delay", async () =>
    {
        const fixture = await createReplayFixture();
        const result = runCli([
            "replay",
            fixture,
            "--output",
            path.join(fixture, "frames"),
            "--play",
            "--frame-delay-ms",
            "0",
        ]);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("Playback uses a fixed 0 ms frame delay");
        expect(result.stdout).toContain("first frame");
        expect(result.stdout).toContain("second frame");
    });

    it("uses recorded frame timing and the speed multiplier", async () =>
    {
        const fixture = await createReplayFixture([0, 0]);
        const result = runCli([
            "replay",
            fixture,
            "--output",
            path.join(fixture, "frames"),
            "--play",
            "--speed",
            "2",
        ]);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("Playback uses recorded frame timing at 2x speed");
    });

    it("falls back to the default delay for old recordings without timing metadata", async () =>
    {
        const fixture = await createReplayFixture();
        const result = runCli([
            "replay",
            fixture,
            "--output",
            path.join(fixture, "frames"),
            "--play",
        ]);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("Playback uses a fixed 80 ms frame delay at 1x speed");
    });
});

function runCli(arguments_: readonly string[]): CliResult
{
    const result = spawnSync(process.execPath, [cli, ...arguments_], {
        encoding: "utf8",
        env: {
            ...process.env,
            NO_COLOR: "1",
        },
    });

    if (result.error !== undefined)
    {
        throw result.error;
    }

    return {
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
    };
}

async function createTemporaryDirectory(prefix = "pi-test-cli-"): Promise<string>
{
    const directory = await mkdtemp(path.join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

async function createReplayFixture(frameDelaysMs?: readonly number[]): Promise<string>
{
    const directory = await createTemporaryDirectory("pi-test-replay-");
    await mkdir(directory, { recursive: true });

    const beginFrame = "\u001B[?2026h";
    const endFrame = "\u001B[?2026l";
    const clear = "\u001B[2J\u001B[H";
    const stream = [
        beginFrame,
        clear,
        "first frame",
        endFrame,
        beginFrame,
        clear,
        "second frame",
        endFrame,
    ].join("");
    await writeFile(
        path.join(directory, "run.jsonl"),
        [
            {
                kind: "summary",
                tuiSize: { cols: 40, rows: 5 },
                ...(frameDelaysMs === undefined ? {} : { frameDelaysMs }),
            },
            { kind: "terminal", data: stream },
        ].map((record) => JSON.stringify(record)).join("\n") + "\n",
        "utf8",
    );

    return directory;
}
