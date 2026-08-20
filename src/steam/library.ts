import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import logger from "../logger.js";
import { findBestMatch } from "./matching.js";
import type { OwnedGame, SteamClient } from "./client.js";

export interface StoredLibrary {
    steamId: string;
    personaName: string;
    /** Unix ms of the last successful fetch. */
    fetchedAt: number;
    games: OwnedGame[];
}

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

    get isLoaded(): boolean {
        return this.games.length > 0;
    }

    get size(): number {
        return this.games.length;
    }

    get all(): readonly OwnedGame[] {
        return this.games;
    }

    async load(path: string): Promise<boolean> {
        try {
            const stored = JSON.parse(await readFile(path, "utf8")) as StoredLibrary;
            this.steamId = stored.steamId;
            this.personaName = stored.personaName;
            this.fetchedAt = stored.fetchedAt;
            this.games = stored.games ?? [];
            this.matchCache.clear();
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
        };
        await writeFile(path, JSON.stringify(stored, null, 2));
    }

    /** Pull the library from Steam and replace what we hold. */
    async refresh(client: SteamClient, steamId: string): Promise<number> {
        const games = await client.getOwnedGames(steamId);
        if (games.length === 0) {
            // Steam returns an empty list for a private profile, indistinguishable from
            // owning nothing - so say what to check rather than reporting zero games.
            throw new Error(
                "Steam returned no games. Set 'Game details' to Public in your Steam privacy " +
                    "settings, and check the API key belongs to this account.",
            );
        }
        const profile = await client.getProfile(steamId).catch(() => null);

        this.games = games;
        this.steamId = steamId;
        this.personaName = profile?.personaName ?? this.personaName;
        this.fetchedAt = Date.now();
        this.matchCache.clear();
        logger.info(`Steam library: ${games.length} games for ${this.personaName || steamId}`);
        return games.length;
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
            // Fall back to total playtime when a game has never been launched, so owned but
            // unplayed titles still sort above unowned ones.
            return game.lastPlayed > 0 ? game.lastPlayed : 1;
        }
        return game.playtimeForever > 0 ? game.playtimeForever : 1;
    }
}
