import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { runRpcProcess } from "../src/runtime/rpc-process.js";

const directories: string[] = [];
afterEach(async () =>
{
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function runFixture(source: string, timeoutMs = 1000)
{
    const root = path.resolve(".agents/tmp/rpc-process");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "case-"));
    directories.push(cwd);
    const command = path.join(cwd, "pi.mjs");
    await writeFile(command, `#!${process.execPath}\n${source}`);
    await chmod(command, 0o755);
    return {
        cwd,
        run: () =>
            runRpcProcess({
                cwd,
                piCommand: command,
                harnessExtension: "unused",
                extensions: [],
                sessionDir: cwd,
                configPath: path.join(cwd, "config.json"),
                tracePath: path.join(cwd, "trace.jsonl"),
                tuiRenderedOutputPath: path.join(cwd, "tui-rendered.log"),
                terminalOutputPath: path.join(cwd, "terminal.log"),
                isolateUserResources: true,
                prompt: "A\u2028B\u2029C",
                timeoutMs,
                expectedProviderRequestCount: 0,
                providerMode: "user",
            }),
    };
}

test("rejects an early exit and preserves stderr", async () =>
{
    const fixture = await runFixture("process.stderr.write(\"startup failed\"); process.exit(7);");
    await expect(fixture.run()).rejects.toThrow("startup failed");
    expect(await readFile(path.join(fixture.cwd, "rpc-stderr.log"), "utf8")).toBe("startup failed");
});

test("rejects an RPC command failure instead of waiting for the timeout", async () =>
{
    const fixture = await runFixture(
        "console.log(JSON.stringify({type:\"response\",success:false,error:\"bad prompt\"})); setInterval(()=>{},1000);",
    );
    await expect(fixture.run()).rejects.toThrow("bad prompt");
});

test("times out a process which only acknowledges the prompt", async () =>
{
    const fixture = await runFixture(
        "console.log(JSON.stringify({type:\"response\",success:true})); setInterval(()=>{},1000);",
        150,
    );
    await expect(fixture.run()).rejects.toThrow("did not settle within 150ms");
});

test("fails promptly when the executable is missing", async () =>
{
    const fixture = await runFixture("");
    await rm(path.join(fixture.cwd, "pi.mjs"));
    await expect(fixture.run()).rejects.toThrow("ENOENT");
});

test.each([
    ["console.log(\"not JSON\");", "Invalid RPC output"],
    ["console.log(JSON.stringify({type:\"extension_ui_request\",method:\"confirm\"}));", "unsupported UI dialog"],
])("rejects unsupported output: %s", async (source, message) =>
{
    const fixture = await runFixture(`${source} setInterval(()=>{},1000);`);
    await expect(fixture.run()).rejects.toThrow(message);
});

test("kills an unresponsive process after a timeout", async () =>
{
    const fixture = await runFixture(
        "import {writeFileSync} from \"node:fs\"; writeFileSync(\"pid\", String(process.pid)); process.on(\"SIGTERM\",()=>{}); setInterval(()=>{},1000);",
        300,
    );
    await expect(fixture.run()).rejects.toThrow("did not settle within 300ms");
    const pid = Number(await readFile(path.join(fixture.cwd, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
});

test("splits RPC records only on LF and uses pipes", async () =>
{
    const fixture = await runFixture(`
import {writeFileSync} from "node:fs";
process.stdin.once("data", data => {
 const request = JSON.parse(data.toString());
 writeFileSync("request.json", JSON.stringify({request, tty: Boolean(process.stdout.isTTY)}));
 writeFileSync(process.env.PI_INTEGRATION_TEST_TRACE, JSON.stringify({type:"agent_settled", sequence:0, timestamp:0})+"\\n");
 process.stdout.write(JSON.stringify({type:"message_update", text:request.message})+"\\n");
 process.stdout.write('{"type":"agent_');
 setTimeout(()=>process.stdout.write('settled"}\\n'),10);
});
setInterval(()=>{},1000);
`);
    const result = await fixture.run();
    expect(JSON.parse(await readFile(path.join(fixture.cwd, "request.json"), "utf8"))).toEqual({
        request: { id: "scenario", type: "prompt", message: "A\u2028B\u2029C" },
        tty: false,
    });
    expect(result.frameDelaysMs).toEqual([]);
});
