import { request } from "undici";

import logger from "../logger.js";
import { SteamError, type OwnedGame } from "./client.js";
import { CLIENT_TOKEN, VERSION } from "../version.js";

/**
 * Why a library fetch failed, when the reason changes what the user should do about it.
 *
 * Everything else is a plain {@link SteamError} - retried on the next cycle with the cached
 * library still in use.
 */
export type LibraryErrorCode =
    | "library_private"
    | "client_outdated"
    | "rate_limited"
    | "unavailable";

export class LibraryError extends SteamError {
    /** Where the user should go to fix it, when there is such a place. */
    readonly actionUrl?: string;
    /** Seconds the broker asked us to wait, when it said. */
    readonly retryAfterSeconds?: number;

    constructor(
        message: string,
        readonly code: LibraryErrorCode,
        options: { actionUrl?: string; retryAfterSeconds?: number } = {},
    ) {
        super(message);
        this.actionUrl = options.actionUrl;
        this.retryAfterSeconds = options.retryAfterSeconds;
    }
}

export interface LibrarySnapshot {
    steamId: string;
    personaName: string;
    games: OwnedGame[];
    /** Unix ms of the fetch that produced this data, which may predate the request. */
    fetchedAt: number;
    /** True when the broker served cached data because Steam was unreachable. */
    stale?: boolean;
}

/** Who an account is, without touching the library. Enough to confirm a link. */
export interface SteamSummary {
    steamId: string;
    personaName: string;
    avatarUrl: string | null;
    /** False when the profile itself is private, so nothing else will be readable either. */
    visible: boolean;
    fetchedAt: number;
    stale: boolean;
}

export interface LibraryProvider {
    fetchLibrary(): Promise<LibrarySnapshot>;
    /** Human label for logs and the dashboard. */
    readonly label: string;
}

/** Steam is unreachable often enough that "no games" needs saying properly. */
const PRIVATE_LIBRARY_MESSAGE =
    "Steam returned no games. Set 'Game details' to Public in your Steam privacy settings.";

/** Where "Game details" lives, for every error that comes down to that setting. */
const STEAM_PRIVACY_URL = "https://steamcommunity.com/my/edit/settings";

export const DEFAULT_BROKER_BASE_URL = "https://sinfulshadows.com";

/** Every non-200 the broker returns shares this shape. */
interface BrokerError {
    error?: string;
    message?: string;
}

