import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    assistantMessage,
    getProviderSystemPrompt,
    getSystemPrompt,
    getToolCallNames,
    getToolExecution,
    getToolExecutionDetails,
    getToolResultText,
    PiIntegrationTest,
    PiRun,
    testArtifactsDir,
    text,
    toolCall,
} from "pi-coding-agent-test";
import { afterEach, expect, test } from "vitest";

const workspaces: string[] = [];
const fixture = (name: string): string => path.join(path.dirname(import.meta.filename), "fixtures", name);

const noteExtension = fixture("note-extension.ts");
const optionalExtension = fixture("optional-extension.ts");
const runtimeExtension = fixture("runtime-extension.ts");

afterEach(async () =>
{
    await Promise.all(workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("loads a custom extension and asserts its real tool effect", async () =>
{
    const workspace = await mkdtemp(path.join(tmpdir(), "pi-coding-agent-test-extension-example-"));
    workspaces.push(workspace);

    const result = await new PiIntegrationTest({
        testName: "custom-extension",
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd: workspace,
        extensions: [noteExtension],
        tools: ["save_note"],
        conversation: [
            assistantMessage([
                toolCall({
                    id: "save-note",
                    name: "save_note",
                    arguments: { title: "Example", body: "Created by real Pi" },
                }),
            ], { stopReason: "toolUse" }),
            assistantMessage([text("The note was saved.")]),
        ],
    }).run("Save a note with the custom extension");

    expect(JSON.parse(await readFile(path.join(workspace, "note.json"), "utf8"))).toEqual({
        title: "Example",
        body: "Created by real Pi",
    });
    expect(getToolExecution(result, "save-note").isError).toBe(false);
    expect(getToolResultText(result, "save-note")).toContain("Saved note: Example");
    expect(getToolExecutionDetails(getToolExecution(result, "save-note"))).toEqual({
        file: "note.json",
        note: { title: "Example", body: "Created by real Pi" },
    });
    const promptMarker = "save_note example extension is loaded";
    expect(getSystemPrompt(result)).toContain(promptMarker);
    expect(result.traceEvents.find((event) => event.type === "agent_start")?.systemPrompt)
        .toEqual(expect.stringContaining(promptMarker));

    const reopened = await PiRun.open(result.artifacts.directory);
    expect(getSystemPrompt(reopened)).toContain(promptMarker);
});

test("makes extension loading and tool selection explicit", async () =>
{
    const loadedWorkspace = await mkdtemp(path.join(tmpdir(), "pi-coding-agent-test-loaded-extension-"));
    const omittedWorkspace = await mkdtemp(path.join(tmpdir(), "pi-coding-agent-test-omitted-extension-"));
    workspaces.push(loadedWorkspace, omittedWorkspace);

    const loaded = await new PiIntegrationTest({
        testName: "extension-selected",
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd: loadedWorkspace,
        extensions: [optionalExtension],
        tools: ["optional_probe"],
        conversation: [
            assistantMessage([
                toolCall({ id: "optional-probe", name: "optional_probe", arguments: {} }),
            ], { stopReason: "toolUse" }),
            assistantMessage([text("The optional extension ran.")]),
        ],
    }).run("Use the optional extension");

    const omitted = await new PiIntegrationTest({
        testName: "extension-omitted",
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd: omittedWorkspace,
        extensions: [],
        tools: [],
        conversation: [assistantMessage([text("No optional extension was loaded.")])],
    }).run("Do not load optional extensions");

    expect(getToolCallNames(loaded)).toEqual(["optional_probe"]);
    expect(getToolResultText(loaded, "optional-probe")).toContain("optional extension executed");
    expect(getProviderSystemPrompt(loaded)).toContain("optional example extension is loaded");
    expect(getToolCallNames(omitted)).toEqual([]);
    expect(getProviderSystemPrompt(omitted)).not.toContain("optional example extension is loaded");
});

test("registers and selects a tool during session_start", async () =>
{
    const workspace = await mkdtemp(path.join(tmpdir(), "pi-coding-agent-test-runtime-extension-"));
    workspaces.push(workspace);

    const result = await new PiIntegrationTest({
        testName: "runtime-extension",
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd: workspace,
        extensions: [runtimeExtension],
        tools: ["runtime_echo"],
        conversation: [
            assistantMessage([
                toolCall({
                    id: "runtime-echo",
                    name: "runtime_echo",
                    arguments: { message: "registered after startup" },
                }),
            ], { stopReason: "toolUse" }),
            assistantMessage([text("The runtime tool completed.")]),
        ],
    }).run("Use the tool registered by the extension at runtime");

    expect(getToolExecution(result, "runtime-echo").isError).toBe(false);
    expect(getToolResultText(result, "runtime-echo")).toContain("[runtime] registered after startup");
    const runtimeDetails = getToolExecutionDetails(getToolExecution(result, "runtime-echo"));
    expect(runtimeDetails).toMatchObject({ activeTools: ["runtime_echo"] });
    expect(["new", "startup"]).toContain(
        (runtimeDetails as { readonly sessionStartReason?: unknown; }).sessionStartReason,
    );
    expect(getProviderSystemPrompt(result)).toContain("runtime extension configured this session");
    const lifecycle = JSON.parse(await readFile(path.join(workspace, "runtime-lifecycle.json"), "utf8")) as {
        readonly reason?: unknown;
        readonly activeTools?: readonly string[];
    };
    expect(lifecycle).toMatchObject({ activeTools: ["runtime_echo"] });
    expect(["new", "quit"]).toContain(lifecycle.reason);
});
