import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { assistantMessage, getToolExecution, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test";

const [scenario, root] = process.argv.slice(2);
const workspace = path.join(root, "workspace");
await mkdir(workspace, { recursive: true });
const options = {
    artifactsDir: path.join(root, "artifacts"),
    cwd: workspace,
    isolateUserResources: true,
    extensions: [path.join(import.meta.dirname, "pty-process-marker.ts")],
    rawMode: scenario === "raw",
    ...(scenario === "standalone" ? { tuiSize: { cols: 100, rows: 30 } } : {}),
    testName: scenario,
};

if (scenario === "invalid")
{
    // An existing but unlaunchable pi file reaches node-pty's late constructor failure on Windows.
    const command = path.join(workspace, "pi");
    await writeFile(command, "not a native executable\n", { mode: 0o755 });
    try
    {
        await new PiIntegrationTest({
            ...options,
            piCommand: command,
            timeoutMs: 2_000,
            conversation: [assistantMessage([text("Never reached")])],
        }).run("This launch must fail");
        throw new Error("Invalid executable unexpectedly launched");
    }
    catch (error)
    {
        if (String(error).includes("unexpectedly launched")) throw error;
        console.log(`EXPECTED_FAILURE: ${error}`);
    }
}
else if (scenario === "timeout")
{
    try
    {
        await new PiIntegrationTest({
            ...options,
            timeoutMs: 2_000,
            conversation: [assistantMessage([text("Too late")], { delayMs: 10_000 })],
        }).run("Cancel a running response");
        throw new Error("Delayed response unexpectedly completed");
    }
    catch (error)
    {
        if (!/timed out|did not settle/iu.test(String(error))) throw error;
        console.log(`EXPECTED_FAILURE: ${error}`);
    }
}
else
{
    const result = await new PiIntegrationTest({
        ...options,
        tools: ["write"],
        conversation: [
            assistantMessage([
                toolCall({
                    id: "write-file",
                    name: "write",
                    arguments: { path: "result.txt", content: "PTY lifecycle OK\n" },
                }),
            ], { stopReason: "toolUse" }),
            assistantMessage([text("PTY lifecycle complete")]),
        ],
    }).run("Write result.txt");
    if (getToolExecution(result, "write-file").isError) throw new Error("Write failed");
    if (await readFile(path.join(workspace, "result.txt"), "utf8") !== "PTY lifecycle OK\n")
    {
        throw new Error("Missing file effect");
    }
    if (!result.tuiRenderedOutput.includes("result.txt")) throw new Error("Missing terminal result");
    if (!result.terminalOutput) throw new Error("Missing terminal recording");
    console.log("EXPECTED_RESULT");
}
