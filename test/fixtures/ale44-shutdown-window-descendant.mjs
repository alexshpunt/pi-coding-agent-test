import { spawn } from "node:child_process";

import fs from "node:fs";
import { mkdtemp, readdir, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncBuiltinESMExports } from "node:module";

import { createBrowserFixture } from "pi-coding-agent-test";
import { chromium } from "playwright";

if (process.platform !== "linux")
{
    throw new Error("The exact shutdown-window descendant scenario requires Linux");
}

const root = await mkdtemp(path.join(tmpdir(), "ale44-shutdown-window-descendant-"));
const mutableChromium = chromium;
const originalLaunchServerDescriptor = Object.getOwnPropertyDescriptor(chromium, "launchServer");
const originalLaunchServer = chromium.launchServer;
let fixture;
let latePage;
let browserServer;
let launchTree;
let lateIdentity;
let lateAncestry;
let unrelated;
let unrelatedIdentity;
let browserServerCloseCalls = 0;
let browserServerKillCalls = 0;
const publicPageCloseDeadlineMs = 400;
const injectedPageCloseDelayMs = publicPageCloseDeadlineMs + 100;
let pageCloseEntered = false;
let ancestryRemovedBeforePageCloseReturned = false;

let discoveryObservedDuringPageClose = false;
let rootAliveAtBrowserServerClose;
let lateParentPidAtBrowserServerClose;
const unrelatedSignalMarker = path.join(root, "unrelated-signal.txt");
let status;

mutableChromium.launchServer = async (options) =>
{
    browserServer = await originalLaunchServer.call(chromium, options);
    const pid = browserServer.process().pid;
    if (pid === undefined) throw new Error("BrowserServer did not expose its Chromium PID");
    const rootIdentity = await waitForIdentity(pid, 2_000);
    launchTree = await captureTree(rootIdentity);
    browserServer.close = async () =>
    {
        browserServerCloseCalls += 1;
        rootAliveAtBrowserServerClose = await originalGenerationExists(launchTree.root);
        lateParentPidAtBrowserServerClose = (await readIdentityIfPresent(lateIdentity.pid))?.parentPid;
    };
    browserServer.kill = async () =>
    {
        browserServerKillCalls += 1;
    };
    return browserServer;
};

