import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createBrowserFixture } from "pi-coding-agent-test";
import { chromium } from "playwright";

if (process.platform !== "linux")
{
    throw new Error("The exact /proc ownership scenario requires Linux");
}

const root = await mkdtemp(path.join(tmpdir(), "ale44-browser-owner-race-"));
const mutableChromium = chromium;
const originalLaunchDescriptor = Object.getOwnPropertyDescriptor(chromium, "launch");
const originalLaunch = chromium.launch;
const launches = [];
const fixtures = [];
const events = [];
const startedAt = process.hrtime.bigint();
let phase = "launch";
let launchTurn = Promise.resolve();
let launchNumber = 0;

function recordEvent(kind, details = {})
{
    events.push({
        atMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        kind,
        phase,
        ...details,
    });
}

mutableChromium.launch = async (options) =>
{
    const priorTurn = launchTurn;
    let releaseTurn;
    launchTurn = new Promise((resolve) => releaseTurn = resolve);
    await priorTurn;

    const sequence = ++launchNumber;
    try
    {
        if (sequence > 1)
        {
            await delay(250);
        }
        const childrenBefore = await readDirectChildren(process.pid);
        const browser = await originalLaunch.call(chromium, options);
        const chromiumRoot = await findSingleNewDirectChild(childrenBefore, 2_000);
        const chromiumTree = await captureStableTree(chromiumRoot, 2_000);
        const signalMarker = path.join(root, `unrelated-${sequence}-signal.txt`);
        const unrelated = spawn(
            process.execPath,
            [
                "--input-type=module",
                "--eval",
                [
                    "import { writeFileSync } from 'node:fs';",
                    `const marker = ${JSON.stringify(signalMarker)};`,
                    "for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => writeFileSync(marker, signal));",
                    "setInterval(() => undefined, 1000);",
                ].join("\n"),
            ],
            { stdio: "ignore" },
        );
        if (unrelated.pid === undefined)
        {
            throw new Error("Could not obtain the unrelated direct child PID");
        }
        const unrelatedIdentity = await waitForIdentity(unrelated.pid, 2_000);
        launches.push({
            browser,
            chromiumTree,
            discoveredGenerations: new Map(chromiumTree.members.map((identity) => [generationKey(identity), identity])),
            realBrowserClose: browser.close.bind(browser),
            sequence,
            signalMarker,
            unrelated,
            unrelatedIdentity,
        });
        recordEvent("launch-captured", {
            root: chromiumTree.root,
            sequence,
            tree: chromiumTree.members,
            unrelated: unrelatedIdentity,
        });
        return browser;
    }
    finally
    {
        releaseTurn();
    }
};

