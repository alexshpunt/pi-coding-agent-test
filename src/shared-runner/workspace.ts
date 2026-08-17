import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

import type { Dirent } from "node:fs";

type WorkspaceEntryKind = "directory" | "file" | "other" | "symbolic-link";

export interface WorkspaceSnapshot
{
    readonly entries: ReadonlyMap<string, WorkspaceEntryKind>;
}

export async function stageWorkspace(source: string, target: string): Promise<WorkspaceSnapshot>
{
    await clearDirectory(target);
    const entries = await readWorkspaceEntries(source);
    await copyDirectoryContents(source, target);
    return { entries };
}

export async function syncWorkspace(
    source: string,
    target: string,
    snapshot: WorkspaceSnapshot,
): Promise<void>
{
    await mkdir(target, { recursive: true });

    const [sourceEntries, targetEntries] = await Promise.all([
        readWorkspaceEntries(source),
        readWorkspaceEntries(target),
    ]);
    const pathsToRemove = new Set<string>();

    for (const [relativePath, originalKind] of snapshot.entries)
    {
        const currentKind = sourceEntries.get(relativePath);

        if (currentKind === undefined || currentKind !== originalKind)
        {
            pathsToRemove.add(relativePath);
        }
    }

    for (const [relativePath, sourceKind] of sourceEntries)
    {
        const targetKind = targetEntries.get(relativePath);

        if (targetKind !== undefined && targetKind !== sourceKind)
        {
            pathsToRemove.add(relativePath);
        }
    }

    await Promise.all(
        topLevelPaths(pathsToRemove).map((relativePath) =>
            rm(path.join(target, relativePath), { recursive: true, force: true })
        ),
    );
    await copyDirectoryContents(source, target);
}

async function clearDirectory(directory: string): Promise<void>
{
    await mkdir(directory, { recursive: true });
    const entries = await readdir(directory);
    await Promise.all(entries.map((entry) => rm(path.join(directory, entry), { recursive: true, force: true })));
}

async function copyDirectoryContents(source: string, target: string): Promise<void>
{
    const entries = await readdir(source);
    await Promise.all(
        entries.map((entry) =>
            cp(path.join(source, entry), path.join(target, entry), { recursive: true, force: true })
        ),
    );
}

async function readWorkspaceEntries(root: string): Promise<Map<string, WorkspaceEntryKind>>
{
    const result = new Map<string, WorkspaceEntryKind>();
    await appendDirectoryEntries(root, "", result);
    return result;
}

async function appendDirectoryEntries(
    root: string,
    relativeDirectory: string,
    result: Map<string, WorkspaceEntryKind>,
): Promise<void>
{
    const directory = path.join(root, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries)
    {
        const relativePath = path.join(relativeDirectory, entry.name);
        result.set(relativePath, entryKind(entry));

        if (entry.isDirectory())
        {
            await appendDirectoryEntries(root, relativePath, result);
        }
    }
}

function entryKind(entry: Dirent): WorkspaceEntryKind
{
    if (entry.isDirectory())
    {
        return "directory";
    }

    if (entry.isFile())
    {
        return "file";
    }

    return entry.isSymbolicLink() ? "symbolic-link" : "other";
}

function topLevelPaths(paths: ReadonlySet<string>): string[]
{
    return [...paths].filter((candidate) =>
    {
        let parent = path.dirname(candidate);

        while (parent !== "." && parent !== candidate)
        {
            if (paths.has(parent))
            {
                return false;
            }

            const next = path.dirname(parent);
            parent = next === parent ? "." : next;
        }

        return true;
    });
}
