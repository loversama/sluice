import type { EventEmitter } from "node:events";

import type { Config, SteamLinkState } from "../config.js";
import type { Miner } from "../miner.js";
import type { AuthState } from "../twitch/auth.js";
import type { NotifierGroup } from "../notifiers/index.js";
import type { RecencyBasis, SteamLibrary } from "../steam/library.js";

export interface DeviceCodeInfo {
    code: string;
    url: string;
    expiresAt: number;
}

/**
 * Everything the dashboard knows about Steam, in one shape.
 *
 * Served by `GET /api/steam`, carried in the state snapshot, and emitted as the `steam`
 * event whenever any of it changes - the same object all three times, so a page cannot end
 * up believing two different things depending on how it heard.
 */
export interface SteamState {
    /** Null means the user has not been asked yet, which is what shows onboarding. */
    linked: SteamLinkState | null;
    steamId: string | null;
    personaName: string | null;
    gameCount: number;
    /**
     * Which signal the "recently played" ranking can use. Never "lastPlayed" through the
     * broker: Steam only reveals last-played times to a key that owns the account.
     */
    recencySignal: RecencyBasis | null;
    /** The library came from a cache because Steam was unreachable. Real data, just old. */
    stale: boolean;
    /** ISO time the data left Steam, not when it was served. */
    fetchedAt: string | null;
    /** Why the last read failed, or null if it did not. */
    lastError: { code: string; message: string } | null;
}

/** The outcome of linking an account: the link and the library are separate things. */
export interface SteamConnectResult {
    personaName: string;
    gameCount: number;
    /**
     * Set when the account linked but its library could not be read - a private profile,
     * most often. The link still stands, so this is reported rather than thrown.
     */
    error: { code: string; message: string } | null;
}

/**
 * Everything the API needs from the running application. Passed as accessors rather than
 * values because the server starts before login finishes and before the miner exists.
 */
export interface ServerContext {
    auth: AuthState;
    version: string;
    startedAt: number;
    /** Event bus carrying miner events; the server relays these to SSE clients. */
    bus: EventEmitter;
    getAuthStatus(): "pending" | "ok";
    getDeviceCode(): DeviceCodeInfo | null;
    getMiner(): Miner | null;
    getConfig(): Config;
    setConfig(config: Config): Promise<void>;
    getNotifier(): NotifierGroup;
    getSteamLibrary(): SteamLibrary | null;
    /** Link state, persona, library size and the last failure, for the API and the bus. */
    getSteamState(): SteamState;
    searchGames(term: string): Promise<{ id: string; name: string; boxArtURL: string | null }[]>;
    /** Box art for games with no campaign running, keyed by lowercased name. */
    getGameArt(): Record<string, { id: string; name: string; boxArtURL: string | null }>;
    /**
     * Remember which Steam account is the user's, and read its library.
     *
     * Throws only when the account cannot be identified at all. A library that will not
     * come back comes back in the result: the link is established either way, and telling
     * someone their sign-in failed because their profile is private would be a lie.
     */
    connectSteam(input: {
        steamId: string;
        /** How it was identified, which the dashboard shows and onboarding depends on. */
        via: Exclude<SteamLinkState, "skipped">;
    }): Promise<SteamConnectResult>;
    /** Record that the user declined to link Steam, so they are not asked again. */
    skipSteam(): Promise<void>;
    /** Revoke the Twitch token, drop the credentials, and restart into the login screen. */
    logout(): Promise<{ revoked: boolean }>;
    refreshSteam(): Promise<number>;
    disconnectSteam(): Promise<void>;
}
