#!/usr/bin/env node
import { access, appendFileSync, watch } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const stateDirectory = requiredEnvironment("ALE44_RESISTANT_PI_STATE");
const countPath = path.join(stateDirectory, "launch-count");
const count = Number.parseInt(await readFile(countPath, "utf8").catch(() => "0"), 10) + 1;
await writeFile(countPath, `${count}\n`, "utf8");
await writeFile(path.join(stateDirectory, `launch-${count}.pid`), `${process.pid}\n`, "utf8");

if (count === 1)
{
    const readyPath = requiredEnvironment("PI_INTEGRATION_TEST_READY");
    const signalsPath = path.join(stateDirectory, "signals.log");
    const armedPath = path.join(stateDirectory, "launch-1-armed.json");
    const releasePath = path.join(stateDirectory, "release-launch-1-ready");
    const readyPhasePath = path.join(stateDirectory, "launch-1-ready.json");

    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"])
    {
        process.on(signal, () => appendFileSync(signalsPath, `${signal}\n`, "utf8"));
    }

    await writePhase(armedPath, "resistant-armed");
    await waitForFile(releasePath);
    await writeFile(readyPath, "{\"ready\":true}\n", "utf8");
    await writePhase(readyPhasePath, "ready-released");

    setInterval(() =>
    {}, 1_000);
}
else
{
    process.exitCode = 42;
}

async function writePhase(filePath, phase)
{
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ count, phase, pid: process.pid })}\n`, "utf8");
    await rename(temporaryPath, filePath);
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

function requiredEnvironment(name)
{
    const value = process.env[name];

    if (value === undefined || value.length === 0)
    {
        throw new Error(`Missing ${name}`);
    }

    return value;
}
