import { createHash } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * Reward art on disk, because a native notification will not fetch one.
 *
 * Windows and Linux both want a local file for a notification icon - a URL is simply
 * ignored, and the notification appears with the app's own icon or none at all. The art is
 * the most recognisable part of a claim, so it is worth a download.
 *
 * Cached by URL: the same reward is claimed repeatedly across a campaign's tiers, and on a
 * busy account the same handful of images would otherwise be fetched dozens of times a day.
 */

/** Small files, but not unbounded: a year of claims should not fill a disk. */
const MAX_FILES = 200;

const EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function nameFor(url: string): string {
    const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
    const suffix = extname(new URL(url).pathname).toLowerCase();
    return `${hash}${EXTENSIONS.has(suffix) ? suffix : ".png"}`;
}

export class IconCache {
    constructor(private readonly dir: string) {}

    /**
     * A local path for the art, or null if it cannot be had.
     *
     * Never throws. A notification without its picture is a great deal better than a claim
     * that goes unannounced because a CDN was slow.
     */
    async pathFor(url: string | null | undefined): Promise<string | null> {
        if (!url || !/^https?:\/\//i.test(url)) return null;

        try {
            const target = join(this.dir, nameFor(url));
            if (existsSync(target)) return target;

            await mkdir(this.dir, { recursive: true });
            const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!response.ok) return null;

            const body = Buffer.from(await response.arrayBuffer());
            // Guard against a CDN handing back an error page with a 200.
            if (body.byteLength < 64 || body.byteLength > 4_000_000) return null;

            await writeFile(target, body);
            void this.prune();
            return target;
        } catch {
            return null;
        }
    }

    /** Oldest first, once there are more than a campaign's worth. */
    private async prune(): Promise<void> {
        try {
            const names = await readdir(this.dir);
            if (names.length <= MAX_FILES) return;

            const entries = await Promise.all(
                names.map(async (name) => {
                    const path = join(this.dir, name);
                    return { path, at: (await stat(path)).mtimeMs };
                }),
            );
            entries.sort((a, b) => a.at - b.at);
            await Promise.all(
                entries.slice(0, entries.length - MAX_FILES).map((entry) => unlink(entry.path)),
            );
        } catch {
            /* A cache that cannot be tidied is still a working cache. */
        }
    }
}
