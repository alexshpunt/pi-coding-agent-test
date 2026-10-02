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
            terminal = spawn(message.command, message.arguments, message.options);
            terminal.onData((data) =>
            {
                send({ type: "data", data });
            });
            terminal.onExit((event) =>
            {
                send({ type: "exit", ...event });
            });
            send({ type: "ready", pid: terminal.pid });
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
