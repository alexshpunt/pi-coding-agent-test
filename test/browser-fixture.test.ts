import { type ChildProcess, spawn } from "node:child_process";
import {
    access,
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    readlink,
    rename,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    type BrowserFixture,
    type BrowserFixtureOptions,
    createBrowserFixture,
    withBrowserFixture,
} from "pi-coding-agent-test";
import { afterEach, describe, expect, test } from "vitest";

const ownedDirectories: string[] = [];
const recoveryCommand = "npx playwright install chromium";
const childTimeoutMs = 5_000;
const childTerminationTimeoutMs = 1_000;
const gracefulTerminationMs = 200;
const browserCleanupBoundMs = 3_000;
const consumerContract = path.join(process.cwd(), "test", "fixtures", "verify-browser-package-consumers.mjs");
const concurrentOwnershipRaceScenario = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "ale44-concurrent-browser-ownership-race.mjs",
);

const zombieExitBoundaryScenario = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "ale44-zombie-exit-boundary.mjs",
);
const zombieWaitpidSource = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "ale44-zombie-waitpid.c",
);

const pid1ZombieBoundaryScenario = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "ale44-pid1-zombie-boundary.mjs",
);
const pid1ZombieWaitpidSource = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "ale44-pid1-zombie-waitpid.c",
);
const pidNamespaceCapability = await detectPidNamespaceCapability();

if (!pidNamespaceCapability.available)
{
    console.warn(`ALE-44 PID namespace regression skipped: ${pidNamespaceCapability.evidence}`);
}

const lateBrowserDescendantScenario = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "ale44-late-browser-descendant.mjs",
);

const shutdownWindowDescendantScenario = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "ale44-shutdown-window-descendant.mjs",
);
const retainedGenerationCollisionScenario = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "ale44-retained-generation-collision.mjs",
);

const childEdgeToctouScenario = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "ale44-child-edge-toctou.mjs",
);

const failingChromiumCommand = path.join(process.cwd(), "test", "fixtures", "failing-chromium-launch.mjs");
const stalledBrowserCreationScenario = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "stalled-browser-creation.mjs",
);

const activeRecorderOwnershipDeadlineMs = 1_800;
const activeRecorderExitDeadlineMs = 150;
const browserResourceCloseDeadlineMs = 400;
const browserServerCloseDeadlineMs = 2_000;
const exactGenerationExitDeadlineMs = 500;
// The public close path is sequential: recorder ownership and exit, page/context/browser,
// browser-server close and kill, then three exact-generation exit windows.
const documentedSequentialCleanupMaximumMs = activeRecorderOwnershipDeadlineMs
    + activeRecorderExitDeadlineMs
    + browserResourceCloseDeadlineMs * 3
    + browserServerCloseDeadlineMs * 2
    + exactGenerationExitDeadlineMs * 3;
const activeRecorderCleanupOuterBoundMs = 12_000;
const activeRecorderPendingProbeMs = activeRecorderOwnershipDeadlineMs - 100;
const cleanFixtureStateSampleCount = 5;
const inactiveRecorderFilesystemSchedulingMarginMs = 500;
const activeRecorderProbeSeparationMs = 750;
let recorderTimingBudgetPromise: Promise<RecorderTimingBudget> | undefined;

interface SpawnResult
{
    readonly cleanupError?: string;
    readonly code: number | null;
    readonly pid: number;
    readonly stderr: string;
    readonly stdout: string;
    readonly timedOut?: boolean;
}

interface ControlledRecorder
{
    readonly child: ChildProcess;
    readonly completed: Promise<SpawnResult>;
    readonly environment: NodeJS.ProcessEnv;
    readonly fixtureDirectory: string;
    readonly initialFixtureFiles: ReadonlySet<string>;
    readonly linuxIdentity: LinuxProcessIdentity | undefined;
    readonly pid: number;
    readonly readyPath: string;
    readonly releasePath: string;
    readonly syncDirectory: string;
}

type RecorderHoldPoint = "before-active-publication" | "after-active-publication";

interface RecorderTimingBudget
{
    readonly activeRecorderWaitProbeMs: number;
    readonly cleanCloseSamplesMs: readonly number[];
    readonly inactiveRecorderDeadlineMs: number;
}

