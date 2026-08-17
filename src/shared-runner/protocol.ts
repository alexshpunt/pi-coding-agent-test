import type { PiIntegrationTestRuntimeArtifacts } from "../runtime/artifacts.js";
import type { InteractiveProcessResult } from "../runtime/interactive-process.js";
import type { PiIntegrationTestOptions } from "../scenario/types.js";

export const SHARED_RUNNER_ENVIRONMENT = "PI_INTEGRATION_TEST_RUNNER";

export interface SharedRunnerEndpoint
{
    readonly host: string;
    readonly port: number;
    readonly token: string;
}

export interface SharedRunInput
{
    readonly cwd: string;
    readonly runtime: PiIntegrationTestRuntimeArtifacts;
    readonly options: PiIntegrationTestOptions;
    readonly prompt: string;
}

export interface SharedRunRequest extends SharedRunInput
{
    readonly type: "run";
    readonly token: string;
    readonly requestId: string;
}

export interface SharedRunResponse
{
    readonly requestId: string;
    readonly result?: InteractiveProcessResult;
    readonly error?: string;
}

export interface SharedRequestFile
{
    readonly prompt: string;
    readonly configPath: string;
    readonly tracePath: string;
}
