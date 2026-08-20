import { describe, expect, it } from "vitest";

import { createPiProcessArguments } from "../src/runtime/pi-process.js";

describe("Pi process arguments", () =>
{
    const base = {
        extensions: ["/tmp/example-extension.mjs"],
        harnessExtension: "/tmp/harness-extension.mjs",
        sessionDirectory: "/tmp/session",
    };

    it("disables ambient runtime resources and loads only explicit extensions in scripted mode", () =>
    {
        expect(createPiProcessArguments({
            ...base,
            model: "scripted/scripted-model",
            thinking: "high",
            isolateUserResources: false,
            providerMode: "scripted",
        })).toEqual([
            "--no-extensions",
            "--extension",
            "/tmp/harness-extension.mjs",
            "--extension",
            "/tmp/example-extension.mjs",
            "--no-context-files",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--model",
            "scripted/scripted-model",
            "--thinking",
            "high",
            "--session-dir",
            "/tmp/session",
            "--approve",
        ]);
    });

    it("loads explicit skills and system prompt settings", () =>
    {
        expect(createPiProcessArguments({
            ...base,
            appendSystemPrompt: ["Append one", "Append two"],
            isolateUserResources: true,
            providerMode: "user",
            skills: ["/tmp/skill-a", "/tmp/skill-b/SKILL.md"],
            systemPrompt: "Custom system prompt",
        })).toEqual([
            "--no-extensions",
            "--extension",
            "/tmp/harness-extension.mjs",
            "--extension",
            "/tmp/example-extension.mjs",
            "--no-context-files",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--skill",
            "/tmp/skill-a",
            "--skill",
            "/tmp/skill-b/SKILL.md",
            "--system-prompt",
            "Custom system prompt",
            "--append-system-prompt",
            "Append one",
            "--append-system-prompt",
            "Append two",
            "--session-dir",
            "/tmp/session",
            "--no-approve",
        ]);
    });

    it("preserves user resources unless user mode explicitly isolates them", () =>
    {
        expect(createPiProcessArguments({
            ...base,
            isolateUserResources: false,
            providerMode: "user",
        })).toEqual([
            "--no-extensions",
            "--extension",
            "/tmp/harness-extension.mjs",
            "--extension",
            "/tmp/example-extension.mjs",
            "--session-dir",
            "/tmp/session",
            "--approve",
        ]);

        expect(createPiProcessArguments({
            ...base,
            isolateUserResources: true,
            providerMode: "user",
        })).toContain("--no-context-files");
    });
});