afterEach(async () =>
{
    await Promise.all(ownedDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("browser fixture package contract", () =>
{
    test("exports the documented fixture API and pins its browser runtime", async () =>
    {
        const options: BrowserFixtureOptions = { headless: true };
        const factory: (options?: BrowserFixtureOptions) => Promise<BrowserFixture> = createBrowserFixture;
        const scope: typeof withBrowserFixture = withBrowserFixture;
        const manifest = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
            dependencies?: Record<string, string>;
            scripts?: Record<string, string>;
        };
        const lock = JSON.parse(await readFile(path.join(process.cwd(), "package-lock.json"), "utf8")) as {
            packages?: Record<string, { version?: string; }>;
        };

        expect(options.headless).toBe(true);
        expect(factory).toBeTypeOf("function");
        expect(scope).toBeTypeOf("function");
        expect(manifest.dependencies?.playwright).toBe("1.62.1");
        expect(lock.packages?.["node_modules/playwright"]?.version).toBe("1.62.1");
        expect(manifest.scripts?.["browser:install"]).toBe("playwright install chromium");
        expect(manifest.scripts?.["browser:install:with-deps"]).toBe("playwright install --with-deps chromium");
    });

    test("passes a side-effect-free preflight for the real package consumer contracts", async () =>
    {
        const result = await run(process.execPath, [consumerContract, "preflight"], process.env, 10_000);

        expect(result.code).toBe(0);
        expect(result.stdout).toContain("Package consumer preflight passed");
        expect(result.stderr).toBe("");
        expect(await consumerDirectories("pack")).toEqual([]);
    });

    test("fails safely and actionably when the matching Chromium is unavailable", async () =>
    {
        const root = await makeOwnedDirectory("pi-browser-missing-");
        const browserCache = path.join(root, "empty-browser-cache");
        const sentinelDirectory = path.join(root, "sentinels");
        const sentinelMarker = path.join(root, "default-opener-invoked");
        await createDefaultOpenerSentinels(sentinelDirectory, sentinelMarker);

        const script = [
            "import { createBrowserFixture } from \"pi-coding-agent-test\";",
            "await createBrowserFixture();",
        ].join("\n");
        const result = await run(process.execPath, ["--input-type=module", "--eval", script], {
            ...process.env,
            PATH: prependPath(sentinelDirectory, process.env.PATH),
            PLAYWRIGHT_BROWSERS_PATH: browserCache,
        });

        expect(result.code).not.toBe(0);
        await expect(access(sentinelMarker)).rejects.toThrow();
        expect(result.stderr).toContain(recoveryCommand);
    });

    test("removes partial fixture state when Chromium launch fails", async () =>
    {
        const root = await makeOwnedDirectory("pi-browser-partial-launch-");
        const fixtureTemporaryRoot = path.join(root, "fixture-tmp");
        const browserCache = path.join(root, "empty-browser-cache");
        const sentinelDirectory = path.join(root, "sentinels");
        const sentinelMarker = path.join(root, "default-opener-invoked");
        await Promise.all([
            mkdir(fixtureTemporaryRoot),
            mkdir(browserCache),
            createDefaultOpenerSentinels(sentinelDirectory, sentinelMarker),
        ]);
        const script = [
            "import { createBrowserFixture } from \"pi-coding-agent-test\";",
            "await createBrowserFixture();",
        ].join("\n");
        const result = await run(process.execPath, ["--input-type=module", "--eval", script], {
            ...process.env,
            PATH: prependPath(sentinelDirectory, process.env.PATH),
            PLAYWRIGHT_BROWSERS_PATH: browserCache,
            TMPDIR: fixtureTemporaryRoot,
        });

        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain(recoveryCommand);
        expect(await readdir(fixtureTemporaryRoot)).toEqual([]);
        await expect(access(sentinelMarker)).rejects.toThrow();
    });

    test.skipIf(process.platform !== "linux")(
        "does not delete foreign Playwright-looking state created during launch failure",
        async () =>
        {
            const root = await makeOwnedDirectory("pi-browser-foreign-launch-");
            const fixtureTemporaryRoot = path.join(root, "fixture-tmp");
            const browserCache = path.join(root, "browser-cache");
            const sentinelDirectory = path.join(root, "sentinels");
            const sentinelMarker = path.join(root, "default-opener-invoked");
            const launchSyncRoot = path.join(root, "fake-chromium-sync");
            const launchReady = path.join(launchSyncRoot, "ready");
            const launchRelease = path.join(launchSyncRoot, "release");
            const launchArtifactRecord = path.join(launchSyncRoot, "artifact-record");
            await Promise.all([
                mkdir(fixtureTemporaryRoot),
                mkdir(browserCache),
                mkdir(launchSyncRoot),
                createDefaultOpenerSentinels(sentinelDirectory, sentinelMarker),
                chmod(failingChromiumCommand, 0o755),
            ]);
            const executableResult = await run(
                process.execPath,
                [
                    "--input-type=module",
                    "--eval",
                    "import { chromium } from 'playwright'; process.stdout.write(chromium.executablePath());",
                ],
                { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserCache },
            );
            expect(executableResult.code).toBe(0);
            const revision = /chromium-(\d+)/u.exec(executableResult.stdout)?.[1];
            expect(revision).toBeDefined();
            const chromiumRoot = path.join(browserCache, `chromium-${revision}`);
            const chromiumExecutable = executableResult.stdout.trim();
            const headlessShellRoot = path.join(browserCache, `chromium_headless_shell-${revision}`);
            const headlessShellExecutable = path.join(
                headlessShellRoot,
                "chrome-headless-shell-linux64",
                "chrome-headless-shell",
            );
            const fakeLauncher = await readFile(failingChromiumCommand);
            await Promise.all([
                mkdir(path.dirname(chromiumExecutable), { recursive: true }),
                mkdir(path.dirname(headlessShellExecutable), { recursive: true }),
            ]);
            await Promise.all([
                writeFile(path.join(chromiumRoot, "INSTALLATION_COMPLETE"), "", "utf8"),
                writeFile(path.join(chromiumRoot, "DEPENDENCIES_VALIDATED"), "", "utf8"),
                writeFile(chromiumExecutable, fakeLauncher, { mode: 0o755 }),
                writeFile(path.join(headlessShellRoot, "INSTALLATION_COMPLETE"), "", "utf8"),
                writeFile(path.join(headlessShellRoot, "DEPENDENCIES_VALIDATED"), "", "utf8"),
                writeFile(headlessShellExecutable, fakeLauncher, { mode: 0o755 }),
            ]);

            const script = [
                "import { createBrowserFixture } from \"pi-coding-agent-test\";",
                "await createBrowserFixture();",
            ].join("\n");
            const launch = run(process.execPath, ["--input-type=module", "--eval", script], {
                ...process.env,
                ALE44_FAKE_CHROMIUM_SYNC_ROOT: launchSyncRoot,
                PATH: prependPath(sentinelDirectory, process.env.PATH),
                PLAYWRIGHT_BROWSERS_PATH: browserCache,
                TMPDIR: fixtureTemporaryRoot,
            }, childTimeoutMs * 2);
            await pollUntil(
                () => access(launchReady).then(() => true, () => false),
                childTimeoutMs,
                "the synchronized fake Chromium launch",
            );
            const fixtureOwnedLaunchDirectory = (await readFile(launchArtifactRecord, "utf8")).trim();
            const fixtureOwnedLaunchMarker = path.join(
                fixtureOwnedLaunchDirectory,
                "fixture-launch-marker.txt",
            );
            const fixtureLaunchTemporaryRoot = path.dirname(fixtureOwnedLaunchDirectory);
            const fixtureLaunchRoot = path.dirname(fixtureLaunchTemporaryRoot);
            const fixtureDirectory = path.dirname(fixtureLaunchRoot);
            expect(path.basename(fixtureLaunchTemporaryRoot)).toBe("tmp");
            expect(path.basename(fixtureLaunchRoot)).toBe("launch");
            expect(path.dirname(fixtureDirectory)).toBe(fixtureTemporaryRoot);
            expect(path.basename(fixtureDirectory)).toMatch(/^pi-browser-fixture-/u);
            expect(path.basename(fixtureOwnedLaunchDirectory)).toMatch(/^playwright_fixture-launch-/u);
            expect(await readFile(fixtureOwnedLaunchMarker, "utf8")).toBe("fixture-owned launch state\n");
            const fixtureDirectories = (await readdir(fixtureTemporaryRoot))
                .filter((entry) => entry.startsWith("pi-browser-fixture-"));
            expect(fixtureDirectories).toHaveLength(1);

            const foreignDirectory = path.join(fixtureTemporaryRoot, `playwright_foreign-${randomUUID()}`);
            const foreignMarker = path.join(foreignDirectory, "caller-marker.txt");
            await mkdir(foreignDirectory);
            await writeFile(foreignMarker, "caller-owned concurrent state\n", "utf8");
            await writeFile(launchRelease, "release\n", "utf8");
            const result = await launch;

            expect(result.code).not.toBe(0);
            expect(result.stderr).toContain(recoveryCommand);
            await expect(access(fixtureOwnedLaunchDirectory)).rejects.toThrow();
            await Promise.all(
                fixtureDirectories.map(async (entry) =>
                    expect(access(path.join(fixtureTemporaryRoot, entry))).rejects.toThrow()
                ),
            );
            expect(await readdir(fixtureTemporaryRoot)).toEqual([path.basename(foreignDirectory)]);
            expect(await readFile(foreignMarker, "utf8")).toBe("caller-owned concurrent state\n");
            await expect(access(sentinelMarker)).rejects.toThrow();
        },
        childTimeoutMs * 3,
    );

    test.skipIf(process.platform !== "linux").each(
        [
            "absolute foreign path",
            "parent traversal escape",
            "symlink component escape",
            "recorded path replacement",
        ] as const,
    )("rejects launch-record ownership attack: %s", async (attack) =>
    {
        await expectLaunchRecordAttackDoesNotDeleteForeignState(attack);
    }, childTimeoutMs * 3);
});

describe("browser fixture behavior", () =>
{
    test("defaults to headless and owns one fresh page in a non-persistent context", async () =>
    {
        const fixture = await createBrowserFixture();

        try
        {
            expect(fixture.browser.isConnected()).toBe(true);
            expect(fixture.context.pages()).toEqual([fixture.page]);
            expect(fixture.page.context()).toBe(fixture.context);
        }
        finally
        {
            await fixture.close();
        }
    });

    test("rejects a Linux headed request without a display instead of changing modes", async () =>
    {
        if (process.platform !== "linux")
        {
            return;
        }

        const priorDisplay = process.env.DISPLAY;
        const priorWaylandDisplay = process.env.WAYLAND_DISPLAY;
        delete process.env.DISPLAY;
        delete process.env.WAYLAND_DISPLAY;

        try
        {
            await expect(createBrowserFixture({ headless: false })).rejects.toThrow(/Xvfb/u);
        }
        finally
        {
            restoreEnvironment("DISPLAY", priorDisplay);
            restoreEnvironment("WAYLAND_DISPLAY", priorWaylandDisplay);
        }
    });

    test("builds isolated child environments without changing parent or caller values", async () =>
    {
        const first = await createBrowserFixture();
        const second = await createBrowserFixture();
        const parentBefore = { ...process.env };
        const base = { PATH: "/caller/bin", NODE_OPTIONS: "--no-warnings", CALLER_VALUE: "preserved" };

        try
        {
            const firstEnvironment = first.childEnvironment(base);
            const secondEnvironment = second.childEnvironment(base);

            expect(base).toEqual({ PATH: "/caller/bin", NODE_OPTIONS: "--no-warnings", CALLER_VALUE: "preserved" });
            expect(process.env).toEqual(parentBefore);
            expect(firstEnvironment).not.toBe(base);
            expect(firstEnvironment.CALLER_VALUE).toBe("preserved");
            expect(firstEnvironment.NODE_OPTIONS).toContain("--no-warnings");
            expect(firstEnvironment.PATH).toContain("/caller/bin");
            expect(privateEnvironment(firstEnvironment)).not.toEqual(privateEnvironment(secondEnvironment));
            expect(firstEnvironment.PATH?.split(path.delimiter)[0]).not.toBe(
                secondEnvironment.PATH?.split(path.delimiter)[0],
            );
        }
        finally
        {
            await Promise.all([first.close(), second.close()]);
        }
    });

    test("captures exactly one correlated absolute HTTP URL", async () =>
    {
        const first = await createBrowserFixture();
        const second = await createBrowserFixture();

        try
        {
            const firstEnvironment = first.childEnvironment();
            const secondEnvironment = second.childEnvironment();
            const firstCapture = run(first.openerCommand, ["http://127.0.0.1:40101/first"], firstEnvironment);
            const secondCapture = run(second.openerCommand, ["https://example.test/second"], secondEnvironment);

            await expect(first.waitForUrl({ timeoutMs: 2_000 })).resolves.toBe("http://127.0.0.1:40101/first");
            await expect(second.waitForUrl({ timeoutMs: 2_000 })).resolves.toBe("https://example.test/second");
            const [firstResult, secondResult] = await Promise.all([firstCapture, secondCapture]);
            expect(firstResult.code).toBe(0);
            expect(secondResult.code).toBe(0);
            await Promise.all([expectPidExited(firstResult.pid), expectPidExited(secondResult.pid)]);
        }
        finally
        {
            await Promise.all([first.close(), second.close()]);
        }
    });

    test("waits through the claim-to-active-publication handoff before removing fixture state", async () =>
    {
        expect(activeRecorderCleanupOuterBoundMs).toBeGreaterThan(documentedSequentialCleanupMaximumMs);
        const timing = await recorderTimingBudget();
        expect(timing.activeRecorderWaitProbeMs).toBeGreaterThan(20);
        const fixture = await createBrowserFixture();
        const recorder = await startControlledRecorder(fixture, "http://127.0.0.1:40106/claim-handoff-close");
        let closeOutcome: SettlementOutcome | undefined;
        let capture: SpawnResult | undefined;
        let directoryPresentAfterRecorderExit = false;

        try
        {
            await waitForControlledRecorder(recorder);
            await fixture.page.close();
            await fixture.context.close();
            await fixture.browser.close();
            const close = fixture.close();
            // Release the held recorder before the real ownership deadline. Clean-close
            // calibration can exceed that deadline on a loaded machine.
            closeOutcome = await settleWithin(
                close,
                Math.min(timing.activeRecorderWaitProbeMs, activeRecorderOwnershipDeadlineMs / 2),
            );
            await writeFile(recorder.releasePath, "release\n", "utf8");
            capture = await recorder.completed;
            directoryPresentAfterRecorderExit = await pathExists(recorder.fixtureDirectory);
            await close;
        }
        finally
        {
            await rescueControlledRecorder(recorder);
            await fixture.close().catch(() => undefined);
        }

        expect.soft(closeOutcome?.status).toBe("pending");
        expect.soft(capture?.code).toBe(0);
        expect.soft(directoryPresentAfterRecorderExit).toBe(true);
        await expectPidExited(recorder.pid);
        await expect(access(recorder.fixtureDirectory)).rejects.toThrow();
    }, activeRecorderCleanupOuterBoundMs);

    test.skipIf(process.platform !== "linux")(
        "bounds claim-handoff cleanup with exact ownership evidence and deterministic repeated close",
        async () =>
        {
            const fixture = await createBrowserFixture();
            const recorder = await startControlledRecorder(fixture, "http://127.0.0.1:40107/claim-handoff-timeout");
            let recorderIdentity: LinuxProcessIdentity | undefined;
            let first: SettlementOutcome | undefined;
            let second: SettlementOutcome | undefined;
            let recorderAliveAfterCleanup = false;
            let directoryPresentAfterCleanup = false;

            try
            {
                await waitForControlledRecorder(recorder);
                recorderIdentity = await readLinuxProcessIdentity(recorder.pid);
                await fixture.page.close();
                await fixture.context.close();
                await fixture.browser.close();
                const closeStartedAt = performance.now();
                const close = fixture.close();
                const beforeRecorderDeadline = await settleWithin(close, activeRecorderPendingProbeMs);
                expect.soft(beforeRecorderDeadline.status).toBe("pending");
                first = await settleWithin(close, activeRecorderCleanupOuterBoundMs - activeRecorderPendingProbeMs);
                expect.soft(performance.now() - closeStartedAt).toBeGreaterThanOrEqual(
                    activeRecorderOwnershipDeadlineMs,
                );
                second = await settleWithin(fixture.close(), 100);
                recorderAliveAfterCleanup = await linuxOriginalProcessGenerationExists(recorderIdentity);
                directoryPresentAfterCleanup = await pathExists(recorder.fixtureDirectory);
            }
            finally
            {
                await rescueControlledRecorder(recorder);
                await fixture.close().catch(() => undefined);
            }

            expect.soft(first?.status).toBe("rejected");
            expect.soft(second?.status).toBe("rejected");
            expect.soft(describeError(first?.error)).toMatch(
                /recorder.*(?:pid|token|generation)|(?:pid|token|generation).*recorder/iu,
            );
            expect.soft(describeError(first?.error)).toMatch(/timed out|timeout|bound/iu);
            expect.soft(recorderAliveAfterCleanup).toBe(false);
            expect.soft(directoryPresentAfterCleanup).toBe(false);
            await expectPidExited(recorder.pid);
        },
        activeRecorderCleanupOuterBoundMs,
    );

    test.skipIf(process.platform !== "linux")(
        "keeps callback failure first when claim-handoff cleanup also fails",
        async () =>
        {
            let recorder: ControlledRecorder | undefined;
            let recorderIdentity: LinuxProcessIdentity | undefined;
            const callbackMessage = "primary callback while opener claim handoff is pending";
            const scoped = withBrowserFixture({}, async (fixture) =>
            {
                recorder = await startControlledRecorder(
                    fixture,
                    "http://127.0.0.1:40108/claim-handoff-callback-primary",
                );
                await waitForControlledRecorder(recorder);
                recorderIdentity = await readLinuxProcessIdentity(recorder.pid);
                throw new Error(callbackMessage);
            });
            const outcome = await settleWithin(scoped, activeRecorderCleanupOuterBoundMs);
            let recorderAliveAfterCleanup = false;
            let directoryPresentAfterCleanup = false;

            try
            {
                expect(recorder).toBeDefined();
                expect(recorderIdentity).toBeDefined();
                recorderAliveAfterCleanup = await linuxOriginalProcessGenerationExists(recorderIdentity!);
                directoryPresentAfterCleanup = await pathExists(recorder!.fixtureDirectory);
            }
            finally
            {
                if (recorder !== undefined)
                {
                    await rescueControlledRecorder(recorder);
                }
            }

            const firstError = outcome.error instanceof AggregateError ? outcome.error.errors[0] : outcome.error;
            expect.soft(outcome.status).toBe("rejected");
            expect.soft(outcome.error).toBeInstanceOf(AggregateError);
            expect.soft(describeError(firstError)).toContain(callbackMessage);
            expect.soft(describeError(outcome.error)).toMatch(/recorder.*(?:pid|token|generation)|timed out|timeout/iu);
            expect.soft(recorderAliveAfterCleanup).toBe(false);
            expect.soft(directoryPresentAfterCleanup).toBe(false);
            await expectPidExited(recorder!.pid);
        },
        activeRecorderCleanupOuterBoundMs,
    );

    test.skipIf(process.platform !== "linux")(
        "ignores malformed, foreign, and stale active recorder state without signalling unrelated processes",
        async () =>
        {
            const timing = await recorderTimingBudget();
            const { activeRecorderWaitProbeMs, inactiveRecorderDeadlineMs } = timing;

            expect(timing.cleanCloseSamplesMs).toHaveLength(cleanFixtureStateSampleCount);
            expect(inactiveRecorderDeadlineMs).toBeLessThan(activeRecorderWaitProbeMs);
            const unrelated = spawn(
                process.execPath,
                ["--input-type=module", "--eval", "setInterval(() => {}, 1000)"],
                {
                    detached: true,
                    stdio: "ignore",
                },
            );
            const unrelatedPid = unrelated.pid;
            expect(unrelatedPid).toBeDefined();
            const unrelatedIdentity = await readLinuxProcessIdentity(unrelatedPid!);

            try
            {
                for (const variant of ["malformed", "foreign", "stale"] as const)
                {
                    const fixture = await createBrowserFixture();
                    const recorder = await startControlledRecorder(
                        fixture,
                        `http://127.0.0.1:40109/${variant}-active-state`,
                        "after-active-publication",
                    );

                    try
                    {
                        await waitForControlledRecorder(recorder);
                        const protocol = await discoverActiveRecorderProtocol(recorder);
                        if (protocol === undefined)
                        {
                            throw new Error(
                                `No child-scoped active recorder ownership metadata was published for owned PID ${recorder.pid}`,
                            );
                        }
                        await writeFile(recorder.releasePath, "release\n", "utf8");
                        expect((await recorder.completed).code).toBe(0);
                        await pollUntil(
                            () => pathExists(protocol.path).then((exists) => !exists),
                            childTimeoutMs,
                            "active state removal",
                        );
                        const marker = variant === "malformed"
                            ? "not-json\n"
                            : mutateInstalledActiveMarker(
                                protocol.marker,
                                recorder,
                                unrelatedIdentity,
                                variant,
                            );
                        await writeFile(protocol.path, marker, "utf8");

                        // Close public browser handles first so this deadline compares only fixture-state cleanup.
                        await fixture.page.close();
                        await fixture.context.close();
                        await fixture.browser.close();
                        const outcome = await settleWithin(fixture.close(), inactiveRecorderDeadlineMs);

                        expect(outcome.status).toBe("fulfilled");
                        expect(await linuxProcessMatches(unrelatedIdentity)).toBe(true);
                        await expect(access(recorder.fixtureDirectory)).rejects.toThrow();
                    }
                    finally
                    {
                        await rescueControlledRecorder(recorder);
                        await fixture.close().catch(() => undefined);
                    }
                }
            }
            finally
            {
                await signalExactLinuxProcessIdentity(unrelatedIdentity, "SIGKILL");
                await new Promise<void>((resolve) => unrelated.once("exit", () => resolve()));
            }
        },
        childTimeoutMs * 4,
    );

    test("rejects recorder input with a missing fixture token", async () =>
    {
        const fixture = await createBrowserFixture();
        const base = { ...process.env };
        const environment = fixture.childEnvironment(base);

        try
        {
            for (const key of changedPrivateKeys(base, environment))
            {
                delete environment[key];
            }
            const capture = await run(fixture.openerCommand, ["http://127.0.0.1:40102/missing-token"], environment);
            expect(capture.code).not.toBe(0);
            expect(capture.stderr).toMatch(/fixture|token/u);
            await expect(fixture.waitForUrl({ timeoutMs: 50 })).rejects.toThrow(/timed out|timeout/u);
        }
        finally
        {
            await fixture.close();
        }
    });

    test("rejects an uncorrelated recorder environment", async () =>
    {
        const fixture = await createBrowserFixture();
        const base = { ...process.env };
        const environment = fixture.childEnvironment(base);

        try
        {
            for (const key of changedPrivateKeys(base, environment))
            {
                const value = environment[key];
                if (value !== undefined && !path.isAbsolute(value))
                {
                    environment[key] = `uncorrelated-${randomUUID()}`;
                }
            }
            const capture = await run(fixture.openerCommand, ["http://127.0.0.1:40103/uncorrelated"], environment);
            expect(capture.code).not.toBe(0);
            expect(capture.stderr).toMatch(/correlat|fixture|token/u);
            await expect(fixture.waitForUrl({ timeoutMs: 50 })).rejects.toThrow(/timed out|timeout/u);
        }
        finally
        {
            await fixture.close();
        }
    });

    test.each([
        ["relative URL", "/relative"],
        ["unsupported URL scheme", "file:///tmp/not-http"],
    ])("rejects malformed recorder input (%s) and cleans its PID", async (_label, value) =>
    {
        const fixture = await createBrowserFixture();
        const ownedDirectory = fixtureDirectory(fixture.childEnvironment());

        try
        {
            const capture = await run(fixture.openerCommand, [value], fixture.childEnvironment());
            expect(capture.code).not.toBe(0);
            await expectPidExited(capture.pid);
            await expect(fixture.waitForUrl({ timeoutMs: 50 })).rejects.toThrow(/timed out|timeout/u);
        }
        finally
        {
            await fixture.close();
        }

        await expect(access(ownedDirectory)).rejects.toThrow();
    });

    test("rejects duplicate capture and removes the recorder and fixture directory", async () =>
    {
        const fixture = await createBrowserFixture();
        const environment = fixture.childEnvironment();
        const ownedDirectory = fixtureDirectory(environment);

        try
        {
            const first = await run(fixture.openerCommand, ["http://127.0.0.1:40104/first"], environment);
            await expect(fixture.waitForUrl({ timeoutMs: 2_000 })).resolves.toContain("/first");
            const duplicate = await run(fixture.openerCommand, ["http://127.0.0.1:40104/duplicate"], environment);
            expect(first.code).toBe(0);
            expect(duplicate.code).not.toBe(0);
            expect(duplicate.stderr).toMatch(/already|duplicate/u);
            await Promise.all([expectPidExited(first.pid), expectPidExited(duplicate.pid)]);
        }
        finally
        {
            await fixture.close();
        }

        await expect(access(ownedDirectory)).rejects.toThrow();
    });

    test("rejects late capture after close without recreating fixture state", async () =>
    {
        const fixture = await createBrowserFixture();
        const environment = fixture.childEnvironment();
        const ownedDirectory = fixtureDirectory(environment);
        await fixture.close();

        const late = await run(fixture.openerCommand, ["http://127.0.0.1:40105/late"], environment);
        expect(late.code).not.toBe(0);
        expect(late.stderr).toMatch(/closed|late|fixture/u);
        await expectPidExited(late.pid);
        await expect(access(ownedDirectory)).rejects.toThrow();
    });

    test("bounds URL waits and fully cleans after abort", async () =>
    {
        const fixture = await createBrowserFixture();
        const ownedDirectory = fixtureDirectory(fixture.childEnvironment());
        const controller = new AbortController();
        const aborted = fixture.waitForUrl({ timeoutMs: 2_000, signal: controller.signal });
        controller.abort(new Error("caller stopped waiting"));

        await expect(aborted).rejects.toThrow(/abort|caller stopped waiting/u);
        await expect(fixture.waitForUrl({ timeoutMs: 25 })).rejects.toThrow(/timed out|timeout/u);
        await fixture.close();
        expect(fixture.browser.isConnected()).toBe(false);
        await expect(access(ownedDirectory)).rejects.toThrow();
    });

    test("shares idempotent cleanup, rejects pending waiters, and removes only owned resources", async () =>
    {
        const callerDirectory = await makeOwnedDirectory("pi-browser-caller-");
        const callerFile = path.join(callerDirectory, "keep.txt");
        await writeFile(callerFile, "caller-owned", "utf8");
        const fixture = await createBrowserFixture();
        const ownedDirectory = fixtureDirectory(fixture.childEnvironment());
        const pending = fixture.waitForUrl({ timeoutMs: 2_000 });
        const firstClose = fixture.close();
        const secondClose = fixture.close();

        expect(secondClose).toBe(firstClose);
        await firstClose;
        await expect(pending).rejects.toThrow(/closed/u);
        expect(await readFile(callerFile, "utf8")).toBe("caller-owned");
        await expect(access(ownedDirectory)).rejects.toThrow();
    });

    test("preserves callback failure while retaining cleanup failure details", async () =>
    {
        let callbackError: Error | undefined;

        try
        {
            await withBrowserFixture({}, async (fixture) =>
            {
                fixture.page.close = async () =>
                {
                    throw new Error("cleanup detail");
                };
                throw new Error("primary callback failure");
            });
        }
        catch (error)
        {
            callbackError = error as Error;
        }

        expect(callbackError?.message).toContain("primary callback failure");
        expect(describeError(callbackError)).toContain("cleanup detail");
    });

    test.skipIf(process.platform !== "linux")(
        "never binds concurrent fixtures to unrelated direct children during launch",
        async () =>
        {
            const result = await run(
                process.execPath,
                [concurrentOwnershipRaceScenario],
                process.env,
                browserCleanupBoundMs * 4,
            );
            const statusLine = result.stdout.trim().split("\n").at(-1);
            expect(statusLine).toBeDefined();
            const status = JSON.parse(statusLine!) as ConcurrentOwnershipRaceStatus;
            console.log(`ALE-44 concurrent ownership evidence: ${
                JSON.stringify({
                    helper: {
                        cleanupError: result.cleanupError ?? "",
                        code: result.code,
                        stderr: result.stderr,
                        timedOut: result.timedOut ?? false,
                    },
                    status,
                })
            }`);

            expect.soft(status.launchCount).toBe(2);
            expect.soft(status.outcomes).toHaveLength(2);
            expect.soft(status.outcomes).toEqual([
                { status: "fulfilled", error: "" },
                { status: "fulfilled", error: "" },
            ]);
            expect.soft(status.resourceCloseElapsedMs).toHaveLength(2);
            for (const timing of status.resourceCloseElapsedMs)
            {
                expect.soft(timing.page).toBeLessThan(browserResourceCloseDeadlineMs);
                expect.soft(timing.context).toBeLessThan(browserResourceCloseDeadlineMs);
                expect.soft(timing.browser).toBeLessThan(browserResourceCloseDeadlineMs);
                expect.soft(timing.total).toBeLessThan(browserCleanupBoundMs);
            }
            expect(status.unrelatedAfterCleanup).toEqual([
                { alive: true, identityUnchanged: true, signal: "" },
                { alive: true, identityUnchanged: true, signal: "" },
            ]);
            expect.soft(status.chromiumAfterCleanup.every((identity) => !identity.alive)).toBe(true);
            expect.soft(status.fixtureDirectoriesGone).toEqual([true, true]);
            expect.soft(result.timedOut, result.cleanupError).not.toBe(true);
            expect.soft(result.cleanupError).toBeUndefined();
            expect.soft(result.code).toBe(0);
        },
        browserCleanupBoundMs * 4 + 5_000,
    );

    test.skipIf(process.platform !== "linux")(
        "does not settle cleanup while the exact owned Chromium generation is a zombie",
        async () =>
        {
            const scenarioRoot = path.join(
                process.cwd(),
                ".agents",
                "tmp",
                `ale44-zombie-exit-${randomUUID()}`,
            );
            ownedDirectories.push(scenarioRoot);
            await mkdir(scenarioRoot, { recursive: true });
            const preloadLibrary = path.join(scenarioRoot, "ale44-zombie-waitpid.so");
            const compile = await run(
                "cc",
                ["-shared", "-fPIC", "-O2", "-o", preloadLibrary, zombieWaitpidSource, "-ldl"],
                process.env,
                10_000,
            );
            expect(compile.code, compile.stderr).toBe(0);

            const result = await run(process.execPath, [zombieExitBoundaryScenario], {
                ...process.env,
                ALE44_ZOMBIE_AUDIT_FILE: path.join(scenarioRoot, "waitpid-audit.log"),
                ALE44_ZOMBIE_RELEASE_FILE: path.join(scenarioRoot, "release"),
                ALE44_ZOMBIE_SCENARIO_ROOT: scenarioRoot,
                ALE44_ZOMBIE_TARGET_FILE: path.join(scenarioRoot, "target-pid"),
                LD_PRELOAD: [preloadLibrary, process.env.LD_PRELOAD].filter(Boolean).join(":"),
            }, browserCleanupBoundMs * 4);
            expect(result.code, result.stderr).toBe(0);
            console.log(`ALE-44 zombie exit evidence: ${result.stdout.trim()}`);
            const status = JSON.parse(result.stdout) as ZombieExitBoundaryStatus & {
                deniedZombieExecutableReads: number;
            };

            expect(status.deniedZombieExecutableReads).toBeGreaterThan(0);
            expect(status.closeOutcome.status).toBe("rejected");
            expect(status.closeOutcome.error).toMatch(/close.*timed out|timeout/iu);
            expect(status.generation.pid).toBeGreaterThan(0);
            expect(status.generation.startTime).toMatch(/^\d+$/u);
            expect(status.closeElapsedMs).toBeGreaterThanOrEqual(800);
            expect(status.closeElapsedMs).toBeLessThan(activeRecorderCleanupOuterBoundMs);
            expect(status.stateAfterClose).toMatchObject({
                executableIdentityAvailable: false,
                generationPresent: true,
                startTime: status.generation.startTime,
                state: "Z",
            });
            expect(status.closeOutcome.error).toContain(`Owned Chromium PID ${status.generation.pid}`);
            expect(status.closeOutcome.error).toMatch(/zombie/iu);
            expect(status.closeOutcome.error).toMatch(/owning parent.*reap/iu);
            expect(status.closeOutcome.error).not.toContain(status.generation.executable);
            expect(status.waitpidAudit).toContain(`pid=${status.generation.pid}`);
            expect(status.signalAttempts).toContainEqual({ pid: status.generation.pid, signal: "SIGTERM" });
            expect(status.signalAttempts.every((attempt) => attempt.pid > 0)).toBe(true);
            expect(status.unrelatedAfterClose).toEqual({ alive: true, identityUnchanged: true, signal: "" });
            expect(status.fixtureDirectoryGone).toBe(true);
            expect(status.rescued).toBe(true);
            expect(status.stateAfterRelease).toEqual({
                executableIdentityAvailable: false,
                generationPresent: false,
                state: "absent",
            });
        },
        browserCleanupBoundMs * 4 + 10_000,
    );

    test.skipIf(process.platform !== "linux" || !pidNamespaceCapability.available)(
        "rejects while a reparented exact Chromium generation remains a PPID-1 zombie",
        async () =>
        {
            const scenarioRoot = path.join(
                process.cwd(),
                ".agents",
                "tmp",
                `ale44-pid1-zombie-${randomUUID()}`,
            );
            ownedDirectories.push(scenarioRoot);
            await mkdir(scenarioRoot, { recursive: true });
            const namespaceInit = path.join(scenarioRoot, "ale44-pid1-zombie-init");
            const compile = await run(
                "cc",
                ["-O2", "-o", namespaceInit, pid1ZombieWaitpidSource],
                process.env,
                10_000,
            );
            expect(compile.code, compile.stderr).toBe(0);

            const result = await run(
                "unshare",
                [
                    "--user",
                    "--map-root-user",
                    "--pid",
                    "--fork",
                    "--mount-proc",
                    namespaceInit,
                    process.execPath,
                    pid1ZombieBoundaryScenario,
                ],
                {
                    ...process.env,
                    ALE44_PID1_ZOMBIE_AUDIT_FILE: path.join(scenarioRoot, "waitpid-audit.log"),
                    ALE44_PID1_ZOMBIE_RELEASE_FILE: path.join(scenarioRoot, "release"),
                    ALE44_PID1_ZOMBIE_SCENARIO_ROOT: scenarioRoot,
                    ALE44_PID1_ZOMBIE_TARGET_FILE: path.join(scenarioRoot, "target-pid"),
                },
                browserCleanupBoundMs * 4,
            );
            expect(result.code, result.stderr).toBe(0);
            console.log(`ALE-44 PPID-1 zombie evidence: ${result.stdout.trim()}`);
            const status = JSON.parse(result.stdout) as Pid1ZombieBoundaryStatus;

            expect(status.namespaceInitPid).toBe(1);
            expect(status.initialParentPid).not.toBe(1);
            expect(status.reparentedThrough[0]).toBe(status.generation.pid);
            expect(status.reparentedThrough.at(-1)).not.toBe(status.generation.pid);
            expect(status.closeOutcome.status).toBe("rejected");
            expect(status.closeOutcome.error).toContain(`Owned Chromium PID ${status.generation.pid}`);
            expect(status.closeOutcome.error).toMatch(/zombie/iu);
            expect(status.closeOutcome.error).toMatch(/reap/iu);
            expect(status.closeOutcome.error).not.toContain(status.generation.executable);
            expect(status.closeElapsedMs).toBeGreaterThanOrEqual(800);
            expect(status.closeElapsedMs).toBeLessThan(activeRecorderCleanupOuterBoundMs);
            expect(status.stateAfterClose).toMatchObject({
                executableIdentityAvailable: false,
                generationPresent: true,
                parentPid: 1,
                startTime: status.generation.startTime,
                state: "Z",
            });
            expect(status.waitpidAudit).toContain(`target=${status.generation.pid} init=1`);
            expect(status.signalAttempts).toContainEqual({ pid: status.generation.pid, signal: "SIGTERM" });
            expect(status.signalAttempts.every((attempt) => attempt.pid > 0)).toBe(true);
            expect(status.unrelatedAfterClose).toEqual({ alive: true, identityUnchanged: true, signal: "" });
            expect(status.fixtureDirectoryGone).toBe(true);
            expect(status.rescued).toBe(true);
            expect(status.stateAfterRelease).toEqual({
                executableIdentityAvailable: false,
                generationPresent: false,
                state: "absent",
            });
        },
        browserCleanupBoundMs * 4 + 10_000,
    );

    test.skipIf(process.platform !== "linux")(
        "waits for an exact Chromium descendant created after its launch snapshot",
        async () =>
        {
            const result = await run(
                process.execPath,
                [lateBrowserDescendantScenario],
                process.env,
                browserCleanupBoundMs * 4,
            );
            expect(result.code).toBe(0);
            const status = JSON.parse(result.stdout) as LateBrowserDescendantStatus;

            expect(status.browserServerCloseCalls).toBe(1);
            expect(status.browserServerKillCalls).toBe(0);
            expect(status.outcome).toEqual({ status: "fulfilled", error: "" });
            expect(status.launchSnapshotPids).not.toContain(status.late.pid);
            expect(status.late.ancestryPids[0]).toBe(status.late.pid);
            expect(status.late.ancestryPids.at(-1)).toBe(status.launchRootPid);
            expect(status.late.ancestryPids).toContain(status.late.parentPid);
            expect(status.late.executable).toMatch(/chrom(?:e|ium)|headless_shell/iu);
            expect(status.late.startTime).toMatch(/^\d+$/u);

            expect(status.late.executableAfterCleanup).toBe(
                status.late.aliveAfterCleanup ? status.late.executable : undefined,
            );
            expect(status.late.startTimeAfterCleanup).toBe(
                status.late.aliveAfterCleanup ? status.late.startTime : undefined,
            );
            if (status.late.parentPidAfterCleanup !== undefined)
            {
                expect(status.late.parentPidAfterCleanup).toBeGreaterThan(0);
            }
            expect(status.unrelated.parentPid).toBe(status.scenarioPid);
            expect(status.unrelated.executable).toBe(process.execPath);
            expect(status.unrelated.alive).toBe(true);
            expect(status.unrelated.identityUnchanged).toBe(true);
            expect(status.unrelated.signal).toBe("");
            expect(status.late.aliveAfterCleanup).toBe(false);
        },
        browserCleanupBoundMs * 4 + 5_000,
    );

    test.skipIf(process.platform !== "linux")(
        "keeps discovery active when page close exceeds its public shutdown deadline",
        async () =>
        {
            const result = await run(
                process.execPath,
                [shutdownWindowDescendantScenario],
                process.env,
                browserCleanupBoundMs * 4,
            );
            expect(result.code).toBe(0);
            const status = JSON.parse(result.stdout) as ShutdownWindowDescendantStatus;

            expect(status.pageCloseEntered).toBe(true);
            expect(status.injectedPageCloseDelayMs).toBeGreaterThan(browserResourceCloseDeadlineMs);
            expect(status.ancestryRemovedBeforePageCloseReturned).toBe(true);
            expect(status.browserServerCloseCalls).toBe(1);
            expect(status.browserServerKillCalls).toBe(0);
            expect(status.outcome.status).toBe("rejected");
            expect(status.outcome.error).toContain("page close timed out after 400ms");
            expect(status.launchSnapshotPids).not.toContain(status.late.pid);
            expect(status.late.ancestryPids[0]).toBe(status.late.pid);
            expect(status.late.ancestryPids.at(-1)).toBe(status.launchRootPid);
            expect(status.lateParentPidAtBrowserServerClose).not.toBe(status.late.parentPid);
            expect(status.late.executable).toMatch(/chrom(?:e|ium)|headless_shell/iu);
            expect(status.late.startTime).toMatch(/^\d+$/u);
            expect(status.unrelated.parentPid).toBe(status.scenarioPid);
            expect(status.unrelated.executable).toBe(process.execPath);
            expect(status.unrelated.alive).toBe(true);
            expect(status.unrelated.identityUnchanged).toBe(true);
            expect(status.unrelated.signal).toBe("");
            expect({
                discoveryObservedDuringPageClose: status.discoveryObservedDuringPageClose,
                lateAliveAfterCleanup: status.late.aliveAfterCleanup,
            }).toEqual({
                discoveryObservedDuringPageClose: true,
                lateAliveAfterCleanup: false,
            });
        },
        browserCleanupBoundMs * 4 + 5_000,
    );

    test.skipIf(process.platform !== "linux")(
        "retains a newly observed owned generation when its PID collides with an expired retained identity",
        async () =>
        {
            const result = await run(
                process.execPath,
                [retainedGenerationCollisionScenario],
                process.env,
                browserCleanupBoundMs * 4,
            );
            expect(result.code).toBe(0);
            const status = JSON.parse(result.stdout) as RetainedGenerationCollisionStatus;

            expect(status.expiredDuringCleanup).toBe(true);
            expect(status.syntheticIdentityReads).toBeGreaterThan(0);
            expect(status.syntheticIdentity.pid).toBe(status.late.pid);
            expect(status.syntheticIdentity.parentPid).toBe(status.late.parentPid);
            expect(status.syntheticIdentity.startTime).not.toBe(status.late.startTime);
            expect(status.syntheticIdentity.executable).not.toBe(status.late.executable);
            expect(status.syntheticIdentity.executableDevice).not.toBe(status.late.executableDevice);
            expect(status.syntheticIdentity.executableInode).not.toBe(status.late.executableInode);
            expect(status.outcome).toEqual({ status: "fulfilled", error: "" });
            expect(status.unrelated.parentPid).toBe(status.scenarioPid);
            expect(status.unrelated.executable).toBe(process.execPath);
            expect(status.unrelated.alive).toBe(true);
            expect(status.unrelated.identityUnchanged).toBe(true);
            expect(status.unrelated.signal).toBe("");
            expect(status.late.aliveAfterCleanup).toBe(false);
        },
        browserCleanupBoundMs * 4 + 5_000,
    );

    test.skipIf(process.platform !== "linux")(
        "does not claim a reused PID whose current parent no longer matches the traversed child edge",
        async () =>
        {
            const result = await run(
                process.execPath,
                [childEdgeToctouScenario],
                process.env,
                browserCleanupBoundMs * 4,
            );
            expect(result.code).toBe(0);
            const status = JSON.parse(result.stdout) as ChildEdgeToctouStatus;

            expect(status.browserServerCloseCalls).toBe(1);
            expect(status.browserServerKillCalls).toBe(0);
            expect(status.outcome).toEqual({ status: "fulfilled", error: "" });
            expect(status.traversal.childrenReads).toBeGreaterThan(0);
            expect(status.traversal.currentIdentityReads).toBeGreaterThan(0);
            expect(status.stable.listedOnTraversedEdge).toBe(true);
            expect(status.stable.parentPid).toBe(status.traversal.parentPid);
            expect(status.stable.startTime).toMatch(/^\d+$/u);
            expect(status.stable.executable).toMatch(/chrom(?:e|ium)|headless_shell/iu);
            expect(status.stable.aliveAfterCleanup).toBe(false);

            expect(status.listedGeneration.pid).toBe(status.unrelated.pid);
            expect(status.listedGeneration.parentPid).toBe(status.traversal.parentPid);
            expect(status.listedGeneration.startTime).not.toBe(status.unrelated.startTime);
            expect(status.listedGeneration.executable).not.toBe(status.unrelated.executable);
            expect(status.listedGeneration.executableDevice).not.toBe(status.unrelated.executableDevice);
            expect(status.listedGeneration.executableInode).not.toBe(status.unrelated.executableInode);
            expect(status.unrelated.parentPid).not.toBe(status.traversal.parentPid);
            expect(status.unrelated.parentPid).not.toBe(status.launchRoot.pid);
            expect(status.unrelated.identityUnchanged).toBe(true);
            expect(status.unrelated.aliveAfterCleanup).toBe(true);
            expect(status.unrelated.signal).toBe("");

            expect(status.traversal.descendantChildrenReads).toBe(0);
            expect(status.unrelatedDescendant.parentPid).toBe(status.unrelated.pid);
            expect(status.unrelatedDescendant.identityUnchanged).toBe(true);
            expect(status.unrelatedDescendant.aliveAfterCleanup).toBe(true);
            expect(status.unrelatedDescendant.signal).toBe("");
        },
        browserCleanupBoundMs * 4 + 5_000,
    );

    test.skipIf(process.platform !== "linux")(
        "bounds stalled creation but leaves no exact owned Chromium process tree alive",
        async () =>
        {
            const root = await makeOwnedDirectory("pi-browser-stalled-creation-");
            const isolatedTemporaryRoot = path.join(root, "fixture-tmp");
            const syncRoot = path.join(root, "sync");
            const identityPath = path.join(syncRoot, "chromium-identity.json");
            const identityAcknowledgedPath = path.join(syncRoot, "identity-acknowledged");
            const statusPath = path.join(syncRoot, "status.json");
            const releasePath = path.join(syncRoot, "release");
            await Promise.all([mkdir(isolatedTemporaryRoot), mkdir(syncRoot)]);
            const scenario = startStalledBrowserCreationScenario(isolatedTemporaryRoot, syncRoot);
            let ownedChromiumTree: LinuxProcessTree | undefined;
            let scenarioProcessIdentity: LinuxProcessIdentity | undefined;
            let primaryError: unknown;
            const cleanupErrors: unknown[] = [];

            try
            {
                await pollUntil(
                    () => pathExists(identityPath),
                    childTimeoutMs,
                    "the complete live Chromium identity",
                );
                ownedChromiumTree = JSON.parse(await readFile(identityPath, "utf8")) as LinuxProcessTree;
                scenarioProcessIdentity = await readLinuxProcessIdentity(scenario.pid);
                const testRunnerIdentity = await readLinuxProcessIdentity(process.pid);
                const parentShellIdentity = await readLinuxProcessIdentity(process.ppid);
                const ownedChromium = ownedChromiumTree.root;

                expect(ownedChromiumTree.members.length).toBeGreaterThan(0);
                expect(ownedChromiumTree.members.some((member) => sameLinuxProcessIdentity(member, ownedChromium)))
                    .toBe(true);
                expect(ownedChromium.parentPid).toBe(scenario.pid);
                expect(ownedChromium.processGroupId).not.toBe(scenarioProcessIdentity.processGroupId);
                expect(ownedChromium.processGroupId).not.toBe(testRunnerIdentity.processGroupId);
                expect(ownedChromium.processGroupId).not.toBe(parentShellIdentity.processGroupId);
                await assertCapturedLinuxProcessGroupOwnership(
                    ownedChromiumTree,
                    new Set([
                        scenarioProcessIdentity.processGroupId,
                        testRunnerIdentity.processGroupId,
                        parentShellIdentity.processGroupId,
                    ]),
                );
                await writeFile(identityAcknowledgedPath, "complete identity received\n", "utf8");

                await pollUntil(() => pathExists(statusPath), childTimeoutMs, "the stalled creation result");
                const status = JSON.parse(await readFile(statusPath, "utf8")) as StalledCreationStatus;
                const launchedPids = [...scenario.stderr.matchAll(/<launched> pid=(\d+)/gu)]
                    .map((match) => Number.parseInt(match[1]!, 10));
                const launchExecutable = /<launching> (\S+) /u.exec(scenario.stderr)?.[1];

                expect(launchedPids, "the isolated scenario must launch exactly one Chromium process")
                    .toEqual([ownedChromium.pid]);
                expect(launchExecutable).toBe(ownedChromium.executable);
                expect(status.scenarioPid).toBe(scenario.pid);
                expect(status.checkpoints).toEqual([
                    "browser launch completed",
                    "chromium identity persisted",
                    "parent acknowledged chromium identity",
                    "newContext failure occurred",
                    "stalled browser.close entered",
                ]);
                expect(status.status).toBe("rejected");
                expect(status.aggregate).toBe(true);
                expect(status.error).toContain("primary context creation failure");
                expect(status.error).toMatch(/browser.*close|close.*timed out|timeout/iu);
                expect(status.disconnected).toBe(true);
                expect(status.fixtureDirectories).toEqual([]);

                const ownedProcessTreeExited = await waitForExactLinuxProcessTreeExit(
                    ownedChromiumTree,
                    Date.now() + childTerminationTimeoutMs,
                );
                expect(
                    ownedProcessTreeExited,
                    `saved exact owned Chromium PID ${ownedChromium.pid} PGID ${ownedChromium.processGroupId} generation remained present after production cleanup and the ${childTerminationTimeoutMs}ms exit-observation bound`,
                ).toBe(true);
            }
            catch (error)
            {
                primaryError = error;
            }
            finally
            {
                try
                {
                    if (
                        ownedChromiumTree !== undefined
                        && await linuxProcessTreeHasOriginalGeneration(ownedChromiumTree)
                    )
                    {
                        await terminateExactLinuxProcessTree(ownedChromiumTree);
                    }
                    if (ownedChromiumTree !== undefined)
                    {
                        expect(await linuxProcessTreeHasOriginalGeneration(ownedChromiumTree)).toBe(false);
                    }
                }
                catch (error)
                {
                    cleanupErrors.push(error);
                }

                await writeFile(identityAcknowledgedPath, "rescue identity acknowledgement\n", "utf8")
                    .catch((error) => cleanupErrors.push(error));
                await writeFile(releasePath, "rescued\n", "utf8").catch((error) => cleanupErrors.push(error));
                try
                {
                    await beforeDeadline(
                        scenario.completed,
                        Date.now() + childTimeoutMs,
                        `stalled creation scenario PID ${scenario.pid} exit`,
                    );
                }
                catch (error)
                {
                    cleanupErrors.push(error);
                    if (scenarioProcessIdentity !== undefined)
                    {
                        await signalExactLinuxProcessIdentity(scenarioProcessIdentity, "SIGKILL")
                            .catch((signalError) => cleanupErrors.push(signalError));
                    }
                }
                await rm(isolatedTemporaryRoot, { recursive: true, force: true });
            }

            if (primaryError !== undefined)
            {
                if (cleanupErrors.length > 0)
                {
                    throw new AggregateError(
                        [primaryError, ...cleanupErrors],
                        "Stalled creation assertion and rescue failed",
                    );
                }
                throw primaryError;
            }
            if (cleanupErrors.length > 0)
            {
                throw new AggregateError(cleanupErrors, "Stalled creation rescue failed");
            }
        },
        browserCleanupBoundMs + 10_000,
    );

    test("bounds a stalled page close and continues independent fixture cleanup", async () =>
    {
        const fixture = await createBrowserFixture();
        const ownedDirectory = path.dirname(fixtureDirectory(fixture.childEnvironment()));
        const realPageClose = fixture.page.close.bind(fixture.page);
        fixture.page.close = async () => await new Promise<void>(() => undefined);
        const firstClose = fixture.close();
        const secondClose = fixture.close();
        expect(secondClose).toBe(firstClose);

        const outcome = await settleWithin(firstClose, browserCleanupBoundMs);
        const disconnectedBeforeRescue = !fixture.browser.isConnected();
        const directoryGoneBeforeRescue = !await pathExists(ownedDirectory);

        await realPageClose().catch(() => undefined);
        await fixture.context.close().catch(() => undefined);
        await fixture.browser.close().catch(() => undefined);
        await rm(ownedDirectory, { recursive: true, force: true });

        expect(outcome.status).toBe("rejected");
        expect(describeError(outcome.error)).toMatch(/page.*close|close.*timed out|timeout/iu);
        expect(disconnectedBeforeRescue).toBe(true);
        expect(directoryGoneBeforeRescue).toBe(true);
        const repeated = await settleWithin(fixture.close(), 100);
        expect(repeated.status).toBe("rejected");
    }, browserCleanupBoundMs + 5_000);

    test("keeps callback failure first when a stalled close reaches its cleanup deadline", async () =>
    {
        let fixtureReference: BrowserFixture | undefined;
        let ownedDirectory = "";
        let realPageClose: (() => Promise<void>) | undefined;
        const scoped = withBrowserFixture({}, async (fixture) =>
        {
            fixtureReference = fixture;
            ownedDirectory = path.dirname(fixtureDirectory(fixture.childEnvironment()));
            realPageClose = fixture.page.close.bind(fixture.page);
            fixture.page.close = async () => await new Promise<void>(() => undefined);
            throw new Error("primary callback before stalled close");
        });
        const outcome = await settleWithin(scoped, browserCleanupBoundMs);
        const disconnectedBeforeRescue = fixtureReference === undefined || !fixtureReference.browser.isConnected();
        const directoryGoneBeforeRescue = ownedDirectory.length > 0 && !await pathExists(ownedDirectory);

        await realPageClose?.().catch(() => undefined);
        await fixtureReference?.context.close().catch(() => undefined);
        await fixtureReference?.browser.close().catch(() => undefined);
        if (ownedDirectory.length > 0)
        {
            await rm(ownedDirectory, { recursive: true, force: true });
        }

        expect(outcome.status).toBe("rejected");
        expect(outcome.error).toBeInstanceOf(AggregateError);
        expect(describeError((outcome.error as AggregateError).errors[0])).toContain(
            "primary callback before stalled close",
        );
        expect(describeError(outcome.error)).toMatch(/close.*timed out|timeout/iu);
        expect(disconnectedBeforeRescue).toBe(true);
        expect(directoryGoneBeforeRescue).toBe(true);
        const repeated = await settleWithin(fixtureReference!.close(), 100);
        expect(repeated.status).toBe("rejected");
    }, browserCleanupBoundMs + 5_000);
});

interface PidNamespaceCapability
{
    readonly available: boolean;
    readonly evidence: string;
}

interface Pid1ZombieBoundaryStatus
{
    readonly closeElapsedMs: number;
    readonly closeOutcome: { readonly error: string; readonly status: string; };
    readonly fixtureDirectoryGone: boolean;
    readonly generation: LinuxProcessIdentity;
    readonly initialParentPid: number;
    readonly namespaceInitPid: number;
    readonly reparentedThrough: readonly number[];
    readonly rescued: boolean;
    readonly signalAttempts: readonly { readonly pid: number; readonly signal: string; }[];
    readonly stateAfterClose: {
        readonly executableIdentityAvailable: boolean;
        readonly generationPresent: boolean;
        readonly parentPid?: number;
        readonly startTime?: string;
        readonly state: string;
    };
    readonly stateAfterRelease: {
        readonly executableIdentityAvailable: boolean;
        readonly generationPresent: boolean;
        readonly parentPid?: number;
        readonly startTime?: string;
        readonly state: string;
    };
    readonly unrelatedAfterClose: {
        readonly alive: boolean;
        readonly identityUnchanged: boolean;
        readonly signal: string;
    };
    readonly waitpidAudit: string;
}

interface ZombieExitBoundaryStatus
{
    readonly closeElapsedMs: number;
    readonly closeOutcome: { readonly error: string; readonly status: string; };
    readonly fixtureDirectoryGone: boolean;
    readonly generation: LinuxProcessIdentity;
    readonly rescued: boolean;
    readonly signalAttempts: readonly { readonly pid: number; readonly signal: string; }[];
    readonly stateAfterClose: {
        readonly executableIdentityAvailable: boolean;
        readonly generationPresent: boolean;
        readonly startTime?: string;
        readonly state: string;
    };

    readonly stateAfterRelease: {
        readonly executableIdentityAvailable: boolean;
        readonly generationPresent: boolean;
        readonly startTime?: string;
        readonly state: string;
    };
    readonly unrelatedAfterClose: {
        readonly alive: boolean;
        readonly identityUnchanged: boolean;
        readonly signal: string;
    };
    readonly waitpidAudit: string;
}

interface ConcurrentOwnershipRaceStatus
{
    readonly chromiumAfterCleanup: readonly { readonly alive: boolean; readonly rootIdentityUnchanged: boolean; }[];
    readonly fixtureDirectoriesGone: readonly boolean[];
    readonly launchCount: number;
    readonly outcomes: readonly { readonly error: string; readonly status: string; }[];
    readonly resourceCloseElapsedMs: readonly {
        readonly browser?: number;
        readonly context?: number;
        readonly page?: number;
        readonly total: number;
    }[];
    readonly unrelatedAfterCleanup: readonly {
        readonly alive: boolean;
        readonly identityUnchanged: boolean;
        readonly signal: string;
    }[];
}

interface LateBrowserDescendantStatus
{
    readonly browserServerCloseCalls: number;
    readonly browserServerKillCalls: number;
    readonly late: {
        readonly aliveAfterCleanup: boolean;
        readonly ancestryPids: readonly number[];
        readonly executable: string;
        readonly executableAfterCleanup?: string;
        readonly parentPid: number;
        readonly parentPidAfterCleanup?: number;
        readonly pid: number;
        readonly startTime: string;
        readonly startTimeAfterCleanup?: string;
    };
    readonly launchRootPid: number;
    readonly launchSnapshotPids: readonly number[];
    readonly outcome: { readonly error: string; readonly status: string; };
    readonly scenarioPid: number;
    readonly unrelated: {
        readonly alive: boolean;
        readonly executable: string;
        readonly identityUnchanged: boolean;
        readonly parentPid: number;
        readonly pid: number;
        readonly signal: string;
        readonly startTime: string;
    };
}

type ShutdownWindowDescendantStatus = LateBrowserDescendantStatus & {
    readonly ancestryRemovedBeforePageCloseReturned: boolean;

    readonly discoveryObservedDuringPageClose: boolean;
    readonly injectedPageCloseDelayMs: number;
    readonly lateParentPidAtBrowserServerClose?: number;
    readonly pageCloseEntered: boolean;
    readonly rootAliveAtBrowserServerClose: boolean;
};

type RetainedGenerationCollisionStatus = LateBrowserDescendantStatus & {
    readonly expiredDuringCleanup: boolean;
    readonly late: LateBrowserDescendantStatus["late"] & {
        readonly executableDevice: string;
        readonly executableInode: string;
    };
    readonly syntheticIdentity: LinuxProcessIdentity;
    readonly syntheticIdentityReads: number;
};

interface ChildEdgeToctouStatus
{
    readonly browserServerCloseCalls: number;
    readonly browserServerKillCalls: number;
    readonly launchRoot: LinuxProcessIdentity;
    readonly listedGeneration: LinuxProcessIdentity;
    readonly outcome: { readonly error: string; readonly status: string; };
    readonly stable: LinuxProcessIdentity & {
        readonly aliveAfterCleanup: boolean;
        readonly listedOnTraversedEdge: boolean;
    };
    readonly traversal: {
        readonly childrenReads: number;
        readonly currentIdentityReads: number;
        readonly descendantChildrenReads: number;
        readonly parentPid: number;
    };
    readonly unrelated: LinuxProcessIdentity & {
        readonly aliveAfterCleanup: boolean;
        readonly identityUnchanged: boolean;
        readonly signal: string;
    };
    readonly unrelatedDescendant: LinuxProcessIdentity & {
        readonly aliveAfterCleanup: boolean;
        readonly identityUnchanged: boolean;
        readonly signal: string;
    };
}

interface StalledCreationStatus
{
    readonly aggregate: boolean;
    readonly checkpoints: string[];
    readonly disconnected: boolean;
    readonly error: string;
    readonly executablePath: string;
    readonly fixtureDirectories: string[];
    readonly scenarioPid: number;
    readonly status: string;
}

interface StalledCreationScenario
{
    readonly child: ChildProcess;
    readonly completed: Promise<void>;
    readonly pid: number;
    readonly stderr: string;
}

interface LinuxProcessIdentity
{
    readonly executable: string;
    readonly executableDevice: string;
    readonly executableInode: string;
    readonly parentPid: number;
    readonly pid: number;
    readonly processGroupId: number;
    readonly sessionId: number;
    readonly startTime: string;
}

interface LinuxProcessTree
{
    readonly members: readonly LinuxProcessIdentity[];
    readonly root: LinuxProcessIdentity;
}

function startStalledBrowserCreationScenario(
    temporaryRoot: string,
    syncRoot: string,
): StalledCreationScenario
{
    const child = spawn(process.execPath, [stalledBrowserCreationScenario], {
        detached: process.platform !== "win32",
        env: {
            ...process.env,
            ALE44_STALLED_CREATION_SYNC_ROOT: syncRoot,
            DEBUG: [process.env.DEBUG, "pw:browser"].filter((value) => value !== undefined && value.length > 0).join(
                ",",
            ),
            TMPDIR: temporaryRoot,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    const pid = child.pid;
    if (pid === undefined)
    {
        throw new Error("Failed to obtain the stalled creation scenario PID");
    }

    const scenario: { child: ChildProcess; completed: Promise<void>; pid: number; stderr: string; } = {
        child,
        completed: Promise.resolve(),
        pid,
        stderr: "",
    };
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => scenario.stderr += chunk);
    child.stdout!.resume();
    scenario.completed = new Promise<void>((resolve, reject) =>
    {
        child.once("error", reject);
        child.once("close", (code, signal) =>
        {
            if (code === 0)
            {
                resolve();
            }
            else
            {
                reject(
                    new Error(
                        `Stalled creation scenario PID ${pid} exited with ${code ?? signal}: ${
                            boundedOutput(scenario.stderr)
                        }`,
                    ),
                );
            }
        });
    });

    return scenario;
}

async function readLinuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity>
{
    const [statText, executable, executableStats] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readlink(`/proc/${pid}/exe`),
        stat(`/proc/${pid}/exe`, { bigint: true }),
    ]);
    const commandEnd = statText.lastIndexOf(")");
    if (commandEnd < 0)
    {
        throw new Error(`Could not parse /proc/${pid}/stat`);
    }
    const fields = statText.slice(commandEnd + 2).trim().split(/\s+/u);
    const parentPid = Number.parseInt(fields[1]!, 10);
    const processGroupId = Number.parseInt(fields[2]!, 10);
    const sessionId = Number.parseInt(fields[3]!, 10);
    const startTime = fields[19];
    if (
        !Number.isSafeInteger(parentPid)
        || !Number.isSafeInteger(processGroupId)
        || !Number.isSafeInteger(sessionId)
        || startTime === undefined
        || executable.length === 0
    )
    {
        throw new Error(`Incomplete exact process identity for Chromium PID ${pid}`);
    }

    return {
        executable,
        executableDevice: executableStats.dev.toString(),
        executableInode: executableStats.ino.toString(),
        parentPid,
        pid,
        processGroupId,
        sessionId,
        startTime,
    };
}

async function readLinuxProcessIdentityIfSignalable(pid: number): Promise<LinuxProcessIdentity | undefined>
{
    try
    {
        return await readLinuxProcessIdentity(pid);
    }
    catch (error)
    {
        if (
            (error as NodeJS.ErrnoException).code === "ENOENT"
            || (error as NodeJS.ErrnoException).code === "ESRCH"
        )
        {
            return undefined;
        }
        throw error;
    }
}

function sameLinuxProcessIdentity(left: LinuxProcessIdentity, right: LinuxProcessIdentity): boolean
{
    return left.pid === right.pid
        && left.parentPid === right.parentPid
        && left.processGroupId === right.processGroupId
        && left.sessionId === right.sessionId
        && left.startTime === right.startTime
        && left.executable === right.executable
        && left.executableDevice === right.executableDevice
        && left.executableInode === right.executableInode;
}

async function linuxProcessMatches(identity: LinuxProcessIdentity): Promise<boolean>
{
    const current = await readLinuxProcessIdentityIfSignalable(identity.pid);

    return current !== undefined && sameLinuxProcessIdentity(current, identity);
}

async function linuxOriginalProcessGenerationExists(identity: LinuxProcessIdentity): Promise<boolean>
{
    try
    {
        const statText = await readFile(`/proc/${identity.pid}/stat`, "utf8");
        const commandEnd = statText.lastIndexOf(")");
        if (commandEnd < 0)
        {
            throw new Error(`Could not parse /proc/${identity.pid}/stat`);
        }
        const fields = statText.slice(commandEnd + 2).trim().split(/\s+/u);

        return fields[19] === identity.startTime;
    }
    catch (error)
    {
        if (
            (error as NodeJS.ErrnoException).code === "ENOENT"
            || (error as NodeJS.ErrnoException).code === "ESRCH"
        )
        {
            return false;
        }
        throw error;
    }
}

async function captureExactLinuxProcessTree(root: LinuxProcessIdentity): Promise<LinuxProcessTree>
{
    if (!await linuxProcessMatches(root))
    {
        throw new Error(`Refusing to capture Chromium tree because exact root PID ${root.pid} identity changed`);
    }

    const identities = await readAllSignalableLinuxProcessIdentities();
    const members = new Map<number, LinuxProcessIdentity>([[root.pid, root]]);
    let added = true;
    while (added)
    {
        added = false;
        for (const identity of identities)
        {
            if (!members.has(identity.pid) && members.has(identity.parentPid))
            {
                members.set(identity.pid, identity);
                added = true;
            }
        }
    }

    return { members: [...members.values()], root };
}

async function readAllSignalableLinuxProcessIdentities(): Promise<LinuxProcessIdentity[]>
{
    const entries = await readdir("/proc", { withFileTypes: true });
    const identities = await Promise.all(
        entries
            .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
            .map(async (entry) =>
            {
                try
                {
                    return await readLinuxProcessIdentityIfSignalable(Number.parseInt(entry.name, 10));
                }
                catch (error)
                {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (code === "EACCES" || code === "EPERM") return undefined;
                    throw error;
                }
            }),
    );

    return identities.filter((identity): identity is LinuxProcessIdentity => identity !== undefined);
}

async function assertCapturedLinuxProcessGroupOwnership(
    tree: LinuxProcessTree,
    excludedProcessGroupIds: ReadonlySet<number>,
): Promise<void>
{
    const processGroupId = tree.root.processGroupId;
    if (processGroupId <= 1 || excludedProcessGroupIds.has(processGroupId))
    {
        throw new Error(`Refusing unsafe Chromium process group ${processGroupId}`);
    }

    const ownedByPid = new Map(tree.members.map((member) => [member.pid, member]));
    const currentGroupMembers = (await readAllSignalableLinuxProcessIdentities())
        .filter((identity) => identity.processGroupId === processGroupId);
    if (currentGroupMembers.length === 0 || !currentGroupMembers.some((member) => member.pid === tree.root.pid))
    {
        throw new Error(`Chromium process group ${processGroupId} has no matching owned root`);
    }
    const foreignOrChangedMember = currentGroupMembers.find((member) =>
    {
        const captured = ownedByPid.get(member.pid);

        return captured === undefined || !sameLinuxProcessIdentity(member, captured);
    });
    if (foreignOrChangedMember !== undefined)
    {
        throw new Error(
            `Refusing Chromium process group ${processGroupId} because PID ${foreignOrChangedMember.pid} is not an exact captured owned identity`,
        );
    }
}

async function linuxProcessTreeHasOriginalGeneration(tree: LinuxProcessTree): Promise<boolean>
{
    return (await Promise.all(tree.members.map(async (member) => await linuxOriginalProcessGenerationExists(member))))
        .some(Boolean);
}

async function terminateExactLinuxProcessTree(capturedTree: LinuxProcessTree): Promise<void>
{
    let tree = capturedTree;
    if (await linuxProcessMatches(capturedTree.root))
    {
        tree = await captureExactLinuxProcessTree(capturedTree.root);
    }
    const orderedMembers = orderLinuxProcessTreeLeavesFirst(tree);
    const deadline = Date.now() + childTerminationTimeoutMs;

    for (const member of orderedMembers)
    {
        await signalExactLinuxProcessIdentity(member, "SIGTERM");
    }
    await waitForExactLinuxProcessTreeExit(tree, Math.min(deadline, Date.now() + gracefulTerminationMs));
    for (const member of orderedMembers)
    {
        if (await linuxOriginalProcessGenerationExists(member))
        {
            await signalExactLinuxProcessIdentity(member, "SIGKILL");
        }
    }
    if (!await waitForExactLinuxProcessTreeExit(tree, deadline))
    {
        throw new Error(`Timed out rescuing exact owned Chromium process tree ${tree.root.pid}`);
    }
}

function orderLinuxProcessTreeLeavesFirst(tree: LinuxProcessTree): LinuxProcessIdentity[]
{
    const byPid = new Map(tree.members.map((member) => [member.pid, member]));
    const depth = (member: LinuxProcessIdentity): number =>
    {
        let current = member;
        let result = 0;
        while (current.pid !== tree.root.pid)
        {
            const parent = byPid.get(current.parentPid);
            if (parent === undefined)
            {
                throw new Error(`Captured Chromium PID ${current.pid} has no owned parent`);
            }
            result += 1;
            current = parent;
        }

        return result;
    };

    return [...tree.members].sort((left, right) => depth(right) - depth(left));
}

async function signalExactLinuxProcessIdentity(
    identity: LinuxProcessIdentity,
    signal: NodeJS.Signals,
): Promise<void>
{
    const current = await readLinuxProcessIdentityIfSignalable(identity.pid);
    if (current === undefined)
    {
        if (await linuxOriginalProcessGenerationExists(identity))
        {
            throw new Error(`Refusing ${signal} because exact Chromium PID ${identity.pid} cannot be fully rechecked`);
        }

        return;
    }
    if (!sameLinuxProcessIdentity(current, identity))
    {
        throw new Error(`Refusing ${signal} because exact Chromium PID ${identity.pid} identity changed`);
    }

    try
    {
        process.kill(identity.pid, signal);
    }
    catch (error)
    {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        {
            throw error;
        }
    }
}

async function waitForExactLinuxProcessTreeExit(tree: LinuxProcessTree, deadline: number): Promise<boolean>
{
    while (await linuxProcessTreeHasOriginalGeneration(tree))
    {
        if (Date.now() >= deadline)
        {
            return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    return true;
}

type LaunchRecordAttack =
    | "absolute foreign path"
    | "parent traversal escape"
    | "symlink component escape"
    | "recorded path replacement";

async function expectLaunchRecordAttackDoesNotDeleteForeignState(attack: LaunchRecordAttack): Promise<void>
{
    const root = await makeOwnedDirectory(`pi-browser-record-${attack.replaceAll(" ", "-")}-`);
    const fixtureTemporaryRoot = path.join(root, "fixture-tmp");
    const browserCache = path.join(root, "browser-cache");
    const sentinelDirectory = path.join(root, "sentinels");
    const sentinelMarker = path.join(root, "default-opener-invoked");
    const launchSyncRoot = path.join(root, "fake-chromium-sync");
    const launchReady = path.join(launchSyncRoot, "ready");
    const launchRelease = path.join(launchSyncRoot, "release");
    const launchArtifactRecord = path.join(launchSyncRoot, "artifact-record");
    await Promise.all([
        mkdir(fixtureTemporaryRoot),
        mkdir(browserCache),
        mkdir(launchSyncRoot),
        createDefaultOpenerSentinels(sentinelDirectory, sentinelMarker),
        chmod(failingChromiumCommand, 0o755),
    ]);
    const executableResult = await run(
        process.execPath,
        [
            "--input-type=module",
            "--eval",
            "import { chromium } from 'playwright'; process.stdout.write(chromium.executablePath());",
        ],
        { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserCache },
    );
    expect(executableResult.code).toBe(0);
    const revision = /chromium-(\d+)/u.exec(executableResult.stdout)?.[1];
    expect(revision).toBeDefined();
    const chromiumRoot = path.join(browserCache, `chromium-${revision}`);
    const chromiumExecutable = executableResult.stdout.trim();
    const headlessShellRoot = path.join(browserCache, `chromium_headless_shell-${revision}`);
    const headlessShellExecutable = path.join(
        headlessShellRoot,
        "chrome-headless-shell-linux64",
        "chrome-headless-shell",
    );
    const fakeLauncher = await readFile(failingChromiumCommand);
    await Promise.all([
        mkdir(path.dirname(chromiumExecutable), { recursive: true }),
        mkdir(path.dirname(headlessShellExecutable), { recursive: true }),
    ]);
    await Promise.all([
        writeFile(path.join(chromiumRoot, "INSTALLATION_COMPLETE"), "", "utf8"),
        writeFile(path.join(chromiumRoot, "DEPENDENCIES_VALIDATED"), "", "utf8"),
        writeFile(chromiumExecutable, fakeLauncher, { mode: 0o755 }),
        writeFile(path.join(headlessShellRoot, "INSTALLATION_COMPLETE"), "", "utf8"),
        writeFile(path.join(headlessShellRoot, "DEPENDENCIES_VALIDATED"), "", "utf8"),
        writeFile(headlessShellExecutable, fakeLauncher, { mode: 0o755 }),
    ]);

    const foreignBytes = `foreign state for ${attack}\n`;
    let tamperedPath: string;
    let survivingMarker: string;
    let replaceAfterRecord = false;

    if (attack === "absolute foreign path")
    {
        const foreignDirectory = path.join(root, "absolute-foreign");
        survivingMarker = path.join(foreignDirectory, "marker.txt");
        await mkdir(foreignDirectory);
        await writeFile(survivingMarker, foreignBytes, "utf8");
        tamperedPath = foreignDirectory;
    }
    else if (attack === "parent traversal escape")
    {
        const intendedRoot = path.join(fixtureTemporaryRoot, "intended-owned-root");
        const foreignDirectory = path.join(fixtureTemporaryRoot, "traversal-foreign");
        survivingMarker = path.join(foreignDirectory, "marker.txt");
        await Promise.all([mkdir(intendedRoot), mkdir(foreignDirectory)]);
        await writeFile(survivingMarker, foreignBytes, "utf8");
        tamperedPath = `${intendedRoot}${path.sep}..${path.sep}${path.basename(foreignDirectory)}`;
    }
    else if (attack === "symlink component escape")
    {
        const ownedLookingRoot = path.join(fixtureTemporaryRoot, "owned-looking-root");
        const foreignDirectory = path.join(root, "symlink-foreign");
        const foreignVictim = path.join(foreignDirectory, "victim");
        survivingMarker = path.join(foreignVictim, "marker.txt");
        await Promise.all([mkdir(ownedLookingRoot), mkdir(foreignVictim, { recursive: true })]);
        await writeFile(survivingMarker, foreignBytes, "utf8");
        await symlink(foreignDirectory, path.join(ownedLookingRoot, "link"), "dir");
        tamperedPath = path.join(ownedLookingRoot, "link", "victim");
    }
    else
    {
        const recordedPath = path.join(fixtureTemporaryRoot, "recorded-owned-path");
        const foreignReplacement = path.join(root, "foreign-replacement");
        survivingMarker = path.join(recordedPath, "marker.txt");
        await Promise.all([mkdir(recordedPath), mkdir(foreignReplacement)]);
        await Promise.all([
            writeFile(path.join(recordedPath, "original.txt"), "original recorded object\n", "utf8"),
            writeFile(path.join(foreignReplacement, "marker.txt"), foreignBytes, "utf8"),
        ]);
        tamperedPath = recordedPath;
        replaceAfterRecord = true;
    }

    const script = [
        "import { createBrowserFixture } from \"pi-coding-agent-test\";",
        "await createBrowserFixture();",
    ].join("\n");
    const launch = run(process.execPath, ["--input-type=module", "--eval", script], {
        ...process.env,
        ALE44_FAKE_CHROMIUM_SYNC_ROOT: launchSyncRoot,
        ALE44_FAKE_CHROMIUM_TAMPER_PATH: tamperedPath,
        PATH: prependPath(sentinelDirectory, process.env.PATH),
        PLAYWRIGHT_BROWSERS_PATH: browserCache,
        TMPDIR: fixtureTemporaryRoot,
    }, childTimeoutMs * 2);
    await pollUntil(
        () => access(launchReady).then(() => true, () => false),
        childTimeoutMs,
        `the synchronized ${attack} launch record`,
    );
    const fakeChromiumPid = Number.parseInt(await readFile(launchReady, "utf8"), 10);
    const fixtureOwnedLaunchDirectory = (await readFile(launchArtifactRecord, "utf8")).trim();
    expect(await readFile(path.join(fixtureOwnedLaunchDirectory, "fixture-launch-marker.txt"), "utf8"))
        .toBe("fixture-owned launch state\n");

    if (replaceAfterRecord)
    {
        const foreignReplacement = path.join(root, "foreign-replacement");
        await rm(tamperedPath, { recursive: true });
        await rename(foreignReplacement, tamperedPath);
    }

    await writeFile(launchRelease, "release\n", "utf8");
    const result = await launch;

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(recoveryCommand);
    await Promise.all([expectPidExited(result.pid), expectPidExited(fakeChromiumPid)]);
    await expect(access(fixtureOwnedLaunchDirectory)).rejects.toThrow();
    expect((await readdir(fixtureTemporaryRoot)).some((entry) => entry.startsWith("pi-browser-fixture-")))
        .toBe(false);
    await expect(access(sentinelMarker)).rejects.toThrow();
    expect(await readFile(survivingMarker, "utf8")).toBe(foreignBytes);
}

async function makeOwnedDirectory(prefix: string): Promise<string>
{
    const directory = await mkdtemp(path.join(tmpdir(), prefix));
    ownedDirectories.push(directory);

    return directory;
}

async function consumerDirectories(mode: string): Promise<string[]>
{
    const directory = path.join(process.cwd(), ".tmp");
    const entries = await readdir(directory);

    return entries.filter((entry) => entry.startsWith(`ale44-${mode}-consumer-`));
}

async function createDefaultOpenerSentinels(directory: string, marker: string): Promise<void>
{
    await mkdir(directory, { recursive: true });
    await writeFile(
        path.join(directory, "sentinel.cjs"),
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "invoked"); process.exit(97);\n`,
        "utf8",
    );
    const commands = process.platform === "win32" ? ["cmd.exe"] : ["xdg-open", "open"];
    await Promise.all(commands.map(async (command) =>
    {
        const target = path.join(directory, command);
        await writeFile(
            target,
            `#!/usr/bin/env node\nrequire(${JSON.stringify(path.join(directory, "sentinel.cjs"))});\n`,
            "utf8",
        );
        await chmod(target, 0o755);
    }));
}

