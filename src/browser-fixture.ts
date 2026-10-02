import { type ChildProcess, spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type Browser, type BrowserContext, type BrowserServer, chromium, type Page } from "playwright";

const tokenEnvironment = "PI_BROWSER_FIXTURE_TOKEN";
const recordEnvironment = "PI_BROWSER_FIXTURE_RECORD";
const claimEnvironment = "PI_BROWSER_FIXTURE_CLAIM";
const activeEnvironment = "PI_BROWSER_FIXTURE_ACTIVE";
const handoffEnvironment = "PI_BROWSER_FIXTURE_HANDOFF";
// Kept as an inert launch marker for older launch helpers; it is never read for cleanup.
const launchRecordEnvironment = "PI_BROWSER_FIXTURE_LAUNCH_RECORDS";
const defaultWaitTimeoutMs = 10_000;
const pollIntervalMs = 20;
const maxDiagnosticsBytes = 64 * 1024;
const browserCloseTimeoutMs = 400;
const browserServerCloseTimeoutMs = 2_000;
const browserProcessExitTimeoutMs = 500;
const activeRecorderWaitTimeoutMs = 1_800;
const activeRecorderProcessExitTimeoutMs = 150;
const activeRecorderPollIntervalMs = 20;
// Keep the original method identity so test launch hooks can be detected without internal Playwright APIs.
// eslint-disable-next-line @typescript-eslint/unbound-method
const defaultChromiumLaunch = chromium.launch;

/** Options for a dedicated, package-owned Chromium browser fixture. */
export interface BrowserFixtureOptions
{
    /** Launch headless Chromium (the default). Set false only with an available display. */
    readonly headless?: boolean;
    /** Directory in which bounded, secret-safe browser evidence is written. */
    readonly artifactsDirectory?: string;
    /** Default bound for URL capture waits. */
    readonly timeoutMs?: number;
}

/** Options accepted by {@link BrowserFixture.waitForUrl}. */
export interface BrowserFixtureWaitOptions
{
    /** Maximum time to wait for the opener URL. */
    readonly timeoutMs?: number;
    /** Cancel the wait without affecting the browser fixture. */
    readonly signal?: AbortSignal;
}

/** A browser owner that is independent of Pi or any application server. */
export interface BrowserFixture
{
    readonly browser: Browser;
    readonly context: BrowserContext;
    readonly page: Page;
    /** Node runtime command to pass to an application's explicit browser opener. */
    readonly openerCommand: string;
    /** Return child-scoped environment values for the application under test. */
    childEnvironment(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
    /** Wait for one URL captured by this fixture's opener. */
    waitForUrl(options?: BrowserFixtureWaitOptions): Promise<string>;
    /** Close all resources owned by this fixture. Safe to call repeatedly. */
    close(): Promise<void>;
}

/** Create and launch an isolated Playwright Chromium browser fixture. */
export async function createBrowserFixture(options: BrowserFixtureOptions = {}): Promise<BrowserFixture>
{
    const headless = options.headless ?? true;

    if (!headless && process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
    {
        throw new Error("Headed browser fixtures on Linux require DISPLAY or WAYLAND_DISPLAY; run under Xvfb.");
    }

    const directory = await mkdtemp(path.join(tmpdir(), "pi-browser-fixture-"));
    const sentinelDirectory = path.join(directory, "sentinels");
    const launchRoot = path.join(directory, "launch");
    const launchArtifacts = path.join(launchRoot, "artifacts");
    const launchTmp = path.join(launchRoot, "tmp");
    const recordPath = path.join(directory, "capture.json");
    const claimPath = path.join(directory, "claim");
    const activePath = path.join(directory, "active-recorder.json");
    const handoffPath = path.join(directory, "recorder-claim");
    const token = randomUUID();
    const preloadPath = fileURLToPath(new URL("runtime/browser-opener-preload.mjs", import.meta.url));
    const launchRecordPath = path.join(launchRoot, "launch-records");
    const launchEnvironment = createLaunchEnvironment(launchTmp, launchRecordPath);
    const diagnostics: DiagnosticRecord[] = [];
    let browser: Browser | undefined;
    let browserServer: BrowserServer | undefined;
    let ownedProcess: OwnedBrowserProcess | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;

    try
    {
        await Promise.all([
            mkdir(sentinelDirectory),
            mkdir(launchArtifacts, { recursive: true }),
            mkdir(launchTmp, { recursive: true }),
            writeFile(claimPath, `${token}\n`, { mode: 0o600 }),
        ]);
        await createSentinels(sentinelDirectory, process.execPath);

        try
        {
            const executablePath = chromium.executablePath();
            await access(executablePath);
            const launchOptions = {
                headless,
                timeout: 8_000,
                args: ["--enable-automation"],
                artifactsDir: launchArtifacts,
                env: launchEnvironment,
            };

            if (chromium.launch === defaultChromiumLaunch)
            {
                browserServer = await chromium.launchServer(launchOptions);
                ownedProcess = await captureOwnedBrowserProcess(browserServer);
                browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 8_000 });
            }
            else
            {
                // A caller-supplied launch hook is supported for process-failure tests.
                browser = await chromium.launch(launchOptions);
                ownedProcess = await captureOwnedPatchedBrowserProcess(executablePath);
            }
        }
        catch (error)
        {
            throw new Error("Playwright Chromium is unavailable. Run `npx playwright install chromium`.", {
                cause: error,
            });
        }

        context = await browser.newContext();
        page = await context.newPage();
        attachDiagnostics(page, diagnostics);

        return new FixtureImpl(
            browser,
            ownedProcess,
            context,
            page,
            directory,
            sentinelDirectory,
            recordPath,
            claimPath,
            activePath,
            handoffPath,
            token,
            preloadPath,
            headless,
            options,
            diagnostics,
        );
    }
    catch (error)
    {
        const cleanupErrors: unknown[] = [];

        for (
            const [resource, label] of [
                [page, "page"],
                [context, "context"],
                [browser, "browser"],
            ] as const
        )
        {
            if (resource !== undefined)
            {
                try
                {
                    await closeWithDeadline(resource.close.bind(resource), label);
                }
                catch (closeError)
                {
                    cleanupErrors.push(closeError);

                    if (resource === browser)
                    {
                        disconnectBrowser(browser);
                    }
                }
            }
        }

        if (browserServer !== undefined && ownedProcess === undefined)
        {
            try
            {
                await closeWithDeadline(
                    browserServer.close.bind(browserServer),
                    "browser server",
                    browserServerCloseTimeoutMs,
                );
            }
            catch (serverError)
            {
                cleanupErrors.push(serverError);

                try
                {
                    await closeWithDeadline(
                        browserServer.kill.bind(browserServer),
                        "browser server kill",
                        browserServerCloseTimeoutMs,
                    );
                }
                catch (killError)
                {
                    cleanupErrors.push(killError);
                }
            }
        }

        try
        {
            await terminateOwnedBrowserProcess(ownedProcess);
        }
        catch (processError)
        {
            cleanupErrors.push(processError);
        }

        try
        {
            await rm(directory, { recursive: true, force: true });
        }
        catch (cleanupError)
        {
            cleanupErrors.push(cleanupError);
        }

        if (cleanupErrors.length > 0)
        {
            throw new AggregateError([error, ...cleanupErrors], "Browser fixture creation and cleanup failed");
        }

        throw error;
    }
}

