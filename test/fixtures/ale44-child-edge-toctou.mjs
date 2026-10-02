import { spawn } from "node:child_process";

import fs from "node:fs";
import { mkdtemp, readFile, readlink, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { createBrowserFixture } from "pi-coding-agent-test";
import { chromium } from "playwright";

if (process.platform !== "linux")
{
    throw new Error("The child-edge PID-reuse scenario requires Linux");
}

const root = await mkdtemp(path.join(tmpdir(), "ale44-child-edge-toctou-"));
const mutableChromium = chromium;
const originalLaunchServerDescriptor = Object.getOwnPropertyDescriptor(chromium, "launchServer");
const originalLaunchServer = chromium.launchServer;
const unrelatedSignalMarker = path.join(root, "unrelated-signal.txt");
const descendantSignalMarker = path.join(root, "unrelated-descendant-signal.txt");
const descendantPidPath = path.join(root, "unrelated-descendant-pid.txt");
let browserServer;
let fixture;
let launchTree;
let stableIdentity;
let listedGeneration;
let unrelated;
let unrelatedIdentity;
let unrelatedDescendantIdentity;
let traversal;
let status;
let browserServerCloseCalls = 0;
let browserServerKillCalls = 0;

mutableChromium.launchServer = async (options) =>
{
    browserServer = await originalLaunchServer.call(chromium, options);
    const pid = browserServer.process().pid;
    if (pid === undefined) throw new Error("BrowserServer did not expose its Chromium PID");
    const rootIdentity = await waitForIdentity(pid, 2_000);
    launchTree = await captureTree(rootIdentity);
    stableIdentity = launchTree.members.find((identity) => identity.pid !== rootIdentity.pid);
    if (stableIdentity === undefined) throw new Error("Chromium did not expose a stable owned child edge");

    unrelated = spawnUnrelatedTree();
    if (unrelated.pid === undefined) throw new Error("Could not obtain unrelated PID");
    unrelatedIdentity = await waitForIdentity(unrelated.pid, 2_000);
    const unrelatedDescendantPid = await waitForPidFile(descendantPidPath, 2_000);
    unrelatedDescendantIdentity = await waitForIdentity(unrelatedDescendantPid, 2_000);
    if (unrelatedDescendantIdentity.parentPid !== unrelatedIdentity.pid)
    {
        throw new Error("Unrelated descendant did not expose its exact parent edge");
    }

    listedGeneration = {
        ...unrelatedIdentity,
        parentPid: stableIdentity.parentPid,
        startTime: `${Number.parseInt(unrelatedIdentity.startTime, 10) + 10_000}`,
        executable: `${unrelatedIdentity.executable}-expired-owned-generation`,
        executableDevice: `${BigInt(unrelatedIdentity.executableDevice) + 10_000n}`,
        executableInode: `${BigInt(unrelatedIdentity.executableInode) + 10_000n}`,
    };
    traversal = installChildEdgeReuse(
        stableIdentity.parentPid,
        stableIdentity.pid,
        unrelatedIdentity.pid,
        unrelatedDescendantIdentity.pid,
    );
    browserServer.close = async () =>
    {
        browserServerCloseCalls += 1;
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
    fixture.page.close = async () => undefined;
    fixture.context.close = async () => undefined;
    fixture.browser.close = async () => undefined;

    if (!await identityMatches(stableIdentity)) throw new Error("Stable owned generation changed before cleanup");
    if (!await identityMatches(unrelatedIdentity)) throw new Error("Unrelated generation changed before cleanup");
    if (!await identityMatches(unrelatedDescendantIdentity))
    {
        throw new Error("Unrelated descendant generation changed before cleanup");
    }
    process.kill(stableIdentity.pid, "SIGSTOP");

    const outcome = await fixture.close().then(
        () => ({ status: "fulfilled", error: "" }),
        (error) => ({ status: "rejected", error: describeError(error) }),
    );
    traversal.restore();

    status = {
        browserServerCloseCalls,
        browserServerKillCalls,
        launchRoot: launchTree.root,
        listedGeneration,
        outcome,
        stable: {
            ...stableIdentity,
            aliveAfterCleanup: await sameGenerationExists(stableIdentity),
            listedOnTraversedEdge: traversal.stableListed(),
        },
        traversal: {
            childrenReads: traversal.childrenReads(),
            currentIdentityReads: traversal.currentIdentityReads(),
            descendantChildrenReads: traversal.descendantChildrenReads(),
            parentPid: stableIdentity.parentPid,
        },
        unrelated: {
            ...unrelatedIdentity,
            aliveAfterCleanup: await sameGenerationExists(unrelatedIdentity),
            identityUnchanged: await identityMatches(unrelatedIdentity),
            signal: await readFile(unrelatedSignalMarker, "utf8").catch(() => ""),
        },
        unrelatedDescendant: {
            ...unrelatedDescendantIdentity,
            aliveAfterCleanup: await sameGenerationExists(unrelatedDescendantIdentity),
            identityUnchanged: await identityMatches(unrelatedDescendantIdentity),
            signal: await readFile(descendantSignalMarker, "utf8").catch(() => ""),
        },
    };
}
finally
{
    traversal?.restore();
    if (originalLaunchServerDescriptor === undefined)
    {
        Reflect.deleteProperty(mutableChromium, "launchServer");
    }
    else
    {
        Object.defineProperty(mutableChromium, "launchServer", originalLaunchServerDescriptor);
    }

    if (stableIdentity !== undefined && await sameGenerationExists(stableIdentity))
    {
        await signalExact(stableIdentity, "SIGCONT").catch(() => undefined);
    }
    if (launchTree !== undefined)
    {
        await terminateExactTree(launchTree).catch(() => undefined);
    }
    for (const identity of [unrelatedDescendantIdentity, unrelatedIdentity])
    {
        if (identity !== undefined && await identityMatches(identity))
        {
            await signalExact(identity, "SIGKILL").catch(() => undefined);
            await waitForIdentityExit(identity, 1_000).catch(() => undefined);
        }
    }
    await fixture?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(status)}\n`);

function spawnUnrelatedTree()
{
    const source = [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        `const parentMarker = ${JSON.stringify(unrelatedSignalMarker)};`,
        `const childMarker = ${JSON.stringify(descendantSignalMarker)};`,
        `const childPidPath = ${JSON.stringify(descendantPidPath)};`,
        "const childSource = `import { writeFileSync } from 'node:fs'; const marker = ${JSON.stringify(childMarker)}; for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => writeFileSync(marker, signal)); setInterval(() => undefined, 1000);`;",
        "const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], { stdio: 'ignore' });",
        "if (child.pid === undefined) throw new Error('missing unrelated descendant PID');",
        "writeFileSync(childPidPath, String(child.pid));",
        "for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => writeFileSync(parentMarker, signal));",
        "setInterval(() => undefined, 1000);",
    ].join("\n");
    return spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: "ignore" });
}

function installChildEdgeReuse(parentPid, stablePid, reusedPid, unrelatedDescendantPid)
{
    const originalReadFile = fs.promises.readFile;
    const childrenPath = `/proc/${parentPid}/task/${parentPid}/children`;
    const reusedStatPath = `/proc/${reusedPid}/stat`;
    const descendantChildrenPath = `/proc/${reusedPid}/task/${reusedPid}/children`;
    let childrenReads = 0;
    let currentIdentityReads = 0;
    let descendantChildrenReads = 0;
    let stableListed = false;
    let restored = false;

    fs.promises.readFile = async (target, ...arguments_) =>
    {
        const value = await originalReadFile(target, ...arguments_);
        const targetPath = String(target);
        if (targetPath === childrenPath)
        {
            childrenReads += 1;
            const listed = String(value).trim().split(/\s+/u).filter(Boolean);
            stableListed ||= listed.includes(`${stablePid}`);
            if (!listed.includes(`${reusedPid}`)) listed.push(`${reusedPid}`);
            return `${listed.join(" ")}\n`;
        }
        if (targetPath === reusedStatPath)
        {
            currentIdentityReads += 1;
        }
        if (targetPath === descendantChildrenPath)
        {
            descendantChildrenReads += 1;
            if (!String(value).trim().split(/\s+/u).includes(`${unrelatedDescendantPid}`))
            {
                throw new Error("Unrelated descendant disappeared from its exact current edge");
            }
        }
        return value;
    };
    syncBuiltinESMExports();

    return {
        childrenReads: () => childrenReads,
        currentIdentityReads: () => currentIdentityReads,
        descendantChildrenReads: () => descendantChildrenReads,
        restore()
        {
            if (restored) return;
            restored = true;
            fs.promises.readFile = originalReadFile;
            syncBuiltinESMExports();
        },
        stableListed: () => stableListed,
    };
}

async function captureTree(rootIdentity)
{
    if (!await identityMatches(rootIdentity))
    {
        throw new Error(`Chromium root PID ${rootIdentity.pid} changed generation`);
    }
    const members = [rootIdentity];
    const visit = async (parentPid) =>
    {
        const childrenText = await readFile(`/proc/${parentPid}/task/${parentPid}/children`, "utf8").catch(() => "");
        for (const pid of childrenText.trim().split(/\s+/u).filter(Boolean).map(Number))
        {
            const identity = await readIdentityIfPresent(pid);
            if (identity === undefined || identity.parentPid !== parentPid) continue;
            members.push(identity);
            await visit(identity.pid);
        }
    };
    await visit(rootIdentity.pid);
    return { root: rootIdentity, members };
}

async function terminateExactTree(tree)
{
    for (const identity of [...tree.members].reverse()) await signalExact(identity, "SIGCONT");
    for (const signal of ["SIGTERM", "SIGKILL"])
    {
        for (const identity of [...tree.members].reverse()) await signalExact(identity, signal);
        if (await waitForTreeExit(tree, 500)) return;
    }
}

async function waitForTreeExit(tree, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while ((await Promise.all(tree.members.map(sameGenerationExists))).some(Boolean))
    {
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return true;
}

async function signalExact(identity, signal)
{
    if (!await sameGenerationExists(identity)) return;
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
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function waitForPidFile(filePath, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while (true)
    {
        const text = await readFile(filePath, "utf8").catch(() => "");
        const pid = Number.parseInt(text, 10);
        if (Number.isSafeInteger(pid) && pid > 0) return pid;
        if (Date.now() >= deadline) throw new Error(`Timed out reading PID from ${filePath}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function waitForIdentityExit(identity, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while (await sameGenerationExists(identity))
    {
        if (Date.now() >= deadline) throw new Error(`Exact PID ${identity.pid} did not exit`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function sameGenerationExists(identity)
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

function describeError(error)
{
    if (error instanceof AggregateError) return `${error.message} ${error.errors.map(describeError).join(" ")}`;
    return error instanceof Error ? error.message : String(error ?? "");
}
