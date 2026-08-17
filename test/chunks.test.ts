import { describe, expect, it } from "vitest";

import { chunkString } from "../src/scenario/chunks.js";

describe("chunkString", () =>
{
    it("uses the exact explicit chunks", () =>
    {
        expect(chunkString("abcdef", { kind: "explicit", chunks: ["ab", "", "cde", "f"] })).toEqual([
            "ab",
            "",
            "cde",
            "f",
        ]);
    });

    it("rejects explicit chunks that change the input", () =>
    {
        expect(() => chunkString("abcdef", { kind: "explicit", chunks: ["abc", "ef"] })).toThrow(
            "Explicit chunks must concatenate to the input string",
        );
    });

    it("splits into fixed-size chunks", () =>
    {
        expect(chunkString("abcdefg", { kind: "fixed", size: 3 })).toEqual(["abc", "def", "g"]);
    });

    it("splits into Unicode characters", () =>
    {
        expect(chunkString("a🙂b", { kind: "characters" })).toEqual(["a", "🙂", "b"]);
    });

    it("rejects a non-positive fixed chunk size", () =>
    {
        expect(() => chunkString("abc", { kind: "fixed", size: 0 })).toThrow(
            "Fixed chunk size must be a positive integer",
        );
    });
    it("preserves an empty input", () =>
    {
        expect(chunkString("", { kind: "explicit", chunks: [] })).toEqual([]);
        expect(chunkString("", { kind: "fixed", size: 4 })).toEqual([]);
        expect(chunkString("", { kind: "characters" })).toEqual([]);
    });

    it("preserves raw JSON through every chunking mode", () =>
    {
        const raw = "{\"path\":\"src/файл.ts\",\"text\":\"line\\n\\\"quoted\\\"\"}";

        expect(chunkString(raw, { kind: "explicit", chunks: [raw.slice(0, 9), raw.slice(9)] }).join(""))
            .toBe(raw);
        expect(chunkString(raw, { kind: "fixed", size: 5 }).join(""))
            .toBe(raw);
        expect(chunkString(raw, { kind: "characters" }).join(""))
            .toBe(raw);
    });

    it("rejects fractional and negative fixed sizes", () =>
    {
        expect(() => chunkString("abc", { kind: "fixed", size: 1.5 })).toThrow(
            "Fixed chunk size must be a positive integer",
        );
        expect(() => chunkString("abc", { kind: "fixed", size: -1 })).toThrow(
            "Fixed chunk size must be a positive integer",
        );
    });
});
