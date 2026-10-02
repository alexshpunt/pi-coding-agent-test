import { access, readdir, readFile, readlink, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { createBrowserFixture } from "pi-coding-agent-test";
import { chromium } from "playwright";

const syncRoot = process.env.ALE44_STALLED_CREATION_SYNC_ROOT;

if (syncRoot === undefined)
{
    throw new Error("ALE44_STALLED_CREATION_SYNC_ROOT is required");
}

const statusPath = path.join(syncRoot, "status.json");
const identityPath = path.join(syncRoot, "chromium-identity.json");
const identityAcknowledgedPath = path.join(syncRoot, "identity-acknowledged");
const releasePath = path.join(syncRoot, "release");
const mutableChromium = chromium;
const originalLaunchDescriptor = Object.getOwnPropertyDescriptor(chromium, "launch");
const originalLaunch = chromium.launch;
const checkpoints = [];
let browserReference;
let realBrowserClose;

mutableChromium.launch = async (options) =>
{
    const childrenBeforeLaunch = new Set(
        (await readAllSignalableLinuxProcessIdentities())
            .filter((identity) => identity.parentPid === process.pid)
            .map((identity) => identity.pid),
    );
    const browser = await originalLaunch.call(chromium, options);
    browserReference = browser;
    realBrowserClose = browser.close.bind(browser);
    checkpoints.push("browser launch completed");

    const chromiumRoot = await findNewDirectChild(childrenBeforeLaunch, 2_000);
    const chromiumTree = await captureStableExactLinuxProcessTree(chromiumRoot, 2_000);
    await writeFile(identityPath, JSON.stringify(chromiumTree), "utf8");
    checkpoints.push("chromium identity persisted");
    await waitForFile(identityAcknowledgedPath, 5_000, "parent identity acknowledgement");
    checkpoints.push("parent acknowledged chromium identity");

    browser.newContext = async () =>
    {
        browser.close = async () =>
        {
            checkpoints.push("stalled browser.close entered");
            await new Promise(() => undefined);
        };
        await Promise.reject(new Error("primary context creation failure")).finally(() =>
            checkpoints.push("newContext failure occurred")
        );
        throw new Error("unreachable newContext outcome");
    };
    return browser;
};

try
{
    const outcome = await createBrowserFixture().then(
        () => ({ status: "fulfilled" }),
        (error) => ({ status: "rejected", error: describeError(error), aggregate: error instanceof AggregateError }),
    );
    const fixtureDirectories = (await readdir(process.env.TMPDIR))
        .filter((entry) => entry.startsWith("pi-browser-fixture-"));

    await writeFile(
        statusPath,
        JSON.stringify({
            aggregate: outcome.aggregate ?? false,
            checkpoints,
            disconnected: browserReference === undefined || !browserReference.isConnected(),
            error: outcome.error ?? "",
            executablePath: chromium.executablePath(),
            fixtureDirectories,
            scenarioPid: process.pid,
            status: outcome.status,
        }),
        "utf8",
    );

    await waitForFile(releasePath, 15_000, "rescue release");
}
finally
{
    if (originalLaunchDescriptor === undefined)
    {
        Reflect.deleteProperty(mutableChromium, "launch");
    }
    else
    {
        Object.defineProperty(mutableChromium, "launch", originalLaunchDescriptor);
    }
    await bounded(realBrowserClose?.(), 1_000);
}

function describeError(error)
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

async function findNewDirectChild(childrenBeforeLaunch, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while (true)
    {
        const candidates = (await readAllSignalableLinuxProcessIdentities())
            .filter((identity) => identity.parentPid === process.pid && !childrenBeforeLaunch.has(identity.pid));
        if (candidates.length === 1)
        {
            return candidates[0];
        }
        if (candidates.length > 1)
        {
            throw new Error(`Expected one new direct Chromium child, found ${candidates.length}`);
        }
        if (Date.now() >= deadline)
        {
            throw new Error(`Timed out after ${timeoutMs}ms finding the direct Chromium child`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function captureStableExactLinuxProcessTree(root, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    let priorKey = "";
    let stableSince = 0;
    while (true)
    {
        const tree = await captureExactLinuxProcessTree(root);
        const key = tree.members
            .map((member) => `${member.pid}:${member.startTime}:${member.parentPid}`)
            .sort()
            .join("|");
        if (key !== priorKey)
        {
            priorKey = key;
            stableSince = Date.now();
        }
        else if (Date.now() - stableSince >= 300)
        {
            return tree;
        }
        if (Date.now() >= deadline)
        {
            throw new Error(`Timed out after ${timeoutMs}ms capturing a stable Chromium process tree`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

async function captureExactLinuxProcessTree(root)
{
    const identities = await readAllSignalableLinuxProcessIdentities();
    const currentRoot = identities.find((identity) => identity.pid === root.pid);
    if (currentRoot === undefined || !sameLinuxProcessIdentity(currentRoot, root))
    {
        throw new Error(`Refusing to capture Chromium tree because exact root PID ${root.pid} identity changed`);
    }

    const members = new Map([[root.pid, root]]);
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

async function readAllSignalableLinuxProcessIdentities()
{
    const entries = await readdir("/proc", { withFileTypes: true });
    const identities = await Promise.all(
        entries
            .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
            .map(async (entry) => await readLinuxProcessIdentityIfSignalable(Number.parseInt(entry.name, 10))),
    );

    return identities.filter((identity) => identity !== undefined);
}

async function readLinuxProcessIdentityIfSignalable(pid)
{
    try
    {
        return await readLinuxProcessIdentity(pid);
    }
    catch (error)
    {
        if (error.code === "ENOENT" || error.code === "ESRCH")
        {
            return undefined;
        }
        throw error;
    }
}

async function readLinuxProcessIdentity(pid)
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
    const identity = {
        executable,
        executableDevice: executableStats.dev.toString(),
        executableInode: executableStats.ino.toString(),
        parentPid: Number.parseInt(fields[1], 10),
        pid,
        processGroupId: Number.parseInt(fields[2], 10),
        sessionId: Number.parseInt(fields[3], 10),
        startTime: fields[19],
    };
    if (
        !Number.isSafeInteger(identity.parentPid)
        || !Number.isSafeInteger(identity.processGroupId)
        || !Number.isSafeInteger(identity.sessionId)
        || identity.startTime === undefined
        || identity.executable.length === 0
    )
    {
        throw new Error(`Incomplete exact process identity for Chromium PID ${pid}`);
    }

    return identity;
}

function sameLinuxProcessIdentity(left, right)
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

async function waitForFile(target, timeoutMs, label)
{
    const deadline = Date.now() + timeoutMs;
    while (!await access(target).then(() => true, () => false))
    {
        if (Date.now() >= deadline)
        {
            throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function bounded(promise, timeoutMs)
{
    if (promise === undefined)
    {
        return;
    }
    await Promise.race([
        promise.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
}
