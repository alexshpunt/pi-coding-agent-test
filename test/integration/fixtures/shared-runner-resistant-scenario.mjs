import { access, watch } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { assistantMessage, PiIntegrationTest, text } from "../../../dist/index.js";
import { startSharedRunnerHost } from "../../../dist/shared-runner/host.js";

const resultPath = requiredEnvironment("ALE44_RESISTANT_SCENARIO_RESULT");

const scenarioPidPath = requiredEnvironment("ALE44_RESISTANT_SCENARIO_PID");
await writeFile(scenarioPidPath, `${process.pid}\n`, "utf8");
const wrapperCommand = requiredEnvironment("ALE44_RESISTANT_PI_COMMAND");
const root = requiredEnvironment("ALE44_RESISTANT_SCENARIO_ROOT");
const workspace = path.join(root, "workspace");
const artifacts = path.join(root, "artifacts");
const state = path.join(root, "state");
await Promise.all([mkdir(workspace), mkdir(artifacts), mkdir(state)]);
const sharedBefore = await sharedRoots();
const host = await startSharedRunnerHost();
const endpoint = JSON.parse(process.env.PI_INTEGRATION_TEST_RUNNER);
const environment = { ALE44_RESISTANT_PI_STATE: state };

try
{
    const armedPath = path.join(state, "launch-1-armed.json");
    const releasePath = path.join(state, "release-launch-1-ready");
    const readyPhasePath = path.join(state, "launch-1-ready.json");
    const first = new PiIntegrationTest({
        testName: "resistant-first",
        artifactsDir: artifacts,
        cwd: workspace,
        piCommand: wrapperCommand,
        rawMode: false,
        environment,
        conversation: [],
        timeoutMs: 250,
    }).run("This request must time out");
    const firstResultPromise = settle(first);

    await waitForFile(armedPath);
    const armedPhase = await readPhase(armedPath, "resistant-armed");
    await writeFile(releasePath, "release\n", "utf8");
    await waitForFile(readyPhasePath);
    const readyPhase = await readPhase(readyPhasePath, "ready-released");

    if (readyPhase.pid !== armedPhase.pid || readyPhase.count !== armedPhase.count)
    {
        throw new Error("The resistant ready phase did not belong to the armed launch");
    }

    const second = new PiIntegrationTest({
        testName: "resistant-second",
        artifactsDir: artifacts,
        cwd: workspace,
        piCommand: wrapperCommand,
        rawMode: false,
        environment,
        conversation: [assistantMessage([text("Recovered")])],
        timeoutMs: 15_000,
    }).run("Recover with the same shared configuration");
    const [firstResult, secondResult] = await Promise.all([firstResultPromise, settle(second)]);

    if (firstResult.status !== "rejected")
    {
        throw new Error("The first shared request unexpectedly succeeded");
    }
    if (secondResult.status !== "rejected")
    {
        throw new Error("The queued shared request unexpectedly succeeded");
    }
    const secondError = describeError(secondResult.reason);

    if (!secondError.includes("Shared Pi exited before becoming ready with code 42"))
    {
        throw new Error(`The queued shared request did not recreate Pi: ${secondError}`);
    }

    const firstPid = Number.parseInt(await readFile(path.join(state, "launch-1.pid"), "utf8"), 10);
    const signals = await readFile(path.join(state, "signals.log"), "utf8");
    const launchCount = Number.parseInt(await readFile(path.join(state, "launch-count"), "utf8"), 10);

    if (armedPhase.pid !== firstPid || armedPhase.count !== 1)
    {
        throw new Error("The resistant handshake did not arm launch 1");
    }
    if (!signals.includes("SIGTERM"))
    {
        throw new Error("Shared teardown did not attempt graceful SIGTERM");
    }
    if (processExists(firstPid))
    {
        throw new Error(`SIGTERM-resistant owned Pi PID ${firstPid} is still alive`);
    }
    if (launchCount < 2)
    {
        throw new Error("The queued same-configuration request did not recreate Pi");
    }

    await host.close();
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
                armedPhase,
                firstError: describeError(firstResult.reason),
                firstPid,
                launchCount,
                readyPhase,
                secondError,
                signals,
            })
        }\n`,
        "utf8",
    );
}
finally
{
    await host.close().catch(() =>
    {});
    await rm(root, { recursive: true, force: true });
}

async function settle(promise)
{
    try
    {
        return { status: "fulfilled", value: await promise };
    }
    catch (reason)
    {
        return { reason, status: "rejected" };
    }
}

async function readPhase(filePath, expectedPhase)
{
    const phase = JSON.parse(await readFile(filePath, "utf8"));

    if (
        phase?.phase !== expectedPhase
        || phase.count !== 1
        || !Number.isInteger(phase.pid)
        || phase.pid <= 0
    )
    {
        throw new Error(`Invalid resistant fixture phase ${expectedPhase}: ${JSON.stringify(phase)}`);
    }

    return phase;
}

async function waitForFile(filePath)
{
    if (await fileExists(filePath))
    {
        return;
    }

    await new Promise((resolve, reject) =>
    {
        let settled = false;
        const watcher = watch(path.dirname(filePath), () => void check());
        const finish = (error) =>
        {
            if (settled)
            {
                return;
            }

            settled = true;
            watcher.close();
            clearTimeout(timer);
            error === undefined ? resolve() : reject(error);
        };
        const check = async () =>
        {
            try
            {
                if (await fileExists(filePath))
                {
                    finish();
                }
            }
            catch (error)
            {
                finish(error);
            }
        };
        const timer = setTimeout(
            () => finish(new Error(`Timed out waiting for fixture phase ${path.basename(filePath)}`)),
            5_000,
        );
        watcher.on("error", finish);
        void check();
    });
}

async function fileExists(filePath)
{
    return await new Promise((resolve, reject) =>
    {
        access(filePath, (error) =>
        {
            if (error === null)
            {
                resolve(true);
            }
            else if (error.code === "ENOENT")
            {
                resolve(false);
            }
            else
            {
                reject(error);
            }
        });
    });
}

async function sharedRoots()
{
    const directory = path.join(process.cwd(), ".tmp");
    return (await readdir(directory).catch(() => [])).filter((entry) => entry.startsWith("pi-integration-shared-"));
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
