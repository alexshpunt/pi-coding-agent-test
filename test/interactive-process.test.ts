import { describe, expect, test, vi } from "vitest";

import { stopPty } from "../src/runtime/interactive-process.js";
import { resolvePtyCommand } from "../src/runtime/pi-command.js";

describe("Windows interactive process", () =>
{
    test("resolves a bare Pi command through PATHEXT", () =>
    {
        const exists = vi.fn((candidate: string) => candidate === "C:\\tools\\pi.CMD");

        expect(resolvePtyCommand("pi", "win32", {
            PATH: "C:\\other;C:\\tools",
            PATHEXT: ".EXE;.CMD",
        }, exists)).toBe("C:\\tools\\pi.CMD");
    });

    test("stops a Windows PTY without passing a Unix signal", () =>
    {
        const kill = vi.fn();

        stopPty({ kill } as never, "win32");

        expect(kill).toHaveBeenCalledWith();
    });

    test("keeps graceful SIGTERM shutdown on Unix", () =>
    {
        const kill = vi.fn();

        stopPty({ kill } as never, "linux");

        expect(kill).toHaveBeenCalledWith("SIGTERM");
    });
});
