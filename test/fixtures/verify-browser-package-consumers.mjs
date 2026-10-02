import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const expectedPlaywright = "1.62.1";
const packageBuildTimeoutMs = 120_000;
const packageOperationTimeoutMs = 90_000;
const packageInstallTimeoutMs = 120_000;
const browserProvisionTimeoutMs = 180_000;
const browserInteractionTimeoutMs = 60_000;
const mode = process.argv[2];
const repository = process.cwd();
const temporaryRoot = path.join(repository, ".tmp");
const consumerFixture = path.join(repository, "test", "fixtures", "browser-package-consumer.mjs");
const verifierFixture = path.join(repository, "test", "fixtures", "verify-browser-package-consumers.mjs");

if (mode !== "preflight" && mode !== "pack")
{
    throw new Error(
        "Usage: node test/fixtures/verify-browser-package-consumers.mjs <preflight|pack>",
    );
}

const sourceManifest = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"));
assertBrowserManifest(sourceManifest, "source package");
if (mode === "preflight")
{
    await runPreflight();
    process.stdout.write("Package consumer preflight passed; pack acceptance was not run.\n");
}
else
{
    await runConsumerAcceptance(mode);
}

async function runPreflight()
{
    const lock = JSON.parse(await readFile(path.join(repository, "package-lock.json"), "utf8"));

    if (lock.packages?.[""]?.dependencies?.playwright !== expectedPlaywright)
    {
        throw new Error(`source lock root must contain exact playwright@${expectedPlaywright}`);
    }
    if (lock.packages?.["node_modules/playwright"]?.version !== expectedPlaywright)
    {
        throw new Error(`source lock resolution must contain exact playwright@${expectedPlaywright}`);
    }
    if (sourceManifest.scripts?.["browser:install:with-deps"] !== "playwright install --with-deps chromium")
    {
        throw new Error("source package must expose the bounded Linux Chromium provisioning command");
    }

    const rootExports = await import("pi-coding-agent-test");
    if (
        typeof rootExports.createBrowserFixture !== "function"
        || typeof rootExports.withBrowserFixture !== "function"
    )
    {
        throw new Error("built package root must export both browser fixture entry points");
    }

    const [consumerSource, verifierSource] = await Promise.all([
        readFile(consumerFixture, "utf8"),
        readFile(verifierFixture, "utf8"),
    ]);
    assertConsumerStructure(consumerSource);
    assertVerifierStructure(verifierSource);
    await Promise.all([
        checkSyntax(consumerFixture, "package consumer syntax"),
        checkSyntax(verifierFixture, "package verifier syntax"),
    ]);
}

async function runConsumerAcceptance(acceptanceMode)
{
    await mkdir(temporaryRoot, { recursive: true });
    const consumer = await mkdtemp(path.join(temporaryRoot, `ale44-${acceptanceMode}-consumer-`));
    // Reuse an explicitly provisioned exact Playwright cache when available. The install
    // command still validates revision 1234 and downloads it when the cache is absent.
    const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH
        ?? path.join(process.env.HOME ?? temporaryRoot, ".cache", "ms-playwright");
    const consumerScript = path.join(consumer, "browser-package-consumer.mjs");

    try
    {
        await writeFile(
            path.join(consumer, "package.json"),
            "{\"name\":\"ale44-browser-consumer\",\"private\":true,\"type\":\"module\"}\n",
        );
        await writeFile(consumerScript, await readFile(consumerFixture, "utf8"));

        const packageIdentity = await installPackedPackage(consumer);
        const installedManifest = JSON.parse(
            await readFile(
                path.join(consumer, "node_modules", ...packageIdentity.name.split("/"), "package.json"),
                "utf8",
            ),
        );
        assertBrowserManifest(installedManifest, `installed ${packageIdentity.spec}`);

        await runOwned(
            path.join(consumer, "node_modules", ".bin", platformCommand("playwright")),
            ["install", "chromium"],
            {
                cwd: consumer,
                environment: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserCache },
                timeoutMs: browserProvisionTimeoutMs,
                label: `${acceptanceMode} consumer Chromium provisioning (Playwright ${expectedPlaywright})`,
            },
        );
        await runOwned(process.execPath, [consumerScript], {
            cwd: consumer,
            environment: {
                ...process.env,
                ALE44_PACKAGE_NAME: packageIdentity.name,
                PLAYWRIGHT_BROWSERS_PATH: browserCache,
            },
            timeoutMs: browserInteractionTimeoutMs,
            label: `${acceptanceMode} root-export browser interaction`,
        });
    }
    finally
    {
        await rm(consumer, { recursive: true, force: true });
    }
}

async function checkSyntax(file, label)
{
    await runOwned(process.execPath, ["--check", file], {
        cwd: repository,
        timeoutMs: 5_000,
        label,
    });
}

function assertConsumerStructure(source)
{
    for (
        const required of [
            "await import(packageName)",
            "await createBrowserFixture()",
            "await fixture.page.goto(url)",
            "await fixture.page.locator(\"#proof\").click()",
            "finally",
            "await fixture.close()",
            "fixture.browser.isConnected()",
        ]
    )
    {
        if (!source.includes(required))
        {
            throw new Error(`package consumer is missing required real-boundary cleanup structure: ${required}`);
        }
    }
}

