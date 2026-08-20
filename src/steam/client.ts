import { request } from "undici";

import logger from "../logger.js";

export class SteamError extends Error {}

const API_BASE = "https://api.steampowered.com";

export interface OwnedGame {
    appid: number;
    name: string;
    /** Total minutes played, as recorded since Steam began tracking in 2009. */
    playtimeForever: number;
    /** Minutes played in the last two weeks. */
    playtimeRecent: number;
    /**
     * Unix seconds of the last session, or 0 if never played.
     *
     * NOTE: Steam exposes no purchase or "added to library" date - this is the closest
     * available recency signal. It is also only returned when the API key belongs to the
     * account being queried.
     */
    lastPlayed: number;
}

export interface SteamProfile {
    steamId: string;
    personaName: string;
    avatarUrl: string | null;
    profileUrl: string;
}

/**
 * Minimal Steam Web API client.
 *
 * A Web API key is required for every call here and belongs to the user - it is obtained at
 * https://steamcommunity.com/dev/apikey. Steam sign-in alone establishes identity but grants
 * no access to the library, so the key cannot be avoided.
 */
export class SteamClient {
    constructor(private readonly apiKey: string) {}

    private async get<T>(path: string, params: Record<string, string>): Promise<T> {
        const query = new URLSearchParams({ key: this.apiKey, ...params });
        const response = await request(`${API_BASE}${path}?${query}`, { method: "GET" });

        if (response.statusCode === 401 || response.statusCode === 403) {
            await response.body.dump();
            throw new SteamError("Steam rejected the API key. Check it at steamcommunity.com/dev/apikey.");
        }
        if (response.statusCode !== 200) {
            await response.body.dump();
            throw new SteamError(`Steam returned ${response.statusCode} for ${path}`);
        }
        return (await response.body.json()) as T;
    }

    /**
     * Every game on the account.
     *
     * Returns an empty list when the profile's game details are private, which is not
     * distinguishable from owning nothing - callers should treat empty as "cannot see".
     */
    async getOwnedGames(steamId: string): Promise<OwnedGame[]> {
        const data = await this.get<{
            response: {
                game_count?: number;
                games?: {
                    appid: number;
                    name?: string;
                    playtime_forever?: number;
                    playtime_2weeks?: number;
                    rtime_last_played?: number;
                }[];
            };
        }>("/IPlayerService/GetOwnedGames/v1/", {
            steamid: steamId,
            include_appinfo: "1",
            include_played_free_games: "1",
        });

        const games = data.response?.games ?? [];
        logger.debug(`Steam library: ${games.length} games`);
        return games
            .filter((game) => game.name)
            .map((game) => ({
                appid: game.appid,
                name: game.name!,
                playtimeForever: game.playtime_forever ?? 0,
                playtimeRecent: game.playtime_2weeks ?? 0,
                lastPlayed: game.rtime_last_played ?? 0,
            }));
    }

    async getProfile(steamId: string): Promise<SteamProfile | null> {
        const data = await this.get<{
            response: {
                players?: {
                    steamid: string;
                    personaname: string;
                    avatarmedium?: string;
                    profileurl: string;
                }[];
            };
        }>("/ISteamUser/GetPlayerSummaries/v2/", { steamids: steamId });

        const player = data.response?.players?.[0];
        if (!player) {
            return null;
        }
        return {
            steamId: player.steamid,
            personaName: player.personaname,
            avatarUrl: player.avatarmedium ?? null,
            profileUrl: player.profileurl,
        };
    }

    /** Turn a custom profile name (steamcommunity.com/id/<name>) into a 64-bit Steam ID. */
    async resolveVanityUrl(vanity: string): Promise<string | null> {
        const data = await this.get<{ response: { success: number; steamid?: string } }>(
            "/ISteamUser/ResolveVanityURL/v1/",
            { vanityurl: vanity },
        );
        return data.response?.success === 1 ? (data.response.steamid ?? null) : null;
    }
}

/**
 * Accept whatever the user pastes: a bare 64-bit ID, a /profiles/ URL, a /id/ vanity URL, or
 * a bare vanity name. Vanity forms need an API round-trip to resolve.
 */
export async function resolveSteamId(input: string, client: SteamClient): Promise<string> {
    const trimmed = input.trim();

    if (/^\d{17}$/.test(trimmed)) {
        return trimmed;
    }

    const profileMatch = trimmed.match(/steamcommunity\.com\/profiles\/(\d{17})/);
    if (profileMatch?.[1]) {
        return profileMatch[1];
    }

    const vanityMatch = trimmed.match(/steamcommunity\.com\/id\/([^/?#]+)/);
    const vanity = vanityMatch?.[1] ?? (/^[\w.-]+$/.test(trimmed) ? trimmed : null);
    if (vanity) {
        const resolved = await client.resolveVanityUrl(vanity);
        if (resolved) {
            return resolved;
        }
        throw new SteamError(`Could not resolve "${vanity}" to a Steam account.`);
    }

    throw new SteamError("Enter a Steam ID, profile URL, or custom URL name.");
}