/** Create a fixture, run a callback, and always close the fixture. */
export async function withBrowserFixture<T>(
    options: BrowserFixtureOptions,
    callback: (fixture: BrowserFixture) => T | Promise<T>,
): Promise<T>;

/** Create a fixture with default options, run a callback, and always close it. */
export async function withBrowserFixture<T>(
    callback: (fixture: BrowserFixture) => T | Promise<T>,
): Promise<T>;

export async function withBrowserFixture<T>(
    optionsOrCallback: BrowserFixtureOptions | ((fixture: BrowserFixture) => T | Promise<T>),
    maybeCallback?: (fixture: BrowserFixture) => T | Promise<T>,
): Promise<T>
{
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;

    if (callback === undefined)
    {
        throw new TypeError("withBrowserFixture requires a callback");
    }

    const fixture = await createBrowserFixture(options);
    let value: T | undefined;
    let primaryError: unknown;

    try
    {
        value = await callback(fixture);
    }
    catch (error)
    {
        primaryError = error;
    }

    let cleanupError: unknown;

    try
    {
        await fixture.close();
    }
    catch (error)
    {
        cleanupError = error;
    }

    if (primaryError !== undefined)
    {
        if (cleanupError !== undefined)
        {
            const primaryMessage = errorMessage(primaryError);
            throw new AggregateError(
                [primaryError, cleanupError],
                `${primaryMessage}; browser fixture cleanup also failed`,
            );
        }

        throw toError(primaryError);
    }

    if (cleanupError !== undefined)
    {
        throw toError(cleanupError);
    }

    return value as T;
}

interface DiagnosticRecord
{
    readonly kind: string;
    readonly [key: string]: unknown;
}

interface ActiveRecorderMarker
{
    readonly kind?: unknown;
    readonly token?: unknown;
    readonly pid?: unknown;
    readonly startTime?: unknown;
}

interface RecorderOwnership
{
    readonly marker?: ActiveRecorderMarker;
    readonly evidence: string;
}

interface LinuxProcessIdentity
{
    readonly pid: number;
    readonly parentPid: number;
    readonly processGroupId: number;
    readonly sessionId: number;
    readonly startTime: string;
    readonly executable: string;
    readonly executableDevice: string;
    readonly executableInode: string;
}

interface LinuxProcessGeneration
{
    readonly pid: number;
    readonly parentPid: number;
    readonly startTime: string;
    readonly state: string;
}
interface LinuxProcessTree
{
    readonly root: LinuxProcessIdentity;
    readonly members: LinuxProcessIdentity[];
}

interface OwnedBrowserProcess
{
    /** The launch-specific Playwright owner returned by chromium.launchServer(). */
    readonly server?: BrowserServer;
    readonly pid: number;
    readonly linuxTree?: LinuxProcessTree;
}

interface LinuxProcessDiscovery
{
    stop(): Promise<void>;
}

class FixtureImpl implements BrowserFixture
{
    readonly openerCommand = process.execPath;
    private readonly waitTimeoutMs: number;
    private closePromise: Promise<void> | undefined;
    private closed = false;
    private capturedUrl: string | undefined;
    private readonly waiters = new Set<() => void>();
    private directorySafeToRemove = true;

    constructor(
        readonly browser: Browser,
        private readonly ownedProcess: OwnedBrowserProcess | undefined,
        readonly context: BrowserContext,
        readonly page: Page,
        private readonly directory: string,
        private readonly sentinelDirectory: string,
        private readonly recordPath: string,
        private readonly claimPath: string,
        private readonly activePath: string,
        private readonly handoffPath: string,
        private readonly token: string,
        private readonly preloadPath: string,
        private readonly headless: boolean,
        private readonly options: BrowserFixtureOptions,
        private readonly diagnostics: DiagnosticRecord[],
    )
    {
        this.waitTimeoutMs = options.timeoutMs ?? defaultWaitTimeoutMs;
    }

    childEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv
    {
        const environment: NodeJS.ProcessEnv = { ...base };
        const nodeOptions = environment.NODE_OPTIONS?.trim();
        const preloadOption = `--import=${quoteNodeOption(this.preloadPath)}`;
        environment.NODE_OPTIONS = nodeOptions === undefined || nodeOptions.length === 0
            ? preloadOption
            : `${nodeOptions} ${preloadOption}`;
        const existingPath = environment.PATH;
        environment.PATH = existingPath === undefined
            ? this.sentinelDirectory
            : `${this.sentinelDirectory}${path.delimiter}${existingPath}`;
        environment[tokenEnvironment] = this.token;
        environment[recordEnvironment] = this.recordPath;
        environment[claimEnvironment] = this.claimPath;
        environment[activeEnvironment] = this.activePath;
        environment[handoffEnvironment] = this.handoffPath;
        return environment;
    }

    waitForUrl(options: BrowserFixtureWaitOptions = {}): Promise<string>
    {
        if (this.closed)
        {
            return Promise.reject(new Error("Browser fixture is closed"));
        }

        if (this.capturedUrl !== undefined)
        {
            return Promise.resolve(this.capturedUrl);
        }

        const timeoutMs = options.timeoutMs ?? this.waitTimeoutMs;

        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        {
            return Promise.reject(new Error("Browser fixture URL wait timeout must be positive"));
        }

        const signal = options.signal;

        if (signal?.aborted)
        {
            return Promise.reject(abortError(signal.reason));
        }

        const promise = new Promise<string>((resolve, reject) =>
        {
            let settled = false;
            const finish = (error?: unknown, value?: string): void =>
            {
                if (settled)
                {
                    return;
                }

                settled = true;
                clearInterval(poll);
                clearTimeout(timer);
                this.waiters.delete(onClose);
                signal?.removeEventListener("abort", onAbort);

                if (error === undefined)
                {
                    resolve(value!);
                }
                else
                {
                    reject(toError(error));
                }
            };
            const onClose = (): void =>
            {
                finish(new Error("Browser fixture closed"));
            };
            const onAbort = (): void =>
            {
                finish(abortError(signal?.reason));
            };
            const poll = setInterval(() =>
            {
                void this.readCapture().then((url) =>
                {
                    if (url !== undefined)
                    {
                        this.capturedUrl = url;
                        finish(undefined, url);
                    }

                    return url;
                }).catch(() =>
                {});
            }, pollIntervalMs);
            const timer = setTimeout(
                () =>
                {
                    finish(new Error(`Browser URL wait timeout after ${timeoutMs}ms`));
                },
                timeoutMs,
            );
            poll.unref();
            timer.unref();
            this.waiters.add(onClose);
            signal?.addEventListener("abort", onAbort, { once: true });
            void this.readCapture().then((url) =>
            {
                if (url !== undefined)
                {
                    this.capturedUrl = url;
                    finish(undefined, url);
                }

                return url;
            }).catch(() =>
            {});
        });
        void promise.catch(() =>
        {});
        return promise;
    }

    close(): Promise<void>
    {
        this.closePromise ??= this.performClose();
        return this.closePromise;
    }

    private async performClose(): Promise<void>
    {
        this.closed = true;

        for (const waiter of this.waiters)
        {
            waiter();
        }

        this.waiters.clear();
        const errors: unknown[] = [];

        try
        {
            // Invalidate new opener claims before waiting for a recorder that already validated one.
            await rm(this.claimPath, { force: true });
        }
        catch (error)
        {
            errors.push(error);
        }

        try
        {
            await this.waitForActiveRecorder();
        }
        catch (error)
        {
            errors.push(error);
        }

        let linuxDiscovery: LinuxProcessDiscovery | undefined;

        if (this.ownedProcess?.linuxTree !== undefined)
        {
            try
            {
                await retainLinuxProcessDescendants(this.ownedProcess.linuxTree);
                linuxDiscovery = startLinuxProcessDiscovery(this.ownedProcess.linuxTree);
            }
            catch (error)
            {
                errors.push(error);
            }
        }

        try
        {
            for (
                const [resource, label] of [
                    [this.page, "page"],
                    [this.context, "context"],
                    [this.browser, "browser"],
                ] as const
            )
            {
                try
                {
                    await closeWithDeadline(resource.close.bind(resource), label);
                }
                catch (error)
                {
                    errors.push(error);

                    if (resource === this.browser)
                    {
                        disconnectBrowser(this.browser);
                    }
                }
            }

            try
            {
                await terminateOwnedBrowserProcess(this.ownedProcess, true);
            }
            catch (error)
            {
                errors.push(error);
            }
        }
        finally
        {
            if (linuxDiscovery !== undefined)
            {
                try
                {
                    await linuxDiscovery.stop();
                }
                catch (error)
                {
                    errors.push(error);
                }
            }
        }

        try
        {
            await this.writeDiagnostics();
        }
        catch (error)
        {
            errors.push(error);
        }

        if (this.directorySafeToRemove)
        {
            try
            {
                await rm(this.directory, { recursive: true, force: true });
            }
            catch (error)
            {
                errors.push(error);
            }
        }

        if (errors.length > 0)
        {
            throw new AggregateError(errors, "Browser fixture cleanup failed");
        }
    }

