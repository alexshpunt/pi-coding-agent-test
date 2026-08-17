import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_TUI_SIZE } from "../runtime/constants.js";
import { TuiRenderer } from "../terminal/renderer.js";
import { synchronizedFrameEndOffsets } from "../terminal/synchronized-output.js";

import type { TuiSize } from "../scenario/types.js";

const maxSelectedFrames = 1_000;
const playbackFrameReset =
    "\u001B[0m\u001B[?25h\u001B[?2004l\u001B[?2026l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1006l\u001B[?1015l\u001B[<100u\u001B[=0u\u001B[>4;0m";
const playbackTerminalReset = `${playbackFrameReset}\u001B[?1049l\u001B[?1047l\u001B[?47l`;

export interface ReplayCommandOptions
{
    readonly input: string;
    readonly output?: string;
    readonly frames?: string;
    readonly play: boolean;
    readonly frameDelayMs?: number;
    readonly speed: number;
}

interface ReplayInput
{
    readonly terminalLog: string;
    readonly artifactDirectory: string;
    readonly frameDelaysMs?: readonly number[];
    readonly stream: string;
}

interface BundlePlaybackData
{
    readonly stream: string;
    readonly frameDelaysMs?: readonly number[];
}

interface FrameChange
{
    readonly rows: string;
    readonly text: string;
}

export async function runReplayCommand(options: ReplayCommandOptions): Promise<void>
{
    const input = await resolveInput(options.input);
    const output = path.resolve(options.output ?? path.join(input.artifactDirectory, "frames"));
    const size = await readTuiSize(input.artifactDirectory);
    const selectedFrames = parseFrameSelection(options.frames);
    const frameEnds = synchronizedFrameEndOffsets(input.stream);

    assertSafeOutput(input, output);

    if (frameEnds.length === 0)
    {
        throw new Error(`No synchronized TUI frames found in ${input.terminalLog}`);
    }

    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });

    if (options.play)
    {
        const timingMessage = input.frameDelaysMs !== undefined
                && input.frameDelaysMs.length > 0
                && options.frameDelayMs === undefined
            ? `Playback uses recorded frame timing at ${options.speed}x speed.\n`
            : `Playback uses a fixed ${options.frameDelayMs ?? 80} ms frame delay at ${options.speed}x speed.\n`;
        process.stdout.write(timingMessage);
    }

    const renderer = new TuiRenderer(size);
    const indexLines = ["frame\tstream_offset\tchanged_rows\tchanged_text"];
    let appliedOffset = 0;
    let previousFrame = "";

    try
    {
        for (const [index, streamEnd] of frameEnds.entries())
        {
            renderer.write(input.stream.slice(appliedOffset, streamEnd));
            await renderer.flush();

            const frameNumber = index + 1;
            const rendered = renderer.render();
            const change = describeChange(previousFrame, rendered);

            indexLines.push(`${frameNumber}\t${streamEnd}\t${change.rows}\t${change.text}`);

            if (selectedFrames.has(frameNumber))
            {
                await writeFrame(output, frameNumber, rendered);
            }

            if (options.play)
            {
                await delay(resolveFrameDelay(input.frameDelaysMs, index, options));
                playFrame(rendered);
            }

            previousFrame = rendered;
            appliedOffset = streamEnd;
        }

        renderer.write(input.stream.slice(appliedOffset));
        await renderer.flush();

        const finalFrame = renderer.render();
        await writeFile(path.join(output, "index.tsv"), `${indexLines.join("\n")}\n`, "utf8");
        await writeFile(path.join(output, "final.txt"), finalFrame, "utf8");

        const missing = [...selectedFrames].filter((frame) => frame > frameEnds.length);

        if (missing.length > 0)
        {
            throw new Error(
                `Requested frame(s) exceed the ${frameEnds.length} captured frames: ${missing.join(", ")}`,
            );
        }

        process.stdout.write(`Indexed ${frameEnds.length} synchronized frames from ${input.terminalLog}\n`);
        process.stdout.write(`Frame index: ${path.join(output, "index.tsv")}\n`);
        process.stdout.write(`Final screen: ${path.join(output, "final.txt")}\n`);

        if (selectedFrames.size > 0)
        {
            process.stdout.write(
                `Selected frames: ${[...selectedFrames].sort((left, right) => left - right).join(", ")}\n`,
            );
        }
    }
    finally
    {
        renderer.dispose();

        if (options.play)
        {
            process.stdout.write(`${playbackTerminalReset}\n`);
        }
    }
}

async function resolveInput(input: string): Promise<ReplayInput>
{
    const resolvedInput = path.resolve(input);
    const isTerminalLog = input.endsWith(".log");
    let artifactDirectory = resolvedInput;

    if (isTerminalLog || input.endsWith(".jsonl"))
    {
        artifactDirectory = path.dirname(resolvedInput);
    }

    const terminalLog = isTerminalLog ? resolvedInput : path.join(artifactDirectory, "run.jsonl");
    const playback: BundlePlaybackData | null = isTerminalLog
        ? await readFile(terminalLog, "utf8").then((stream) => ({ stream })).catch(() => null)
        : await readBundleTerminal(terminalLog);

    if (playback === null)
    {
        throw new Error(`Cannot read terminal stream: ${terminalLog}`);
    }

    return {
        terminalLog,
        artifactDirectory,
        ...(playback.frameDelaysMs === undefined ? {} : { frameDelaysMs: playback.frameDelaysMs }),
        stream: playback.stream,
    };
}

