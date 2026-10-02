const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const nodePty = require("node-pty");

const releasePath = process.env.ALE44_STALE_EXIT_RELEASE;
const stateDirectory = process.env.ALE44_STALE_EXIT_STATE;

if (releasePath && stateDirectory)
{
    const originalSpawn = nodePty.spawn;
    const originalProcessKill = process.kill.bind(process);
    let spawnCount = 0;
    let firstPid;
    let released = false;

    process.kill = (pid, signal) =>
    {
        if (!released && firstPid !== undefined && pid === -firstPid && signal !== 0)
        {
            appendFileSync(`${stateDirectory}/termination-attempts.log`, `process.kill ${signal}\n`, "utf8");
            return true;
        }

        return originalProcessKill(pid, signal);
    };

    nodePty.spawn = (...args) =>
    {
        const pty = originalSpawn(...args);
        spawnCount += 1;

        if (spawnCount !== 1)
        {
            return pty;
        }

        firstPid = pty.pid;
        writeFileSync(`${stateDirectory}/old-pty.pid`, `${firstPid}\n`, "utf8");
        const releaseWatcher = setInterval(() =>
        {
            if (!existsSync(releasePath))
            {
                return;
            }

            released = true;
            clearInterval(releaseWatcher);
            pty.kill("SIGKILL");
        }, 10);
        releaseWatcher.unref();

        return new Proxy(pty, {
            get(target, property)
            {
                if (property === "kill")
                {
                    return (signal) =>
                    {
                        appendFileSync(`${stateDirectory}/termination-attempts.log`, `pty.kill ${signal}\n`, "utf8");
                    };
                }
                if (property === "onExit")
                {
                    return (listener) =>
                        target.onExit((event) =>
                        {
                            writeFileSync(`${stateDirectory}/old-exit-delivered`, `${event.exitCode}\n`, "utf8");
                            listener(event);
                        });
                }

                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
    };
}