    private async waitForActiveRecorder(): Promise<void>
    {
        const deadline = Date.now() + activeRecorderWaitTimeoutMs;
        let ownership = await this.readRecorderOwnership();

        while (ownership !== undefined)
        {
            if (Date.now() >= deadline)
            {
                if (ownership.marker === undefined)
                {
                    this.directorySafeToRemove = false;
                    throw new Error(
                        `Active opener recorder timed out; exact ownership could not be proven `
                            + `(${ownership.evidence})`,
                    );
                }

                await this.terminateActiveRecorder(ownership.marker);
                // SIGKILL cannot run the recorder's finally block. Remove its lock only after
                // the exact owner has exited so fixture state remains safe to delete.
                await rm(this.handoffPath, { recursive: true, force: true });
                throw new Error(
                    `Active opener recorder timed out after ${activeRecorderWaitTimeoutMs}ms `
                        + `(${activeRecorderEvidence(ownership.marker, this.token)})`,
                );
            }

            await new Promise((resolve) =>
            {
                const timer = setTimeout(resolve, activeRecorderPollIntervalMs);
                timer.unref();
            });
            ownership = await this.readRecorderOwnership();
        }
    }

    private async readRecorderOwnership(): Promise<RecorderOwnership | undefined>
    {
        const active = await this.readActiveRecorder();

        if (active !== undefined)
        {
            return { marker: active, evidence: activeRecorderEvidence(active, this.token) };
        }

        try
        {
            await access(this.handoffPath);
        }
        catch
        {
            return undefined;
        }

        const ownerPath = path.join(this.handoffPath, "owner.json");
        let value: unknown;

        try
        {
            value = JSON.parse(await readFile(ownerPath, "utf8"));
        }
        catch
        {
            return { evidence: `recorder claim handoff is present for token=${this.token}` };
        }

        if (!isClaimHandoffMarker(value, this.token))
        {
            return { evidence: `recorder claim handoff has invalid ownership for token=${this.token}` };
        }

        const marker = value;

        if (process.platform === "linux")
        {
            if (typeof marker.startTime !== "string")
            {
                return { evidence: activeRecorderEvidence(marker, this.token) };
            }

            const identity = await readLinuxProcessIdentityIfPresent(marker.pid as number);

            if (identity?.startTime !== marker.startTime)
            {
                return { evidence: activeRecorderEvidence(marker, this.token) };
            }
        }

        return { marker, evidence: activeRecorderEvidence(marker, this.token) };
    }

    private async readActiveRecorder(): Promise<ActiveRecorderMarker | undefined>
    {
        let value: unknown;

        try
        {
            value = JSON.parse(await readFile(this.activePath, "utf8"));
        }
        catch
        {
            return undefined;
        }

        if (!isActiveRecorderMarker(value, this.token))
        {
            return undefined;
        }

        if (process.platform === "linux")
        {
            if (typeof value.startTime !== "string")
            {
                return undefined;
            }

            const identity = await readLinuxProcessIdentityIfPresent(value.pid as number);

            if (identity?.startTime !== value.startTime)
            {
                return undefined;
            }
        }

        return value;
    }

    private async terminateActiveRecorder(marker: ActiveRecorderMarker): Promise<void>
    {
        if (process.platform !== "linux" || typeof marker.pid !== "number" || typeof marker.startTime !== "string")
        {
            this.directorySafeToRemove = false;
            throw new Error(
                `Active opener recorder timed out; exact termination is unavailable on ${process.platform} `
                    + `(${activeRecorderEvidence(marker, this.token)})`,
            );
        }

        const identity = await readLinuxProcessIdentityIfPresent(marker.pid);

        if (identity?.startTime !== marker.startTime)
        {
            return;
        }

        await signalExactProcess(identity, "SIGTERM");

        if (await waitForLinuxProcessExit([identity], activeRecorderProcessExitTimeoutMs))
        {
            return;
        }

        await signalExactProcess(identity, "SIGKILL");

        if (!await waitForLinuxProcessExit([identity], activeRecorderProcessExitTimeoutMs))
        {
            this.directorySafeToRemove = false;
            throw new Error(
                `Active opener recorder PID ${marker.pid} did not exit after forced termination `
                    + `(${activeRecorderEvidence(marker, this.token)})`,
            );
        }
    }

    private async readCapture(): Promise<string | undefined>
    {
        if (this.closed)
        {
            return undefined;
        }

        try
        {
            const parsed: unknown = JSON.parse(await readFile(this.recordPath, "utf8"));
            return isCapture(parsed) ? parsed.url : undefined;
        }
        catch
        {
            return undefined;
        }
    }

    private async writeDiagnostics(): Promise<void>
    {
        if (this.options.artifactsDirectory === undefined)
        {
            return;
        }

        const browserDirectory = path.join(this.options.artifactsDirectory, "browser");
        await mkdir(browserDirectory, { recursive: true });
        const metadata: DiagnosticRecord = {
            kind: "browser_fixture",
            browserVersion: this.browser.version(),
            platform: process.platform,
            headless: this.headless,
            records: this.diagnostics.slice(-100),
        };
        await writeFile(
            path.join(browserDirectory, "evidence.json"),
            `${JSON.stringify(metadata, null, 2)}\n`.slice(0, maxDiagnosticsBytes),
            "utf8",
        );
    }
}

