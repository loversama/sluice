import { readFile, writeFile } from "node:fs/promises";

import type { LogLevel } from "./logger.js";
import type { PriorityMode } from "./models/campaign.js";

/**
 * How unlinked campaigns are treated.
 *
 * "ownedOrChosen" is the useful middle: mining an unlinked campaign is only worth the time
 * if the user would plausibly go and link it, and the honest signals for that are owning the
 * game on Steam or having named it in the priority list. Everything else is watch time spent
 * on a reward nobody intends to collect.
 */
export type UnlinkedPolicy = "mine" | "skip" | "ownedOrChosen";

export interface Config {
    /**
     * Games to mine, most wanted first. Accepts display names ("Rust") or numeric game IDs.
     * An empty list means "any game with an active campaign".
     */
    priorityGames: string[];
    /** Games to never mine, whatever the priority mode says. */
    excludedGames: string[];
    /**
     * How campaigns outside `priorityGames` are ordered against each other.
     * "priority_only" mines nothing outside the list.
     */
    priorityMode: PriorityMode;
    /**
     * @deprecated Superseded by `priorityMode`. A stored `false` migrates to "priority_only".
     */
    mineUnlistedGames?: boolean;
    /** Preferred channels, tried before searching the game directory. */
    preferredChannels: string[];
    /** Channels never to watch, whatever else qualifies them. */
    blockedChannels: string[];
    /**
     * Restrict channel search to these broadcaster languages, as two-letter codes such as
     * "EN". Empty means any language.
     */
    broadcasterLanguages: string[];
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
    /**
     * What to do with campaigns whose account is not linked, and whose rewards therefore may
     * never arrive. Badge and emote campaigns are always mined - those need no link.
     *
     * Linked campaigns are ranked first regardless, so this only decides what happens once
     * they run out.
     */
    unlinkedPolicy: UnlinkedPolicy;
    /**
     * Send a notification when an unlinked campaign you have already earned progress on is
     * this many hours from expiring - the last chance to link the account and keep it.
     * Zero disables it.
     */
    unlinkedExpiryWarningHours: number;
    /**
     * Hold back the claim on a drop whose campaign is not linked to your account, and notify
     * instead of claiming.
     *
     * Publishers differ on whether a drop claimed before linking can be recovered. Some
     * honour a later link (Rust offers "check for missing drops"; Halo allows 14 days after
     * the campaign), while others treat it as gone - Bungie states plainly that rewards
     * claimed before linking are lost. Holding trades a certain-but-recoverable state for an
     * uncertain one, so it is off by default: an unclaimed drop is definitely lost once the
     * 24-hour post-campaign window closes, whereas a claimed one is often still recoverable.
     */
    holdClaimsWhenUnlinked: boolean;
/**
     * Show Twitch's embedded player in the dashboard's live channel panel, muted.
     *
     * This is the ordinary public embed any site can use, pointed at the channel already
     * being mined. Turn it off to fall back to the refreshing preview thumbnail, which is
     * lighter on a machine that is only being glanced at.
     */
    allowStreamEmbed: boolean;
    logLevel: LogLevel;
    steam: {
        /**
         * Steam Web API key from https://steamcommunity.com/dev/apikey. Required to read the
         * library - signing in through Steam establishes identity only.
         */
        apiKey?: string;
        /** 64-bit Steam ID, filled in by signing in through Steam or entered by hand. */
        steamId?: string;
        /** Hours between library refreshes. Libraries change rarely. */
        refreshHours: number;
    };
    notifications: {
        telegram?: { botToken: string; chatId: string };
        discord?: { webhookUrl: string };
    };
}

export const DEFAULT_CONFIG: Config = {
    priorityGames: [],
    excludedGames: [],
    priorityMode: "ending_soonest",
    preferredChannels: [],
    blockedChannels: [],
    broadcasterLanguages: [],
    campaignRefreshMinutes: 20,
    attemptImpossibleCampaigns: true,
    autoClaimDrops: true,
    autoClaimPoints: true,
    warnUnlinkedAccounts: true,
    unlinkedPolicy: "mine",
    unlinkedExpiryWarningHours: 12,
    holdClaimsWhenUnlinked: false,
    allowStreamEmbed: true,
    logLevel: "info",
    steam: { refreshHours: 24 },
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
        steam: { ...DEFAULT_CONFIG.steam, ...(parsed.steam ?? {}) },
        notifications: { ...DEFAULT_CONFIG.notifications, ...(parsed.notifications ?? {}) },
    };

    // Older configs expressed this as a boolean; carry the intent across.
    if (parsed.priorityMode === undefined && parsed.mineUnlistedGames === false) {
        config.priorityMode = "priority_only";
    }
    delete config.mineUnlistedGames;

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
