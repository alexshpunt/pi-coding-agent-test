import { spawn } from "node:child_process";
import { access, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { createBrowserFixture } from "pi-coding-agent-test";
import { chromium } from "playwright";

if (process.platform !== "linux")
{
    throw new Error("The exact zombie generation scenario requires Linux");
}

const root = process.env.ALE44_ZOMBIE_SCENARIO_ROOT;
const targetPath = process.env.ALE44_ZOMBIE_TARGET_FILE;
const releasePath = process.env.ALE44_ZOMBIE_RELEASE_FILE;
const auditPath = process.env.ALE44_ZOMBIE_AUDIT_FILE;
if ([root, targetPath, releasePath, auditPath].some((value) => value === undefined))
{
    throw new Error("The zombie scenario requires its private control paths");
}

const mutableChromium = chromium;
const originalLaunchDescriptor = Object.getOwnPropertyDescriptor(chromium, "launch");
const originalLaunch = chromium.launch;
let fixture;
let realBrowserClose;
let ownedRoot;
let unrelated;
let unrelatedIdentity;
let processKillPatched = false;
let reaperPulse;
const signalAttempts = [];
const originalProcessKill = process.kill;
const unrelatedSignalPath = path.join(root, "unrelated-signal.txt");
let status;

try
{
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
    if (unrelated.pid === undefined)
    {
        throw new Error("Could not obtain the unrelated process PID");
    }
    unrelatedIdentity = await waitForCompleteIdentity(unrelated.pid, 2_000);

    mutableChromium.launch = async (options) =>
    {
        const browser = await originalLaunch.call(chromium, options);
        const candidates = (await readDirectChildren(process.pid)).filter((identity) =>
            /chrom(?:e|ium)|headless_shell/iu.test(path.basename(identity.executable))
        );
        if (candidates.length === 0)
        {
            await browser.close();
            throw new Error("Could not locate the fixture-owned Chromium launch root");
        }
        ownedRoot = candidates.reduce((latest, candidate) =>
            Number(candidate.startTime) > Number(latest.startTime) ? candidate : latest
        );
        await writeFile(targetPath, `${ownedRoot.pid}\n`, { mode: 0o600 });
        return browser;
    };

    fixture = await createBrowserFixture();
    realBrowserClose = fixture.browser.close.bind(fixture.browser);
    fixture.browser.close = async () => await new Promise(() => undefined);

    process.kill = (pid, signal) =>
    {
        signalAttempts.push({ pid, signal: signal ?? "SIGTERM" });
        return originalProcessKill.call(process, pid, signal);
    };
    processKillPatched = true;
    reaperPulse = setInterval(() => originalProcessKill.call(process, process.pid, "SIGCHLD"), 10);
    const closeStartedAt = performance.now();
    const closeOutcome = await fixture.close().then(
        () => ({ status: "fulfilled", error: "" }),
        (error) => ({ status: "rejected", error: describeError(error) }),
    );
    const closeElapsedMs = performance.now() - closeStartedAt;
    const stateAfterClose = await readGenerationState(ownedRoot);
    const unrelatedAfterClose = {
        alive: await generationExists(unrelatedIdentity),
        identityUnchanged: await completeIdentityMatches(unrelatedIdentity),
        signal: await readFile(unrelatedSignalPath, "utf8").catch(() => ""),
    };
    const fixtureDirectory = path.dirname(fixture.childEnvironment().PI_BROWSER_FIXTURE_CLAIM);
    const fixtureDirectoryGone = !await exists(fixtureDirectory);
    const waitpidAudit = await readFile(auditPath, "utf8").catch(() => "");

    // The test-owned parent deliberately keeps the exact generation as a zombie until
    // public cleanup has rejected and all ownership evidence has been captured.
    await writeFile(releasePath, "release\n", { mode: 0o600 });
    await reapReleasedGeneration(ownedRoot, 2_000);
    const stateAfterRelease = await readGenerationState(ownedRoot);

    status = {
        closeElapsedMs,
        closeOutcome,
        fixtureDirectoryGone,
        generation: ownedRoot,
        signalAttempts,
        stateAfterClose,
        stateAfterRelease,
        unrelatedAfterClose,
        waitpidAudit,
        rescued: !await generationExists(ownedRoot),
    };
}
finally
{
    if (reaperPulse !== undefined)
    {
        clearInterval(reaperPulse);
    }
    if (processKillPatched)
    {
        process.kill = originalProcessKill;
    }
    if (originalLaunchDescriptor === undefined)
    {
        Reflect.deleteProperty(mutableChromium, "launch");
    }
    else
    {
        Object.defineProperty(mutableChromium, "launch", originalLaunchDescriptor);
    }
    await writeFile(releasePath, "release\n", { mode: 0o600 }).catch(() => undefined);
    if (ownedRoot !== undefined)
    {
        originalProcessKill.call(process, process.pid, "SIGCHLD");
        await waitForGenerationExit(ownedRoot, 1_000).catch(() => undefined);
    }
    if (unrelatedIdentity !== undefined && await completeIdentityMatches(unrelatedIdentity))
    {
        originalProcessKill.call(process, unrelatedIdentity.pid, "SIGKILL");
        await waitForGenerationExit(unrelatedIdentity, 1_000).catch(() => undefined);
    }
    await realBrowserClose?.().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(status)}\n`);

async function reapReleasedGeneration(identity, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while (await generationExists(identity))
    {
        originalProcessKill.call(process, process.pid, "SIGCHLD");
        if (Date.now() >= deadline)
        {
            throw new Error(`Timed out reaping released zombie PID ${identity.pid}`);
        }
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
            executableIdentityAvailable: await readCompleteIdentityIfPresent(identity.pid) !== undefined,
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

async function readDirectChildren(parentPid)
{
    const children = (await readFile(`/proc/${parentPid}/task/${parentPid}/children`, "utf8"))
        .trim().split(/\s+/u).filter(Boolean).map(Number);
    const identities = await Promise.all(children.map(readCompleteIdentityIfPresent));
    return identities.filter((identity) => identity?.parentPid === parentPid);
}

async function waitForCompleteIdentity(pid, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while (true)
    {
        const identity = await readCompleteIdentityIfPresent(pid);
        if (identity !== undefined) return identity;
        if (Date.now() >= deadline) throw new Error(`Timed out reading complete identity for PID ${pid}`);
        await delay(10);
    }
}

async function readCompleteIdentityIfPresent(pid)
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

async function generationExists(identity)
{
    try
    {
        const statText = await readFile(`/proc/${identity.pid}/stat`, "utf8");
        return statText.slice(statText.lastIndexOf(")") + 2).trim().split(/\s+/u)[19] === identity.startTime;
    }
    catch (error)
    {
        if (error.code === "ENOENT" || error.code === "ESRCH") return false;
        throw error;
    }
}

async function completeIdentityMatches(expected)
{
    const current = await readCompleteIdentityIfPresent(expected.pid);
    return current !== undefined
        && current.pid === expected.pid
        && current.parentPid === expected.parentPid
        && current.processGroupId === expected.processGroupId
        && current.sessionId === expected.sessionId
        && current.startTime === expected.startTime
        && current.executable === expected.executable
        && current.executableDevice === expected.executableDevice
        && current.executableInode === expected.executableInode;
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

async function exists(target)
{
    return await access(target).then(() => true, () => false);
}

function describeError(error)
{
    if (error instanceof AggregateError)
    {
        return `${error.message}: ${error.errors.map(describeError).join("; ")}`;
    }
    return error instanceof Error ? error.message : String(error ?? "");
}

function delay(milliseconds)
{
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
