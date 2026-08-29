import type { EventEmitter } from "node:events";

import type { Config } from "../config.js";
import type { Miner } from "../miner.js";
import type { AuthState } from "../twitch/auth.js";
import type { NotifierGroup } from "../notifiers/index.js";
import type { SteamLibrary } from "../steam/library.js";

export interface DeviceCodeInfo {
    code: string;
    url: string;
    expiresAt: number;
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
    searchGames(term: string): Promise<{ id: string; name: string; boxArtURL: string | null }[]>;
    /** Box art for games with no campaign running, keyed by lowercased name. */
    getGameArt(): Record<string, { id: string; name: string; boxArtURL: string | null }>;
    /** Store credentials and pull the library. Returns the number of games found. */
    connectSteam(input: {
        provider?: "direct" | "sinfulshadows";
        apiKey?: string;
        steamId?: string;
        sinfulshadowsApiKey?: string;
    }): Promise<number>;
    /** Revoke the Twitch token, drop the credentials, and restart into the login screen. */
    logout(): Promise<{ revoked: boolean }>;
    refreshSteam(): Promise<number>;
    disconnectSteam(): Promise<void>;
}
