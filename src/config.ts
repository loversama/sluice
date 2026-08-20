import { readFile, writeFile } from "node:fs/promises";

import type { LogLevel } from "./logger.js";

export interface Config {
    /**
     * Games to mine, most wanted first. Accepts display names ("Rust") or numeric game IDs.
     * An empty list means "any game with an active campaign".
     */
    priorityGames: string[];
    /** Games to never mine, even when `mineUnlistedGames` is true. */
    excludedGames: string[];
    /** Mine campaigns for games outside `priorityGames`. */
    mineUnlistedGames: boolean;
    /** Preferred channels, tried before searching the game directory. */
    preferredChannels: string[];
    /** Minutes between full campaign refreshes. */
    campaignRefreshMinutes: number;
    /**
     * Work on campaigns that cannot realistically be finished before they expire.
     * Campaigns are sometimes extended, so this defaults to on.
     */
    attemptImpossibleCampaigns: boolean;
    /** Claim drops automatically once they are ready. */
    autoClaimDrops: boolean;
    /** Claim channel points bonuses while watching. */
    autoClaimPoints: boolean;
    /** Warn when a campaign's rewards will not reach the game because accounts are unlinked. */
    warnUnlinkedAccounts: boolean;
    logLevel: LogLevel;
    notifications: {
        telegram?: { botToken: string; chatId: string };
        discord?: { webhookUrl: string };
    };
}

export const DEFAULT_CONFIG: Config = {
    priorityGames: [],
    excludedGames: [],
    mineUnlistedGames: true,
    preferredChannels: [],
    campaignRefreshMinutes: 20,
    attemptImpossibleCampaigns: true,
    autoClaimDrops: true,
    autoClaimPoints: true,
    warnUnlinkedAccounts: true,
    logLevel: "info",
    notifications: {},
};

/** Load config from disk, writing a default file if none exists. */
export async function loadConfig(path: string): Promise<Config> {
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch {
        await writeFile(path, `${JSON.stringify(DEFAULT_CONFIG, null, 4)}\n`);
        return { ...DEFAULT_CONFIG };
    }

    let parsed: Partial<Config>;
    try {
        parsed = JSON.parse(raw) as Partial<Config>;
    } catch (error) {
        throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
    }

    const config: Config = {
        ...DEFAULT_CONFIG,
        ...parsed,
        notifications: { ...DEFAULT_CONFIG.notifications, ...(parsed.notifications ?? {}) },
    };

    if (config.campaignRefreshMinutes < 5) {
        // Polling harder than this risks rate limiting without finding campaigns any sooner.
        config.campaignRefreshMinutes = 5;
    }
    return config;
}

/** Persist config back to disk after an API edit. */
export async function saveConfig(path: string, config: Config): Promise<void> {
    await writeFile(path, `${JSON.stringify(config, null, 4)}\n`);
}