let status;
const originalProcessKill = process.kill;
let processKillPatched = false;
try
{
    const created = await Promise.all([createBrowserFixture(), createBrowserFixture()]);
    const resourceCloseElapsedMs = created.map(() => ({ total: 0 }));
    fixtures.push(...created);
    for (const [index, fixture] of created.entries())
    {
        const launch = launches.find((candidate) => candidate.browser === fixture.browser);
        const pageClose = fixture.page.close.bind(fixture.page);
        const contextClose = fixture.context.close.bind(fixture.context);
        fixture.page.close = async (...arguments_) =>
        {
            const startedAt = performance.now();
            recordEvent("page-close-start", { fixture: index + 1, sequence: launch?.sequence });
            try
            {
                return await pageClose(...arguments_);
            }
            finally
            {
                resourceCloseElapsedMs[index].page = performance.now() - startedAt;
                recordEvent("page-close-end", {
                    elapsedMs: resourceCloseElapsedMs[index].page,
                    fixture: index + 1,
                    sequence: launch?.sequence,
                });
            }
        };
        fixture.context.close = async (...arguments_) =>
        {
            const startedAt = performance.now();
            recordEvent("context-close-start", { fixture: index + 1, sequence: launch?.sequence });
            try
            {
                return await contextClose(...arguments_);
            }
            finally
            {
                resourceCloseElapsedMs[index].context = performance.now() - startedAt;
                recordEvent("context-close-end", {
                    elapsedMs: resourceCloseElapsedMs[index].context,
                    fixture: index + 1,
                    sequence: launch?.sequence,
                });
            }
        };
        fixture.browser.close = async (...arguments_) =>
        {
            const startedAt = performance.now();
            recordEvent("browser-close-start", { fixture: index + 1, sequence: launch?.sequence });
            try
            {
                return await launch.realBrowserClose(...arguments_);
            }
            finally
            {
                resourceCloseElapsedMs[index].browser = performance.now() - startedAt;
                recordEvent("browser-close-end", {
                    elapsedMs: resourceCloseElapsedMs[index].browser,
                    fixture: index + 1,
                    sequence: launch?.sequence,
                });
            }
        };
    }

    process.kill = (pid, signal) =>
    {
        const launch = launches.find((candidate) =>
            candidate.chromiumTree.members.some((identity) => identity.pid === pid)
        );
        recordEvent("signal-attempt", {
            pid,
            sequence: launch?.sequence,
            signal: signal ?? "SIGTERM",
        });
        return originalProcessKill.call(process, pid, signal);
    };
    processKillPatched = true;
    phase = "public-close";
    const stopDiscovery = startDiagnosticDiscovery(launches);
    recordEvent("public-close-start");
    const outcomes = await Promise.all(created.map(async (fixture, index) =>
    {
        const startedAt = performance.now();
        const outcome = await fixture.close().then(
            () =>
            {
                recordEvent("public-close-fulfilled", { fixture: index + 1 });
                return { status: "fulfilled", error: "" };
            },
            (error) =>
            {
                const description = describeError(error);
                recordEvent("public-close-rejected", { error: description, fixture: index + 1 });
                return { status: "rejected", error: description };
            },
        );
        resourceCloseElapsedMs[index].total = performance.now() - startedAt;
        return outcome;
    }));
    recordEvent("public-close-all-settled");
    const immediateGenerationStates = await Promise.all(launches.map(async (launch) => ({
        discoveredGenerations: [...launch.discoveredGenerations.values()],
        members: await Promise.all(
            [...launch.discoveredGenerations.values()].map(async (identity) => await readProcessState(identity)),
        ),
        sequence: launch.sequence,
    })));
    recordEvent("immediate-generation-state", { launches: immediateGenerationStates });
    await stopDiscovery();
    process.kill = originalProcessKill;
    processKillPatched = false;
    phase = "evidence";
    const unrelatedAfterCleanup = await Promise.all(launches.map(async (launch) => ({
        alive: await identityExists(launch.unrelatedIdentity),
        identityUnchanged: await identityMatches(launch.unrelatedIdentity),
        signal: await readFile(launch.signalMarker, "utf8").catch(() => ""),
    })));
    const chromiumAfterCleanup = await Promise.all(launches.map(async (launch) => ({
        alive: await treeHasOriginalGeneration(launch.chromiumTree),
        rootIdentityUnchanged: await identityMatches(launch.chromiumTree.root),
    })));
    const fixtureDirectoriesGone = await Promise.all(created.map(async (fixture) =>
    {
        const sentinel = fixture.childEnvironment().PATH.split(path.delimiter)[0];
        return !await exists(path.dirname(sentinel));
    }));
    await delay(25);
    const generationStatesAfter25Ms = await Promise.all(launches.map(async (launch) => ({
        members: await Promise.all(
            [...launch.discoveredGenerations.values()].map(async (identity) => await readProcessState(identity)),
        ),
        sequence: launch.sequence,
    })));

    status = {
        chromiumAfterCleanup,
        diagnostic: {
            events,
            generationStatesAfter25Ms,
            immediateGenerationStates,
        },
        fixtureDirectoriesGone,
        launchCount: launches.length,
        outcomes,
        resourceCloseElapsedMs,
        unrelatedAfterCleanup,
    };
}
finally
{
    phase = "rescue";
    if (processKillPatched)
    {
        process.kill = originalProcessKill;
        processKillPatched = false;
    }
    if (originalLaunchDescriptor === undefined)
    {
        Reflect.deleteProperty(mutableChromium, "launch");
    }
    else
    {
        Object.defineProperty(mutableChromium, "launch", originalLaunchDescriptor);
    }

    for (const launch of launches)
    {
        await terminateExactTree(launch.chromiumTree).catch(() => undefined);
        if (await identityMatches(launch.unrelatedIdentity))
        {
            process.kill(launch.unrelatedIdentity.pid, "SIGKILL");
            await waitForIdentityExit(launch.unrelatedIdentity, 1_000);
        }
        await Promise.race([launch.realBrowserClose().catch(() => undefined), delay(500)]);
    }
    await Promise.all(fixtures.map(async (fixture) => await fixture.close().catch(() => undefined)));
    await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(status)}\n`);

function generationKey(identity)
{
    return [
        identity.pid,
        identity.startTime,
        identity.executable,
        identity.executableDevice,
        identity.executableInode,
    ].join("\u0000");
}

function startDiagnosticDiscovery(activeLaunches)
{
    let stopped = false;
    let inFlight = Promise.resolve();
    const discover = async () =>
    {
        for (const launch of activeLaunches)
        {
            const tree = await captureTree(launch.chromiumTree.root).catch(() => undefined);
            if (tree === undefined) continue;
            for (const identity of tree.members)
            {
                const key = generationKey(identity);
                if (!launch.discoveredGenerations.has(key))
                {
                    launch.discoveredGenerations.set(key, identity);
                    recordEvent("generation-discovered", { identity, sequence: launch.sequence });
                }
            }
        }
    };
    const schedule = () =>
    {
        inFlight = inFlight.then(discover);
    };
    const interval = setInterval(() =>
    {
        if (!stopped) schedule();
    }, 5);
    interval.unref();
    schedule();
    return async () =>
    {
        stopped = true;
        clearInterval(interval);
        await inFlight;
        await discover();
    };
}

async function readProcessState(identity)
{
    try
    {
        const statText = await readFile(`/proc/${identity.pid}/stat`, "utf8");
        const fields = statText.slice(statText.lastIndexOf(")") + 2).trim().split(/\s+/u);
        const currentStartTime = fields[19];
        return {
            currentParentPid: Number.parseInt(fields[1], 10),
            currentStartTime,
            executableIdentityAvailable: await readIdentityIfPresent(identity.pid) !== undefined,
            expected: identity,
            generationPresent: currentStartTime === identity.startTime,
            processState: fields[0],
        };
    }
    catch (error)
    {
        if (error.code === "ENOENT" || error.code === "ESRCH")
        {
            return { expected: identity, generationPresent: false, processState: "absent" };
        }
        throw error;
    }
}

async function readDirectChildren(parentPid)
{
    return (await readAllIdentities()).filter((identity) => identity.parentPid === parentPid);
}

async function findSingleNewDirectChild(previous, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while (true)
    {
        const current = await readDirectChildren(process.pid);
        const candidates = current.filter((candidate) =>
            !previous.some((identity) => sameIdentity(candidate, identity))
        );
        if (candidates.length === 1)
        {
            return candidates[0];
        }
        if (candidates.length > 1)
        {
            throw new Error(`Expected one launch-owned direct child, found ${candidates.length}`);
        }
        if (Date.now() >= deadline)
        {
            throw new Error("Timed out locating the launch-owned Chromium child");
        }
        await delay(10);
    }
}

async function waitForIdentity(pid, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while (true)
    {
        const identity = await readIdentityIfPresent(pid);
        if (identity !== undefined)
        {
            return identity;
        }
        if (Date.now() >= deadline)
        {
            throw new Error(`Timed out reading exact identity for PID ${pid}`);
        }
        await delay(10);
    }
}

async function captureStableTree(rootIdentity, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    let prior = "";
    let stableSince = Date.now();
    while (true)
    {
        const tree = await captureTree(rootIdentity);
        const key = tree.members.map((member) => `${member.pid}:${member.startTime}:${member.parentPid}`).sort().join(
            "|",
        );
        if (key !== prior)
        {
            prior = key;
            stableSince = Date.now();
        }
        else if (Date.now() - stableSince >= 200)
        {
            return tree;
        }
        if (Date.now() >= deadline)
        {
            throw new Error("Timed out capturing a stable exact Chromium tree");
        }
        await delay(20);
    }
}

async function captureTree(rootIdentity)
{
    if (!await identityMatches(rootIdentity))
    {
        throw new Error(`Chromium root PID ${rootIdentity.pid} changed generation`);
    }
    const identities = await readAllIdentities();
    const members = new Map([[rootIdentity.pid, rootIdentity]]);
    let changed = true;
    while (changed)
    {
        changed = false;
        for (const identity of identities)
        {
            if (!members.has(identity.pid) && members.has(identity.parentPid))
            {
                members.set(identity.pid, identity);
                changed = true;
            }
        }
    }
    return { root: rootIdentity, members: [...members.values()] };
}

async function terminateExactTree(tree)
{
    const currentTree = await captureTree(tree.root).catch(() => tree);
    const members = [...currentTree.members].reverse();
    for (const signal of ["SIGTERM", "SIGKILL"])
    {
        for (const identity of members)
        {
            if (await identityMatches(identity))
            {
                try
                {
                    process.kill(identity.pid, signal);
                }
                catch (error)
                {
                    if (error.code !== "ESRCH") throw error;
                }
            }
        }
        if (!await treeHasOriginalGeneration(currentTree)) return;
        await delay(200);
    }
    await waitForTreeExit(currentTree, 1_000);
}

async function waitForTreeExit(tree, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while (await treeHasOriginalGeneration(tree))
    {
        if (Date.now() >= deadline) throw new Error(`Exact tree ${tree.root.pid} did not exit`);
        await delay(10);
    }
}

async function waitForIdentityExit(identity, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while (await identityExists(identity))
    {
        if (Date.now() >= deadline) throw new Error(`Exact PID ${identity.pid} did not exit`);
        await delay(10);
    }
}

async function treeHasOriginalGeneration(tree)
{
    return (await Promise.all(tree.members.map(identityExists))).some(Boolean);
}

async function identityExists(identity)
{
    const current = await readIdentityGenerationIfPresent(identity.pid);
    return current === identity.startTime;
}

async function identityMatches(identity)
{
    const current = await readIdentityIfPresent(identity.pid);
    return current !== undefined && sameIdentity(current, identity);
}

function sameIdentity(left, right)
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

async function readAllIdentities()
{
    const entries = await readdir("/proc", { withFileTypes: true });
    const identities = await Promise.all(
        entries
            .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
            .map(async (entry) =>
            {
                try
                {
                    return await readIdentityIfPresent(Number.parseInt(entry.name, 10));
                }
                catch (error)
                {
                    // Foreign root processes are not readable by a normal runner user.
                    if (error.code === "EACCES" || error.code === "EPERM") return undefined;
                    throw error;
                }
            }),
    );
    return identities.filter((identity) => identity !== undefined);
}

async function readIdentityIfPresent(pid)
{
    try
    {
        const [statText, executable, executableStats] = await Promise.all([
            readFile(`/proc/${pid}/stat`, "utf8"),
            readlink(`/proc/${pid}/exe`),
            stat(`/proc/${pid}/exe`, { bigint: true }),
        ]);
        const commandEnd = statText.lastIndexOf(")");
        const fields = statText.slice(commandEnd + 2).trim().split(/\s+/u);
        return {
            executable,
            executableDevice: executableStats.dev.toString(),
            executableInode: executableStats.ino.toString(),
            parentPid: Number.parseInt(fields[1], 10),
            pid,
            processGroupId: Number.parseInt(fields[2], 10),
            sessionId: Number.parseInt(fields[3], 10),
            startTime: fields[19],
        };
    }
    catch (error)
    {
        if (error.code === "ENOENT" || error.code === "ESRCH") return undefined;
        throw error;
    }
}

async function readIdentityGenerationIfPresent(pid)
{
    try
    {
        const statText = await readFile(`/proc/${pid}/stat`, "utf8");
        return statText.slice(statText.lastIndexOf(")") + 2).trim().split(/\s+/u)[19];
    }
    catch (error)
    {
        if (error.code === "ENOENT" || error.code === "ESRCH") return undefined;
        throw error;
    }
}

async function exists(target)
{
    return await access(target).then(() => true, () => false);
}

function describeError(error)
{
    if (error instanceof AggregateError)
    {
        return `${error.message} ${error.errors.map(describeError).join(" ")}`;
    }
    return error instanceof Error ? error.message : String(error ?? "");
}

function delay(milliseconds)
{
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
