import { spawn } from "node:child_process";
import { access, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { createBrowserFixture } from "pi-coding-agent-test";
import { chromium } from "playwright";

if (process.platform !== "linux" || process.ppid !== 1)
{
    throw new Error("The PPID-1 zombie scenario must run directly below PID 1 in an isolated Linux PID namespace");
}

const root = process.env.ALE44_PID1_ZOMBIE_SCENARIO_ROOT;
const targetPath = process.env.ALE44_PID1_ZOMBIE_TARGET_FILE;
const releasePath = process.env.ALE44_PID1_ZOMBIE_RELEASE_FILE;
const auditPath = process.env.ALE44_PID1_ZOMBIE_AUDIT_FILE;
if ([root, targetPath, releasePath, auditPath].some((value) => value === undefined))
{
    throw new Error("The PPID-1 zombie scenario requires its private control paths");
}

const mutableChromium = chromium;
const originalLaunchServerDescriptor = Object.getOwnPropertyDescriptor(chromium, "launchServer");
const originalLaunchServer = chromium.launchServer;
const originalProcessKill = process.kill;
const signalAttempts = [];
const unrelatedSignalPath = path.join(root, "unrelated-signal.txt");
let browserServer;
let fixture;
let launchTree;
let lateIdentity;
let lateAncestry;
let latePage;
let unrelated;
let unrelatedIdentity;
let processKillPatched = false;
let status;

mutableChromium.launchServer = async (options) =>
{
    browserServer = await originalLaunchServer.call(chromium, options);
    const pid = browserServer.process().pid;
    if (pid === undefined) throw new Error("BrowserServer did not expose its Chromium PID");
    const rootIdentity = await waitForIdentity(pid, 2_000);
    launchTree = await captureTree(rootIdentity);
    browserServer.close = async () => undefined;
    browserServer.kill = async () => undefined;
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
                `const marker = ${JSON.stringify(unrelatedSignalPath)};`,
                "for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => writeFileSync(marker, signal));",
                "setInterval(() => undefined, 1000);",
            ].join("\n"),
        ],
        { stdio: "ignore" },
    );
    if (unrelated.pid === undefined) throw new Error("Could not obtain the unrelated process PID");
    unrelatedIdentity = await waitForIdentity(unrelated.pid, 2_000);

    fixture.context.close = async () => undefined;
    fixture.browser.close = async () => undefined;
    fixture.page.close = async () =>
    {
        latePage = await fixture.context.newPage();
        await latePage.goto("data:text/html,<title>pid1-zombie-owned-generation</title>");
        const late = await waitForNewDescendant(launchTree.root, treeBeforeShutdown.members, 2_000);
        lateIdentity = late.identity;
        lateAncestry = late.ancestry;
        latePage.close = async () => undefined;
        originalProcessKill.call(process, lateIdentity.pid, "SIGSTOP");
        await writeFile(targetPath, `${lateIdentity.pid}\n`, { mode: 0o600 });

        for (const ancestor of lateAncestry.slice(1))
        {
            await signalExact(ancestor, "SIGKILL");
        }
        await waitForGenerationExit(launchTree.root, 2_000);
        await waitForParent(lateIdentity, 1, 2_000);
    };

    process.kill = (pid, signal) =>
    {
        signalAttempts.push({ pid, signal: signal ?? "SIGTERM" });
        return originalProcessKill.call(process, pid, signal);
    };
    processKillPatched = true;
    const closeStartedAt = performance.now();
    const closeOutcome = await fixture.close().then(
        () => ({ status: "fulfilled", error: "" }),
        (error) => ({ status: "rejected", error: describeError(error) }),
    );
    const closeElapsedMs = performance.now() - closeStartedAt;
    const stateAfterClose = await readGenerationState(lateIdentity);
    const unrelatedAfterClose = {
        alive: await generationExists(unrelatedIdentity),
        identityUnchanged: await identityMatches(unrelatedIdentity),
        signal: await readFile(unrelatedSignalPath, "utf8").catch(() => ""),
    };
    const fixtureDirectory = path.dirname(fixture.childEnvironment().PI_BROWSER_FIXTURE_CLAIM);
    const fixtureDirectoryGone = !await exists(fixtureDirectory);
    await writeFile(releasePath, "release\n", { mode: 0o600 });
    await reapReleasedGeneration(lateIdentity, 2_000);
    const stateAfterRelease = await readGenerationState(lateIdentity);
    const waitpidAudit = await readFile(auditPath, "utf8").catch(() => "");

    status = {
        closeElapsedMs,
        closeOutcome,
        fixtureDirectoryGone,
        generation: lateIdentity,
        initialParentPid: lateIdentity.parentPid,
        namespaceInitPid: process.ppid,
        reparentedThrough: lateAncestry.map((identity) => identity.pid),
        rescued: !await generationExists(lateIdentity),
        signalAttempts,
        stateAfterClose,
        stateAfterRelease,
        unrelatedAfterClose,
        waitpidAudit,
    };
}
finally
{
    if (processKillPatched) process.kill = originalProcessKill;
    if (originalLaunchServerDescriptor === undefined)
    {
        Reflect.deleteProperty(mutableChromium, "launchServer");
    }
    else
    {
        Object.defineProperty(mutableChromium, "launchServer", originalLaunchServerDescriptor);
    }

    await writeFile(releasePath, "release\n", { mode: 0o600 }).catch(() => undefined);
    if (lateIdentity !== undefined)
    {
        await signalExactGeneration(lateIdentity, "SIGCONT").catch(() => undefined);
        await signalExactGeneration(lateIdentity, "SIGKILL").catch(() => undefined);
        await waitForGenerationExit(lateIdentity, 1_000).catch(() => undefined);
    }
    if (launchTree !== undefined) await terminateExactTree(launchTree).catch(() => undefined);
    if (unrelatedIdentity !== undefined && await identityMatches(unrelatedIdentity))
    {
        await signalExact(unrelatedIdentity, "SIGKILL").catch(() => undefined);
        await waitForGenerationExit(unrelatedIdentity, 1_000).catch(() => undefined);
    }
    await fixture?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(status)}\n`);

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

async function waitForParent(identity, parentPid, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while (true)
    {
        const state = await readGenerationState(identity);
        if (!state.generationPresent) throw new Error(`PID ${identity.pid} disappeared before reparenting`);
        if (state.parentPid === parentPid) return;
        if (Date.now() >= deadline)
        {
            throw new Error(`Timed out waiting for PID ${identity.pid} to reach PPID ${parentPid}`);
        }
        await delay(10);
    }
}

async function reapReleasedGeneration(identity, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while (await generationExists(identity))
    {
        if (Date.now() >= deadline) throw new Error(`Timed out reaping released PPID-1 zombie PID ${identity.pid}`);
        await delay(10);
    }
}

async function terminateExactTree(tree)
{
    for (const identity of [...tree.members].reverse()) await signalExactGeneration(identity, "SIGCONT");
    for (const signal of ["SIGTERM", "SIGKILL"])
    {
        for (const identity of [...tree.members].reverse()) await signalExact(identity, signal);
        await delay(100);
    }
}

async function signalExact(identity, signal)
{
    if (!await identityMatches(identity)) return;
    try
    {
        originalProcessKill.call(process, identity.pid, signal);
    }
    catch (error)
    {
        if (error.code !== "ESRCH") throw error;
    }
}

async function signalExactGeneration(identity, signal)
{
    if (!await generationExists(identity)) return;
    try
    {
        originalProcessKill.call(process, identity.pid, signal);
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

async function waitForGenerationExit(identity, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while (await generationExists(identity))
    {
        if (Date.now() >= deadline) throw new Error(`Exact generation ${identity.pid} did not exit`);
        await delay(10);
    }
}

async function readGenerationState(identity)
{
    try
    {
        const statText = await readFile(`/proc/${identity.pid}/stat`, "utf8");
        const fields = statText.slice(statText.lastIndexOf(")") + 2).trim().split(/\s+/u);
        return {
            executableIdentityAvailable: await readIdentityIfPresent(identity.pid) !== undefined,
            generationPresent: fields[19] === identity.startTime,
            parentPid: Number.parseInt(fields[1], 10),
            startTime: fields[19],
            state: fields[0],
        };
    }
    catch (error)
    {
        if (error.code === "ENOENT" || error.code === "ESRCH")
        {
            return { executableIdentityAvailable: false, generationPresent: false, state: "absent" };
        }
        throw error;
    }
}

async function generationExists(identity)
{
    const state = await readGenerationState(identity);
    return state.generationPresent;
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

async function exists(target)
{
    return await access(target).then(() => true, () => false);
}

function describeError(error)
{
    if (error instanceof AggregateError) return `${error.message}: ${error.errors.map(describeError).join("; ")}`;
    return error instanceof Error ? error.message : String(error ?? "");
}

function delay(milliseconds)
{
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