async function readBundleTerminal(runFile: string): Promise<BundlePlaybackData | null>
{
    const contents = await readFile(runFile, "utf8").catch(() => null);

    if (contents === null)
    {
        return null;
    }

    try
    {
        const records = contents
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) =>
                JSON.parse(line) as {
                    readonly kind?: unknown;
                    readonly data?: unknown;
                    readonly frameDelaysMs?: unknown;
                }
            );
        const terminal = records.find((record) => record.kind === "terminal");
        const summary = records.find((record) => record.kind === "summary");

        if (typeof terminal?.data !== "string")
        {
            return null;
        }

        return {
            stream: terminal.data,
            ...(isNumberArray(summary?.frameDelaysMs) ? { frameDelaysMs: summary.frameDelaysMs } : {}),
        };
    }
    catch
    {
        return null;
    }
}

function assertSafeOutput(input: ReplayInput, output: string): void
{
    if (
        output === input.artifactDirectory
        || input.artifactDirectory.startsWith(`${output}${path.sep}`)
        || input.terminalLog === output
        || input.terminalLog.startsWith(`${output}${path.sep}`)
    )
    {
        throw new Error(`Replay output must not contain or replace the source artifacts: ${output}`);
    }
}

async function readTuiSize(artifactDirectory: string): Promise<TuiSize>
{
    const runFile = path.join(artifactDirectory, "run.jsonl");

    try
    {
        const contents = await readFile(runFile, "utf8");
        const records = contents
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { readonly kind?: unknown; readonly tuiSize?: unknown; });
        const summary = records.find((record) => record.kind === "summary");
        const size = summary?.tuiSize;
        const cols = isRecord(size) ? size.cols : undefined;
        const rows = isRecord(size) ? size.rows : undefined;

        if (Number.isSafeInteger(cols) && Number(cols) > 0 && Number.isSafeInteger(rows) && Number(rows) > 0)
        {
            return { cols: Number(cols), rows: Number(rows) };
        }
    }
    catch
    {
        // Failed or interrupted runs may not have a complete run bundle.
    }

    return DEFAULT_TUI_SIZE;
}

function isRecord(value: unknown): value is Record<string, unknown>
{
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown): value is readonly number[]
{
    return Array.isArray(value) && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function parseFrameSelection(value: string | undefined): Set<number>
{
    const frames = new Set<number>();

    if (value === undefined || value.trim() === "")
    {
        return frames;
    }

    for (const part of value.split(","))
    {
        const trimmed = part.trim();
        const range = /^(\d+)-(\d+)$/u.exec(trimmed);

        if (range !== null)
        {
            const start = parsePositiveSafeInteger(range[1] ?? "", `Invalid frame range: ${part}`);
            const end = parsePositiveSafeInteger(range[2] ?? "", `Invalid frame range: ${part}`);

            if (end < start)
            {
                throw new Error(`Invalid frame range: ${part}`);
            }

            for (let frame = start; frame <= end; frame += 1)
            {
                frames.add(frame);

                if (frames.size > maxSelectedFrames)
                {
                    throw new Error(`Select at most ${maxSelectedFrames} frames at once`);
                }
            }

            continue;
        }

        frames.add(parsePositiveSafeInteger(trimmed, `Invalid frame number: ${part}`));
    }

    return frames;
}

function parsePositiveSafeInteger(value: string, message: string): number
{
    const parsed = Number(value);

    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < 1)
    {
        throw new Error(message);
    }

    return parsed;
}

function describeChange(before: string, after: string): FrameChange
{
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    const changedRows: number[] = [];
    const changedText: string[] = [];
    const lineCount = Math.max(beforeLines.length, afterLines.length);

    for (let index = 0; index < lineCount; index += 1)
    {
        const previous = beforeLines[index] ?? "";
        const current = afterLines[index] ?? "";

        if (previous === current)
        {
            continue;
        }

        changedRows.push(index + 1);
        const visible = current.trim().length > 0 ? current.trim() : `[removed: ${previous.trim()}]`;

        if (visible.length > 0)
        {
            changedText.push(visible);
        }
    }

    return {
        rows: compressRows(changedRows),
        text: sanitizeIndexText(changedText.join(" | ")),
    };
}

function compressRows(rows: readonly number[]): string
{
    if (rows.length === 0)
    {
        return "-";
    }

    const ranges: string[] = [];
    let start = rows[0] ?? 0;
    let end = start;

    for (const row of rows.slice(1))
    {
        if (row === end + 1)
        {
            end = row;
            continue;
        }

        ranges.push(start === end ? String(start) : `${start}-${end}`);
        start = row;
        end = row;
    }

    ranges.push(start === end ? String(start) : `${start}-${end}`);
    return ranges.join(",");
}

function sanitizeIndexText(value: string): string
{
    const oneLine = value.replaceAll("\t", " ").replaceAll("\r", " ").replaceAll("\n", " ");
    return oneLine.length <= 400 ? oneLine : `${oneLine.slice(0, 397)}...`;
}

async function writeFrame(output: string, frameNumber: number, rendered: string): Promise<void>
{
    const name = `frame-${String(frameNumber).padStart(6, "0")}.txt`;
    await writeFile(path.join(output, name), rendered, "utf8");
}

function resolveFrameDelay(
    frameDelaysMs: readonly number[] | undefined,
    frameIndex: number,
    options: ReplayCommandOptions,
): number
{
    const recordedDelay = frameDelaysMs?.[frameIndex];
    const delayMs = options.frameDelayMs ?? recordedDelay ?? 80;
    return Math.max(0, delayMs / options.speed);
}

function delay(milliseconds: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function playFrame(rendered: string): void
{
    process.stdout.write(`${playbackFrameReset}\u001B[2J\u001B[H`);
    process.stdout.write(rendered);
}
