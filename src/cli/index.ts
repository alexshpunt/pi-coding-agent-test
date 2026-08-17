import path from "node:path";

import { runLiveCommand } from "./live.js";
import { runReplayCommand } from "./replay.js";
import { runRunCommand } from "./run.js";

import type { LiveCommandOptions } from "./live.js";
import type { ReplayCommandOptions } from "./replay.js";
import type { RunCommandOptions } from "./run.js";
import type { TestCommand } from "./test-command.js";

const help = `pi-test — real-process testing for Pi Coding Agent

Usage:
  pi-test run [options] -- <test-command> [arguments...]
  pi-test live [options] -- <test-command> [arguments...]
  pi-test replay <run-dir-or-run.jsonl> [options]

Commands:
  run       Run any test command with a shared Pi process
  live      Repeat any test command with live Pi TUI output
  replay    Reconstruct and inspect frames from run.jsonl

Run "pi-test <command> --help" for command options.
`;

const runHelp = `Usage:
  pi-test run [options] -- <test-command> [arguments...]

Options:
  --cwd <directory>             Child working directory; defaults to cwd
  --help                        Show this help
`;

const liveHelp = `Usage:
  pi-test live [options] -- <test-command> [arguments...]

Options:
  --cwd <directory>             Child working directory; defaults to cwd
  --stream-profile <name>       Streaming profile; defaults to gpt-5.6-sol-xhigh
  --delay-ms <milliseconds>     Fixed delta delay instead of a stream profile
  --pause-ms <milliseconds>     Loop delay; defaults to 2000
  --once                        Run once instead of looping
  --help                        Show this help
`;

const replayHelp = `Usage:
  pi-test replay <run-dir-or-run.jsonl> [options]

Options:
  --root <directory>            Base for relative paths; defaults to cwd
  --output <directory>          Output directory; defaults to <run-dir>/frames
  --frames <selection>          Frames to save, for example 27,31,35-38
  --play                        Play reconstructed frames in the terminal
  --frame-delay-ms <number>     Override recorded timing with a fixed delay
  --speed <number>              Playback speed multiplier; defaults to 1
  --help                        Show this help
`;

interface AllowedArguments
{
    readonly boolean: ReadonlySet<string>;
    readonly value: ReadonlySet<string>;
}

interface ParsedArguments
{
    readonly flags: ReadonlySet<string>;
    readonly positionals: readonly string[];
    readonly values: ReadonlyMap<string, string>;
}

interface ParsedTestCommand
{
    readonly command: TestCommand;
    readonly parsed: ParsedArguments;
}

