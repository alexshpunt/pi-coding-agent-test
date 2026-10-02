import { accessSync, watch } from "node:fs";

const gatePath = process.env.PI_INTEGRATION_SHARED_GATE_PATH;
const targetNodeOptions = process.env.PI_INTEGRATION_SHARED_TARGET_NODE_OPTIONS;
const missingNodeOptions = "__pi_integration_shared_no_node_options__";

if (targetNodeOptions === undefined || targetNodeOptions === missingNodeOptions)
{
    delete process.env.NODE_OPTIONS;
}
else
{
    process.env.NODE_OPTIONS = targetNodeOptions;
}

delete process.env.PI_INTEGRATION_SHARED_TARGET_NODE_OPTIONS;
delete process.env.PI_INTEGRATION_SHARED_COMMAND_GATE;
delete process.env.PI_INTEGRATION_SHARED_GATE_PATH;

if (gatePath !== undefined)
{
    await waitForGateRelease(gatePath);
}

async function waitForGateRelease(filePath)
{
    if (gateReleased(filePath))
    {
        return;
    }

    await new Promise((resolve, reject) =>
    {
        let watcher;
        let settled = false;
        const finish = (error) =>
        {
            if (settled)
            {
                return;
            }

            settled = true;
            watcher?.close();

            if (error === undefined)
            {
                resolve();
            }
            else
            {
                reject(error);
            }
        };
        const check = () =>
        {
            try
            {
                if (gateReleased(filePath))
                {
                    finish();
                }
            }
            catch (error)
            {
                finish(error);
            }
        };

        try
        {
            watcher = watch(filePath, check);
            watcher.on("error", (error) =>
            {
                if (error.code === "ENOENT" && gateReleased(filePath))
                {
                    finish();
                    return;
                }

                finish(error);
            });
            check();
        }
        catch (error)
        {
            if (error.code === "ENOENT" && gateReleased(filePath))
            {
                finish();
                return;
            }

            finish(error);
        }
    });
}

function gateReleased(filePath)
{
    try
    {
        accessSync(filePath);
        return false;
    }
    catch (error)
    {
        if (error.code === "ENOENT")
        {
            return true;
        }

        throw error;
    }
}
