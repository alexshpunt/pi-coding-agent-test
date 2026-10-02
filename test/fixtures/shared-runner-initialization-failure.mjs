#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const pidPath = process.env.ALE44_INITIALIZATION_FAILURE_PID;

if (pidPath === undefined || pidPath.length === 0)
{
    throw new Error("Missing ALE44_INITIALIZATION_FAILURE_PID");
}

await writeFile(pidPath, `${process.pid}\n`, "utf8");
process.exitCode = 41;
