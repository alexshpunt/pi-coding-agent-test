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
    throw new Error("The retained-generation collision scenario requires Linux");
}

const root = await mkdtemp(path.join(tmpdir(), "ale44-retained-generation-collision-"));
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
const unrelatedSignalMarker = path.join(root, "unrelated-signal.txt");
let status;

let restoreSyntheticIdentity = () => undefined;
let syntheticIdentity;
let syntheticIdentityReads = 0;
let expiredDuringCleanup = false;

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
    const treeBeforeLatePage = await captureTree(launchTree.root);
    latePage = await fixture.context.newPage();
    await latePage.goto("data:text/html,<title>late-owned-generation</title>");
    const lateTree = await waitForNewDescendant(launchTree.root, treeBeforeLatePage.members, 2_000);
    lateIdentity = lateTree.identity;
    lateAncestry = lateTree.ancestry;

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

    latePage.close = async () => undefined;
    fixture.context.close = async () => undefined;
    fixture.browser.close = async () => undefined;
    process.kill(lateIdentity.pid, "SIGSTOP");
    if (!await identityMatches(lateIdentity)) throw new Error("Owned Chromium generation changed before cleanup");
    syntheticIdentity = {
        ...lateIdentity,
        startTime: `${Number.parseInt(lateIdentity.startTime, 10) + 10_000}`,
        executable: `${lateIdentity.executable}-new-generation`,
        executableDevice: `${BigInt(lateIdentity.executableDevice) + 10_000n}`,
        executableInode: `${BigInt(lateIdentity.executableInode) + 10_000n}`,
    };
    fixture.page.close = async () =>
    {
        restoreSyntheticIdentity = installSyntheticLinuxIdentity(lateIdentity, syntheticIdentity, () =>
        {
            syntheticIdentityReads += 1;
        });
        expiredDuringCleanup = !await identityMatches(lateIdentity);
    };

    const outcome = await fixture.close().then(
        () => ({ status: "fulfilled", error: "" }),
        (error) => ({ status: "rejected", error: describeError(error) }),
    );
    restoreSyntheticIdentity();
    restoreSyntheticIdentity = () => undefined;
    const lateAfterCleanup = await readIdentityIfPresent(lateIdentity.pid);
    status = {
        browserServerCloseCalls,
        browserServerKillCalls,

        expiredDuringCleanup,
        syntheticIdentity,
        syntheticIdentityReads,
        late: {
            aliveAfterCleanup: await originalGenerationExists(lateIdentity),
            ancestryPids: lateAncestry.map((identity) => identity.pid),
            executable: lateIdentity.executable,

            executableDevice: lateIdentity.executableDevice,
            executableInode: lateIdentity.executableInode,
            executableAfterCleanup: lateAfterCleanup?.executable,
            parentPid: lateIdentity.parentPid,
            parentPidAfterCleanup: lateAfterCleanup?.parentPid,
            pid: lateIdentity.pid,
            startTime: lateIdentity.startTime,
            startTimeAfterCleanup: lateAfterCleanup?.startTime,
        },
        launchRootPid: launchTree.root.pid,
        launchSnapshotPids: launchTree.members.map((identity) => identity.pid),
        outcome,
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
    restoreSyntheticIdentity();
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

function installSyntheticLinuxIdentity(actual, synthetic, observed)
{
    const originalReadFile = fs.promises.readFile;
    const originalReadlink = fs.promises.readlink;
    const originalStat = fs.promises.stat;
    const statPath = `/proc/${actual.pid}/stat`;
    const executablePath = `/proc/${actual.pid}/exe`;

    fs.promises.readFile = async (target, ...arguments_) =>
    {
        const value = await originalReadFile(target, ...arguments_);
        if (String(target) !== statPath) return value;
        observed();
        const text = String(value);
        const commandEnd = text.lastIndexOf(")");
        const fields = text.slice(commandEnd + 2).trim().split(/\s+/u);
        fields[19] = synthetic.startTime;
        return `${text.slice(0, commandEnd + 2)}${fields.join(" ")}\n`;
    };
    fs.promises.readlink = async (target, ...arguments_) =>
    {
        if (String(target) === executablePath) return synthetic.executable;
        return await originalReadlink(target, ...arguments_);
    };
    fs.promises.stat = async (target, ...arguments_) =>
    {
        const value = await originalStat(target, ...arguments_);
        if (String(target) !== executablePath) return value;
        return new Proxy(value, {
            get(inner, property, receiver)
            {
                if (property === "dev") return BigInt(synthetic.executableDevice);
                if (property === "ino") return BigInt(synthetic.executableInode);
                return Reflect.get(inner, property, receiver);
            },
        });
    };
    syncBuiltinESMExports();

    return () =>
    {
        fs.promises.readFile = originalReadFile;
        fs.promises.readlink = originalReadlink;
        fs.promises.stat = originalStat;
        syncBuiltinESMExports();
    };
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
            .map((entry) => readIdentityIfPresent(Number.parseInt(entry.name, 10))),
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