function assertVerifierStructure(source)
{
    for (
        const required of [
            "npm\", [\"install\", \"--ignore-scripts\", \"--no-audit\", \"--no-fund\", tarball]",
            "PLAYWRIGHT_BROWSERS_PATH: browserCache",
            "timeoutMs: browserProvisionTimeoutMs",
            "timeoutMs: browserInteractionTimeoutMs",
            "finally",
            "await rm(consumer, { recursive: true, force: true })",
        ]
    )
    {
        if (!source.includes(required))
        {
            throw new Error(`package verifier is missing required bounded acceptance structure: ${required}`);
        }
    }
}

async function installPackedPackage(consumerDirectory)
{
    const packDirectory = path.join(consumerDirectory, "pack");
    await mkdir(packDirectory);
    await runOwned("npm", ["run", "build"], {
        cwd: repository,
        timeoutMs: packageBuildTimeoutMs,
        label: "package build",
    });
    const packed = await runOwned("npm", ["pack", "--json", "--pack-destination", packDirectory], {
        cwd: repository,
        timeoutMs: packageOperationTimeoutMs,
        label: "npm pack",
    });
    const records = JSON.parse(packed.stdout);
    const filename = records[0]?.filename;

    if (typeof filename !== "string")
    {
        throw new Error(`npm pack did not report a tarball: ${packed.stdout.slice(0, 500)}`);
    }

    const tarball = path.join(packDirectory, filename);
    await runOwned("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
        cwd: consumerDirectory,
        timeoutMs: packageInstallTimeoutMs,
        label: "packed tarball install",
    });

    return { name: "pi-coding-agent-test", spec: tarball };
}

function assertBrowserManifest(manifest, label)
{
    if (manifest.dependencies?.playwright !== expectedPlaywright)
    {
        throw new Error(`${label} must contain exact playwright@${expectedPlaywright}`);
    }
    if (manifest.scripts?.["browser:install"] !== "playwright install chromium")
    {
        throw new Error(`${label} must expose browser:install through its installed Playwright dependency`);
    }
}

function platformCommand(command)
{
    return process.platform === "win32" ? `${command}.cmd` : command;
}

async function runOwned(command, arguments_, options)
{
    process.stdout.write(`STAGE START: ${options.label} (${options.timeoutMs}ms bound)\n`);
    return await new Promise((resolve, reject) =>
    {
        const child = spawn(command, arguments_, {
            cwd: options.cwd,
            detached: process.platform !== "win32",
            env: options.environment ?? process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => stdout += chunk);
        child.stderr.on("data", (chunk) => stderr += chunk);
        const timer = setTimeout(() =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            void terminateOwnedProcess(child).finally(() =>
            {
                writeStageOutput(options.label, stdout, stderr, "TIMEOUT");
                reject(
                    new Error(
                        `${options.label} exceeded ${options.timeoutMs}ms; stopped owned PID ${
                            child.pid ?? "unknown"
                        }. `
                            + `stdout=${JSON.stringify(stdout.slice(-4_000))} stderr=${
                                JSON.stringify(stderr.slice(-4_000))
                            }`,
                    ),
                );
            });
        }, options.timeoutMs);
        timer.unref();
        child.once("error", (error) =>
        {
            if (!settled)
            {
                settled = true;
                clearTimeout(timer);
                writeStageOutput(options.label, stdout, stderr, "SPAWN ERROR");
                reject(error);
            }
        });
        child.once("exit", (code, signal) =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            clearTimeout(timer);
            writeStageOutput(
                options.label,
                stdout,
                stderr,
                code === 0 ? "PASS" : `FAIL ${code ?? signal ?? "unknown"}`,
            );

            if (code === 0)
            {
                resolve({ stdout, stderr });
            }
            else
            {
                reject(
                    new Error(
                        `${options.label} failed (${code ?? signal ?? "unknown"}): ${
                            (stderr || stdout).slice(0, 2_000)
                        }`,
                    ),
                );
            }
        });
    });
}

function writeStageOutput(label, stdout, stderr, outcome)
{
    process.stdout.write(`STAGE ${outcome}: ${label}\n`);
    if (stdout.length > 0)
    {
        process.stdout.write(`STDOUT ${label}:\n${stdout}${stdout.endsWith("\n") ? "" : "\n"}`);
    }
    if (stderr.length > 0)
    {
        process.stderr.write(`STDERR ${label}:\n${stderr}${stderr.endsWith("\n") ? "" : "\n"}`);
    }
}

async function terminateOwnedProcess(child)
{
    const pid = child.pid;

    if (pid === undefined)
    {
        return;
    }

    if (process.platform === "win32")
    {
        await new Promise((resolve) =>
        {
            const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
            const timer = setTimeout(() =>
            {
                killer.kill("SIGTERM");
                resolve();
            }, 1_000);
            timer.unref();
            killer.once("exit", () =>
            {
                clearTimeout(timer);
                resolve();
            });
            killer.once("error", () =>
            {
                clearTimeout(timer);
                resolve();
            });
        });

        return;
    }

    try
    {
        process.kill(-pid, "SIGTERM");
    }
    catch
    {
        child.kill("SIGTERM");
    }

    await new Promise((resolve) =>
    {
        const timer = setTimeout(() =>
        {
            try
            {
                process.kill(-pid, "SIGKILL");
            }
            catch
            {
                // The owned process group already exited.
            }
            resolve();
        }, 1_000);
        timer.unref();
        child.once("exit", () =>
        {
            clearTimeout(timer);
            resolve();
        });
    });
}
