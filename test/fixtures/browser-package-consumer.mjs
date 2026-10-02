import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const expectedVersion = "1.62.1";
const packageName = process.env.ALE44_PACKAGE_NAME ?? "pi-coding-agent-test";
const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(require.resolve(`${packageName}/package.json`), "utf8"));
const { createBrowserFixture, withBrowserFixture } = await import(packageName);

if (manifest.dependencies?.playwright !== expectedVersion)
{
    throw new Error(`Installed package must pin playwright@${expectedVersion}`);
}

if (typeof createBrowserFixture !== "function" || typeof withBrowserFixture !== "function")
{
    throw new Error(`Installed package ${packageName} must export its browser fixture from the package root`);
}

const fixture = await createBrowserFixture();
const environment = fixture.childEnvironment(process.env);
const sentinelDirectory = environment.PATH?.split(path.delimiter)[0];

try
{
    const url = "data:text/html,<button id='proof'>installed package browser proof</button>";
    await fixture.page.goto(url);
    await fixture.page.locator("#proof").click();

    if (await fixture.page.locator("#proof").textContent() !== "installed package browser proof")
    {
        throw new Error("Installed package did not complete a real page interaction");
    }
}
finally
{
    await fixture.close();
}

if (fixture.browser.isConnected())
{
    throw new Error("Installed package left its browser connected");
}

if (sentinelDirectory !== undefined)
{
    await access(sentinelDirectory).then(
        () => Promise.reject(new Error("Installed package left its fixture directory behind")),
        () => undefined,
    );
}

await withBrowserFixture({}, async (scopedFixture) =>
{
    await scopedFixture.page.setContent("<p>scope helper proof</p>");
});
