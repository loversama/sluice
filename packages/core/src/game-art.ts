import { readFile } from "node:fs/promises";

import { writeFileAtomic } from "./atomic-write.js";
import logger from "./logger.js";

/**
 * Box art for games we have no campaign for.
 *
 * The dashboard learned every game from the campaigns it was holding, so a game on the
 * priority list with no campaign running had no id, and no id meant no poster - the row for
 * Star Citizen sat blank whenever nobody was running a Star Citizen campaign. The art was
 * never the problem: Twitch has it, and serves it happily. We simply never asked.
 *
 * Asking is a search against Twitch's category list, which is cheap but not free, so the
 * answers are kept. A game's box art changes about as often as its name does.
 */

/** How long an entry is trusted before it is looked up again. */
export const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

export interface GameArt {
    id: string;
    /** As Twitch spells it, which is not always how the user typed it. */
    name: string;
    boxArtURL: string | null;
    /** When this was fetched. */
    at: number;
}

/** What the dashboard needs, keyed by the lowercased name it will look up. */
export type GameArtRecord = Record<string, { id: string; name: string; boxArtURL: string | null }>;

type Lookup = (name: string) => Promise<GameArt | null>;

export class GameArtCache {
    private entries = new Map<string, GameArt>();
    /** Names looked up and genuinely not found, so we stop asking every cycle. */
    private missing = new Map<string, number>();
    private inFlight = new Set<string>();

    constructor(
        private readonly path: string,
        private readonly lookup: Lookup,
    ) {}

    async load(): Promise<void> {
        try {
            const raw = await readFile(this.path, "utf8");
            const stored = JSON.parse(raw) as Record<string, GameArt>;
            for (const [key, value] of Object.entries(stored)) {
                if (value?.id) {
                    this.entries.set(key, value);
                }
            }
            logger.debug(`Loaded box art for ${this.entries.size} games.`);
        } catch {
            // No cache yet, or an unreadable one. Either way it refills itself.
        }
    }

    /**
     * Art for a name, if it is known - stale or not.
     *
     * Deliberately ignores the age. A poster from yesterday is right in every way that
     * matters here, and blanking it while a refresh is in flight would make the page flicker
     * for no gain.
     */
    get(name: string): GameArt | null {
        return this.entries.get(key(name)) ?? null;
    }

    /**
     * Make sure these names are known, fetching any that are missing or stale.
     *
     * Never throws and never blocks anything important: a lookup that fails leaves the old
     * answer in place, and the next call tries again.
     */
    async ensure(names: string[]): Promise<void> {
        const now = Date.now();
        const wanted = [...new Set(names.map(key).filter(Boolean))].filter((name) => {
            if (this.inFlight.has(name)) return false;
            const known = this.entries.get(name);
            if (known && now - known.at < REFRESH_AFTER_MS) return false;
            const absent = this.missing.get(name);
            if (absent !== undefined && now - absent < REFRESH_AFTER_MS) return false;
            return true;
        });
        if (wanted.length === 0) {
            return;
        }

        let changed = false;
        for (const name of wanted) {
            this.inFlight.add(name);
            try {
                const found = await this.lookup(name);
                if (found) {
                    this.entries.set(name, { ...found, at: Date.now() });
                    this.missing.delete(name);
                    changed = true;
                } else {
                    // Twitch has no such category. Remember that, or every refresh spends a
                    // request rediscovering it.
                    this.missing.set(name, Date.now());
                }
            } catch (error) {
                logger.debug(`Box art lookup failed for ${name}: ${String(error)}`);
            } finally {
                this.inFlight.delete(name);
            }
        }

        if (changed) {
            await this.save();
        }
    }

    /** Everything known, for the dashboard snapshot. */
    toRecord(): GameArtRecord {
        const out: GameArtRecord = {};
        for (const [name, art] of this.entries) {
            out[name] = { id: art.id, name: art.name, boxArtURL: art.boxArtURL };
        }
        return out;
    }

    private async save(): Promise<void> {
        try {
            await writeFileAtomic(this.path, JSON.stringify(Object.fromEntries(this.entries), null, 2));
        } catch (error) {
            // Losing the cache costs a few searches next time, nothing more.
            logger.debug(`Could not save box art cache: ${String(error)}`);
        }
    }
}

function key(name: string): string {
    return name.trim().toLowerCase();
}

/**
 * Pick the category that is actually the game asked for.
 *
 * A search for "Rust" also returns "Rust Console Edition" and anything else with the word in
 * it, so only an exact name match will do. Taking the first result would quietly hang the
 * wrong poster on the row, which is worse than leaving it blank.
 */
export function exactMatch(
    term: string,
    results: { id: string; name: string; boxArtURL: string | null }[],
): GameArt | null {
    const wanted = key(term);
    const hit = results.find((result) => key(result.name) === wanted);
    return hit ? { id: hit.id, name: hit.name, boxArtURL: hit.boxArtURL, at: Date.now() } : null;
}