function prependPath(directory: string, current: string | undefined): string
{
    return current === undefined ? directory : `${directory}${path.delimiter}${current}`;
}

function privateEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv
{
    return Object.fromEntries(
        Object.entries(environment).filter(([key]) => !["PATH", "NODE_OPTIONS", "CALLER_VALUE"].includes(key)),
    );
}

function changedPrivateKeys(base: NodeJS.ProcessEnv, environment: NodeJS.ProcessEnv): string[]
{
    return Object.keys(environment).filter((key) =>
        !["PATH", "NODE_OPTIONS"].includes(key) && environment[key] !== base[key]
    );
}

function fixtureDirectory(environment: NodeJS.ProcessEnv): string
{
    const directory = environment.PATH?.split(path.delimiter)[0];

    if (directory === undefined || directory.length === 0)
    {
        throw new Error("Browser fixture did not prepend its owned directory to PATH");
    }

    return directory;
}

async function startControlledRecorder(
    fixture: BrowserFixture,
    url: string,
    holdPoint: RecorderHoldPoint = "before-active-publication",
): Promise<ControlledRecorder>
{
    const syncDirectory = await makeOwnedDirectory("ale44-active-recorder-sync-");
    const readyPath = path.join(syncDirectory, "ready.json");
    const releasePath = path.join(syncDirectory, "release");
    const environment = fixture.childEnvironment(process.env);
    const ownedFixtureDirectory = path.dirname(fixtureDirectory(environment));
    const initialFixtureFiles = new Set(await listFixtureFiles(ownedFixtureDirectory));
    environment.NODE_OPTIONS = await instrumentRecorderPreload(
        environment.NODE_OPTIONS,
        path.join(syncDirectory, "controlled-browser-opener-preload.mjs"),
        holdPoint,
    );
    const child = spawn(fixture.openerCommand, [url], {
        detached: process.platform !== "win32",
        env: {
            ...environment,
            ALE44_RECORDER_READY: readyPath,
            ALE44_RECORDER_RELEASE: releasePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    const pid = child.pid;
    if (pid === undefined)
    {
        throw new Error("Failed to obtain the controlled opener recorder PID");
    }

    const linuxIdentity = process.platform === "linux" ? await readLinuxProcessIdentity(pid) : undefined;

    let stderr = "";
    let stdout = "";
    child.stderr!.setEncoding("utf8");
    child.stdout!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => stderr += chunk);
    child.stdout!.on("data", (chunk: string) => stdout += chunk);
    const completed = new Promise<SpawnResult>((resolve, reject) =>
    {
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, pid, stderr, stdout }));
    });

    return {
        child,
        completed,
        environment,
        fixtureDirectory: ownedFixtureDirectory,
        initialFixtureFiles,
        linuxIdentity,
        pid,
        readyPath,
        releasePath,
        syncDirectory,
    };
}

