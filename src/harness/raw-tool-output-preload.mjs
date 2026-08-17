import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

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
    const runtimeRequire = createRequire(cliUrl);
    const tuiEntry = runtimeRequire.resolve("@earendil-works/pi-tui");
    const toolExecutionUrl = new URL("./modes/interactive/components/tool-execution.js", cliUrl);
    const [{ ToolExecutionComponent }, { Text }] = await Promise.all([
        import(toolExecutionUrl.href),
        import(pathToFileURL(tuiEntry).href),
    ]);
    const prototype = ToolExecutionComponent?.prototype;

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
        const toolName = this.toolName;
        return (args) => new Text(`tool_call: ${rawJson({ name: toolName, arguments: args })}`, 0, 0);
    };
    prototype.getResultRenderer = () => (result) => new Text(`tool_call_result: ${contentText(result.content)}`, 0, 0);
    process.env[readyEnvironment] = "1";
    process.env[rawOutputEnvironment] = "0";
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
