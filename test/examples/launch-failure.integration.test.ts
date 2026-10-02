import { assistantMessage, PiIntegrationTest, testArtifactsDir, text } from "pi-coding-agent-test";
import { expect, test } from "vitest";

// A failed launch must not strand the shared runner or prevent its next launch.
test("rejects a missing executable promptly and then launches Pi", async () =>
{
    const startedAt = Date.now();
    await expect(new PiIntegrationTest({
        testName: "missing-executable",
        piCommand: "pi-test-deliberately-missing-executable-lpt-311",
        isolateUserResources: true,
        artifactsDir: testArtifactsDir(import.meta.filename),
        rawMode: false,
        timeoutMs: 5_000,
        conversation: [assistantMessage([text("Never reached")])],
    }).run("This launch must fail")).rejects.toThrow(
        process.platform === "win32"
            ? /PTY startup failed for pi-test-deliberately-missing-executable-lpt-311: File not found/u
            : /exited before (?:becoming ready|settling)/u,
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);

    const result = await new PiIntegrationTest({
        testName: "launch-after-missing-executable",
        ...(process.env.PI_COMMAND === undefined ? {} : { piCommand: process.env.PI_COMMAND }),
        isolateUserResources: true,
        artifactsDir: testArtifactsDir(import.meta.filename),
        rawMode: false,
        conversation: [assistantMessage([text("Recovered after failed launch")])],
    }).run("Verify the next launch works");
    expect(result.tuiRenderedOutput).toContain("Recovered after failed launch");
});
