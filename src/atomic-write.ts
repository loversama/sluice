import { writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Write a file so a reader never sees it half-written.
 *
 * Every persisted file here is rewritten whole on each change, so a process killed
 * mid-write leaves a truncated file rather than a stale one. Most of them degrade quietly -
 * a broken claims.json simply reads as no history - which is precisely why it is worth
 * avoiding: the loss is silent.
 *
 * Writing to a sibling and renaming makes the swap atomic. `rename` replaces an existing
 * file on POSIX and, on Windows, maps to MoveFileEx with MOVEFILE_REPLACE_EXISTING, so the
 * behaviour holds on both. The temporary file sits in the same directory deliberately: a
 * rename across filesystems is a copy, and would lose the atomicity that is the whole point.
 */
export async function writeFileAtomic(
    path: string,
    contents: string,
    options: { mode?: number } = {},
): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    try {
        await writeFile(temporary, contents, options.mode ? { mode: options.mode } : undefined);
        await rename(temporary, path);
    } catch (error) {
        // Leaving a stray .tmp behind would be picked up by nothing and cleaned by nobody.
        await unlink(temporary).catch(() => {});
        throw error;
    }
}
