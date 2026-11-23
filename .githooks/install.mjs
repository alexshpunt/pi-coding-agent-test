import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const preCommit = `#!/bin/sh
if [ -f .githooks/format-staged.mjs ]; then
    exec node .githooks/format-staged.mjs
fi
`;

function git(...args)
{
    return execFileSync("git", ["rev-parse", "--path-format=absolute", ...args], { encoding: "utf8" }).trimEnd();
}

function install()
{
    if (process.env.NODE_ENV === "production" || !existsSync(".git")) return;

    // Use the clone's default hook directory without changing any existing hooks.
    const defaultHooks = path.join(git("--git-common-dir"), "hooks");
    const activeHooks = git("--git-path", "hooks");
    if (path.normalize(activeHooks) !== defaultHooks)
    {
        console.warn("Custom core.hooksPath: add node .githooks/format-staged.mjs to your pre-commit hook.");
        return;
    }

    mkdirSync(defaultHooks, { recursive: true });
    const hook = path.join(defaultHooks, "pre-commit");
    try
    {
        writeFileSync(hook, preCommit, { flag: "wx", mode: 0o755 });
    }
    catch (error)
    {
        if (error.code !== "EEXIST") throw error;
        if (!lstatSync(hook).isFile() || readFileSync(hook, "utf8") !== preCommit)
        {
            console.warn("Existing pre-commit hook kept: add node .githooks/format-staged.mjs to it.");
        }
    }
}

install();
