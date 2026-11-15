import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

const clock = vi.hoisted(() => ({ now: 0 }));
vi.mock("node:timers/promises", () => ({
    setTimeout: async (ms: number) =>
    {
        clock.now += ms;
    },
}));

const archive = Buffer.from("validated release archive");
const shasum = createHash("sha1").update(archive).digest("hex");
const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
const tarball = "https://registry.npmjs.org/example/-/example.tgz";
let directory: string;
let version: string;
let originalArguments: string[];

beforeEach(async () =>
{
    vi.resetModules();
    clock.now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    vi.spyOn(console, "log").mockImplementation(() =>
    {});
    directory = await mkdtemp(path.join(os.tmpdir(), "published-package-"));
    const archivePath = path.join(directory, "release.tgz");
    await writeFile(archivePath, archive);
    version = JSON.parse(await readFile("package.json", "utf8")).version as string;
    originalArguments = process.argv;
    process.argv = [process.execPath, "scripts/verify-published-package.mjs", archivePath];
});

afterEach(async () =>
{
    process.argv = originalArguments;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
});

function metadata(available: boolean, content = archive): Response
{
    return Response.json(
        available
            ? {
                "dist-tags": { latest: version },
                versions: {
                    [version]: {
                        dist: {
                            tarball,
                            shasum: createHash("sha1").update(content).digest("hex"),
                            integrity: `sha512-${createHash("sha512").update(content).digest("base64")}`,
                        },
                    },
                },
            }
            : { "dist-tags": { latest: "previous" }, versions: {} },
    );
}

test("verifies the exact archive when publication takes more than a minute", async () =>
{
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => url === tarball ? new Response(archive) : metadata(clock.now >= 150_000)),
    );
    await import("../scripts/verify-published-package.mjs");
    expect(clock.now).toBe(150_000);
    const report = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string);
    expect(report).toMatchObject({ version, shasum, integrity, tarball, archiveMatches: true });
});

test("stops waiting after ten minutes when the version is still unavailable", async () =>
{
    vi.stubGlobal("fetch", vi.fn(async () => metadata(false)));
    await expect(import("../scripts/verify-published-package.mjs")).rejects.toBeInstanceOf(Error);
    expect(clock.now).toBe(600_000);
    expect(console.log).not.toHaveBeenCalled();
});

test("retries transient registry failures within the propagation deadline", async () =>
{
    let attempt = 0;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
        {
            if (url === tarball) return new Response(archive);
            attempt += 1;
            if (attempt === 1) throw new TypeError("temporary network failure");
            if (attempt <= 4) return new Response(null, { status: [404, 429, 503][attempt - 2]! });
            return metadata(true);
        }),
    );
    await import("../scripts/verify-published-package.mjs");
    expect(attempt).toBe(5);
    expect(clock.now).toBe(12_000);
    expect(console.log).toHaveBeenCalledOnce();
});

test.each(
    [200, 503].flatMap((status) =>
        [new TypeError("connection lost"), new DOMException("request timed out", "TimeoutError")].map((error) => ({
            status,
            error,
        }))
    ),
)(
    "retries when handling a $status registry response body fails: $error",
    async ({ status, error }) =>
    {
        let attempt = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) =>
            {
                if (url === tarball) return new Response(archive);
                attempt += 1;
                if (attempt === 1)
                {
                    return new Response(
                        new ReadableStream({
                            start(controller)
                            {
                                controller.error(error);
                            },
                        }),
                        { status },
                    );
                }
                return metadata(true);
            }),
        );
        await import("../scripts/verify-published-package.mjs");
        expect(attempt).toBe(2);
        expect(clock.now).toBe(3_000);
        expect(console.log).toHaveBeenCalledOnce();
    },
);

test("fails immediately on a permanent registry error", async () =>
{
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
    await expect(import("../scripts/verify-published-package.mjs")).rejects.toBeInstanceOf(Error);
    expect(clock.now).toBe(0);
    expect(console.log).not.toHaveBeenCalled();
});

test("rejects a registry archive with valid checksums but different validated bytes", async () =>
{
    const different = Buffer.from("different validated bytes");
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
        {
            if (url === tarball) return new Response(different);
            return metadata(true, different);
        }),
    );
    await expect(import("../scripts/verify-published-package.mjs")).rejects.toBeInstanceOf(Error);
    expect(console.log).not.toHaveBeenCalled();
});
test("rejects an archive that differs from the validated release", async () =>
{
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => url === tarball ? new Response("different archive") : metadata(true)),
    );
    await expect(import("../scripts/verify-published-package.mjs")).rejects.toBeInstanceOf(Error);
    expect(console.log).not.toHaveBeenCalled();
});
