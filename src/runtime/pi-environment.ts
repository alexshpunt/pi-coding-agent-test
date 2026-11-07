/**
 * Environment values the harness adds to every Pi child unless the caller or the parent process
 * sets them. Pi shows an "Update Available" notice when pi.dev reports a newer release, so a run's
 * screen would otherwise depend on the release feed rather than on the scenario.
 */
const HARNESS_ENVIRONMENT_DEFAULTS: Readonly<Record<string, string>> = {
    PI_SKIP_VERSION_CHECK: "1",
};

/** Return the caller's Pi environment with the harness defaults it and the parent leave unset. */
export function withHarnessEnvironmentDefaults(
    environment: NodeJS.ProcessEnv | undefined,
    parentEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv
{
    const defaults = Object.entries(HARNESS_ENVIRONMENT_DEFAULTS).filter(([name]) =>
        environment?.[name] === undefined && parentEnvironment[name] === undefined
    );

    return { ...Object.fromEntries(defaults), ...environment };
}