async function instrumentRecorderPreload(
    nodeOptions: string | undefined,
    target: string,
    holdPoint: RecorderHoldPoint,
): Promise<string>
{
    if (nodeOptions === undefined)
    {
        throw new Error("Browser fixture child environment did not install its opener preload");
    }

    const importPattern = /--import=(?:"([^"]*browser-opener-preload\.mjs)"|(\S*browser-opener-preload\.mjs))/u;
    const match = importPattern.exec(nodeOptions);
    const preloadPath = match?.[1] ?? match?.[2];
    if (match === null || preloadPath === undefined)
    {
        throw new Error("Browser fixture child environment did not expose its opener preload path");
    }

    const source = await readFile(preloadPath, "utf8");
    const boundary = holdPoint === "before-active-publication"
        ? "    let activePublished = false;"
        : "        const handle = await open(recordPath, \"wx\");";
    const index = source.indexOf(boundary);
    if (index < 0)
    {
        throw new Error(`Controlled recorder could not locate the ${holdPoint} preload boundary`);
    }

    const synchronization = [
        "    if (process.env.ALE44_RECORDER_READY !== undefined",
        "        && process.env.ALE44_RECORDER_RELEASE !== undefined)",
        "    {",
        "        const { writeFile: writeSynchronizationFile, rename: publishSynchronizationFile } = await import(\"node:fs/promises\");",
        "        await writeSynchronizationFile(",
        "            `${process.env.ALE44_RECORDER_READY}.pending`,",
        "            `${JSON.stringify({ pid: process.pid, token })}\\n`,",
        "            \"utf8\",",
        "        );",
        "        await publishSynchronizationFile(`${process.env.ALE44_RECORDER_READY}.pending`, process.env.ALE44_RECORDER_READY);",
        "        while (!existsSync(process.env.ALE44_RECORDER_RELEASE))",
        "        {",
        "            await new Promise((resolve) => setTimeout(resolve, 10));",
        "        }",
        "    }",
        "",
    ].join("\n");
    await writeFile(target, `${source.slice(0, index)}${synchronization}${source.slice(index)}`, "utf8");

    return nodeOptions.replace(match[0], `--import=${JSON.stringify(target)}`);
}
async function waitForControlledRecorder(recorder: ControlledRecorder): Promise<void>
{
    await pollUntil(
        () => pathExists(recorder.readyPath),
        childTimeoutMs,
        "validated-claim opener recorder hold point",
    );
    const ready = JSON.parse(await readFile(recorder.readyPath, "utf8")) as { pid?: unknown; token?: unknown; };
    expect(ready).toEqual({
        pid: recorder.pid,
        token: recorder.environment.PI_BROWSER_FIXTURE_TOKEN,
    });
}

