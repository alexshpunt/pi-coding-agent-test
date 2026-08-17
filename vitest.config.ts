import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        exclude: ["test/integration/**", "test/examples/**"],
        coverage: {
            provider: "v8",
            reporter: ["text", "json", "html"],
            reportsDirectory: ".tmp/coverage",
            include: ["src/**/*.ts"],
            exclude: ["src/**/*.d.ts"],
        },
    },
});
