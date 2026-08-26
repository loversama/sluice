import { readFile, rename } from "node:fs/promises";

import { writeFileAtomic } from "./atomic-write.js";
import logger from "./logger.js";

import type { LogLevel } from "./logger.js";
import type { LibraryPolicy, PriorityMode } from "./models/campaign.js";

export type { LibraryPolicy };

/**
 * How unlinked campaigns are treated.
 *
 * "ownedOrChosen" is the useful middle: mining an unlinked campaign is only worth the time
 * if the user would plausibly go and link it, and the honest signals for that are owning the
 * game on Steam or having named it in the priority list. Everything else is watch time spent
 * on a reward nobody intends to collect.
 */
export type UnlinkedPolicy = "mine" | "skip" | "ownedOrChosen";

/** Where the Steam library is read from. See `Config.steam.provider`. */
export type SteamProvider = "direct" | "sinfulshadows";

export interface Config {
    /**
     * Games to mine, most wanted first. Accepts display names ("Rust") or numeric game IDs.
     * An empty list means "any game with an active campaign".
     */
    priorityGames: string[];
    /** Games to never mine, whatever the priority mode says. */
    excludedGames: string[];
    /**
     * Restrict mining to games you own on Steam or named in `priorityGames`.
     *
     * Twitch runs campaigns for hundreds of games, and watch time spent on one you do not
     * own and did not ask for earns a reward you will never use. Defaults to "ownedOrListed"
     * for that reason.
     *
     * Has no effect until a Steam library is loaded - without one there is nothing to check
     * ownership against, and applying it would leave nothing mineable.
     */
    libraryPolicy: LibraryPolicy;
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
    /**
     * Leave a channel the moment it switches to a category the campaign does not cover.
     *
     * Watch time only counts while the streamer is in the campaign's category, so a mid-
     * stream switch earns nothing. That is already caught without this: the drop stops
     * progressing and the stall watchdog moves on after about fifteen minutes. Subscribing
     * to the change makes it immediate, at the cost of a second PubSub topic for every
     * channel watched, so it is off by default and worth turning on only if those fifteen
     * minutes matter more than the extra subscription.
     */
    switchOnCategoryChange: boolean;
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
     * Play Twitch's embedded player in the dashboard, muted, instead of a thumbnail.
     *
     * The ordinary public embed, pointed at the channel already being mined and always
     * loaded signed out, so it watches as a guest and cannot become a second watch session
     * on the account.
     *
     * Off by default, and worth leaving off. A signed-out viewer is served ad breaks like
     * any other - either a real advertiser's video or Twitch's own "commercial break in
     * progress" filler when nothing bid - and there is no supported way to detect or
     * suppress them. The panel is decoration either way: mining runs on its own watch
     * beats and never looks at this player.
     */
    allowStreamEmbed: boolean;
    /**
     * Extra Host header values the dashboard will answer to.
     *
     * Loopback names and the address it was told to bind are always accepted. Anything else
     * is refused, which is what stops a hostile page re-pointing its own domain at
     * 127.0.0.1 and talking to the dashboard as though it were same-origin. Add your own
     * hostname here when serving it behind a reverse proxy.
     */
    allowedHosts: string[];
    logLevel: LogLevel;
    steam: {
        /**
         * Where the library is read from.
         *
         * "direct" uses the user's own Steam Web API key. "sinfulshadows" borrows the key
         * held by sinfulshadows.com, which returns the Steam account linked to the
         * SinfulShadows account the key belongs to - so no Steam key or ID is needed.
         */
        provider: SteamProvider;
        /**
         * Steam Web API key from https://steamcommunity.com/dev/apikey. Required to read the
         * library - signing in through Steam establishes identity only. "direct" only.
         */
        apiKey?: string;
        /**
         * 64-bit Steam ID, filled in by signing in through Steam or entered by hand.
         * "direct" only; the SinfulShadows provider derives it from the linked account.
         */
        steamId?: string;
        sinfulshadows: {
            /** Key created at sinfulshadows.com under Settings -> API keys. */
            apiKey?: string;
            /** Overridable so the pair can be run against a local backend. */
            baseUrl: string;
        };
        /** Hours between library refreshes. Libraries change rarely. */
        refreshHours: number;
    };
    /**
     * Pop-up notifications from the desktop app, shown by the operating system rather than
     * inside the window. Ignored by the container build, which has no desktop to pop up on.
     */
    desktopNotifications: boolean;
    /**
     * How those pop-ups look. Native matches everything else on the machine, which is what
     * a notification is usually expected to do; themed matches the app instead.
     */
    desktopNotificationStyle: "native" | "themed";
    /**
     * Audible feedback in the dashboard. Held here rather than in the browser so the
     * choice follows the account to whatever is showing the dashboard.
     */
    sounds: {
        enabled: boolean;
        /** 0 to 1. Applied to the element, so it scales the source rather than the system. */
        volume: number;
    };
    notifications: {
        telegram?: { botToken: string; chatId: string };
        /**
         * Either half works on its own. A webhook is the simpler route and needs no bot;
         * a bot token plus channel posts under an identity you already own.
         */
        discord?: { webhookUrl: string; botToken?: string; channelId?: string };
    };
}

