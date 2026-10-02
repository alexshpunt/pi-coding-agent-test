import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { assistantMessage, PiIntegrationTest, text } from "../../../dist/index.js";
import { startSharedRunnerHost } from "../../../dist/shared-runner/host.js";

const resultPath = requiredEnvironment("ALE44_STALE_SCENARIO_RESULT");
const scenarioPidPath = requiredEnvironment("ALE44_STALE_SCENARIO_PID");
const wrapperCommand = requiredEnvironment("ALE44_STALE_PI_COMMAND");
const root = requiredEnvironment("ALE44_STALE_SCENARIO_ROOT");
const preloadPath = requiredEnvironment("ALE44_STALE_PRELOAD");
const realPiCommand = requiredEnvironment("ALE44_STALE_REAL_PI_COMMAND");
const workspace = path.join(root, "workspace");
const artifacts = path.join(root, "artifacts");
const state = path.join(root, "state");
const releasePath = path.join(state, "release-old-pty");
await writeFile(scenarioPidPath, `${process.pid}\n`, "utf8");
await Promise.all([mkdir(workspace), mkdir(artifacts), mkdir(state)]);
const sharedBefore = await sharedRoots();
process.env.ALE44_STALE_EXIT_RELEASE = releasePath;
process.env.ALE44_STALE_EXIT_STATE = state;
process.env.NODE_OPTIONS = appendRequire(process.env.NODE_OPTIONS, preloadPath);
const host = await startSharedRunnerHost();
const endpoint = JSON.parse(process.env.PI_INTEGRATION_TEST_RUNNER);
const environment = {
    ALE44_STALE_EXIT_RELEASE: releasePath,
    ALE44_STALE_EXIT_STATE: state,
    ALE44_STALE_REAL_PI_COMMAND: realPiCommand,
};

try
{
    const first = await run("stale-old-first", 250).then(
        () => ({ status: "fulfilled" }),
        (error) => ({ status: "rejected", error }),
    );

    if (first.status !== "rejected")
    {
        throw new Error("The stale-old request unexpectedly succeeded");
    }

    const oldPid = Number.parseInt(await readFile(path.join(state, "old-pty.pid"), "utf8"), 10);
    const attempts = await readFile(path.join(state, "termination-attempts.log"), "utf8");

    if (!attempts.includes("SIGTERM") || !attempts.includes("SIGKILL"))
    {
        throw new Error(`The old PTY did not cross both termination deadlines: ${attempts}`);
    }
    if (!processExists(oldPid))
    {
        throw new Error(`The old PTY PID ${oldPid} did not survive both deadlines`);
    }

    const second = await run("stale-old-replacement", 15_000);

    if (!second.traceEvents.some((event) => event.type === "agent_settled"))
    {
        throw new Error("The replacement shared Pi did not complete a real request");
    }

    const replacementPid = Number.parseInt(await readFile(path.join(state, "launch-2.pid"), "utf8"), 10);

    if (!processExists(replacementPid))
    {
        throw new Error(`The healthy replacement PID ${replacementPid} exited too early`);
    }

    await writeFile(releasePath, "release\n", "utf8");
    await pollUntil(() => exists(path.join(state, "old-exit-delivered")), 2_000, "the obsolete PTY exit callback");
    await pollUntil(() => !processExists(oldPid), 2_000, "the obsolete PTY process to exit");

    const third = await run("stale-old-reuse", 15_000);

    if (!third.traceEvents.some((event) => event.type === "agent_settled"))
    {
        throw new Error("The request after the obsolete exit did not settle");
    }

    const launchCount = Number.parseInt(await readFile(path.join(state, "launch-count"), "utf8"), 10);

    if (launchCount !== 2)
    {
        throw new Error(`Obsolete PTY exit replaced the healthy runner; observed ${launchCount} launches`);
    }
    if (!processExists(replacementPid))
    {
        throw new Error(`Obsolete PTY exit closed the healthy replacement PID ${replacementPid}`);
    }

    await host.close();
    await pollUntil(() => !processExists(replacementPid), 2_000, "the replacement PTY to close");
    await expectEndpointClosed(endpoint.host, endpoint.port);
    const sharedAfter = await sharedRoots();
    const sharedLeaks = sharedAfter.filter((entry) => !sharedBefore.includes(entry));

    if (sharedLeaks.length > 0)
    {
        throw new Error(`Shared runner left temporary roots: ${sharedLeaks.join(", ")}`);
    }

    await writeFile(
        resultPath,
        `${
            JSON.stringify({
                attempts,
                firstError: describeError(first.error),
                launchCount,
                oldPid,
                replacementPid,
            })
        }\n`,
        "utf8",
    );
}
finally
{
    await writeFile(releasePath, "release\n", "utf8").catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await forceKillRecordedPids(state);
    await host.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
}

function run(testName, timeoutMs)
{
    return new PiIntegrationTest({
        testName,
        artifactsDir: artifacts,
        cwd: workspace,
        piCommand: wrapperCommand,
        rawMode: false,
        environment,
        conversation: [assistantMessage([text(`Completed ${testName}`)])],
        timeoutMs,
    }).run(`Complete ${testName}`);
}

function appendRequire(nodeOptions, preload)
{
    const option = `--require=${JSON.stringify(preload)}`;
    return nodeOptions?.trim() ? `${nodeOptions} ${option}` : option;
}

async function sharedRoots()
{
    const directory = path.join(process.cwd(), ".tmp");
    return (await readdir(directory).catch(() => [])).filter((entry) => entry.startsWith("pi-integration-shared-"));
}

async function forceKillRecordedPids(directory)
{
    const entries = await readdir(directory).catch(() => []);

    for (const entry of entries.filter((name) => /^(?:old-pty|launch-\d+)\.pid$/u.test(name)))
    {
        const pid = Number.parseInt(await readFile(path.join(directory, entry), "utf8"), 10);

        if (processExists(pid))
        {
            process.kill(pid, "SIGKILL");
        }
    }
}

async function expectEndpointClosed(host, port)
{
    const { connect } = await import("node:net");
    await new Promise((resolve, reject) =>
    {
        const socket = connect(port, host);
        socket.once("connect", () =>
        {
            socket.destroy();
            reject(new Error("Shared runner server remained reachable after close"));
        });
        socket.once("error", () => resolve());
    });
}

async function pollUntil(predicate, timeoutMs, label)
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

async function exists(target)
{
    return await access(target).then(() => true, () => false);
}

function processExists(pid)
{
    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch
    {
        return false;
    }
}

function describeError(error)
{
    if (error instanceof AggregateError)
    {
        return `${error.message} ${error.errors.map(describeError).join(" ")}`;
    }
    return error instanceof Error ? error.stack ?? error.message : String(error);
}

function requiredEnvironment(name)
{
    const value = process.env[name];

    if (value === undefined || value.length === 0)
    {
        throw new Error(`Missing ${name}`);
    }

    return value;
}
