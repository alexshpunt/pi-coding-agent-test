import type { PiIntegrationTestProviderMode, PiIntegrationTestThinkingLevel } from "../scenario/types.js";

export interface PiProcessArgumentsOptions
{
    readonly extensions: readonly string[];
    readonly harnessExtension: string;
    readonly isolateUserResources: boolean;
    readonly model?: string;
    readonly prompt?: string;
    readonly providerMode: PiIntegrationTestProviderMode;
    readonly sessionDirectory: string;
    readonly thinking?: PiIntegrationTestThinkingLevel;
}

export function createPiProcessArguments(options: PiProcessArgumentsOptions): string[]
{
    const extensionArguments = options.extensions.flatMap((extension) => ["--extension", extension]);
    const arguments_ = [
        "--no-extensions",
        "--extension",
        options.harnessExtension,
        ...extensionArguments,
    ];

    if (options.providerMode === "scripted" || options.isolateUserResources)
    {
        arguments_.push("--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes");
    }

    if (options.model !== undefined)
    {
        arguments_.push("--model", options.model);
    }

    if (options.thinking !== undefined)
    {
        arguments_.push("--thinking", options.thinking);
    }

    arguments_.push(
        "--session-dir",
        options.sessionDirectory,
        options.isolateUserResources ? "--no-approve" : "--approve",
    );

    if (options.prompt !== undefined)
    {
        arguments_.push(options.prompt);
    }

    return arguments_;
}