function attachDiagnostics(page: Page, diagnostics: DiagnosticRecord[]): void
{
    page.on("console", (message) =>
    {
        if (message.type() === "error" || message.type() === "warning")
        {
            diagnostics.push({ kind: "console", type: message.type(), location: scrubUrl(message.location().url) });
        }
    });
    page.on("requestfailed", (request) =>
    {
        diagnostics.push({ kind: "request_failed", method: request.method(), url: scrubUrl(request.url()) });
    });
}

async function createSentinels(directory: string, runtime: string): Promise<void>
{
    await Promise.all(["xdg-open", "open", "cmd.exe"].map((name) => copyFile(runtime, path.join(directory, name))));
}

function quoteNodeOption(value: string): string
{
    return /[\s'"]/.test(value) ? JSON.stringify(value) : value;
}

function createLaunchEnvironment(tempRoot: string, recordPath: string): NodeJS.ProcessEnv
{
    const environment = { ...process.env };

    for (const key of ["TMPDIR", "TMP", "TEMP"])
    {
        environment[key] = tempRoot;
    }

    environment[launchRecordEnvironment] = recordPath;
    return environment;
}

function scrubUrl(value: string): string
{
    try
    {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.href;
    }
    catch
    {
        return "<invalid-url>";
    }
}

function isCapture(value: unknown): value is { readonly url: string; }
{
    if (typeof value !== "object" || value === null || !("url" in value) || typeof value.url !== "string")
    {
        return false;
    }

    try
    {
        const url = new URL(value.url);
        return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
    }
    catch
    {
        return false;
    }
}

function isClaimHandoffMarker(value: unknown, token: string): value is ActiveRecorderMarker
{
    if (typeof value !== "object" || value === null)
    {
        return false;
    }

    const marker = value as ActiveRecorderMarker;
    return marker.kind === "pi-browser-fixture-claim-handoff"
        && marker.token === token
        && typeof marker.pid === "number"
        && Number.isSafeInteger(marker.pid)
        && marker.pid > 0;
}

function isActiveRecorderMarker(value: unknown, token: string): value is ActiveRecorderMarker
{
    if (typeof value !== "object" || value === null)
    {
        return false;
    }

    const marker = value as ActiveRecorderMarker;
    return marker.kind === "pi-browser-fixture-active-recorder"
        && marker.token === token
        && typeof marker.pid === "number"
        && Number.isSafeInteger(marker.pid)
        && marker.pid > 0;
}

function activeRecorderEvidence(marker: ActiveRecorderMarker, token: string): string
{
    const pid = typeof marker.pid === "number" ? marker.pid : "unknown";
    const generation = typeof marker.startTime === "string" ? marker.startTime : "unknown";
    return `recorder pid=${pid} generation=${generation} token=${token}`;
}

async function signalExactProcess(identity: LinuxProcessIdentity, signal: NodeJS.Signals): Promise<void>
{
    const current = await readLinuxProcessIdentityIfPresent(identity.pid);

    if (current?.startTime !== identity.startTime)
    {
        return;
    }

    try
    {
        process.kill(identity.pid, signal);
    }
    catch (error)
    {
        const code = (error as NodeJS.ErrnoException).code;

        if (code !== "ESRCH")
        {
            throw error;
        }
    }
}

function abortError(reason: unknown): Error
{
    return reason instanceof Error ? reason : new Error("Browser URL wait aborted");
}

function errorMessage(value: unknown): string
{
    return value instanceof Error ? value.message : "Browser fixture callback failed";
}

function toError(value: unknown): Error
{
    return value instanceof Error ? value : new Error(errorMessage(value));
}

function disconnectBrowser(browser: Browser): void
{
    const internal = browser as Browser & {
        readonly _didClose?: () => void;
        readonly _connection?: { close(): void; };
    };

    try
    {
        internal._connection?.close();
    }
    catch
    {
        /* already disconnected */
    }

    internal._didClose?.();
}

async function captureOwnedPatchedBrowserProcess(executablePath: string): Promise<OwnedBrowserProcess>
{
    if (process.platform !== "linux")
    {
        throw new Error("A custom Chromium launcher cannot establish an owned process on this platform");
    }

    const executableCandidates = new Set([executablePath, headlessShellExecutablePath(executablePath)]);
    const children = await readDirectLinuxChildren(process.pid);
    const candidates = children.filter((child) => executableCandidates.has(child.executable));

    if (candidates.length === 0)
    {
        throw new Error("A custom Chromium launcher did not expose an exact Chromium process");
    }

    // Test launch hooks can overlap before returning; only exact Chromium identities are candidates.
    let root = candidates[0]!;

    for (const candidate of candidates.slice(1))
    {
        if (Number(candidate.startTime) > Number(root.startTime))
        {
            root = candidate;
        }
    }

    return { pid: root.pid, linuxTree: await captureLinuxProcessTree(root) };
}

function headlessShellExecutablePath(executablePath: string): string
{
    const match = /^(.*[/\\])chromium-(\d+)([/\\]).*$/u.exec(executablePath);

    if (match === null)
    {
        return "";
    }

    const cacheRoot = match[1]!.slice(0, -1);
    const platformDirectory = process.platform === "linux" ? "chrome-headless-shell-linux64" : "";
    return path.join(cacheRoot, `chromium_headless_shell-${match[2]}`, platformDirectory, "chrome-headless-shell");
}

async function readDirectLinuxChildren(parentPid: number): Promise<LinuxProcessIdentity[]>
{
    const childrenText = await readFile(`/proc/${parentPid}/task/${parentPid}/children`, "utf8").catch(() => "");
    const children = childrenText.trim().split(/\s+/u).filter(Boolean).map(Number);
    const identities = await Promise.all(children.map((pid) => readLinuxProcessIdentityIfPresent(pid)));
    return identities.filter(
        (identity): identity is LinuxProcessIdentity => identity?.parentPid === parentPid,
    );
}

async function captureOwnedBrowserProcess(server: BrowserServer): Promise<OwnedBrowserProcess>
{
    // BrowserServer.process() is the documented process handle for this exact launch.
    const handle = server.process();
    const pid = handle.pid;

    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0)
    {
        throw new Error("Playwright did not provide an owned Chromium process handle");
    }

    if (process.platform === "linux")
    {
        const root = await readLinuxProcessIdentity(pid);
        return { server, pid, linuxTree: await captureLinuxProcessTree(root) };
    }

    return { server, pid };
}

