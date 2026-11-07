import { expect, test } from "vitest";

import { withHarnessEnvironmentDefaults } from "../src/runtime/pi-environment.js";

test("skips Pi's version check by default", () =>
{
    expect(withHarnessEnvironmentDefaults({ EXTRA: "value" }, {})).toEqual({
        PI_SKIP_VERSION_CHECK: "1",
        EXTRA: "value",
    });
    expect(withHarnessEnvironmentDefaults(undefined, {})).toEqual({ PI_SKIP_VERSION_CHECK: "1" });
});

test("keeps a version check setting from the caller or the parent process", () =>
{
    expect(withHarnessEnvironmentDefaults({ PI_SKIP_VERSION_CHECK: "0" }, {})).toEqual({
        PI_SKIP_VERSION_CHECK: "0",
    });
    expect(withHarnessEnvironmentDefaults({}, { PI_SKIP_VERSION_CHECK: "0" })).toEqual({});
});
