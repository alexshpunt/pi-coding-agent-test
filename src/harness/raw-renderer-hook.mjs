/** Process-local installer used by the instrumented Pi CLI component. */
export const rawRendererInstaller = "pi-coding-agent-test.raw-renderer-installer";

const rendererMethods = ["getCallRenderer", "getResultRenderer", "getRenderShell", "hasRendererDefinition"];

/**
 * Add an installer to the actual CLI renderer, independent of bundle chunk names.
 * This targets Pi's renderer method signatures, not arbitrary JavaScript classes.
 * Reject partial or ambiguous matches instead of silently using native rendering.
 * @param {string} source Loaded JavaScript from the CLI's own module directory.
 * @returns {string | undefined} Instrumented source, or undefined for unrelated modules.
 */
export function instrumentRawRenderer(source)
{
    const counts = rendererMethods.map((name) =>
        [...source.matchAll(new RegExp(`\\b${name}\\(\\)\\s*\\{`, "gu"))].length
    );

    if (counts.every((count) => count === 0))
    {
        return undefined;
    }

    if (!counts.every((count) => count === 1))
    {
        throw new Error(`Raw tool output is incompatible with this Pi renderer: method counts ${counts.join(", ")}`);
    }

    // A static block sees the fully defined prototype before any instance is created.
    return source.replace(
        /\bgetCallRenderer\(\)\s*\{/u,
        `static { globalThis[Symbol.for(${JSON.stringify(rawRendererInstaller)})](this); } getCallRenderer(){`,
    );
}