try
{
    await main(process.argv.slice(2));
}
catch (error)
{
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pi-test: ${message}\n`);
    process.exitCode = 1;
}

async function main(arguments_: readonly string[]): Promise<void>
{
    const command = arguments_[0];
    const commandArguments = arguments_.slice(1);

    if (command === undefined || command === "help" || command === "--help" || command === "-h")
    {
        process.stdout.write(help);
        return;
    }

    if (command === "run")
    {
        if (hasCommandHelp(commandArguments))
        {
            process.stdout.write(runHelp);
            return;
        }

        process.exitCode = await runRunCommand(parseRunOptions(commandArguments));
        return;
    }

    if (command === "live")
    {
        if (hasCommandHelp(commandArguments))
        {
            process.stdout.write(liveHelp);
            return;
        }

        process.exitCode = await runLiveCommand(parseLiveOptions(commandArguments));
        return;
    }

    if (command === "replay")
    {
        if (commandArguments.includes("--help") || commandArguments.includes("-h"))
        {
            process.stdout.write(replayHelp);
            return;
        }

        await runReplayCommand(parseReplayOptions(commandArguments));
        return;
    }

    throw new Error(`Unknown command: ${command}`);
}

function hasCommandHelp(arguments_: readonly string[]): boolean
{
    const separator = arguments_.indexOf("--");
    const ownArguments = separator === -1 ? arguments_ : arguments_.slice(0, separator);
    return ownArguments.includes("--help") || ownArguments.includes("-h");
}

function parseTestCommandInvocation(
    arguments_: readonly string[],
    allowed: AllowedArguments,
    commandName: "live" | "run",
): ParsedTestCommand
{
    const separator = arguments_.indexOf("--");

    if (separator === -1)
    {
        throw new Error(`${commandName} requires -- <test-command>`);
    }

    const parsed = parseArguments(arguments_.slice(0, separator), allowed);

    if (parsed.positionals.length > 0)
    {
        throw new Error(`Unexpected argument before --: ${parsed.positionals[0]}`);
    }

    const executable = arguments_[separator + 1];

    if (executable === undefined || executable.trim() === "")
    {
        throw new Error(`${commandName} requires a test command after --`);
    }

    return {
        command: {
            executable,
            arguments: arguments_.slice(separator + 2),
        },
        parsed,
    };
}

function parseRunOptions(arguments_: readonly string[]): RunCommandOptions
{
    const { command, parsed } = parseTestCommandInvocation(arguments_, {
        boolean: new Set(),
        value: new Set(["--cwd"]),
    }, "run");

    return {
        ...command,
        cwd: path.resolve(process.cwd(), parsed.values.get("--cwd") ?? "."),
    };
}

function parseLiveOptions(arguments_: readonly string[]): LiveCommandOptions
{
    const { command, parsed } = parseTestCommandInvocation(arguments_, {
        boolean: new Set(["--once"]),
        value: new Set([
            "--cwd",
            "--delay-ms",
            "--pause-ms",
            "--stream-profile",
        ]),
    }, "live");
    const explicitProfile = parsed.values.get("--stream-profile");
    const fixedDelay = parsed.values.get("--delay-ms");

    if (explicitProfile !== undefined && fixedDelay !== undefined)
    {
        throw new Error("--stream-profile and --delay-ms cannot be used together");
    }

    if (explicitProfile === "")
    {
        throw new Error("--stream-profile must not be empty");
    }

    return {
        ...command,
        cwd: path.resolve(process.cwd(), parsed.values.get("--cwd") ?? "."),
        ...(fixedDelay === undefined ? {} : { delayMs: parseNonNegativeInteger(fixedDelay, "--delay-ms") }),
        ...(explicitProfile === undefined && fixedDelay !== undefined
            ? {}
            : { streamProfile: explicitProfile ?? "gpt-5.6-sol-xhigh" }),
        pauseMs: parseNonNegativeInteger(parsed.values.get("--pause-ms") ?? "2000", "--pause-ms"),
        once: parsed.flags.has("--once"),
    };
}

function parseReplayOptions(arguments_: readonly string[]): ReplayCommandOptions
{
    const parsed = parseArguments(arguments_, {
        boolean: new Set(["--play"]),
        value: new Set(["--frame-delay-ms", "--frames", "--output", "--root", "--speed"]),
    });
    const input = parsed.positionals[0];

    if (parsed.positionals.length !== 1 || input === undefined)
    {
        throw new Error("replay requires a run directory or run.jsonl");
    }

    const root = path.resolve(process.cwd(), parsed.values.get("--root") ?? ".");
    const output = parsed.values.get("--output");
    const frames = parsed.values.get("--frames");

    return {
        input: path.resolve(root, input),
        ...(output === undefined ? {} : { output: path.resolve(root, output) }),
        ...(frames === undefined ? {} : { frames }),
        play: parsed.flags.has("--play"),
        ...(parsed.values.has("--frame-delay-ms")
            ? { frameDelayMs: parseNonNegativeInteger(parsed.values.get("--frame-delay-ms") ?? "", "--frame-delay-ms") }
            : {}),
        speed: parsePositiveNumber(parsed.values.get("--speed") ?? "1", "--speed"),
    };
}

function parseArguments(arguments_: readonly string[], allowed: AllowedArguments): ParsedArguments
{
    const flags = new Set<string>();
    const positionals: string[] = [];
    const values = new Map<string, string>();

    for (let index = 0; index < arguments_.length; index += 1)
    {
        const argument = arguments_[index];

        if (argument === undefined)
        {
            continue;
        }

        if (!argument.startsWith("--"))
        {
            positionals.push(argument);
            continue;
        }

        if (allowed.boolean.has(argument))
        {
            if (flags.has(argument))
            {
                throw new Error(`Duplicate option: ${argument}`);
            }

            flags.add(argument);
            continue;
        }

        if (!allowed.value.has(argument))
        {
            throw new Error(`Unknown option: ${argument}`);
        }

        if (values.has(argument))
        {
            throw new Error(`Duplicate option: ${argument}`);
        }

        const value = arguments_[index + 1];

        if (value === undefined || value.startsWith("--"))
        {
            throw new Error(`${argument} requires a value`);
        }

        values.set(argument, value);
        index += 1;
    }

    return { flags, positionals, values };
}

function parseNonNegativeInteger(value: string, name: string): number
{
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)))
    {
        throw new Error(`${name} must be a non-negative integer`);
    }

    return Number(value);
}

function parsePositiveNumber(value: string, name: string): number
{
    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed <= 0)
    {
        throw new Error(`${name} must be a positive number`);
    }

    return parsed;
}