interface LibraryResponse {
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

interface SummaryResponse {
    steamId: string;
    personaName: string;
    avatarUrl: string | null;
    visible: boolean;
    fetchedAt: number;
    stale: boolean;
}

/** `Retry-After` in seconds, or undefined if the broker did not send a usable one. */
function retryAfterOf(headers: Record<string, string | string[] | undefined>): number | undefined {
    const raw = headers["retry-after"];
    const value = Number(Array.isArray(raw) ? raw[0] : raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Read Steam through the broker on sinfulshadows.com.
 *
 * The user supplies no key of any kind - only which account is theirs. The broker holds one
 * Steam key, caches what it reads and rate-limits per IP, which is what makes serving every
 * copy of Sluice from a single key tenable.
 *
 * A Steam ID identifies a public profile and nothing more, so there is no secret here to
 * get wrong: the broker will only ever return what the account has already made public.
 */
export class BrokerProvider implements LibraryProvider {
    readonly label = "Steam";

    constructor(
        private readonly steamId: string,
        private readonly baseUrl: string = DEFAULT_BROKER_BASE_URL,
        private readonly clientToken: string = CLIENT_TOKEN,
    ) {}

    private url(path: string): string {
        const query = new URLSearchParams({ steamId: this.steamId });
        return `${this.baseUrl.replace(/\/+$/, "")}/api/v1/sluice/steam/${path}?${query}`;
    }

    private async get(path: string): Promise<unknown> {
        let response;
        try {
            response = await request(this.url(path), {
                method: "GET",
                headers: {
                    // Says which build is calling; see CLIENT_TOKEN. Not a credential, and
                    // never logged.
                    "X-Sluice-Client": this.clientToken,
                    "user-agent": `sluice/${VERSION}`,
                    accept: "application/json",
                },
                headersTimeout: 15_000,
                bodyTimeout: 15_000,
            });
        } catch (error) {
            throw new LibraryError(
                `Could not reach the Steam service: ${(error as Error).message}`,
                "unavailable",
            );
        }

        const status = response.statusCode;
        let body: BrokerError | null = null;
        try {
            body = (await response.body.json()) as BrokerError;
        } catch {
            await response.body.dump().catch(() => {});
        }

        if (status === 200) {
            // Read before the charge for this request, so it is the headroom that was there
            // a moment ago rather than what is left now. Only ever worth a debug line.
            const remaining = response.headers["x-ratelimit-remaining"];
            if (remaining !== undefined) {
                logger.debug(`Steam service quota remaining: ${String(remaining)}`);
            }
            return body;
        }

        // The header is authoritative: the body's retryAfter is a convenience copy, and a
        // proxy in between can change one without the other.
        const retryAfterSeconds = retryAfterOf(response.headers);
        const message = body?.message ?? `The Steam service returned ${status}.`;

        // 401 means the broker does not know this token; 426 means it knows it and has
        // stopped answering to it. Either way this build is the thing that is out of date,
        // and updating is the only fix the user has.
        if (status === 401 || status === 426) {
            throw new LibraryError(
                "This version of Sluice can no longer read Steam. Update to the latest release.",
                "client_outdated",
            );
        }
        if (status === 409) {
            // The broker names the exact Steam setting in its message, so pass it through
            // rather than paraphrasing it here.
            throw new LibraryError(message, "library_private", { actionUrl: STEAM_PRIVACY_URL });
        }
        if (status === 429) {
            throw new LibraryError(message, "rate_limited", { retryAfterSeconds });
        }
        // Everything left - a malformed Steam ID, a profile Steam has never heard of, Steam
        // itself being down - is retryable in the sense that matters here: the cached
        // library stays in use and the next cycle tries again. The broker's own message is
        // what distinguishes them for the user.
        throw new LibraryError(message, "unavailable", { retryAfterSeconds });
    }

    /** Who this Steam ID belongs to. Cheap, and unaffected by the library being private. */
    async fetchSummary(): Promise<SteamSummary> {
        const body = (await this.get("summary")) as SummaryResponse;
        return {
            steamId: body.steamId ?? this.steamId,
            personaName: body.personaName ?? "",
            avatarUrl: body.avatarUrl ?? null,
            visible: body.visible ?? false,
            fetchedAt: body.fetchedAt ?? Date.now(),
            stale: body.stale ?? false,
        };
    }

    async fetchLibrary(): Promise<LibrarySnapshot> {
        const body = (await this.get("library")) as LibraryResponse;
        const games: OwnedGame[] = (body.games ?? []).map((game) => ({
            appid: game.appid,
            name: game.name,
            playtimeForever: game.playtimeForever ?? 0,
            playtimeRecent: game.playtimeRecent ?? 0,
            lastPlayed: game.lastPlayed ?? 0,
        }));

        if (games.length === 0) {
            // Steam answers a private profile with an empty list rather than an error, and
            // the broker forwards what it got. Owning nothing looks identical, so say what
            // to check instead of reporting a library of zero games.
            throw new LibraryError(PRIVATE_LIBRARY_MESSAGE, "library_private", {
                actionUrl: STEAM_PRIVACY_URL,
            });
        }
        if (body.stale) {
            // Real data, just old - Steam was unreachable and a cached copy was served. Not
            // worth telling the user about; it only shortens the wait before the next try.
            logger.debug("The Steam service served a cached library - Steam was unreachable.");
        }

        return {
            steamId: body.steamId ?? this.steamId,
            personaName: body.personaName ?? "",
            games,
            // Keep the broker's own timestamp: treating cached data as a fresh sync would
            // delay the retry by a full refresh interval.
            fetchedAt: body.fetchedAt ?? Date.now(),
            stale: body.stale,
        };
    }
}
