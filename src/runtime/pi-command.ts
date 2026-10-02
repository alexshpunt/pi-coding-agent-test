import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** A native executable and its argv, suitable for both PTY and pipe transports. */
export interface PiCommand
{
    readonly command: string;
    readonly arguments: string[];
}

/** Resolve the Windows Pi shim through public bin metadata, without invoking a shell. */
export function resolvePiCommand(
    command: string,
    arguments_: readonly string[],
    environment: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): PiCommand
{
    if (platform !== "win32")
    {
        return { command, arguments: [...arguments_] };
    }

    if (/\.(?:cjs|js|mjs)$/iu.test(command))
    {
        return { command: process.execPath, arguments: [command, ...arguments_] };
    }

    const selected = resolvePtyCommand(command, platform, environment);
    const isPiShim = command === "pi"
        || (path.win32.basename(path.win32.dirname(selected)) === ".bin"
            && /^pi(?:\.cmd)?$/iu.test(path.win32.basename(selected)));

    if (!isPiShim)
    {
        return { command: selected, arguments: [...arguments_] };
    }

    const require = createRequire(path.resolve(path.dirname(selected), "pi-host.cjs"));
    const manifestPath = require.resolve.paths("@earendil-works/pi-coding-agent")
        ?.map((directory) => path.join(directory, "@earendil-works/pi-coding-agent/package.json"))
        .find((candidate) => existsSync(candidate));

    if (manifestPath === undefined)
    {
        throw new Error(`Cannot find the selected Pi package for ${selected}`);
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin?: string | Record<string, string>; };
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;

    if (bin === undefined)
    {
        throw new Error(`Selected Pi package has no public pi bin: ${manifestPath}`);
    }

    return { command: process.execPath, arguments: [path.resolve(path.dirname(manifestPath), bin), ...arguments_] };
}

/** Locate an explicitly selected executable/shim using the Windows PATH and PATHEXT. */
export function resolvePtyCommand(
    command: string,
    platform: NodeJS.Platform = process.platform,
    environment: NodeJS.ProcessEnv = process.env,
    exists: (candidate: string) => boolean = existsSync,
): string
{
    if (platform !== "win32" || path.win32.isAbsolute(command) || /[\\/]/u.test(command))
    {
        return command;
    }

    const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === "PATH");
    const pathValue = pathKey === undefined ? undefined : environment[pathKey];

    if (pathValue === undefined)
    {
        return command;
    }

    const extensionsKey = Object.keys(environment).find((key) => key.toUpperCase() === "PATHEXT");
    const configuredExtensions = (extensionsKey === undefined ? undefined : environment[extensionsKey])
        ?? ".COM;.EXE;.BAT;.CMD";
    const extensions = path.win32.extname(command) === "" ? configuredExtensions.split(";") : [""];

    for (const directory of pathValue.split(";"))
    {
        for (const extension of extensions)
        {
            const candidate = path.win32.join(directory, command + extension);

            if (exists(candidate))
            {
                return candidate;
            }
        }
    }

    return command;
}
