import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

const tokenKey = "PI_BROWSER_FIXTURE_TOKEN";
const recordKey = "PI_BROWSER_FIXTURE_RECORD";
const claimKey = "PI_BROWSER_FIXTURE_CLAIM";
const activeKey = "PI_BROWSER_FIXTURE_ACTIVE";
const handoffKey = "PI_BROWSER_FIXTURE_HANDOFF";
const sentinelNames = new Set(["xdg-open", "open", "cmd.exe"]);
const token = process.env[tokenKey];
const recordPath = process.env[recordKey];
const claimPath = process.env[claimKey];
const activePath = process.env[activeKey];
const handoffPath = process.env[handoffKey];
const invokedName = path.basename(process.argv0 ?? "").toLowerCase();
const sentinel = sentinelNames.has(invokedName);

function recoverUrl(value)
{
    if (typeof value !== "string")
    {
        return value;
    }
    const index = value.search(/https?:\//u);
    if (index < 0)
    {
        return value;
    }
    const prefix = value.slice(index);
    return prefix.startsWith("http:/") && !prefix.startsWith("http://")
        ? `http://${prefix.slice("http:/".length)}`
        : prefix.startsWith("https:/") && !prefix.startsWith("https://")
        ? `https://${prefix.slice("https:/".length)}`
        : prefix;
}

function linuxStartTime()
{
    if (process.platform !== "linux")
    {
        return undefined;
    }

    try
    {
        const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
        const commandEnd = stat.lastIndexOf(")");
        if (commandEnd < 0)
        {
            return undefined;
        }
        return stat.slice(commandEnd + 2).trim().split(/\s+/u)[19];
    }
    catch
    {
        return undefined;
    }
}

const entryArgument = process.argv[1] ?? "";
const likelyOpener = sentinel || (entryArgument.length > 0 && !existsSync(entryArgument));

if (likelyOpener)
{
    const fail = (message) =>
    {
        if (sentinel && recordPath !== undefined)
        {
            try
            {
                writeFileSync(
                    path.join(path.dirname(recordPath), "sentinels", "default-opener-failure"),
                    `${invokedName}\n`,
                );
            }
            catch
            {
                // The fixture may already be closed; the failure is still reported on stderr.
            }
        }
        process.stderr.write(`Browser fixture opener rejected: ${message}\n`);
        process.exitCode = 97;
    };

    if (
        token === undefined || recordPath === undefined || claimPath === undefined || activePath === undefined
        || handoffPath === undefined
    )
    {
        fail("missing fixture token");
        process.exit();
    }

    let handoffAcquired = false;
    const rejectAndExit = async (message) =>
    {
        fail(message);
        if (handoffAcquired)
        {
            await rm(handoffPath, { recursive: true, force: true }).catch(() => undefined);
        }
        process.exit();
    };

    try
    {
        // mkdir is the fixture-local claim lock. It is acquired before reading the claim,
        // so close() cannot miss a recorder that has already observed valid claim state.
        await mkdir(handoffPath, { mode: 0o700 });
        handoffAcquired = true;
    }
    catch (error)
    {
        await rejectAndExit(error?.code === "EEXIST" ? "duplicate URL capture" : "fixture is closed or uncorrelated");
    }

    let expected;
    try
    {
        expected = (await readFile(claimPath, "utf8")).trim();
    }
    catch
    {
        await rejectAndExit("fixture is closed or uncorrelated");
    }

    if (expected !== token)
    {
        await rejectAndExit("uncorrelated fixture token");
    }

    if (sentinel)
    {
        await rejectAndExit(`default opener ${invokedName} was invoked`);
    }

    const candidate = recoverUrl(process.argv[1]);
    let url;
    try
    {
        const parsed = new URL(candidate ?? "");
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname.length === 0)
        {
            throw new Error("unsupported URL");
        }
        url = parsed.href;
    }
    catch
    {
        await rejectAndExit("expected one absolute HTTP(S) URL");
    }

    const startTime = linuxStartTime();
    const marker = {
        kind: "pi-browser-fixture-active-recorder",
        token,
        pid: process.pid,
        ...(startTime === undefined ? {} : { startTime }),
    };
    const handoffMarker = { ...marker, kind: "pi-browser-fixture-claim-handoff" };
    try
    {
        writeFileSync(
            path.join(handoffPath, "owner.json"),
            `${JSON.stringify(handoffMarker)}\n`,
            { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
    }
    catch
    {
        await rejectAndExit("fixture is closed or recorder ownership could not be published");
    }

    let activePublished = false;
    try
    {
        writeFileSync(activePath, `${JSON.stringify(marker)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        activePublished = true;

        const handle = await open(recordPath, "wx");
        await handle.writeFile(`${JSON.stringify({ url })}\n`, "utf8");
        await handle.close();
    }
    catch (error)
    {
        await rejectAndExit(
            error?.code === "EEXIST" ? "duplicate URL capture" : "fixture is closed or capture could not be recorded",
        );
    }
    finally
    {
        if (activePublished)
        {
            try
            {
                unlinkSync(activePath);
            }
            catch
            {
                // Cleanup owns the marker if the fixture closes concurrently.
            }
        }
        if (handoffAcquired)
        {
            await rm(handoffPath, { recursive: true, force: true }).catch(() => undefined);
        }
    }
    process.exit(0);
}
