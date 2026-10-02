import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { expect, test } from "vitest";

import { spawnOwnedPty } from "../src/runtime/owned-pty.js";
import { resolvePiCommand } from "../src/runtime/pi-command.js";

test("releases an owned terminal after the Pi CLI exits naturally", async () =>
{
    const launch = resolvePiCommand(path.resolve("node_modules/.bin/pi"), ["--version"]);
    const terminal = await spawnOwnedPty(launch.command, launch.arguments, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        env: process.env,
    }, 3_000);
    let output = "";
    terminal.onData((data) =>
    {
        output += data;
    });
    try
    {
        const code = await new Promise<number>((resolve) => terminal.onExit(({ exitCode }) => resolve(exitCode)));
        await terminal.dispose();
        expect(code).toBe(0);
        expect(stripVTControlCharacters(output).trim()).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/u);
        expect(() => process.kill(terminal.pid, 0)).toThrow();
    }
    finally
    {
        await terminal.dispose();
    }
}, 5_000);
