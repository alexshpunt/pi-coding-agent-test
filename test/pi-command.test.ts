import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "vitest";

import { resolvePiCommand } from "../src/runtime/pi-command.js";

test("launches the selected Windows Pi shim from public bin metadata even when package.json is not exported", () =>
{
    const shim = path.resolve("node_modules/.bin/pi.cmd");
    const manifestPath = path.resolve("node_modules/@earendil-works/pi-coding-agent/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin: { pi: string; }; };
    const launch = resolvePiCommand(shim, ["--version"], process.env, "win32");
    expect(launch.command).toBe(process.execPath);
    expect(launch.arguments).toEqual([path.resolve(path.dirname(manifestPath), manifest.bin.pi), "--version"]);
    expect(existsSync(launch.arguments[0]!)).toBe(true);
});

test("does not substitute an arbitrary existing pi file with the installed host", () =>
{
    const command = path.resolve(".tmp/unlaunchable/pi");
    expect(resolvePiCommand(command, ["--version"], process.env, "win32")).toEqual({
        command,
        arguments: ["--version"],
    });
});