async function readLinuxProcessGeneration(pid: number): Promise<LinuxProcessGeneration>
{
    const statText = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = statText.lastIndexOf(")");

    if (commandEnd === -1)
    {
        throw new Error(`Could not parse /proc/${pid}/stat`);
    }

    const fields = statText.slice(commandEnd + 2).trim().split(/\s+/u);
    const state = fields[0];
    const parentPidText = fields[1];
    const startTime = fields[19];
    const parentPid = parentPidText === undefined ? Number.NaN : Number.parseInt(parentPidText, 10);

    if (
        state === undefined
        || state.length === 0
        || !Number.isSafeInteger(parentPid)
        || parentPid <= 0
        || startTime === undefined
        || startTime.length === 0
    )
    {
        throw new Error(`Incomplete process generation for Chromium PID ${pid}`);
    }

    return { parentPid, pid, startTime, state };
}

async function readLinuxProcessGenerationIfPresent(pid: number): Promise<LinuxProcessGeneration | undefined>
{
    try
    {
        return await readLinuxProcessGeneration(pid);
    }
    catch (error)
    {
        const code = (error as NodeJS.ErrnoException).code;

        if (code === "ENOENT" || code === "ESRCH")
        {
            return undefined;
        }

        throw error;
    }
}

function sameLinuxProcessGenerationOnly(
    left: LinuxProcessGeneration,
    right: LinuxProcessIdentity,
): boolean
{
    return left.pid === right.pid && left.startTime === right.startTime;
}

async function readLinuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity>
{
    const [statText, executable, executableStats] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readlink(`/proc/${pid}/exe`),
        stat(`/proc/${pid}/exe`, { bigint: true }),
    ]);
    const commandEnd = statText.lastIndexOf(")");

    if (commandEnd === -1)
    {
        throw new Error(`Could not parse /proc/${pid}/stat`);
    }

    const fields = statText.slice(commandEnd + 2).trim().split(/\s+/u);
    const parentPid = Number.parseInt(fields[1]!, 10);
    const processGroupId = Number.parseInt(fields[2]!, 10);
    const sessionId = Number.parseInt(fields[3]!, 10);
    const startTime = fields[19];

    if (
        !Number.isSafeInteger(parentPid) || !Number.isSafeInteger(processGroupId) || !Number.isSafeInteger(sessionId)
        || startTime === undefined || executable.length === 0
    )
    {
        throw new Error(`Incomplete exact process identity for Chromium PID ${pid}`);
    }

    return {
        pid,
        parentPid,
        processGroupId,
        sessionId,
        startTime,
        executable,
        executableDevice: executableStats.dev.toString(),
        executableInode: executableStats.ino.toString(),
    };
}

async function captureLinuxProcessTree(root: LinuxProcessIdentity): Promise<LinuxProcessTree>
{
    const members: LinuxProcessIdentity[] = [root];
    const visit = async (parentPid: number): Promise<void> =>
    {
        for (const child of await readDirectLinuxChildren(parentPid))
        {
            members.push(child);
            await visit(child.pid);
        }
    };
    await visit(root.pid);
    return { root, members };
}

function sameLinuxProcessGeneration(left: LinuxProcessIdentity, right: LinuxProcessIdentity): boolean
{
    return left.pid === right.pid && left.startTime === right.startTime
        && left.executable === right.executable
        && left.executableDevice === right.executableDevice && left.executableInode === right.executableInode;
}

async function retainLinuxProcessDescendants(tree: LinuxProcessTree): Promise<void>
{
    const root = await readLinuxProcessIdentityIfPresent(tree.root.pid);

    if (root === undefined || !sameLinuxProcessGeneration(root, tree.root))
    {
        return;
    }

    const current = await captureLinuxProcessTree(root);
    const retainedByGeneration = new Map(tree.members.map((member) => [linuxProcessGenerationKey(member), member]));

    for (const member of current.members)
    {
        // Keep every complete generation. A PID may be reused while an older retained
        // identity is still present, and the new owned generation must not be dropped.
        retainedByGeneration.set(linuxProcessGenerationKey(member), member);
    }

    tree.members.splice(0, tree.members.length, ...retainedByGeneration.values());
}

function linuxProcessGenerationKey(identity: LinuxProcessIdentity): string
{
    return [
        identity.pid,
        identity.startTime,
        identity.executable,
        identity.executableDevice,
        identity.executableInode,
    ].join("\\u0000");
}

