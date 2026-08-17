#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$ROOT/test/examples/replay-recording/run.jsonl"

npm --prefix "$ROOT" run build >/dev/null

printf 'Replaying the checked-in run bundle: %s\n' "$BUNDLE"
node --input-type=module - "$BUNDLE" <<'NODE'
import { readFile } from "node:fs/promises";

const bundlePath = process.argv[2];
const records = (await readFile(bundlePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const stream = records.find((record) => record.kind === "terminal")?.data;

if (typeof stream !== "string")
{
    throw new Error(`Run bundle has no terminal record: ${bundlePath}`);
}
const frameEnd = "\u001B[?2026l";
const frameDelayMs = 80;
let offset = 0;

for (;;)
{
    const end = stream.indexOf(frameEnd, offset);

    if (end === -1)
    {
        break;
    }

    const nextOffset = end + frameEnd.length;
    process.stdout.write(stream.slice(offset, nextOffset));
    offset = nextOffset;
    await new Promise((resolve) => setTimeout(resolve, frameDelayMs));
}

if (offset < stream.length)
{
    process.stdout.write(stream.slice(offset));
}

process.stdout.write("\u001B[0m\u001B[?25h\u001B[?2004l\n");
NODE
