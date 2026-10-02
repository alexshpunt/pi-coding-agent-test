import { realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

import { instrumentRawRenderer, rawRendererInstaller } from "./raw-renderer-hook.mjs";

const rawOutputEnvironment = "PI_INTEGRATION_TEST_RAW_TOOL_OUTPUT";
const readyEnvironment = "PI_INTEGRATION_TEST_RAW_TOOL_OUTPUT_READY";

if (process.env[rawOutputEnvironment] === "1")
{
    const cliPath = process.argv[1];

    if (cliPath === undefined)
    {
        throw new Error("Raw tool output requires a Node-based Pi CLI entrypoint");
    }

    const cliUrl = pathToFileURL(realpathSync(cliPath));
    const cliDirectory = new URL("./", cliUrl).href;
    const runtimeRequire = createRequire(cliUrl);
    const tuiEntry = runtimeRequire.resolve("@earendil-works/pi-tui");
    const { Text } = await import(pathToFileURL(tuiEntry).href);
    const installerKey = Symbol.for(rawRendererInstaller);

    // The SDK export is a separate class from the bundled CLI renderer. Install
    // on the class loaded by the CLI itself, without changing any installed file.
    globalThis[installerKey] = (component) =>
    {
        const prototype = component?.prototype;

        if (
            prototype === undefined
            || typeof prototype.getCallRenderer !== "function"
            || typeof prototype.getResultRenderer !== "function"
            || typeof prototype.getRenderShell !== "function"
            || typeof prototype.hasRendererDefinition !== "function"
        )
        {
            throw new Error("Raw tool output is incompatible with this Pi ToolExecutionComponent");
        }

        prototype.hasRendererDefinition = () => true;
        prototype.getRenderShell = () => "self";
        prototype.getCallRenderer = function getRawCallRenderer()
        {
            if (typeof this.toolName !== "string" || typeof this.toolCallId !== "string")
            {
                throw new Error("Raw tool output cannot identify this Pi tool call");
            }

            const name = this.toolName;
            const toolCallId = this.toolCallId;
            return (args) => new Text(`tool_call: ${rawJson({ name, toolCallId, arguments: args })}`, 0, 0);
        };
        prototype.getResultRenderer = function getRawResultRenderer()
        {
            const toolCallId = this.toolCallId;
            return (result, options, _theme, context) =>
                new Text(
                    `tool_call_result: ${contentText(result.content)}\n${
                        rawJson({
                            toolCallId,
                            isError: context.isError,
                            isPartial: options.isPartial,
                            result,
                        })
                    }`,
                    0,
                    0,
                );
        };
        Reflect.deleteProperty(globalThis, installerKey);
        process.env[readyEnvironment] = "1";
        process.env[rawOutputEnvironment] = "0";
    };

    const hooks = registerHooks({
        load(url, context, nextLoad)
        {
            const loaded = nextLoad(url, context);

            if (!url.startsWith(cliDirectory) || loaded.format !== "module" || loaded.source == null)
            {
                return loaded;
            }

            const source = typeof loaded.source === "string"
                ? loaded.source
                : Buffer.from(loaded.source).toString("utf8");
            const instrumented = instrumentRawRenderer(source);

            if (instrumented === undefined)
            {
                return loaded;
            }

            // Only the renderer's owning module is changed, in memory. Later
            // imports, including SDK copies loaded by extensions, stay untouched.
            hooks.deregister();
            return { ...loaded, source: instrumented };
        },
    });
}

function contentText(content)
{
    if (!Array.isArray(content))
    {
        return typeof content === "string" ? content : "";
    }

    return content
        .filter((item) =>
            typeof item === "object"
            && item !== null
            && item.type === "text"
            && typeof item.text === "string"
        )
        .map((item) => item.text)
        .join("\n");
}

function rawJson(value)
{
    try
    {
        return JSON.stringify(value, null, 2);
    }
    catch
    {
        return String(value);
    }
}
