#!/usr/bin/env node
import { access, appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const syncRoot = requiredEnvironment("ALE44_FAKE_CHROMIUM_SYNC_ROOT");
const readyPath = path.join(syncRoot, "ready");
const releasePath = path.join(syncRoot, "release");
const artifactRecordPath = path.join(syncRoot, "artifact-record");
const artifactDirectory = await mkdtemp(path.join(tmpdir(), "playwright_fixture-launch-"));
const artifactMarker = path.join(artifactDirectory, "fixture-launch-marker.txt");

await mkdir(syncRoot, { recursive: true });
await writeFile(artifactMarker, "fixture-owned launch state\n", "utf8");
await writeFile(artifactRecordPath, `${artifactDirectory}\n`, "utf8");
const tamperedRecord = process.env.ALE44_FAKE_CHROMIUM_TAMPER_PATH;

if (tamperedRecord !== undefined)
{
    await appendFile(requiredEnvironment("PI_BROWSER_FIXTURE_LAUNCH_RECORDS"), `${tamperedRecord}\n`, "utf8");
}
await writeFile(readyPath, `${process.pid}\n`, "utf8");

while (!await exists(releasePath))
{
    await new Promise((resolve) => setTimeout(resolve, 10));
}

process.exitCode = 23;

function requiredEnvironment(name)
{
    const value = process.env[name];

    if (value === undefined || value.length === 0)
    {
        throw new Error(`Missing ${name}`);
    }

    return value;
}

async function exists(target)
{
    return await access(target).then(() => true, () => false);
}
