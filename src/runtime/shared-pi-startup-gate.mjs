import { spawn } from "node:child_process";
import { accessSync, watch } from "node:fs";

const [gatePath, encodedCommand] = process.argv.slice(2);

if (gatePath === undefined || encodedCommand === undefined)
{
    throw new Error("Missing shared Pi startup gate arguments");
}

const command = JSON.parse(encodedCommand);

if (
    command === null
    || typeof command !== "object"
    || typeof command.command !== "string"
    || !Array.isArray(command.arguments)
    || command.arguments.some((argument) => typeof argument !== "string")
)
{
    throw new Error("Invalid shared Pi startup gate command");
}

await waitForGateRelease(gatePath);

const childEnvironment = { ...process.env };
const targetNodeOptions = childEnvironment.PI_INTEGRATION_SHARED_TARGET_NODE_OPTIONS;
const missingNodeOptions = "__pi_integration_shared_no_node_options__";

if (targetNodeOptions === undefined || targetNodeOptions === missingNodeOptions)
{
    delete childEnvironment.NODE_OPTIONS;
}
else
{
    childEnvironment.NODE_OPTIONS = targetNodeOptions;
}

delete childEnvironment.PI_INTEGRATION_SHARED_TARGET_NODE_OPTIONS;
delete childEnvironment.PI_INTEGRATION_SHARED_COMMAND_GATE;
delete childEnvironment.PI_INTEGRATION_SHARED_GATE_PATH;

const child = spawn(command.command, command.arguments, {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: "inherit",
    windowsHide: true,
});

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"])
{
    process.on(signal, () =>
    {
        if (!child.killed)
        {
            child.kill(signal);
        }
    });
}

child.once("error", (error) =>
{
    console.error(error);
    process.exitCode = 1;
});
child.once("exit", (code, signal) =>
{
    if (signal !== null)
    {
        process.kill(process.pid, signal);
        return;
    }

    process.exit(code ?? 1);
});

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
