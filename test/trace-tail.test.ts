import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TraceTail } from "../src/runtime/trace.js";

describe("incremental trace reading", () =>
{
    let directory: string;
    let file: string;

    beforeEach(async () =>
    {
        directory = await mkdtemp(path.join(os.tmpdir(), "trace-tail-"));
        file = path.join(directory, "trace.jsonl");
        await writeFile(file, "");
    });

    afterEach(async () =>
    {
        await rm(directory, { recursive: true, force: true });
    });

    it("returns events appended between polls and keeps a partial line pending", async () =>
    {
        const tail = new TraceTail(file);
        expect(await tail.poll()).toEqual([]);

        await appendFile(file, `${JSON.stringify({ type: "a", sequence: 0, text: "é" })}\n{"type":"b",`);
        expect((await tail.poll()).map((event) => event.type)).toEqual(["a"]);

        await appendFile(file, `"sequence":1}\n`);
        const events = await tail.poll();
        expect(events.map((event) => event.type)).toEqual(["a", "b"]);
        expect(events[0]).toMatchObject({ text: "é" });
    });

    it("starts over when the file is replaced by a shorter one", async () =>
    {
        const tail = new TraceTail(file);
        await appendFile(file, `${JSON.stringify({ type: "old", sequence: 0, padding: "x".repeat(64) })}\n`);
        await tail.poll();

        await writeFile(file, `${JSON.stringify({ type: "new", sequence: 0 })}\n`);
        expect((await tail.poll()).map((event) => event.type)).toEqual(["new"]);
    });

    it("rejects a malformed complete line", async () =>
    {
        const tail = new TraceTail(file);
        await appendFile(file, "not json\n");
        await expect(tail.poll()).rejects.toThrow(SyntaxError);
    });
});