function startLinuxProcessDiscovery(tree: LinuxProcessTree): LinuxProcessDiscovery
{
    let stopped = false;
    let inFlight = Promise.resolve();
    const errors: unknown[] = [];
    const runDiscovery = async (): Promise<void> =>
    {
        try
        {
            await retainLinuxProcessDescendants(tree);
        }
        catch (error)
        {
            errors.push(error);
        }
    };
    const discover = (): Promise<void> =>
    {
        const run = inFlight.then(runDiscovery);
        inFlight = run;
        return run;
    };
    const interval = setInterval(() =>
    {
        if (!stopped)
        {
            void discover();
        }
    }, pollIntervalMs);
    interval.unref();
    void discover();

    return {
        async stop(): Promise<void>
        {
            stopped = true;
            clearInterval(interval);
            await inFlight;
            await discover();

            if (errors.length > 0)
            {
                throw new AggregateError(errors, "Owned Chromium discovery failed during browser shutdown");
            }
        },
    };
}

async function readLinuxProcessIdentityIfPresent(pid: number): Promise<LinuxProcessIdentity | undefined>
{
    try
    {
        return await readLinuxProcessIdentity(pid);
    }
    catch (error)
    {
        const code = (error as NodeJS.ErrnoException).code;

        if (code === "ENOENT" || code === "ESRCH")
        {
            return undefined;
        }

        if (code === "EACCES" || code === "EPERM")
        {
            const generation = await readLinuxProcessGenerationIfPresent(pid);

            // A zombie has no usable executable identity. Generation-based exit
            // checks still retain it until its parent reaps it; never signal it.
            if (generation === undefined || generation.state === "Z")
            {
                return undefined;
            }
        }

        throw error;
    }
}

async function closeOwnedBrowserServer(
    server: BrowserServer,
    tree: LinuxProcessTree | undefined,
    operation: "close" | "kill",
    continuousDiscovery = false,
): Promise<void>
{
    if (tree === undefined || process.platform !== "linux" || continuousDiscovery)
    {
        await closeWithDeadline(
            server[operation].bind(server),
            operation === "close" ? "browser server" : "browser server kill",
            browserServerCloseTimeoutMs,
        );
        return;
    }

    const discoveryErrors: unknown[] = [];
    const discover = async (): Promise<void> =>
    {
        try
        {
            await retainLinuxProcessDescendants(tree);
        }
        catch (error)
        {
            discoveryErrors.push(error);
        }
    };

    await discover();
    let operationError: unknown;
    let settledAt = Number.POSITIVE_INFINITY;
    const attempt = closeWithDeadline(
        server[operation].bind(server),
        operation === "close" ? "browser server" : "browser server kill",
        browserServerCloseTimeoutMs,
    ).catch((error: unknown) =>
    {
        operationError = error;
    }).finally(() =>
    {
        settledAt = Date.now();
    });
    const deadline = Date.now() + browserServerCloseTimeoutMs;

    // Keep discovering while the authoritative root is alive. BrowserServer can resolve
    // before a renderer/utility child is reparented, so an immediate final scan is too late.
    while (Date.now() < deadline)
    {
        await discover();

        if (Number.isFinite(settledAt))
        {
            const root = await readLinuxProcessIdentityIfPresent(tree.root.pid);

            if (root === undefined || !sameLinuxProcessGeneration(root, tree.root))
            {
                break;
            }
        }

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    await attempt;
    await discover();

    if (operationError !== undefined)
    {
        if (discoveryErrors.length === 0)
        {
            throw toError(operationError);
        }

        throw new AggregateError(
            [toError(operationError), ...discoveryErrors],
            "Browser server shutdown and ownership discovery failed",
        );
    }

    if (discoveryErrors.length > 0)
    {
        throw new AggregateError(discoveryErrors, "Owned Chromium discovery failed during browser server shutdown");
    }
}

async function terminateOwnedBrowserProcess(
    browserProcess: OwnedBrowserProcess | undefined,
    continuousDiscovery = false,
): Promise<void>
{
    if (browserProcess === undefined)
    {
        return;
    }

    const errors: unknown[] = [];
    let exited = false;

    if (browserProcess.server !== undefined)
    {
        try
        {
            await closeOwnedBrowserServer(
                browserProcess.server,
                browserProcess.linuxTree,
                "close",
                continuousDiscovery,
            );
            exited = true;
        }
        catch (error)
        {
            errors.push(error);
        }

        if (!exited)
        {
            try
            {
                await closeOwnedBrowserServer(
                    browserProcess.server,
                    browserProcess.linuxTree,
                    "kill",
                    continuousDiscovery,
                );
                exited = true;
            }
            catch (error)
            {
                errors.push(error);
            }
        }
    }

    // BrowserServer.close()/kill() can resolve before every captured Chromium
    // generation has exited. Verify the exact launch tree independently, then
    // terminate any remaining identities leaves-first before reporting success.
    if (browserProcess.linuxTree !== undefined)
    {
        try
        {
            await terminateLinuxProcessTree(browserProcess.linuxTree);
            exited = true;
        }
        catch (error)
        {
            errors.push(error);
            exited = false;
        }
    }

    if (!exited && process.platform === "win32")
    {
        try
        {
            await terminateWindowsBrowserTree(browserProcess.pid);
            exited = true;
        }
        catch (error)
        {
            errors.push(error);
        }
    }

    if (!exited)
    {
        errors.push(new Error(`Owned Chromium PID ${browserProcess.pid} did not exit after bounded termination`));
    }

    if (errors.length === 0)
    {
        return;
    }

    if (!exited)
    {
        throw new AggregateError(errors, `Owned Chromium PID ${browserProcess.pid} termination failed`);
    }

    throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, `Owned Chromium PID ${browserProcess.pid} termination completed with errors`);
}

