import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const gitOptions = ["--no-optional-locks", "-c", "core.quotePath=true"];
const maxBuffer = 64 * 1024 * 1024;

function run(command, args, options)
{
    const result = spawnSync(command, args, { maxBuffer, ...options });
    if (result.error) throw result.error;
    return result;
}

function checked(command, args, options)
{
    const result = run(command, args, options);
    if (result.status !== 0)
    {
        const detail = options?.stdio === "inherit" ? "" : `\n${result.stderr.toString().trimEnd()}`;
        throw new Error(`${command} failed (${String(result.signal ?? result.status)})${detail}`);
    }
    return result.stdout;
}

function git(args, options)
{
    return checked("git", [...gitOptions, ...args], options);
}

function records(output)
{
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        .decode(output)
        .split("\0")
        .slice(0, -1);
}

function stagedFiles()
{
    // Treat renames as additions plus deletions; only format the new regular file.
    const entries = records(
        git(["diff", "--cached", "--raw", "-z", "--no-renames", "--diff-filter=AMT", "--"]),
    );
    return entries.filter((_, i) => i % 2 === 1 && /^:\d+ 100[67]\d\d /.test(entries[i - 1] ?? ""));
}

function formattingContext()
{
    return records(
        git([
            "ls-files",
            "--stage",
            "-z",
            "--",
            "dprint.json",
            "**/dprint.json",
            "**/dprint.jsonc",
            "**/.dprint.json",
            "**/.dprint.jsonc",
            "**/.gitignore",
            ".gitignore",
        ]),
    ).flatMap((entry) =>
    {
        const tab = entry.indexOf("\t");
        return /^100[67]\d\d [0-9a-f]+ 0$/.test(entry.slice(0, tab)) ? [entry.slice(tab + 1)] : [];
    });
}

const applyArgs = ["-c", "apply.ignoreWhitespace=no", "apply", "--whitespace=nowarn"];

function mirrorFormatting(patch)
{
    if (run("git", [...applyArgs, "-"], { input: patch }).status === 0) return;

    // A conflict in one file must not stop unrelated files from being updated.
    // Latin-1 round-trips the patch bytes; hunk lines cannot start with this header.
    const changes = patch.toString("latin1").split(/\n(?=diff --git )/);
    for (const change of changes)
    {
        const input = Buffer.from(change.endsWith("\n") ? change : `${change}\n`, "latin1");
        const result = run("git", [...applyArgs, "-"], { input });
        if (result.status !== 0)
        {
            console.warn(
                `Formatting staged; working copy left unchanged:\n${result.stderr.toString().trimEnd()}`,
            );
        }
    }
}

function main()
{
    const files = new Set(stagedFiles());
    if (files.size === 0) return;

    let formatter;
    try
    {
        formatter = require.resolve("dprint/bin.cjs");
    }
    catch (error)
    {
        throw new Error("dprint is not installed. Run npm ci in this checkout.", { cause: error });
    }
    const context = formattingContext();
    const scratch = mkdtempSync(path.join(tmpdir(), "format-staged-"));
    try
    {
        const snapshot = [...new Set([...files, ...context])];
        git(["checkout-index", `--prefix=${scratch}/`, "--stdin", "-z"], {
            input: `${snapshot.join("\0")}\0`,
        });
        checked(process.execPath, [formatter, "fmt", "--allow-no-files", "--config", "dprint.json", "."], {
            cwd: scratch,
            stdio: "inherit",
        });
        // Config and ignore files that weren't staged provided context only. Removing
        // them from the snapshot makes the diff ignore them along with all other absent files.
        for (const file of context)
        {
            if (!files.has(file)) rmSync(path.join(scratch, file));
        }
        // Git changes its working directory for --work-tree. Commit hooks can
        // receive a relative path to a temporary index (for example, git commit -a).
        const index = git(["rev-parse", "--path-format=absolute", "--git-path", "index"])
            .toString()
            .slice(0, -1);
        const patch = git(
            [
                `--work-tree=${scratch}`,
                "-c",
                "core.filemode=false",
                "diff",
                "--diff-filter=M",
                "--binary",
                "--full-index",
                "--no-renames",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--no-relative",
                "--src-prefix=a/",
                "--dst-prefix=b/",
                "--",
            ],
            { env: { ...process.env, GIT_INDEX_FILE: index } },
        );
        if (patch.length === 0) return;

        // First update only the index. If a patch overlaps an unstaged edit, Git
        // won't apply it to that working file and the user's edited bytes stay intact.
        git([...applyArgs, "--cached", "-"], { input: patch });
        mirrorFormatting(patch);
    }
    finally
    {
        rmSync(scratch, { recursive: true, force: true });
    }
}

try
{
    main();
}
catch (error)
{
    console.error(
        `Could not format staged files: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
}