async function rescueControlledRecorder(recorder: ControlledRecorder): Promise<void>
{
    await writeFile(recorder.releasePath, "rescue\n", "utf8").catch(() => undefined);
    const outcome = await settleWithin(recorder.completed, childTerminationTimeoutMs);
    if (outcome.status === "pending")
    {
        if (recorder.linuxIdentity !== undefined)
        {
            const exited = new Promise<void>((resolve) => recorder.child.once("exit", () => resolve()));
            if (await linuxOriginalProcessGenerationExists(recorder.linuxIdentity))
            {
                await signalExactLinuxProcessIdentity(recorder.linuxIdentity, "SIGKILL");
                await exited;
            }
        }
        else
        {
            await terminateOwnedProcessTree(
                recorder.child,
                recorder.pid,
                new Promise<void>((resolve) => recorder.child.once("exit", () => resolve())),
            );
        }
    }
    await rm(recorder.syncDirectory, { recursive: true, force: true });
}

async function discoverActiveRecorderProtocol(
    recorder: ControlledRecorder,
): Promise<{ readonly marker: unknown; readonly path: string; } | undefined>
{
    const token = recorder.environment.PI_BROWSER_FIXTURE_TOKEN;
    if (token === undefined)
    {
        throw new Error("Controlled recorder environment did not contain its fixture token");
    }

    const candidates = (await listFixtureFiles(recorder.fixtureDirectory))
        .filter((file) => !recorder.initialFixtureFiles.has(file));
    for (const candidate of candidates)
    {
        const raw = await readFile(candidate, "utf8").catch(() => "");
        if (!raw.includes(token) || !raw.includes(String(recorder.pid)))
        {
            continue;
        }

        try
        {
            return { marker: JSON.parse(raw), path: candidate };
        }
        catch
        {
            // A fixture may own other new files; only structured ownership metadata qualifies.
        }
    }

    return undefined;
}