async function findRemainingLinuxGenerations(tree: LinuxProcessTree): Promise<LinuxProcessGeneration[]>
{
    const remaining: LinuxProcessGeneration[] = [];

    for (const member of tree.members)
    {
        const current = await readLinuxProcessGenerationIfPresent(member.pid);

        if (current !== undefined && sameLinuxProcessGenerationOnly(current, member))
        {
            remaining.push(current);
        }
    }

    return remaining;
}

async function terminateLinuxProcessTree(tree: LinuxProcessTree): Promise<void>
{
    // BrowserServer shutdown is not proof that every captured generation exited.
    // Discover while the exact root ancestry is still observable, then retain identities across reparenting.
    await retainLinuxProcessDescendants(tree);

    if (await waitForOwnedLinuxProcessExit(tree, browserProcessExitTimeoutMs))
    {
        return;
    }

    await signalLinuxProcesses(orderLinuxProcessTreeLeavesFirst(tree), "SIGTERM");

    // A zombie remains the exact owned generation while its parent is reaping it.
    // Keep the full bounded window so normally reaped children can disappear.
    if (await waitForOwnedLinuxProcessExit(tree, browserProcessExitTimeoutMs))
    {
        return;
    }

    await signalLinuxProcesses(orderLinuxProcessTreeLeavesFirst(tree), "SIGKILL");

    if (await waitForOwnedLinuxProcessExit(tree, browserProcessExitTimeoutMs))
    {
        return;
    }

    // A retained exact generation is still a cleanup failure, even when reparented to init.
    // Its PID/start-time evidence remains actionable; only complete identities authorize signals.
    const remaining = await findRemainingLinuxGenerations(tree);
    const zombies = remaining.filter((generation) => generation.state === "Z");

    if (zombies.length > 0)
    {
        const pids = zombies.map((generation) => `Owned Chromium PID ${generation.pid}`).join(", ");
        throw new Error(`${pids} remained as a zombie; ensure the owning parent reaps child processes`);
    }

    throw new Error(`Owned Chromium PID ${remaining[0]?.pid ?? tree.root.pid} did not exit after forced termination`);
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
                return 0;
            }

            current = parent;
            result += 1;
        }

        return result;
    };
    return [...tree.members].sort((left, right) => depth(right) - depth(left));
}

async function signalLinuxProcesses(members: readonly LinuxProcessIdentity[], signal: NodeJS.Signals): Promise<void>
{
    for (const member of members)
    {
        const current = await readLinuxProcessIdentityIfPresent(member.pid);

        if (current === undefined || !sameLinuxProcessGeneration(current, member))
        {
            continue;
        }

        try
        {
            process.kill(member.pid, signal);
        }
        catch (error)
        {
            const code = (error as NodeJS.ErrnoException).code;

            if (code !== "ESRCH")
            {
                throw error;
            }
        }
    }
}

async function waitForLinuxProcessExit(members: readonly LinuxProcessIdentity[], timeoutMs: number): Promise<boolean>
{
    const deadline = Date.now() + timeoutMs;

    while (true)
    {
        let alive = false;

        for (const member of members)
        {
            const current = await readLinuxProcessGenerationIfPresent(member.pid);

            if (current !== undefined && sameLinuxProcessGenerationOnly(current, member))
            {
                alive = true;
            }
        }

        if (!alive)
        {
            return true;
        }

        if (Date.now() >= deadline)
        {
            return false;
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function waitForOwnedLinuxProcessExit(tree: LinuxProcessTree, timeoutMs: number): Promise<boolean>
{
    const deadline = Date.now() + timeoutMs;

    while (true)
    {
        await retainLinuxProcessDescendants(tree);
        const alive = await Promise.all(tree.members.map(async (member) =>
        {
            const current = await readLinuxProcessGenerationIfPresent(member.pid);
            return current !== undefined && sameLinuxProcessGenerationOnly(current, member);
        }));

        if (!alive.some(Boolean))
        {
            return true;
        }

        if (Date.now() >= deadline)
        {
            return false;
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean>
{
    if (child.exitCode !== null || child.signalCode !== null)
    {
        return true;
    }

    return await new Promise<boolean>((resolve) =>
    {
        const timer = setTimeout(() =>
        {
            child.removeListener("exit", onExit);
            resolve(false);
        }, timeoutMs);
        timer.unref();
        const onExit = (): void =>
        {
            clearTimeout(timer);
            resolve(true);
        };
        child.once("exit", onExit);
    });
}

async function terminateWindowsBrowserTree(pid: number): Promise<void>
{
    const taskkill = spawnProcess("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
    });

    if (!await waitForChildExit(taskkill, 1_000))
    {
        taskkill.kill();
        throw new Error(`taskkill did not finish for owned Chromium PID ${pid}`);
    }

    if (taskkill.exitCode !== 0)
    {
        throw new Error(`taskkill failed for owned Chromium PID ${pid} with code ${taskkill.exitCode ?? "unknown"}`);
    }
}

async function closeWithDeadline(
    close: () => Promise<void>,
    label: string,
    timeoutMs: number = browserCloseTimeoutMs,
): Promise<void>
{
    let timer: NodeJS.Timeout | undefined;
    const attempt = Promise.resolve().then(close);

    try
    {
        await Promise.race([
            attempt,
            new Promise<never>((_resolve, reject) =>
            {
                timer = setTimeout(
                    () =>
                    {
                        reject(new Error(`${label} close timed out after ${timeoutMs}ms`));
                    },
                    timeoutMs,
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
