// Filesystem boundary for the neo-arc-assessment workflow: the only module that writes durable files.
// It persists validated report files (see helpers.mjs validateOutputPath) and nothing else.
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Nearest ancestor of `startDir` holding a `.git` entry (directory, or file for worktrees/submodules). */
export async function findGitRoot(startDir) {
    let dir = path.resolve(startDir);
    for (;;) {
        try {
            await fs.lstat(path.join(dir, ".git"));
            return await fs.realpath(dir);
        } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        }
        const parent = path.dirname(dir);
        if (parent === dir) throw new Error(`no Git repository found at or above ${startDir}`);
        dir = parent;
    }
}

async function lstatOrNull(target) {
    try {
        return await fs.lstat(target);
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

/**
 * Walk the parent directories of `relPath` under `root`, rejecting any symlink or non-directory.
 * With `create`, missing directories are made one level at a time (never through a symlink).
 * Returns the parent directory's absolute path.
 */
async function walkParents(root, relPath, create) {
    const segments = relPath.split("/");
    let current = root;
    for (const segment of segments.slice(0, -1)) {
        current = path.join(current, segment);
        let stat = await lstatOrNull(current);
        if (stat === null && create) {
            try {
                await fs.mkdir(current);
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
            }
            stat = await lstatOrNull(current);
        }
        if (stat === null) return { dir: current, exists: false };
        if (stat.isSymbolicLink()) throw new Error(`refusing symlink path component: ${relPath} (${segment})`);
        if (!stat.isDirectory()) throw new Error(`path component is not a directory: ${relPath} (${segment})`);
    }
    return { dir: current, exists: true };
}

function assertContained(root, relPath) {
    const rel = path.relative(root, path.resolve(root, relPath));
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`destination escapes the repository: ${relPath}`);
    }
}

/** Decide, without writing, what persisting `content` at `relPath` would do: "create", "unchanged", or "overwrite". */
async function plan(root, file, overwrite) {
    assertContained(root, file.relPath);
    const { dir, exists } = await walkParents(root, file.relPath, false);
    if (!exists) return "create";
    const dest = path.join(dir, path.basename(file.relPath));
    const stat = await lstatOrNull(dest);
    if (stat === null) return "create";
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink destination: ${file.relPath}`);
    if (!stat.isFile()) throw new Error(`destination exists and is not a regular file: ${file.relPath}`);
    if ((await fs.readFile(dest, "utf8")) === file.content) return "unchanged";
    if (!overwrite) {
        throw new Error(`destination already exists with different content (pass overwrite:true to replace): ${file.relPath}`);
    }
    return "overwrite";
}

async function writeAtomic(root, file) {
    const { dir } = await walkParents(root, file.relPath, true);
    // Containment proof: the real parent directory is exactly where the validated path says it is.
    const expected = path.join(root, ...file.relPath.split("/").slice(0, -1));
    if ((await fs.realpath(dir)) !== expected) throw new Error(`destination parent resolved outside its path: ${file.relPath}`);
    const dest = path.join(dir, path.basename(file.relPath));
    const temp = path.join(dir, `.${path.basename(file.relPath)}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    try {
        const handle = await fs.open(temp, "wx", 0o644);
        try {
            await handle.writeFile(file.content, "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }
        const stat = await lstatOrNull(dest);
        if (stat?.isSymbolicLink()) throw new Error(`refusing symlink destination: ${file.relPath}`);
        await fs.rename(temp, dest);
    } catch (error) {
        await fs.rm(temp, { force: true });
        throw error;
    }
}

/**
 * Check every file can be persisted, without touching the disk. Throws on the first violation.
 * @param {string} root canonical Git root
 * @param {{ relPath: string, content: string }[]} files
 */
export async function preflightReportFiles(root, files, overwrite) {
    for (const file of files) await plan(root, file, overwrite);
}

/**
 * Persist report files idempotently: preflight all first, then write each via temp file + rename.
 * Identical existing content is left alone (safe replay); different content needs `overwrite`.
 * @returns {Promise<Record<string, "created" | "unchanged" | "overwritten">>} status per relPath
 */
export async function persistReportFiles(root, files, overwrite) {
    const plans = [];
    for (const file of files) plans.push(await plan(root, file, overwrite));
    const status = {};
    for (const [i, file] of files.entries()) {
        const action = plans[i];
        if (action !== "unchanged") await writeAtomic(root, file);
        status[file.relPath] = action === "create" ? "created" : action === "overwrite" ? "overwritten" : "unchanged";
    }
    return status;
}