try
{
    fixture = await createBrowserFixture();
    const treeBeforeShutdown = await captureTree(launchTree.root);

    unrelated = spawn(
        process.execPath,
        [
            "--input-type=module",
            "--eval",
            [
                "import { writeFileSync } from 'node:fs';",
                `const marker = ${JSON.stringify(unrelatedSignalMarker)};`,
                "for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => writeFileSync(marker, signal));",
                "setInterval(() => undefined, 1000);",
            ].join("\n"),
        ],
        { stdio: "ignore" },
    );
    if (unrelated.pid === undefined) throw new Error("Could not obtain unrelated direct-child PID");
    unrelatedIdentity = await waitForIdentity(unrelated.pid, 2_000);

    fixture.context.close = async () => undefined;
    fixture.browser.close = async () => undefined;
    fixture.page.close = async () =>
    {
        pageCloseEntered = true;
        latePage = await fixture.context.newPage();
        await latePage.goto("data:text/html,<title>shutdown-window-owned-generation</title>");
        const lateTree = await waitForNewDescendant(launchTree.root, treeBeforeShutdown.members, 2_000);
        lateIdentity = lateTree.identity;
        lateAncestry = lateTree.ancestry;
        latePage.close = async () => undefined;
        process.kill(lateIdentity.pid, "SIGSTOP");

        const discovery = observeExactChildDiscovery(lateIdentity.parentPid, lateIdentity.pid);
        if (!await identityMatches(lateIdentity))
        {
            throw new Error("Shutdown-window Chromium generation changed before ancestry removal");
        }

        discoveryObservedDuringPageClose = await discovery.wait(150);
        discovery.restore();

        for (const ancestor of lateAncestry.slice(1))
        {
            await signalExact(ancestor, "SIGKILL");
        }
        await waitForIdentityExit(launchTree.root, 2_000);
        await waitForReparenting(lateIdentity, 2_000);
        ancestryRemovedBeforePageCloseReturned = !await originalGenerationExists(launchTree.root)
            && (await readIdentityIfPresent(lateIdentity.pid))?.parentPid !== lateIdentity.parentPid;
        // Keep the injected page close beyond the public 400ms deadline on purpose.
        await delay(injectedPageCloseDelayMs);
    };

    const outcome = await fixture.close().then(
        () => ({ status: "fulfilled", error: "" }),
        (error) => ({ status: "rejected", error: describeError(error) }),
    );
    const lateAfterCleanup = await readIdentityIfPresent(lateIdentity.pid);
    status = {
        ancestryRemovedBeforePageCloseReturned,
        browserServerCloseCalls,
        browserServerKillCalls,

        discoveryObservedDuringPageClose,
        late: {
            aliveAfterCleanup: await originalGenerationExists(lateIdentity),
            ancestryPids: lateAncestry.map((identity) => identity.pid),
            executable: lateIdentity.executable,
            executableAfterCleanup: lateAfterCleanup?.executable,
            parentPid: lateIdentity.parentPid,
            parentPidAfterCleanup: lateAfterCleanup?.parentPid,
            pid: lateIdentity.pid,
            startTime: lateIdentity.startTime,
            startTimeAfterCleanup: lateAfterCleanup?.startTime,
        },
        lateParentPidAtBrowserServerClose,
        injectedPageCloseDelayMs,
        launchRootPid: launchTree.root.pid,
        launchSnapshotPids: launchTree.members.map((identity) => identity.pid),
        outcome,
        pageCloseEntered,
        rootAliveAtBrowserServerClose,
        scenarioPid: process.pid,
        unrelated: {
            alive: await originalGenerationExists(unrelatedIdentity),
            executable: unrelatedIdentity.executable,
            identityUnchanged: await identityMatches(unrelatedIdentity),
            parentPid: unrelatedIdentity.parentPid,
            pid: unrelatedIdentity.pid,
            signal: await readFile(unrelatedSignalMarker, "utf8").catch(() => ""),
            startTime: unrelatedIdentity.startTime,
        },
    };
}
finally
{
    if (originalLaunchServerDescriptor === undefined)
    {
        Reflect.deleteProperty(mutableChromium, "launchServer");
    }
    else
    {
        Object.defineProperty(mutableChromium, "launchServer", originalLaunchServerDescriptor);
    }

    if (lateIdentity !== undefined && await sameExecutableGenerationExists(lateIdentity))
    {
        await signalExactGeneration(lateIdentity, "SIGCONT").catch(() => undefined);
        await signalExactGeneration(lateIdentity, "SIGKILL").catch(() => undefined);
        await waitForIdentityExit(lateIdentity, 1_000).catch(() => undefined);
    }
    if (launchTree !== undefined)
    {
        await terminateExactTree(launchTree).catch(() => undefined);
    }
    if (unrelatedIdentity !== undefined && await identityMatches(unrelatedIdentity))
    {
        await signalExact(unrelatedIdentity, "SIGKILL").catch(() => undefined);
        await waitForIdentityExit(unrelatedIdentity, 1_000).catch(() => undefined);
    }
    await fixture?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(status)}\n`);

function observeExactChildDiscovery(parentPid, childPid)
{
    const originalReadFile = fs.promises.readFile;
    const childrenPath = `/proc/${parentPid}/task/${parentPid}/children`;
    let resolveObserved;
    const observed = new Promise((resolve) =>
    {
        resolveObserved = resolve;
    });

    fs.promises.readFile = async (target, ...arguments_) =>
    {
        const value = await originalReadFile(target, ...arguments_);
        if (
            String(target) === childrenPath
            && String(value).trim().split(/\s+/u).includes(`${childPid}`)
        )
        {
            resolveObserved(true);
        }
        return value;
    };
    syncBuiltinESMExports();

    return {
        restore()
        {
            fs.promises.readFile = originalReadFile;
            syncBuiltinESMExports();
        },
        wait(timeoutMs)
        {
            return Promise.race([
                observed,
                new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
            ]);
        },
    };
}

async function waitForReparenting(identity, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while (true)
    {
        const current = await readIdentityIfPresent(identity.pid);
        if (current === undefined || current.startTime !== identity.startTime)
        {
            throw new Error(`Shutdown-window generation PID ${identity.pid} disappeared before cleanup verification`);
        }
        if (current.parentPid !== identity.parentPid) return;
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for PID ${identity.pid} to be reparented`);
        await delay(10);
    }
}

