import { SHARED_RUNNER_ENVIRONMENT } from "./protocol.js";
import { startSharedRunner } from "./server.js";

export interface SharedRunnerHost
{
    readonly close: () => Promise<void>;
}

export async function startSharedRunnerHost(): Promise<SharedRunnerHost>
{
    const previous = process.env[SHARED_RUNNER_ENVIRONMENT];
    const { endpoint, teardown } = await startSharedRunner();
    process.env[SHARED_RUNNER_ENVIRONMENT] = JSON.stringify(endpoint);
    let closed = false;

    return {
        close: async () =>
        {
            if (closed)
            {
                return;
            }

            closed = true;

            try
            {
                await teardown();
            }
            finally
            {
                if (previous === undefined)
                {
                    delete process.env.PI_INTEGRATION_TEST_RUNNER;
                }
                else
                {
                    process.env[SHARED_RUNNER_ENVIRONMENT] = previous;
                }
            }
        },
    };
}