function mutateInstalledActiveMarker(
    marker: unknown,
    recorder: ControlledRecorder,
    unrelated: LinuxProcessIdentity,
    variant: "foreign" | "stale",
): string
{
    const token = recorder.environment.PI_BROWSER_FIXTURE_TOKEN;
    const recorderIdentity = recorder.linuxIdentity;
    if (token === undefined || recorderIdentity === undefined)
    {
        throw new Error("Installed active recorder metadata lacks a Linux token/generation source");
    }

    let mutated = replaceJsonScalar(marker, recorder.pid, unrelated.pid);
    mutated = replaceJsonScalar(mutated.value, recorderIdentity.startTime, unrelated.startTime);
    if (mutated.replacements === 0)
    {
        throw new Error("Installed active recorder metadata did not expose its exact process generation");
    }
    if (variant === "foreign")
    {
        mutated = replaceJsonScalar(mutated.value, token, `foreign-${randomUUID()}`);
        if (mutated.replacements === 0)
        {
            throw new Error("Installed active recorder metadata did not retain its fixture token");
        }
    }
    else
    {
        mutated = replaceJsonScalar(
            mutated.value,
            unrelated.startTime,
            (BigInt(unrelated.startTime) + 1n).toString(),
        );
    }

    return `${JSON.stringify(mutated.value)}\n`;
}

