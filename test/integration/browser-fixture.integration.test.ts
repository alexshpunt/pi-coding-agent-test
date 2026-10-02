import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    assistantMessage,
    createBrowserFixture,
    getToolExecution,
    getToolExecutionDetails,
    getToolResultText,
    PiIntegrationTest,
    testArtifactsDir,
    text,
    toolCall,
    withBrowserFixture,
} from "pi-coding-agent-test";
import { afterEach, describe, expect, test } from "vitest";

const extensionPath = path.join(path.dirname(import.meta.filename), "fixtures", "browser-decision-extension.ts");
const workspaces: string[] = [];
const portCloseTimeoutMs = 2_000;
const fileWaitTimeoutMs = 2_000;

interface DecisionState
{
    readonly port: number;
    readonly decision?: string;
}

afterEach(async () =>
{
    await Promise.all(workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("dedicated browser fixture with real Pi", () =>
{
    test("submits a real page while PiIntegrationTest.run is pending and cleans every owner", async () =>
    {
        const workspace = await makeWorkspace("pi-browser-decision-");
        const fixture = await createBrowserFixture();
        const environment = fixture.childEnvironment({ ...process.env, BROWSER: fixture.openerCommand });
        const sentinelDirectory = firstPathEntry(environment);
        const run = startDecisionRun("browser-real-ui", workspace, "accepted-in-browser", environment);

        try
        {
            const url = await fixture.waitForUrl({ timeoutMs: 10_000 });
            expect(await isPending(run)).toBe(true);
            expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);

            await fixture.page.goto(url);
            await fixture.page.getByLabel("decision-accepted-in-browser").fill("approve");
            await fixture.page.getByRole("button", { name: "Submit" }).click();

            const result = await run;
            expect(getToolExecution(result, "browser-decision-accepted-in-browser").isError).toBe(false);
            expect(getToolResultText(result, "browser-decision-accepted-in-browser")).toContain("approve");
            expect(getToolExecutionDetails(getToolExecution(result, "browser-decision-accepted-in-browser")))
                .toMatchObject({ decision: "approve" });
            const state = await readDecisionState(workspace, "accepted-in-browser");
            expect(state.decision).toBe("approve");
            await expectPortClosed(state.port);
            expect(await sentinelFailures(sentinelDirectory)).toEqual([]);
        }
        finally
        {
            await fixture.close();
        }

        expect(fixture.browser.isConnected()).toBe(false);
        await expect(access(sentinelDirectory)).rejects.toThrow();
    });

    test("keeps two pending Pi runs, URLs, pages, environments, and browser state isolated", async () =>
    {
        const firstWorkspace = await makeWorkspace("pi-browser-first-");
        const secondWorkspace = await makeWorkspace("pi-browser-second-");
        const first = await createBrowserFixture();
        const second = await createBrowserFixture();
        const firstEnvironment = first.childEnvironment({
            ...process.env,
            BROWSER: first.openerCommand,
            FIXTURE_SIDE: "first",
        });
        const secondEnvironment = second.childEnvironment({
            ...process.env,
            BROWSER: second.openerCommand,
            FIXTURE_SIDE: "second",
        });
        const firstRun = startDecisionRun("browser-concurrent-first", firstWorkspace, "first", firstEnvironment);
        const secondRun = startDecisionRun("browser-concurrent-second", secondWorkspace, "second", secondEnvironment);

        try
        {
            const [firstUrl, secondUrl] = await Promise.all([
                first.waitForUrl({ timeoutMs: 10_000 }),
                second.waitForUrl({ timeoutMs: 10_000 }),
            ]);
            expect(firstUrl).not.toBe(secondUrl);
            expect(first.context).not.toBe(second.context);
            expect(first.page).not.toBe(second.page);
            expect(firstPathEntry(firstEnvironment)).not.toBe(firstPathEntry(secondEnvironment));

            await Promise.all([first.page.goto(firstUrl), second.page.goto(secondUrl)]);
            await first.page.evaluate(() => localStorage.setItem("fixture", "first"));
            await second.page.evaluate(() => localStorage.setItem("fixture", "second"));
            await first.page.getByLabel("decision-first").fill("first-choice");
            await second.page.getByLabel("decision-second").fill("second-choice");
            await Promise.all([
                first.page.getByRole("button", { name: "Submit" }).click(),
                second.page.getByRole("button", { name: "Submit" }).click(),
            ]);

            const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);
            expect(getToolResultText(firstResult, "browser-decision-first")).toContain("first-choice");
            expect(getToolResultText(secondResult, "browser-decision-second")).toContain("second-choice");
            expect(await first.page.evaluate(() => localStorage.getItem("fixture"))).toBe("first");
            expect(await second.page.evaluate(() => localStorage.getItem("fixture"))).toBe("second");
            await expectPortClosed((await readDecisionState(firstWorkspace, "first")).port);
            await expectPortClosed((await readDecisionState(secondWorkspace, "second")).port);
        }
        finally
        {
            await Promise.all([first.close(), second.close()]);
        }
    });

    test("routes a real application fallback through the failing sentinel and closes its session", async () =>
    {
        const workspace = await makeWorkspace("pi-browser-fallback-");
        const fixture = await createBrowserFixture();
        const base = { ...process.env };
        delete base.BROWSER;
        const environment = fixture.childEnvironment(base);
        delete environment.BROWSER;
        const sentinelDirectory = firstPathEntry(environment);

        try
        {
            const result = await startDecisionRun("browser-fallback-sentinel", workspace, "fallback", environment);
            const execution = getToolExecution(result, "browser-decision-fallback");
            expect(execution.isError).toBe(true);
            expect(getToolResultText(result, "browser-decision-fallback"))
                .toMatch(/browser fallback failed|default|system|opener|fixture/u);
            expect(await sentinelFailures(sentinelDirectory)).not.toEqual([]);
            const state = await readDecisionState(workspace, "fallback");
            await expectPortClosed(state.port);
        }
        finally
        {
            await fixture.close();
        }

        await expect(access(sentinelDirectory)).rejects.toThrow();
    });

    test("honors explicit headed mode in the actual connected Chromium launch", async () =>
    {
        if (process.env.PI_TEST_HEADED !== "1")
        {
            return;
        }

        await withBrowserFixture({ headless: false }, async (fixture) =>
        {
            const session = await fixture.browser.newBrowserCDPSession();

            try
            {
                const launch = await session.send("Browser.getBrowserCommandLine");
                expect(launch.arguments.some((argument) => /^--headless(?:=|$)/u.test(argument))).toBe(false);
                expect(fixture.browser.isConnected()).toBe(true);
                await fixture.page.setContent("<button>headed browser</button>");
                await fixture.page.getByRole("button").click();
                await expect(fixture.page.getByRole("button").textContent()).resolves.toBe("headed browser");
            }
            finally
            {
                await withTimeout(session.detach(), 1_000, "headed CDP session detach");
            }
        });
    });

    test("closes browser resources and the decision server after a page assertion failure", async () =>
    {
        const workspace = await makeWorkspace("pi-browser-assertion-");
        let fixtureDirectory = "";
        let browserConnected: (() => boolean) | undefined;

        await expect(withBrowserFixture({}, async (fixture) =>
        {
            const environment = fixture.childEnvironment({ ...process.env, BROWSER: fixture.openerCommand });
            fixtureDirectory = firstPathEntry(environment);
            browserConnected = () => fixture.browser.isConnected();
            const run = startDecisionRun("browser-assertion-failure", workspace, "assertion", environment);
            const url = await fixture.waitForUrl({ timeoutMs: 10_000 });
            await fixture.page.goto(url);
            await expect(fixture.page.getByLabel("decision-assertion").isVisible()).resolves.toBe(true);
            expect(await sentinelFailures(fixtureDirectory)).toEqual([]);
            await fixture.page.getByLabel("decision-assertion").fill("activity-complete");
            await fixture.page.getByRole("button", { name: "Submit" }).click();
            await run;
            throw new Error("intentional page assertion failure");
        })).rejects.toThrow("intentional page assertion failure");

        expect(browserConnected?.()).toBe(false);
        await expect(access(fixtureDirectory)).rejects.toThrow();
        await expectPortClosed((await readDecisionState(workspace, "assertion")).port);
    });

    test("attaches a real-boundary cleanup failure without replacing the page failure", async () =>
    {
        const workspace = await makeWorkspace("pi-browser-cleanup-failure-");
        let fixtureDirectory = "";
        let browserConnected: (() => boolean) | undefined;
        let received: unknown;

        try
        {
            await withBrowserFixture({}, async (fixture) =>
            {
                const environment = fixture.childEnvironment({ ...process.env, BROWSER: fixture.openerCommand });
                fixtureDirectory = firstPathEntry(environment);
                browserConnected = () => fixture.browser.isConnected();
                const run = startDecisionRun("browser-cleanup-failure", workspace, "cleanup-failure", environment);
                const url = await fixture.waitForUrl({ timeoutMs: 10_000 });
                await fixture.page.goto(url);
                await fixture.page.getByLabel("decision-cleanup-failure").fill("complete");
                await fixture.page.getByRole("button", { name: "Submit" }).click();
                await run;
                const closeContext = fixture.context.close.bind(fixture.context);
                fixture.context.close = async () =>
                {
                    await closeContext();
                    throw new Error("real context cleanup detail");
                };
                throw new Error("primary real page assertion failure");
            });
        }
        catch (error)
        {
            received = error;
        }

        expect(describeError(received)).toContain("primary real page assertion failure");
        expect(describeError(received)).toContain("real context cleanup detail");
        expect(browserConnected?.()).toBe(false);
        await expect(access(fixtureDirectory)).rejects.toThrow();
        await expectPortClosed((await readDecisionState(workspace, "cleanup-failure")).port);
    });

    test("cleans the browser after a bounded Pi timeout", async () =>
    {
        const workspace = await makeWorkspace("pi-browser-timeout-");
        let fixtureDirectory = "";
        let browserConnected: (() => boolean) | undefined;

        await expect(withBrowserFixture({}, async (fixture) =>
        {
            const environment = fixture.childEnvironment({ ...process.env, BROWSER: fixture.openerCommand });
            fixtureDirectory = firstPathEntry(environment);
            browserConnected = () => fixture.browser.isConnected();
            const run = startDecisionRun("browser-pi-timeout", workspace, "timeout", environment, 10_000);
            const url = await fixture.waitForUrl({ timeoutMs: 10_000 });
            await fixture.page.goto(url);
            await expect(fixture.page.getByLabel("decision-timeout").isVisible()).resolves.toBe(true);
            expect(await sentinelFailures(fixtureDirectory)).toEqual([]);
            expect(await isPending(run)).toBe(true);
            await run;
        })).rejects.toThrow(/Trace did not settle|timed out|timeout/u);

        expect(browserConnected?.()).toBe(false);
        await expect(access(fixtureDirectory)).rejects.toThrow();
        await expectPortClosed((await readDecisionState(workspace, "timeout")).port);
    });

    test("writes bounded diagnostics without secrets or unsafe browser artifacts", async () =>
    {
        const artifactRoot = await makeWorkspace("pi-browser-diagnostics-");
        const secret = "ALE44_SECRET_VALUE";

        await withBrowserFixture({ artifactsDirectory: artifactRoot }, async (fixture) =>
        {
            await fixture.page.setContent(`<script>console.error(${JSON.stringify(secret)})</script>`);
            await fixture.page.goto(`http://user:password@127.0.0.1:1/private?token=${secret}#fragment`).catch(() =>
                undefined
            );
        });

        const files = await listFiles(artifactRoot);
        expect(files.length).toBeGreaterThan(0);
        expect(files.some((file) => /screenshot|trace/u.test(file))).toBe(false);
        const evidence = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
        expect(Buffer.byteLength(evidence)).toBeLessThan(64 * 1024);
        expect(evidence).not.toContain(secret);
        expect(evidence).not.toContain("password");
        expect(evidence).not.toContain("token=");
        expect(evidence).not.toContain("PLAYWRIGHT_BROWSERS_PATH");
        expect(evidence).not.toMatch(/executablePath|userDataDir|authorization|cookie/iu);
    });
});

function startDecisionRun(
    testName: string,
    workspace: string,
    id: string,
    environment: NodeJS.ProcessEnv,
    timeoutMs = 20_000,
): ReturnType<PiIntegrationTest["run"]>
{
    return new PiIntegrationTest({
        testName,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd: workspace,
        extensions: [extensionPath],
        tools: ["browser_decision"],
        environment,
        timeoutMs,
        conversation: [
            assistantMessage([
                toolCall({ id: `browser-decision-${id}`, name: "browser_decision", arguments: { id } }),
            ], { stopReason: "toolUse" }),
            assistantMessage([text("The browser decision completed.")]),
        ],
    }).run("Open the local decision page and wait for the browser response");
}

async function makeWorkspace(prefix: string): Promise<string>
{
    const workspace = await mkdtemp(path.join(tmpdir(), prefix));
    workspaces.push(workspace);

    return workspace;
}

async function readDecisionState(workspace: string, id: string): Promise<DecisionState>
{
    const statePath = path.join(workspace, `browser-decision-${id}.json`);
    let state: DecisionState | undefined;
    await pollUntil(
        async () =>
        {
            try
            {
                state = JSON.parse(await readFile(statePath, "utf8")) as DecisionState;

                return true;
            }
            catch (error)
            {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT")
                {
                    return false;
                }
                throw error;
            }
        },
        fileWaitTimeoutMs,
        `decision state ${statePath}`,
    );

    if (state === undefined)
    {
        throw new Error(`Decision state was not readable after ${fileWaitTimeoutMs}ms: ${statePath}`);
    }

    return state;
}

async function isPending(promise: Promise<unknown>): Promise<boolean>
{
    return await Promise.race([
        promise.then(() => false, () => false),
        new Promise<true>((resolve) => setTimeout(() => resolve(true), 50)),
    ]);
}

function firstPathEntry(environment: NodeJS.ProcessEnv): string
{
    const entry = environment.PATH?.split(path.delimiter)[0];

    if (entry === undefined || entry.length === 0)
    {
        throw new Error("Browser fixture did not prepend its sentinel directory to PATH");
    }

    return entry;
}

async function sentinelFailures(directory: string): Promise<string[]>
{
    return (await readdir(directory)).filter((name) => /fail|marker|invoked/u.test(name));
}

async function expectPortClosed(port: number): Promise<void>
{
    await pollUntil(async () => await canBind(port), portCloseTimeoutMs, `test-owned port ${port} to close`);
}

async function canBind(port: number): Promise<boolean>
{
    const server = createServer();

    return await new Promise<boolean>((resolve, reject) =>
    {
        let cancelled = false;
        let listenSettled = false;
        let settlementStarted = false;
        const finish = (value: boolean | undefined, error?: unknown): void =>
        {
            if (settlementStarted)
            {
                return;
            }

            settlementStarted = true;
            clearTimeout(timer);
            void closePortProbe(server, !listenSettled, port).then(
                () =>
                {
                    if (server.listening)
                    {
                        reject(new Error(`Port ${port} probe retained a listening handle after cleanup`));
                    }
                    else if (error !== undefined)
                    {
                        reject(error);
                    }
                    else
                    {
                        resolve(value ?? false);
                    }
                },
                reject,
            );
        };
        const timer = setTimeout(() =>
        {
            cancelled = true;
            finish(undefined, new Error(`single port ${port} closure check exceeded 250ms`));
        }, 250);
        timer.unref();
        server.once("listening", () =>
        {
            listenSettled = true;
            if (cancelled)
            {
                void closePortProbe(server, false, port).catch(() => undefined);

                return;
            }
            finish(true);
        });
        server.once("error", (error: NodeJS.ErrnoException) =>
        {
            listenSettled = true;
            if (cancelled)
            {
                return;
            }
            if (error.code === "EADDRINUSE")
            {
                finish(false);
            }
            else
            {
                finish(undefined, error);
            }
        });
        server.listen(port, "127.0.0.1");
    });
}

async function closePortProbe(
    server: ReturnType<typeof createServer>,
    waitForPendingClose: boolean,
    port: number,
): Promise<void>
{
    let closeCallbackError: Error | undefined;
    const closeEvent = new Promise<void>((resolve) => server.once("close", resolve));
    const closeCallback = new Promise<void>((resolve) =>
    {
        server.close((error) =>
        {
            closeCallbackError = error;
            resolve();
        });
    });

    if (waitForPendingClose)
    {
        await withTimeout(closeEvent, 250, `pending port ${port} probe close`);
    }
    else
    {
        await withTimeout(Promise.race([closeEvent, closeCallback]), 250, `port ${port} probe close`);
    }

    if (
        closeCallbackError !== undefined
        && (closeCallbackError as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
    )
    {
        throw closeCallbackError;
    }
    if (server.listening)
    {
        await withTimeout(
            new Promise<void>((resolve, reject) =>
                server.close((error) =>
                {
                    if (error === undefined)
                    {
                        resolve();
                    }
                    else
                    {
                        reject(error);
                    }
                })
            ),
            250,
            `late port ${port} probe close`,
        );
    }
    if (server.listening)
    {
        throw new Error(`Port ${port} probe retained a listening handle`);
    }
}

async function listFiles(directory: string): Promise<string[]>
{
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) =>
    {
        const target = path.join(directory, entry.name);

        return entry.isDirectory() ? await listFiles(target) : [target];
    }));

    return nested.flat();
}

async function pollUntil(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs: number,
    label: string,
): Promise<void>
{
    const deadline = Date.now() + timeoutMs;

    while (!await predicate())
    {
        if (Date.now() >= deadline)
        {
            throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T>
{
    let timer: NodeJS.Timeout | undefined;

    try
    {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) =>
            {
                timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
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
