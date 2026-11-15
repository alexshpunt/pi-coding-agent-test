import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Verify the registry independently against the exact archive checked by CI.
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const archivePath = process.argv[2];
if (!archivePath)
{
    throw new Error("Usage: node scripts/verify-published-package.mjs <validated-tarball>");
}
const archive = await readFile(path.resolve(archivePath));
const endpoint = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`;
const deadline = Date.now() + 10 * 60_000;
let published;
let lastError;
while (Date.now() < deadline)
{
    let response;
    let metadata;
    try
    {
        response = await fetch(endpoint, {
            signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))),
            cache: "no-store",
        });
        if (response.ok)
        {
            metadata = await response.json();
        }
        else
        {
            await response.body?.cancel();
        }
    }
    catch (error)
    {
        lastError = error;
    }
    if (metadata?.["dist-tags"]?.latest === manifest.version && metadata.versions?.[manifest.version])
    {
        published = metadata.versions[manifest.version];
        break;
    }
    if (response && !response.ok)
    {
        const error = new Error(`Registry request failed: ${response.status}`);
        if (response.status !== 404 && response.status !== 429 && response.status < 500)
        {
            throw error;
        }
        lastError = error;
    }
    await delay(Math.max(0, Math.min(3_000, deadline - Date.now())));
}
if (!published)
{
    throw new Error(`Registry has not confirmed ${manifest.name}@${manifest.version} as latest after ten minutes`, {
        cause: lastError,
    });
}
const response = await fetch(published.dist.tarball, { signal: AbortSignal.timeout(30_000) });
if (!response.ok)
{
    throw new Error(`Published archive download failed: ${response.status}`);
}
const downloaded = Buffer.from(await response.arrayBuffer());
const shasum = createHash("sha1").update(downloaded).digest("hex");
const integrity = `sha512-${createHash("sha512").update(downloaded).digest("base64")}`;
if (shasum !== published.dist.shasum || integrity !== published.dist.integrity)
{
    throw new Error("Published archive does not match registry checksums");
}
if (!archive.equals(downloaded))
{
    throw new Error("Published archive differs from the validated CI archive");
}
console.log(JSON.stringify(
    {
        package: manifest.name,
        version: manifest.version,
        latest: manifest.version,
        shasum,
        integrity,
        tarball: published.dist.tarball,
        archiveMatches: true,
    },
    null,
    2,
));