function replaceJsonScalar(
    value: unknown,
    expected: string | number,
    replacement: string | number,
): { readonly replacements: number; readonly value: unknown; }
{
    if (value === expected)
    {
        return { replacements: 1, value: replacement };
    }
    if (Array.isArray(value))
    {
        const entries = value.map((entry) => replaceJsonScalar(entry, expected, replacement));

        return {
            replacements: entries.reduce((total, entry) => total + entry.replacements, 0),
            value: entries.map((entry) => entry.value),
        };
    }
    if (value !== null && typeof value === "object")
    {
        let replacements = 0;
        const entries = Object.entries(value).map(([key, entry]) =>
        {
            const result = replaceJsonScalar(entry, expected, replacement);
            replacements += result.replacements;

            return [key, result.value];
        });

        return { replacements, value: Object.fromEntries(entries) };
    }

    return { replacements: 0, value };
}

async function listFixtureFiles(root: string): Promise<string[]>
{
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> =>
    {
        for (const entry of await readdir(directory, { withFileTypes: true }))
        {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory())
            {
                await visit(target);
            }
            else if (entry.isFile())
            {
                files.push(target);
            }
        }
    };
    await visit(root);

    return files;
}

function restoreEnvironment(key: string, value: string | undefined): void
{
    if (value === undefined)
    {
        delete process.env[key];
    }
    else
    {
        process.env[key] = value;
    }
}

