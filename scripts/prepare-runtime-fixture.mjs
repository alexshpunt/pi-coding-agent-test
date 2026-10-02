import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Copy the installed package's examples outside Vitest's node_modules exclusion.
const root = path.resolve(process.argv[2] ?? ".tmp/runtime-install");
const examples = path.join(root, "node_modules/pi-coding-agent-test/test/examples");
await mkdir(path.join(root, "test"), { recursive: true });
for (
    const name of [
        "raw-tooling-renderer.integration.test.ts",
        "native-tui.integration.test.ts",
        "launch-failure.integration.test.ts",
        "fixtures/note-extension.ts",
        "fixtures/raw-payload-extension.ts",
    ]
)
{
    const destination = path.join(root, "test", name);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(examples, name), destination, { recursive: true });
}
await writeFile(
    path.join(root, "vitest.config.mjs"),
    `export default {
    test: {
        include: ["test/**/*.integration.test.ts"],
        testTimeout: 60000,
        fileParallelism: false,
    },
};\n`,
);
