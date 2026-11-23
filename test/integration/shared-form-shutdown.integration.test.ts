import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    assistantMessage,
    getToolExecution,
    getToolResultText,
    PiIntegrationTest,
    testArtifactsDir,
    text,
    toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

const askExtension = fileURLToPath(import.meta.resolve("pi-agent-ask/src/index.ts"));
const workspaceCache = fileURLToPath(new URL("fixtures/workspace-cache-extension.ts", import.meta.url));

async function createWorkspace(root: string, name: string): Promise<string>
{
    const cwd = path.join(root, name);
    await mkdir(cwd);
    await writeFile(path.join(cwd, "value.txt"), name, "utf8");
    return cwd;
}

const probeWorkspace = assistantMessage([
    toolCall({ id: "workspace-probe", name: "workspace_cache", arguments: {} }),
], { stopReason: "toolUse" });

const finish = assistantMessage([text("Done.")]);

test.runIf(process.env.PI_INTEGRATION_TEST_RUNNER !== undefined)(
    "a shared Pi finishes with an open background form and reuses the process",
    async () =>
    {
        const root = await mkdtemp(path.join(tmpdir(), "pi-test-form-shutdown-"));

        try
        {
            const options = {
                artifactsDir: testArtifactsDir(import.meta.filename),
                environment: { PI_CODING_AGENT_DIR: path.join(root, "agent") },
                extensions: [askExtension, workspaceCache],
                rawMode: false,
                tools: ["ask_user", "workspace_cache"],
            };
            const optionLabel = "Leave this choice unanswered";
            const first = await new PiIntegrationTest({
                ...options,
                testName: "shared-open-form",
                cwd: await createWorkspace(root, "first"),
                conversation: [
                    probeWorkspace,
                    assistantMessage([
                        toolCall({
                            id: "background-form",
                            name: "ask_user",
                            arguments: {
                                background: true,
                                questions: [{
                                    id: "open-form",
                                    prompt: "Which option should we use?",
                                    options: [{ value: "unanswered", label: optionLabel }],
                                }],
                            },
                        }),
                    ], { stopReason: "toolUse" }),
                    finish,
                ],
            }).run("Open a background question and finish without an answer.");

            expect(getToolExecution(first, "background-form").isError).toBe(false);
            expect(first.tuiRenderedOutput).toContain(optionLabel);
            expect(getToolExecution(first, "workspace-probe").isError).toBe(false);
            const firstWorkspace = JSON.parse(getToolResultText(first, "workspace-probe")) as { pid: number; };

            const second = await new PiIntegrationTest({
                ...options,
                testName: "shared-after-open-form",
                cwd: await createWorkspace(root, "second"),
                conversation: [probeWorkspace, finish],
            }).run("Read the second workspace and finish.");

            expect(getToolExecution(second, "workspace-probe").isError).toBe(false);
            expect(JSON.parse(getToolResultText(second, "workspace-probe"))).toMatchObject({
                pid: firstWorkspace.pid,
                value: "second",
            });
            expect(second.tuiRenderedOutput).not.toContain(optionLabel);
        }
        finally
        {
            await rm(root, { recursive: true, force: true });
        }
    },
);