export const DEFAULT_CONFIG: Config = {
    priorityGames: [],
    excludedGames: [],
    priorityMode: "ending_soonest",
    libraryPolicy: "ownedOrListed",
    preferredChannels: [],
    blockedChannels: [],
    broadcasterLanguages: [],
    campaignRefreshMinutes: 20,
    attemptImpossibleCampaigns: true,
    switchOnCategoryChange: false,
    autoClaimDrops: true,
    autoClaimPoints: true,
    warnUnlinkedAccounts: true,
    unlinkedPolicy: "mine",
    unlinkedExpiryWarningHours: 12,
    holdClaimsWhenUnlinked: false,
    allowStreamEmbed: false,
    desktopNotifications: true,
    desktopNotificationStyle: "native",
    sounds: { enabled: true, volume: 0.5 },
    allowedHosts: [],
    logLevel: "info",
    steam: {
        provider: "direct",
        sinfulshadows: { baseUrl: "https://sinfulshadows.com" },
        refreshHours: 24,
    },
    notifications: {},
};

/** Load config from disk, writing a default file if none exists. */
export async function loadConfig(path: string): Promise<Config> {
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch {
        await writeFileAtomic(path, `${JSON.stringify(DEFAULT_CONFIG, null, 4)}\n`);
        return { ...DEFAULT_CONFIG };
    }

    let parsed: Partial<Config>;
    try {
        parsed = JSON.parse(raw) as Partial<Config>;
    } catch (error) {
        // A half-written config used to be fatal, which meant a machine losing power
        // mid-save would not start again - no dashboard, and on the desktop build no
        // message either. The settings are recoverable by hand and worth keeping, so the
        // file is set aside rather than deleted, and startup continues on defaults.
        const quarantine = `${path}.corrupt-${Date.now()}`;
        await rename(path, quarantine).catch(() => {});
        logger.warn(
            `${path} is not valid JSON (${(error as Error).message}). Moved it to ` +
                `${quarantine} and started from defaults.`,
        );
        return { ...DEFAULT_CONFIG };
    }

    const config: Config = {
        ...DEFAULT_CONFIG,
        ...parsed,
        steam: {
            ...DEFAULT_CONFIG.steam,
            ...(parsed.steam ?? {}),
            sinfulshadows: {
                ...DEFAULT_CONFIG.steam.sinfulshadows,
                ...(parsed.steam?.sinfulshadows ?? {}),
            },
        },
        notifications: { ...DEFAULT_CONFIG.notifications, ...(parsed.notifications ?? {}) },
    };

    // Configs written before the SinfulShadows provider existed used a Steam key directly.
    if (!config.steam.provider) {
        config.steam.provider = "direct";
    }

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
    await writeFileAtomic(path, `${JSON.stringify(config, null, 4)}\n`);
}
