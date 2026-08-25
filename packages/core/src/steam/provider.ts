import { request } from "undici";

import logger from "../logger.js";
import { SteamClient, SteamError, type OwnedGame } from "./client.js";
import { VERSION } from "../version.js";

/**
 * Why a library fetch failed, when the reason changes what the user should do about it.
 *
 * Everything else is a plain {@link SteamError} - retried on the next cycle with the cached
 * library still in use.
 */
export type LibraryErrorCode =
    | "key_invalid"
    | "steam_not_linked"
    | "library_private"
    | "rate_limited"
    | "unavailable";

export class LibraryError extends SteamError {
    constructor(
        message: string,
        readonly code: LibraryErrorCode,
        /** Where the user should go to fix it, when there is such a place. */
        readonly actionUrl?: string,
    ) {
        super(message);
    }
}

export interface LibrarySnapshot {
    steamId: string;
    personaName: string;
    games: OwnedGame[];
    /** Unix ms of the fetch that produced this data, which may predate the request. */
    fetchedAt: number;
    /** True when the provider served cached data because Steam was unreachable. */
    stale?: boolean;
}

export interface LibraryProvider {
    fetchLibrary(): Promise<LibrarySnapshot>;
    /** Human label for logs and the dashboard. */
    readonly label: string;
}

/** Steam is unreachable often enough that "no games" needs saying properly. */
const PRIVATE_LIBRARY_MESSAGE =
    "Steam returned no games. Set 'Game details' to Public in your Steam privacy settings, " +
    "and check the API key belongs to this account.";

/** The user's own Steam Web API key, talking to Steam directly. */
export class DirectSteamProvider implements LibraryProvider {
    readonly label = "Steam (your API key)";

    constructor(
        private readonly client: SteamClient,
        private readonly steamId: string,
    ) {}

    async fetchLibrary(): Promise<LibrarySnapshot> {
        const games = await this.client.getOwnedGames(this.steamId);
        if (games.length === 0) {
            // An empty list is what Steam returns for a private profile, which is not
            // distinguishable from owning nothing - so say what to check instead.
            throw new LibraryError(PRIVATE_LIBRARY_MESSAGE, "library_private");
        }
        const profile = await this.client.getProfile(this.steamId).catch(() => null);
        return {
            steamId: this.steamId,
            personaName: profile?.personaName ?? "",
            games,
            fetchedAt: Date.now(),
        };
    }
}

interface ProxyResponse {
    steamId: string;
    personaName: string;
    fetchedAt: number;
    stale: boolean;
    games: {
        appid: number;
        name: string;
        playtimeForever: number;
        playtimeRecent: number;
        lastPlayed: number;
    }[];
}

export const DEFAULT_SINFULSHADOWS_BASE_URL = "https://sinfulshadows.com";

/**
 * Read the library through SinfulShadows, which holds the Steam key.
 *
 * There is no Steam ID to supply: the endpoint serves only the Steam account the key's owner
 * has linked on the site, so identity comes from the key. That is also what keeps the site
 * from becoming an open proxy for reading strangers' libraries.
 */
export class SinfulShadowsProvider implements LibraryProvider {
    readonly label = "SinfulShadows";

    constructor(
        private readonly apiKey: string,
        private readonly baseUrl: string = DEFAULT_SINFULSHADOWS_BASE_URL,
    ) {}

    private url(path: string): string {
        return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
    }

    private async get(path: string): Promise<unknown> {
        let response;
        try {
            response = await request(this.url(path), {
                method: "GET",
                headers: {
                    authorization: `Bearer ${this.apiKey}`,
                    "user-agent": `twitch-drops-bot/${VERSION}`,
                    accept: "application/json",
                },
                headersTimeout: 15_000,
                bodyTimeout: 15_000,
            });
        } catch (error) {
            throw new LibraryError(
                `Could not reach SinfulShadows: ${(error as Error).message}`,
                "unavailable",
            );
        }

        const status = response.statusCode;
        let body: any = null;
        try {
            body = await response.body.json();
        } catch {
            await response.body.dump().catch(() => {});
        }

        if (status === 200) {
            return body;
        }

        const message: string = body?.message ?? `SinfulShadows returned ${status}.`;

        if (status === 401 || status === 403) {
            throw new LibraryError(
                body?.error === "insufficient_scope"
                    ? "This SinfulShadows key lacks the steam:library scope. Create a new one."
                    : "SinfulShadows rejected the API key - it may have been revoked. Create a new one.",
                "key_invalid",
                `${this.baseUrl}/settings/api`,
            );
        }
        if (status === 429) {
            throw new LibraryError(message, "rate_limited");
        }
        if (body?.error === "steam_not_linked") {
            throw new LibraryError(
                "No Steam account is linked to your SinfulShadows account. Link it, then retry.",
                "steam_not_linked",
                `${this.baseUrl}/settings/connections`,
            );
        }
        if (body?.error === "library_private") {
            throw new LibraryError(message, "library_private");
        }
        throw new LibraryError(message, "unavailable");
    }

    /** Confirm the key works and report whose library it will return. */
    async verify(): Promise<{ userId: number; steamLinked: boolean; personaName: string }> {
        const body = (await this.get("/api/v1/me")) as any;
        return {
            userId: body?.userId ?? 0,
            steamLinked: Boolean(body?.steam?.linked),
            personaName: body?.steam?.personaName ?? "",
        };
    }

    async fetchLibrary(): Promise<LibrarySnapshot> {
        const body = (await this.get("/api/v1/steam/library")) as ProxyResponse;
        const games: OwnedGame[] = (body.games ?? []).map((game) => ({
            appid: game.appid,
            name: game.name,
            playtimeForever: game.playtimeForever ?? 0,
            playtimeRecent: game.playtimeRecent ?? 0,
            lastPlayed: game.lastPlayed ?? 0,
        }));

        if (games.length === 0) {
            throw new LibraryError(PRIVATE_LIBRARY_MESSAGE, "library_private");
        }
        if (body.stale) {
            logger.warn("SinfulShadows served a cached Steam library - Steam was unreachable.");
        }

        return {
            steamId: body.steamId,
            personaName: body.personaName ?? "",
            games,
            // Keep the provider's own timestamp: treating cached data as a fresh sync would
            // delay the retry by a full refresh interval.
            fetchedAt: body.fetchedAt ?? Date.now(),
            stale: body.stale,
        };
    }
}