async function waitForNewDescendant(rootIdentity, previousMembers, timeoutMs)
{
    const previous = new Set(previousMembers.map(identityKey));
    const deadline = Date.now() + timeoutMs;
    while (true)
    {
        const tree = await captureTree(rootIdentity);
        const candidates = tree.members.filter((identity) => !previous.has(identityKey(identity)));
        const candidate = candidates.find((identity) => identity.pid !== rootIdentity.pid);
        if (candidate !== undefined)
        {
            return { identity: candidate, ancestry: ancestryFor(candidate, tree) };
        }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for a post-snapshot Chromium descendant");
        await delay(10);
    }
}

function ancestryFor(identity, tree)
{
    const byPid = new Map(tree.members.map((member) => [member.pid, member]));
    const ancestry = [identity];
    let current = identity;
    while (current.pid !== tree.root.pid)
    {
        const parent = byPid.get(current.parentPid);
        if (parent === undefined) throw new Error(`Missing owned ancestor for PID ${current.pid}`);
        ancestry.push(parent);
        current = parent;
    }
    return ancestry;
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
    const current = await captureTree(tree.root).catch(() => tree);
    const members = [...current.members].reverse();
    for (const signal of ["SIGTERM", "SIGKILL"])
    {
        for (const identity of members) await signalExact(identity, signal);
        if (!await treeHasOriginalGeneration(current)) return;
        await delay(200);
    }
}

async function signalExact(identity, signal)
{
    if (!await identityMatches(identity)) return;
    try
    {
        process.kill(identity.pid, signal);
    }
    catch (error)
    {
        if (error.code !== "ESRCH") throw error;
    }
}

async function signalExactGeneration(identity, signal)
{
    if (!await sameExecutableGenerationExists(identity)) return;
    try
    {
        process.kill(identity.pid, signal);
    }
    catch (error)
    {
        if (error.code !== "ESRCH") throw error;
    }
}

async function waitForIdentity(pid, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while (true)
    {
        const identity = await readIdentityIfPresent(pid);
        if (identity !== undefined) return identity;
        if (Date.now() >= deadline) throw new Error(`Timed out reading exact identity for PID ${pid}`);
        await delay(10);
    }
}

async function waitForIdentityExit(identity, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while (await originalGenerationExists(identity))
    {
        if (Date.now() >= deadline) throw new Error(`Exact PID ${identity.pid} did not exit`);
        await delay(10);
    }
}

async function treeHasOriginalGeneration(tree)
{
    return (await Promise.all(tree.members.map(originalGenerationExists))).some(Boolean);
}

async function originalGenerationExists(identity)
{
    const current = await readIdentityGenerationIfPresent(identity.pid);
    return current === identity.startTime;
}

async function sameExecutableGenerationExists(identity)
{
    const current = await readIdentityIfPresent(identity.pid);
    return current !== undefined
        && current.startTime === identity.startTime
        && current.executable === identity.executable
        && current.executableDevice === identity.executableDevice
        && current.executableInode === identity.executableInode;
}

async function identityMatches(identity)
{
    const current = await readIdentityIfPresent(identity.pid);
    return current !== undefined && identityKey(current) === identityKey(identity);
}

function identityKey(identity)
{
    return [
        identity.pid,
        identity.parentPid,
        identity.processGroupId,
        identity.sessionId,
        identity.startTime,
        identity.executable,
        identity.executableDevice,
        identity.executableInode,
    ].join(":");
}

async function readAllIdentities()
{
    const entries = await readdir("/proc", { withFileTypes: true });
    const identities = await Promise.all(
        entries.filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
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
        const fields = statText.slice(statText.lastIndexOf(")") + 2).trim().split(/\s+/u);
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

function describeError(error)
{
    if (error instanceof AggregateError) return `${error.message} ${error.errors.map(describeError).join(" ")}`;
    return error instanceof Error ? error.message : String(error ?? "");
}

function delay(milliseconds)
{
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
