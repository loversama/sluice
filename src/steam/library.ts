import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import logger from "../logger.js";
import { findBestMatch } from "./matching.js";
import type { OwnedGame } from "./client.js";
import type { LibraryProvider } from "./provider.js";

export interface StoredLibrary {
    steamId: string;
    personaName: string;
    /** Unix ms of the last successful fetch. */
    fetchedAt: number;
    games: OwnedGame[];
    /** True when the data came from a provider's cache rather than live from Steam. */
    stale?: boolean;
}

/**
 * Which field the "recently played" ranking can actually use.
 *
 * Steam only fills in a last-played timestamp when the querying API key belongs to the
 * account being queried, so a library read through a shared key has none. Two-week playtime
 * is returned either way, and total playtime always exists - so the mode degrades rather
 * than collapsing into "owned or not".
 */
export type RecencyBasis = "lastPlayed" | "playtimeRecent" | "playtimeForever";

/**
 * The user's Steam library, cached on disk and matched against Twitch category names.
 *
 * Libraries change rarely, so this is refreshed on a slow cadence rather than per cycle; the
 * name-match result is memoised because matching runs for every campaign on every ranking.
 */
export class SteamLibrary {
    private games: OwnedGame[] = [];
    private matchCache = new Map<string, OwnedGame | null>();

    steamId = "";
    personaName = "";
    fetchedAt = 0;
    stale = false;

    private recencyBasis: RecencyBasis = "lastPlayed";

    /** Which signal `score(.., "recent")` is currently ranking on. */
    get recencySignal(): RecencyBasis {
        return this.recencyBasis;
    }

    /**
     * Pick the best recency signal the data actually supports.
     *
     * Mixing them would be worse than picking one: a unix timestamp and a minute count are
     * not comparable, so a library where only some games carry a timestamp must still rank
     * on a single field.
     */
    private chooseRecencyBasis(): void {
        if (this.games.some((game) => game.lastPlayed > 0)) {
            this.recencyBasis = "lastPlayed";
        } else if (this.games.some((game) => game.playtimeRecent > 0)) {
            this.recencyBasis = "playtimeRecent";
        } else {
            this.recencyBasis = "playtimeForever";
        }
    }

    get isLoaded(): boolean {
        return this.games.length > 0;
    }

    get size(): number {
        return this.games.length;
    }

    get all(): readonly OwnedGame[] {
        return this.games;
    }

    /**
     * Forget the library entirely.
     *
     * Every derived value has to go with it: a stale match cache would keep answering for
     * games that are no longer owned, and the recency basis was chosen from data that is
     * no longer here.
     */
    clear(): void {
        this.games = [];
        this.steamId = "";
        this.personaName = "";
        this.fetchedAt = 0;
        this.stale = false;
        this.matchCache.clear();
        this.recencyBasis = "lastPlayed";
    }

    /**
     * Replace what we hold with what is on disk, or with nothing if that fails.
     *
     * Clearing first is the point. This used to return false and leave the previous
     * contents in place, so signing in as a second account whose library had never been
     * fetched kept the first account's games - silently driving ownership gating and
     * playtime ranking from a library belonging to someone else.
     */
    async load(path: string): Promise<boolean> {
        this.clear();
        try {
            const stored = JSON.parse(await readFile(path, "utf8")) as StoredLibrary;
            this.steamId = stored.steamId;
            this.personaName = stored.personaName;
            this.fetchedAt = stored.fetchedAt;
            this.games = stored.games ?? [];
            this.stale = stored.stale ?? false;
            this.matchCache.clear();
            this.chooseRecencyBasis();
            logger.debug(`Loaded ${this.games.length} Steam games from cache`);
            return true;
        } catch {
            return false;
        }
    }

    async save(path: string): Promise<void> {
        await mkdir(dirname(path), { recursive: true });
        const stored: StoredLibrary = {
            steamId: this.steamId,
            personaName: this.personaName,
            fetchedAt: this.fetchedAt,
            games: this.games,
            stale: this.stale,
        };
        await writeFile(path, JSON.stringify(stored, null, 2));
    }

    /** Pull the library from whichever provider is configured and replace what we hold. */
    async refresh(provider: LibraryProvider): Promise<number> {
        const snapshot = await provider.fetchLibrary();

        this.games = snapshot.games;
        this.steamId = snapshot.steamId;
        this.personaName = snapshot.personaName || this.personaName;
        // The provider's timestamp, not now: cached data must look as old as it is, so the
        // next cycle retries instead of resting on it for a full refresh interval.
        this.fetchedAt = snapshot.fetchedAt;
        this.stale = snapshot.stale ?? false;
        this.matchCache.clear();
        this.chooseRecencyBasis();

        const via = `via ${provider.label}${snapshot.stale ? ", cached" : ""}`;
        logger.info(
            `Steam library: ${this.games.length} games for ${this.personaName || this.steamId} (${via})`,
        );
        return this.games.length;
    }

    /** The owned game corresponding to a Twitch category, or null if not owned. */
    match(twitchGameName: string): OwnedGame | null {
        const cached = this.matchCache.get(twitchGameName);
        if (cached !== undefined) {
            return cached;
        }
        const found = findBestMatch(twitchGameName, this.games);
        this.matchCache.set(twitchGameName, found);
        return found;
    }

    owns(twitchGameName: string): boolean {
        return this.match(twitchGameName) !== null;
    }

    /**
     * Ranking weight for a Twitch category, higher being more wanted.
     *
     * Owning a game always outranks not owning it, so an unplayed purchase still beats a game
     * the user has never touched. Within owned games, the chosen signal breaks the tie.
     */
    score(twitchGameName: string, by: "playtime" | "recent"): number {
        const game = this.match(twitchGameName);
        if (!game) {
            return 0;
        }
        if (by === "recent") {
            // Fall back to 1 for a game with no signal at all, so an owned but unplayed title
            // still sorts above an unowned one.
            const value =
                this.recencyBasis === "lastPlayed"
                    ? game.lastPlayed
                    : this.recencyBasis === "playtimeRecent"
                      ? game.playtimeRecent
                      : game.playtimeForever;
            return value > 0 ? value : 1;
        }
        return game.playtimeForever > 0 ? game.playtimeForever : 1;
    }
}