async function detectPidNamespaceCapability(): Promise<PidNamespaceCapability>
{
    if (process.platform !== "linux")
    {
        return { available: false, evidence: `platform=${process.platform}` };
    }

    try
    {
        const result = await run(
            "unshare",
            [
                "--user",
                "--map-root-user",
                "--pid",
                "--fork",
                "--mount-proc",
                process.execPath,
                "--input-type=module",
                "--eval",
                "process.stdout.write(JSON.stringify({ pid: process.pid, ppid: process.ppid }))",
            ],
            process.env,
            childTimeoutMs,
        );
        const identity = JSON.parse(result.stdout) as { readonly pid?: unknown; readonly ppid?: unknown; };
        const available = result.code === 0 && identity.pid === 1 && identity.ppid === 0;
        return {
            available,
            evidence: available
                ? "unshare created PID 1 with a private /proc mount"
                : `exit=${result.code} stdout=${boundedOutput(result.stdout)} stderr=${boundedOutput(result.stderr)}`,
        };
    }
    catch (error)
    {
        return { available: false, evidence: describeError(error) };
    }
}

async function run(
    command: string,
    arguments_: readonly string[],
    environment: NodeJS.ProcessEnv,
    timeoutMs = childTimeoutMs,
): Promise<SpawnResult>
{
    return await new Promise((resolve, reject) =>
    {
        const child = spawn(command, arguments_, {
            detached: process.platform !== "win32",
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        const pid = child.pid;

        if (pid === undefined)
        {
            reject(new Error("Failed to obtain the owned command PID"));

            return;
        }

        let stderr = "";
        let stdout = "";
        let settled = false;
        let timingOut = false;
        child.stderr.setEncoding("utf8");
        child.stdout.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => stderr += chunk);
        child.stdout.on("data", (chunk: string) => stdout += chunk);
        const exited = new Promise<void>((exitResolve) => child.once("exit", () => exitResolve()));
        const timer = setTimeout(() =>
        {
            if (settled || timingOut)
            {
                return;
            }

            timingOut = true;
            void terminateOwnedProcessTree(child, pid, exited).then(
                () =>
                {
                    settled = true;
                    resolve({
                        code: child.exitCode,
                        pid,
                        stderr,
                        stdout,
                        timedOut: true,
                    });
                },
                (terminationError: unknown) =>
                {
                    settled = true;
                    resolve({
                        cleanupError: describeError(terminationError),
                        code: child.exitCode,
                        pid,
                        stderr,
                        stdout,
                        timedOut: true,
                    });
                },
            );
        }, timeoutMs);
        timer.unref();
        child.once("error", (error) =>
        {
            if (!settled && !timingOut)
            {
                settled = true;
                clearTimeout(timer);
                reject(error);
            }
        });
        child.once("close", (code) =>
        {
            if (!settled && !timingOut)
            {
                settled = true;
                clearTimeout(timer);
                if (code !== 0)
                {
                    console.error(JSON.stringify({ command, arguments: arguments_, code, stderr, stdout }));
                }
                resolve({ code, pid, stderr, stdout });
            }
        });
    });
}

async function terminateOwnedProcessTree(
    child: ChildProcess,
    pid: number,
    exited: Promise<void>,
): Promise<void>
{
    const deadline = Date.now() + childTerminationTimeoutMs;
    const cleanupErrors: unknown[] = [];

    try
    {
        if (process.platform === "linux")
        {
            const identity = await readLinuxProcessIdentity(pid);
            const tree = await captureExactLinuxProcessTree(identity);
            await terminateExactLinuxProcessTree(tree);
        }
        else
        {
            child.kill("SIGTERM");
            await Promise.race([
                exited,
                new Promise<void>((resolve) => setTimeout(resolve, gracefulTerminationMs)),
            ]);
            if (child.exitCode === null && child.signalCode === null)
            {
                child.kill("SIGKILL");
            }
        }
    }
    catch (error)
    {
        cleanupErrors.push(error);
    }

    try
    {
        await beforeDeadline(exited, deadline, `owned PID ${pid} exit`);
    }
    catch (error)
    {
        cleanupErrors.push(error);
    }

    if (child.exitCode === null && child.signalCode === null)
    {
        cleanupErrors.push(new Error(`Owned PID ${pid} did not report exit after tree termination`));
    }
    if (cleanupErrors.length > 0)
    {
        throw new AggregateError(cleanupErrors, `Owned PID ${pid} process-tree termination failed`);
    }
}

async function beforeDeadline<T>(promise: Promise<T>, deadline: number, label: string): Promise<T>
{
    const remainingMs = deadline - Date.now();

    if (remainingMs <= 0)
    {
        throw new Error(`${label} exceeded the ${childTerminationTimeoutMs}ms termination bound`);
    }

    let timer: NodeJS.Timeout | undefined;

    try
    {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) =>
            {
                timer = setTimeout(
                    () => reject(new Error(`${label} exceeded the ${childTerminationTimeoutMs}ms termination bound`)),
                    remainingMs,
                );
                timer.unref();
            }),
        ]);
    }
    finally
    {
        if (timer !== undefined)
        {
            clearTimeout(timer);
        }
    }
}

function boundedOutput(output: string): string
{
    return JSON.stringify(output.slice(-500));
}

async function expectPidExited(pid: number): Promise<void>
{
    await pollUntil(
        () =>
        {
            try
            {
                process.kill(pid, 0);

                return false;
            }
            catch
            {
                return true;
            }
        },
        1_000,
        `recorder PID ${pid} to exit`,
    );
}

async function pollUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void>
{
    const deadline = Date.now() + timeoutMs;

    while (!await predicate())
    {
        if (Date.now() >= deadline)
        {
            throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function recorderTimingBudget(): Promise<RecorderTimingBudget>
{
    recorderTimingBudgetPromise ??= measureRecorderTimingBudget();

    return await recorderTimingBudgetPromise;
}

async function measureRecorderTimingBudget(): Promise<RecorderTimingBudget>
{
    const cleanCloseSamplesMs: number[] = [];

    for (let sample = 0; sample < cleanFixtureStateSampleCount; sample += 1)
    {
        const fixture = await createBrowserFixture();

        try
        {
            await fixture.page.close();
            await fixture.context.close();
            await fixture.browser.close();
            const startedAt = performance.now();
            await fixture.close();
            cleanCloseSamplesMs.push(performance.now() - startedAt);
        }
        finally
        {
            await fixture.close().catch(() => undefined);
        }
    }

    const conservativeCleanCloseBaselineMs = Math.max(...cleanCloseSamplesMs);
    const inactiveRecorderDeadlineMs = Math.ceil(conservativeCleanCloseBaselineMs)
        + inactiveRecorderFilesystemSchedulingMarginMs;

    return {
        activeRecorderWaitProbeMs: inactiveRecorderDeadlineMs + activeRecorderProbeSeparationMs,
        cleanCloseSamplesMs,
        inactiveRecorderDeadlineMs,
    };
}

interface SettlementOutcome
{
    readonly status: "fulfilled" | "pending" | "rejected";
    readonly error?: unknown;
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<SettlementOutcome>
{
    let timer: NodeJS.Timeout | undefined;

    try
    {
        return await Promise.race([
            promise.then(
                (): SettlementOutcome => ({ status: "fulfilled" }),
                (error: unknown): SettlementOutcome => ({ status: "rejected", error }),
            ),
            new Promise<SettlementOutcome>((resolve) =>
            {
                timer = setTimeout(() => resolve({ status: "pending" }), timeoutMs);
                timer.unref();
            }),
        ]);
    }
    finally
    {
        if (timer !== undefined)
        {
            clearTimeout(timer);
        }
    }
}

async function pathExists(target: string): Promise<boolean>
{
    return await access(target).then(() => true, () => false);
}

function describeError(error: unknown): string
{
    if (error instanceof AggregateError)
    {
        return `${error.message} ${error.errors.map(describeError).join(" ")}`;
    }
    if (error instanceof Error)
    {
        return `${error.message} ${describeError(error.cause)}`;
    }

    return String(error ?? "");
}
