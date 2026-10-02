import { describe, expect, test } from "vitest";

import { instrumentRawRenderer, rawRendererInstaller } from "../src/harness/raw-renderer-hook.mjs";

const renderer = `export default class Renderer {
    constructor() { this.observed = this.getCallRenderer(); }
    getCallRenderer() { return "native"; }
    getResultRenderer() { return "native result"; }
    getRenderShell() { return "default"; }
    hasRendererDefinition() { return false; }
}`;

describe("raw CLI renderer instrumentation", () =>
{
    test.each([renderer, renderer.replaceAll(/\s+/gu, " ")])(
        "installs on the actual class before its first instance",
        async (source) =>
        {
            const key = Symbol.for(rawRendererInstaller);
            let installations = 0;
            Reflect.set(globalThis, key, (component: { prototype: { getCallRenderer: () => string; }; }) =>
            {
                installations += 1;
                component.prototype.getCallRenderer = () => "raw";
            });

            try
            {
                const instrumented = instrumentRawRenderer(source);
                expect(instrumented).toBeDefined();
                const module = await import(`data:text/javascript,${encodeURIComponent(instrumented!)}`) as {
                    default: new() => { observed: string; };
                };
                expect(new module.default().observed).toBe("raw");
                expect(installations).toBe(1);
            }
            finally
            {
                Reflect.deleteProperty(globalThis, key);
            }
        },
    );

    test("leaves unrelated modules alone", () =>
    {
        expect(instrumentRawRenderer("export const value = 1;")).toBeUndefined();
    });

    test("rejects a changed renderer rather than silently falling back", () =>
    {
        expect(() => instrumentRawRenderer(renderer.replace("getRenderShell", "changedRenderShell")))
            .toThrow("incompatible");
    });

    test("rejects multiple candidates rather than patching an arbitrary class", () =>
    {
        expect(() => instrumentRawRenderer(`${renderer}\n${renderer}`)).toThrow("incompatible");
    });
});
