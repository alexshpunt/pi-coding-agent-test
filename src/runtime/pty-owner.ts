import { spawn as spawnProcess } from "node:child_process";

import { spawn } from "node-pty";

import type { OwnerRequest, OwnerResponse } from "./owned-pty.js";
import type { IPty } from "node-pty";

let terminal: IPty | undefined;

function send(message: OwnerResponse): void
{
    if (process.connected)
    {
        process.send?.(message);
    }
}

// Only this disposable process may allocate Windows PTY workers and native handles.
process.on("message", (message: OwnerRequest) =>
{
    try
    {
        if (message.type === "start")
        {
            const started = spawn(message.command, message.arguments, message.options);
            terminal = started;
            // node-pty 1.2 starts Windows processes asynchronously: pid stays 0 until ConPTY
            // connects, which happens before the first data or exit event.
            let announced = false;
            const announce = (): void =>
            {
                if (announced || started.pid === 0)
                {
                    return;
                }

                announced = true;
                clearInterval(pidPoll);
                send({ type: "ready", pid: started.pid });
            };
            const pidPoll = setInterval(announce, 10);
            started.onData((data) =>
            {
                announce();
                send({ type: "data", data });
            });
            started.onExit((event) =>
            {
                announce();
                clearInterval(pidPoll);
                send({ type: "exit", ...event });
            });
            announce();
        }
        else
        {
            terminal?.write(message.data);
        }
    }
    catch (error)
    {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
});

// A dead parent must not leave its terminal running. Normal shutdown is awaited by the parent.
process.on("disconnect", () =>
{
    const killer = spawnProcess("taskkill.exe", ["/pid", String(process.pid), "/t", "/f"], { stdio: "ignore" });
    killer.on("error", () => process.kill(process.pid, "SIGKILL"));
});
