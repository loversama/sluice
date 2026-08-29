import type { DailyLimit, Schedule } from "./schedule.js";
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

/**
 * How the Steam account was identified, or null while the question has not been put.
 *
 * Null is what makes the onboarding prompt appear, and "skipped" is what stops it. That is
 * why the answer is kept here rather than in the browser: skipping is a decision about the
 * account, and it should survive a reinstall and follow the user to whatever is showing
 * the dashboard, not be forgotten by a cleared browser profile.
 */
export type SteamLinkState = "openid" | "profile" | "skipped";

export interface Config {
    /**
     * Games to mine, most wanted first. Accepts display names ("Rust") or numeric game IDs.
     * An empty list means "any game with an active campaign".
     */
    priorityGames: string[];
    /**
     * Games moved by dragging the queue, in the order they were put.
     *
     * Separate from the priority list on purpose. The priority list is curated by hand and
     * means "I want these games"; dragging the queue means "not that one first", which is a
     * smaller statement and should not silently enrol a game into a list the user is
     * keeping. An earlier version wrote drags into priorityGames and put fifty-odd games
     * there in one gesture.
     */
    queueOrder: string[];
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
        /** Whether Steam has been linked, how, or that the user chose not to. */
        linked: SteamLinkState | null;
        /**
         * 64-bit Steam ID, filled in by signing in through Steam or by pasting a profile
         * URL. It identifies a public profile and is not a credential.
         */
        steamId?: string;
        /**
         * The service that reads Steam on the app's behalf, so no key of any kind is asked
         * of the user. Overridable so the pair can be run against a local backend.
         */
        brokerBaseUrl: string;
        /** Hours between library refreshes. Libraries change rarely. */
        refreshHours: number;
    };
    /**
     * Pop-up notifications from the desktop app, shown by the operating system rather than
     * inside the window. Ignored by the container build, which has no desktop to pop up on.
     */
    /**
     * How the sidebar behaves. Auto collapses it when the window is too narrow to spare the
     * rail's width, which is most of the time on a side-by-side desktop.
     */
    sidebarMode: "expanded" | "collapsed" | "auto";
    /**
     * Check for and download new versions on its own. Desktop only; the container is
     * updated by pulling an image.
     *
     * On by default and worth leaving on: Twitch rotates its GraphQL query hashes without
     * notice, and when it does the bot cannot mine until a fix ships. Someone running the
     * installer has no other route to that fix.
     */
    /**
     * Hours the miner is allowed to run.
     *
     * Twitch credits one watch session per account, so two copies in two places starve each
     * other. Giving each its own hours is how they stop competing.
     */
    schedule: Schedule;
    /**
     * A ceiling on how long it mines in a local day, with half an hour of latitude to
     * finish a drop already in progress - cutting five minutes short of a tier wastes the
     * whole session's watch time on it, since drops pay all or nothing.
     */
    dailyLimit: DailyLimit;
    autoUpdate: boolean;
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
    queueOrder: [],
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
    sidebarMode: "auto",
    schedule: { enabled: false, windows: [] },
    dailyLimit: { enabled: false, hours: 8 },
    autoUpdate: true,
    desktopNotifications: true,
    desktopNotificationStyle: "native",
    sounds: { enabled: true, volume: 0.5 },
    allowedHosts: [],
    logLevel: "info",
    steam: {
        linked: null,
        brokerBaseUrl: "https://sinfulshadows.com",
        refreshHours: 24,
    },
    notifications: {},
};

/** The Steam block as it was written before the broker, when keys were the user's problem. */
interface LegacySteam {
    provider?: "direct" | "sinfulshadows";
    /** The user's own Steam Web API key. */
    apiKey?: string;
    steamId?: string;
    sinfulshadows?: { apiKey?: string; baseUrl?: string };
}

/**
 * Carry a key-era Steam block onto the keyless one.
 *
 * Nobody should lose their library or have to do anything, so the rule is to keep whatever
 * identifies the account and throw away everything that was only ever there to grant
 * access to it:
 *
 * - A direct Steam key with an ID beside it becomes a plain profile link. The ID is all
 *   that was ever needed to read a public library; the key was the price Steam charged for
 *   asking, and the broker pays it now.
 * - A SinfulShadows key had no Steam ID in the config at all - the site derived it from the
 *   linked account. The ID is in steam.json instead, so `app.ts` adopts it once the cached
 *   library is loaded and this leaves `linked` null for it to fill in.
 * - Neither leaves `linked` null, which is what puts the onboarding prompt on screen.
 *
 * A base URL somebody pointed at a local backend is worth keeping either way: the broker
 * lives on the same host as the API it replaces.
 */
function migrateSteam(config: Config, legacy: LegacySteam | undefined): void {
    if (!legacy) {
        return;
    }
    const legacyBaseUrl = legacy.sinfulshadows?.baseUrl;
    if (legacyBaseUrl && legacyBaseUrl !== DEFAULT_CONFIG.steam.brokerBaseUrl) {
        config.steam.brokerBaseUrl = legacyBaseUrl;
    }

    if (!config.steam.linked) {
        config.steam.linked = legacy.apiKey && config.steam.steamId ? "profile" : null;
    }

    if (legacy.apiKey || legacy.sinfulshadows?.apiKey) {
        logger.info(
            "Steam no longer needs an API key of any kind; the stored one has been removed " +
                "and your library will keep refreshing without it.",
        );
    }

    // Deleted rather than left in place: a key kept in a file nothing reads is a secret
    // still sitting on disk, and the point of the change is that there is no longer one.
    const stale = config.steam as LegacySteam;
    delete stale.provider;
    delete stale.apiKey;
    delete stale.sinfulshadows;
}

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
        steam: { ...DEFAULT_CONFIG.steam, ...(parsed.steam ?? {}) },
        notifications: { ...DEFAULT_CONFIG.notifications, ...(parsed.notifications ?? {}) },
    };

    migrateSteam(config, parsed.steam as LegacySteam | undefined);

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
    // Owner-only, as auth.json already was. This file holds the Telegram bot token and the
    // Discord bot token or webhook - each of which is full control of that bot - and it was
    // being written at the default mode, readable by any other account on the machine or any
    // container sharing the data volume.
    await writeFileAtomic(path, `${JSON.stringify(config, null, 4)}\n`, { mode: 0o600 });
}
