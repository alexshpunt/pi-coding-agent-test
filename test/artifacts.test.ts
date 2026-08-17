import path from "node:path";

import { describe, expect, it } from "vitest";

import { testArtifactsDir } from "../src/runtime/artifacts.js";

describe("integration artifact paths", () =>
{
    it("groups an in-repository test below the requested artifact root", () =>
    {
        expect(testArtifactsDir(path.join("test", "example.integration.test.ts"), ".tmp/runs"))
            .toBe(path.resolve(".tmp/runs/test/example.integration.test.ts"));
    });

    it("rejects a test path outside the current repository", () =>
    {
        expect(() => testArtifactsDir(path.resolve("..", "outside.test.ts"))).toThrow(
            "Integration test file must be inside",
        );
    });

    it("requires a test path", () =>
    {
        expect(() => testArtifactsDir(undefined)).toThrow("Cannot determine the current integration test file");
    });
});
