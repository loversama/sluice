import { EventEmitter } from "node:events";

import logger from "./logger.js";
import type { Config } from "./config.js";
import { Campaign, compareCampaigns, type Drop, type RankingOptions } from "./models/campaign.js";
import { Channel } from "./models/channel.js";
import type { AuthState } from "./twitch/auth.js";
import { StaleQueryHashError, type TwitchGql } from "./twitch/gql.js";
import { PubSubPool, type DropProgressMessage } from "./twitch/websocket.js";
import type { SteamLibrary } from "./steam/library.js";
import { loadState, saveState } from "./state.js";
import { loadClaims, saveClaims, summarise, type ClaimHistory, type ClaimStats } from "./claims.js";
import { WATCH_INTERVAL_MS } from "./twitch/constants.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Beats sent without Twitch confirming any progress before we conclude the channel is not
 * actually earning. Counted in beats rather than wall-clock time so a stalled or failing
 * connection does not masquerade as a stalled campaign.
 */
const MAX_UNCONFIRMED_BEATS = 15;
/**
 * Beats to allow before asking Twitch directly whether this session is earning. Cheap enough
 * to run often, and it turns "is this channel a dud?" from a fifteen-minute question into a
 * three-minute one.
 */
const BEATS_BEFORE_SESSION_CHECK = 3;
/**
 * Consecutive rejected beats tolerated before benching the channel. A single CDN or Spade
 * hiccup is common and should not cost a thirty-minute exclusion.
 */
const MAX_BEAT_FAILURES = 3;
/** How long a channel that failed stays out of the rotation. */
const CHANNEL_COOLDOWN_MS = 30 * 60_000;
/** How many campaigns to try per cycle before giving the loop a rest. */
const MAX_CAMPAIGNS_PER_CYCLE = 12;
/**
 * Twitch keeps a finished drop claimable from the inventory page for 24 hours after its
 * campaign ends, so an expired campaign is not necessarily a lost one.
 * https://help.twitch.tv/s/article/mission-based-drops#claiming
 */
const CLAIM_GRACE_MS = 24 * 60 * 60_000;
/** Eligibility checks cost a request each, so cap them per search tier. */
const MAX_ELIGIBILITY_CHECKS = 8;
/** Above this, an allow-list is intersected against the directory instead of walked. */
const MAX_ALLOW_LIST_LOOKUPS = 20;

/**
 * Channels to keep PubSub subscriptions for. Each costs one topic, and the pool allows
 * several hundred, so this is a comfort limit rather than a hard one.
 */
const MAX_TRACKED_CHANNELS = 150;

/** Streamers running an untagged campaign almost always say so in the title. */
const DROPS_IN_TITLE = /\bdrops?\b/i;

function mentionsDrops(channel: Channel): boolean {
    return DROPS_IN_TITLE.test(channel.stream?.title ?? "");
}

export interface MinerEvents {
    "campaigns-updated": [Campaign[]];
    "watching": [{ channel: Channel; campaign: Campaign; drop: Drop }];
    "progress": [{ drop: Drop; minutes: number; required: number }];
    "drop-claimed": [{ drop: Drop; campaign: Campaign }];
    "campaign-completed": [Campaign];
    /** Emitted after each accepted watch beat; drives the dashboard heartbeat. */
    beat: [{ at: number }];
    /** A drop finished on a campaign the account is not linked to. */
    "unlinked-claim": [{ campaign: Campaign; drop: Drop; held: boolean }];
    /** Progress has been earned on an unlinked campaign that is about to expire. */
    "unlinked-expiring": [
        { campaign: Campaign; earnedMinutes: number; rewards: string[]; hoursLeft: number },
    ];
    /** Human-readable activity line for the dashboard feed. */
    feed: [FeedEntry];
    error: [Error];
}

export type FeedLevel = "info" | "warn" | "error";

export interface FeedEntry {
    at: number;
    level: FeedLevel;
    message: string;
}

/**
 * A game whose campaigns are earning progress that will never reach the game, because the
 * Twitch account is not linked to the publisher.
 */
export interface LinkSuggestion {
    gameId: string;
    gameName: string;
    /** Unlinked campaigns currently running for this game. */
    campaignCount: number;
    ownedOnSteam: boolean;
    /** Total minutes played on Steam, or null when the library is unavailable. */
    playtimeMinutes: number | null;
    /** Minutes already watched toward these campaigns - progress that is currently wasted. */
    wastedMinutes: number;
    /** Rewards at stake, for showing the user what they are missing. */
    rewards: string[];
    /** The publisher's linking page for this game. */
    linkUrl: string;
}

export interface ClaimRecord {
    at: number;
    dropId: string;
    campaignId: string;
    dropName: string;
    gameName: string;
    rewardImageURL: string | null;
}

/** What the miner is doing right now, or null when idle. */
export interface MiningState {
    channel: { login: string; displayName: string; url: string };
    campaignId: string;
    dropId: string;
    since: number;
    lastBeatAt: number | null;
    lastProgressAt: number | null;
}

/**
 * Drives the whole mining process: keeps campaigns up to date, picks what to work on,
 * watches a channel for it, and claims rewards as they land.
 */
export class Miner extends EventEmitter {
    private campaigns = new Map<string, Campaign>();
    private readonly slugCache = new Map<string, string>();
    /** Channel login -> time it becomes eligible again after a failure. */
    private readonly channelCooldowns = new Map<string, number>();
    private readonly claimedDropIds = new Set<string>();
    /** Drops Twitch refused to claim, so a doomed claim is not retried every refresh. */
    private readonly failedClaimIds = new Set<string>();

    private pubsub: PubSubPool | null = null;
    private currentChannel: Channel | null = null;
    private currentDrop: Drop | null = null;
    private lastProgressAt = 0;
    /** Set when a better campaign appears, so the watch loop yields at its next beat. */
    private switchRequested = false;
    private stopping = false;
    /** When true, the miner reads and reports but never sends watch beats or claims. */
    dryRun = false;
    /** Paused by the user. Campaigns keep refreshing; nothing is watched or claimed. */
    private paused = false;

    private currentCampaign: Campaign | null = null;
    private miningSince: number | null = null;
    private lastBeatAt: number | null = null;
    private nextRefreshAt: number | null = null;
    /** Ring buffers so a dashboard that connects late still has recent history. */
    private readonly recentClaims: ClaimRecord[] = [];
    private readonly feedEntries: FeedEntry[] = [];
    /** Regenerated each refresh so "random" mode varies between cycles but not within one. */
    private randomKeys = new Map<string, number>();
    /**
     * Campaigns already warned about, so the alert fires once rather than every refresh -
     * or every restart, which is why this is persisted rather than kept in memory.
     */
    private readonly warnedExpiring = new Set<string>();
    /** Drops already flagged as claimed while unlinked. */
    private readonly notifiedUnlinkedClaims = new Set<string>();
    private statePath: string | null = null;
    private claimsPath: string | null = null;
    private claimHistory: ClaimHistory = { claims: [], completedCampaignIds: [] };
    private steam: SteamLibrary | null = null;
    private boundaryTimer: NodeJS.Timeout | null = null;
    /** Watch beats accepted since Twitch last confirmed progress. */
    private unconfirmedBeats = 0;
    /**
     * Channels we hold a live status subscription for, whether or not they are streaming.
     *
     * Tracking allow-list streamers while they are offline is the point: a campaign
     * restricted to a handful of channels is otherwise only minable if one happens to be
     * live at the moment we look, and we would miss the rest of their stream.
     */
    private readonly watchlist = new Map<
        string,
        { id: string; login: string; displayName: string; online: boolean; campaignIds: Set<string> }
    >();
    /** Channel login -> ID, so preferred channels are only resolved once. */
    private readonly channelIdCache = new Map<string, string>();

    constructor(
        private readonly auth: AuthState,
        private readonly gql: TwitchGql,
        private config: Config,
    ) {
        super();
    }

    /** Restore notification bookkeeping so "once" survives a restart. */
    async loadPersistedState(path: string): Promise<void> {
        this.statePath = path;
        const state = await loadState(path);
        state.warnedExpiring.forEach((id: string) => this.warnedExpiring.add(id));
        state.notifiedUnlinkedClaims.forEach((id: string) => this.notifiedUnlinkedClaims.add(id));
        state.failedClaims.forEach((id: string) => this.failedClaimIds.add(id));
        logger.debug(
            `Restored notification state: ${this.warnedExpiring.size} warned campaigns, ` +
                `${this.notifiedUnlinkedClaims.size} flagged claims`,
        );
    }

    /** Restore the durable record of what has been earned. */
    async loadClaimHistory(path: string): Promise<void> {
        this.claimsPath = path;
        this.claimHistory = await loadClaims(path);
        // Seed the in-memory view so a fresh process still shows recent claims.
        this.recentClaims.push(...this.claimHistory.claims.slice(-100));
        logger.debug(`Restored ${this.claimHistory.claims.length} claims from history`);
    }

    /** Lifetime totals for the dashboard. */
    getClaimStats(): ClaimStats {
        const required = new Map<string, number>();
        for (const campaign of this.campaigns.values()) {
            for (const drop of campaign.drops) {
                required.set(drop.id, drop.requiredMinutes);
            }
        }
        return summarise(this.claimHistory, required);
    }

    /**
     * Note a campaign as finished once its last drop is claimed.
     *
     * This lives here rather than in the watch loop because most claims happen in the
     * refresh sweep, which never ran the check - so a campaign finished by that path was
     * never counted, and the dashboard reported zero completions against real claims.
     */
    private recordCompletionIfFinished(campaign: Campaign): void {
        if (!campaign.isCompleted || this.claimHistory.completedCampaignIds.includes(campaign.id)) {
            return;
        }
        this.claimHistory.completedCampaignIds.push(campaign.id);
        this.persistClaims();
        logger.info(`Completed campaign: ${campaign.gameName} - ${campaign.name}`);
        this.emit("campaign-completed", campaign);
    }

    /**
     * Recover completions that predate the fix, or that happened while the bot was stopped:
     * any known campaign that is finished and that we hold a claim for.
     */
    private reconcileCompletions(): void {
        const claimedDrops = new Set(this.claimHistory.claims.map((claim) => claim.dropId));
        for (const campaign of this.campaigns.values()) {
            if (!campaign.isCompleted) {
                continue;
            }
            const ours = campaign.drops.some((drop) => claimedDrops.has(drop.id));
            if (ours) {
                this.recordCompletionIfFinished(campaign);
            }
        }
    }

    private persistClaims(): void {
        if (this.claimsPath) {
            void saveClaims(this.claimsPath, this.claimHistory);
        }
    }

    private persistState(): void {
        if (!this.statePath) {
            return;
        }
        void saveState(this.statePath, {
            warnedExpiring: [...this.warnedExpiring],
            notifiedUnlinkedClaims: [...this.notifiedUnlinkedClaims],
            failedClaims: [...this.failedClaimIds],
        });
    }

    get isPaused(): boolean {
        return this.paused;
    }

    /** Stop watching without stopping the daemon. The loop yields at its next beat. */
    pause(): void {
        if (this.paused) {
            return;
        }
        this.paused = true;
        this.switchRequested = true;
        logger.info("Paused by request.");
        this.pushFeed("info", "Paused");
    }

    resume(): void {
        if (!this.paused) {
            return;
        }
        this.paused = false;
        logger.info("Resumed by request.");
        this.pushFeed("info", "Resumed");
    }

    /**
     * Leave the current channel and pick another. The channel is benched briefly so the
     * next selection does not immediately choose it again.
     */
    skipChannel(): boolean {
        const channel = this.currentChannel;
        if (!channel) {
            return false;
        }
        this.channelCooldowns.set(channel.login, Date.now() + CHANNEL_COOLDOWN_MS);
        this.switchRequested = true;
        logger.info(`Skipping ${channel.displayName} by request.`);
        this.pushFeed("info", `Skipped ${channel.displayName}`);
        return true;
    }

    /** Refresh campaigns immediately rather than waiting for the next scheduled sweep. */
    async refreshNow(): Promise<void> {
        await this.refreshCampaigns();
    }

    /** Attach a Steam library so ownership and playtime can influence ranking. */
    setSteamLibrary(library: SteamLibrary | null): void {
        this.steam = library;
    }

    /** The ranking rules in force right now, including live focus and shuffle state. */
    private rankingOptions(): RankingOptions {
        const steam = this.steam;
        const mode = this.config.priorityMode;
        return {
            priorityGames: this.config.priorityGames,
            mode,
            randomKeys: this.randomKeys,
            focusGameId: this.currentCampaign?.gameId ?? null,
            steamScore:
                steam && (mode === "steam_playtime" || mode === "steam_recent")
                    ? (campaign) =>
                          steam.score(
                              campaign.gameName,
                              mode === "steam_recent" ? "recent" : "playtime",
                          )
                    : undefined,
        };
    }

    /**
     * Games where linking the Twitch account would convert wasted watch time into rewards.
     *
     * Ranked by how much the user probably cares: games they own on Steam first, then by how
     * much progress is already being thrown away.
     */
    getLinkSuggestions(): LinkSuggestion[] {
        const byGame = new Map<string, LinkSuggestion>();

        for (const campaign of this.campaigns.values()) {
            if (!campaign.isActive || campaign.isDeliverable || campaign.isCompleted) {
                continue;
            }
            const existing = byGame.get(campaign.gameId) ?? {
                gameId: campaign.gameId,
                gameName: campaign.gameName,
                campaignCount: 0,
                ownedOnSteam: false,
                playtimeMinutes: null,
                wastedMinutes: 0,
                rewards: [],
                linkUrl: campaign.accountLinkUrl,
            };
            existing.campaignCount++;
            for (const drop of campaign.drops) {
                if (!drop.isClaimed) {
                    existing.wastedMinutes += drop.currentMinutes;
                    if (drop.rewardNames && existing.rewards.length < 4) {
                        existing.rewards.push(drop.rewardNames);
                    }
                }
            }
            byGame.set(campaign.gameId, existing);
        }

        for (const suggestion of byGame.values()) {
            const owned = this.steam?.match(suggestion.gameName) ?? null;
            suggestion.ownedOnSteam = owned !== null;
            suggestion.playtimeMinutes = owned ? owned.playtimeForever : null;
        }

        return [...byGame.values()].sort((a, b) => {
            if (a.ownedOnSteam !== b.ownedOnSteam) {
                return a.ownedOnSteam ? -1 : 1;
            }
            const playtimeDelta = (b.playtimeMinutes ?? 0) - (a.playtimeMinutes ?? 0);
            if (playtimeDelta !== 0) {
                return playtimeDelta;
            }
            return b.wastedMinutes - a.wastedMinutes;
        });
    }

    /** Record a human-readable activity line and emit it to listeners. */
    private pushFeed(level: FeedLevel, message: string): void {
        const entry: FeedEntry = { at: Date.now(), level, message };
        this.feedEntries.push(entry);
        // Keep the buffer bounded; this is a status feed, not a log file.
        if (this.feedEntries.length > 200) {
            this.feedEntries.splice(0, this.feedEntries.length - 200);
        }
        this.emit("feed", entry);
    }

    getFeed(limit = 50): FeedEntry[] {
        return this.feedEntries.slice(-limit).reverse();
    }

    getRecentClaims(limit = 20): ClaimRecord[] {
        return this.recentClaims.slice(-limit).reverse();
    }

    /** What is being mined right now, or null when idle. */
    getMiningState(): MiningState | null {
        const channel = this.currentChannel;
        const drop = this.currentDrop;
        const campaign = this.currentCampaign;
        if (!channel || !drop || !campaign || this.miningSince === null) {
            return null;
        }
        return {
            channel: {
                login: channel.login,
                displayName: channel.displayName,
                url: channel.url,
            },
            campaignId: campaign.id,
            dropId: drop.id,
            since: this.miningSince,
            lastBeatAt: this.lastBeatAt,
            lastProgressAt: this.lastProgressAt || null,
        };
    }

    getNextRefreshAt(): number | null {
        return this.nextRefreshAt;
    }

    getConfig(): Config {
        return this.config;
    }

    /**
     * Apply a config change at runtime. Ranking is recomputed on the next selection, so
     * priority edits take effect without a restart.
     */
    applyConfig(config: Config): void {
        this.config = config;
        this.pushFeed("info", "Configuration updated");

        // Re-rank straight away. Editing priorities and then watching the bot carry on with
        // the old campaign for another refresh interval reads as the setting not working.
        const best = this.getMineableCampaigns()[0];
        if (this.currentChannel && best && best.id !== this.currentCampaign?.id) {
            logger.info(`Priorities changed; switching to ${best.gameName}.`);
            this.pushFeed("info", `Priorities changed - switching to ${best.gameName}`);
            this.switchRequested = true;
        }
    }

    /** Every campaign currently known, active and upcoming alike. */
    getCampaigns(): Campaign[] {
        return [...this.campaigns.values()];
    }

    /** Campaigns that have not started yet, soonest first. */
    getUpcomingCampaigns(): Campaign[] {
        return this.getCampaigns()
            .filter((campaign) => campaign.isUpcoming)
            .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    }

    /** Active campaigns with work left, in the order they would be mined. */
    getMineableCampaigns(): Campaign[] {
        return this.getCampaigns()
            .filter((campaign) => campaign.isActive && !campaign.isCompleted)
            .sort((a, b) => compareCampaigns(a, b, this.rankingOptions()));
    }

    async start(): Promise<void> {
        this.pubsub = new PubSubPool(() => this.auth.accessToken);
        this.attachPubSubHandlers(this.pubsub);
        // Drop events are account-wide, so this one subscription covers every campaign.
        this.pubsub.listen(`user-drop-events.${this.auth.userId}`);
        // Reward notifications are a faster signal that the inventory changed than polling.
        this.pubsub.listen(`onsite-notifications.${this.auth.userId}`);

        await this.refreshCampaigns();
        this.scheduleCampaignRefresh();

        while (!this.stopping) {
            try {
                if (this.paused) {
                    await sleep(5_000);
                    continue;
                }
                const worked = await this.runOnce();
                if (!worked) {
                    logger.info("Nothing to mine right now. Waiting for the next refresh.");
                    await sleep(this.config.campaignRefreshMinutes * 60_000);
                }
            } catch (error) {
                if (error instanceof StaleQueryHashError) {
                    // Nothing will work until the hash is updated; surface it and stop.
                    this.emit("error", error);
                    throw error;
                }
                logger.error("Mining cycle failed:", error);
                this.emit("error", error as Error);
                await sleep(60_000);
            }
        }
    }

    stop(): void {
        this.stopping = true;
        if (this.boundaryTimer) {
            clearTimeout(this.boundaryTimer);
            this.boundaryTimer = null;
        }
        this.pubsub?.close();
        this.pubsub = null;
    }

    /**
     * Work down the ranked campaigns until one has a channel we can actually watch.
     *
     * Falling through matters: a campaign nobody is streaming right now is common, and
     * stopping at the first such campaign would idle the miner for a full refresh interval
     * while dozens of viable campaigns sat untouched.
     */
    private async runOnce(): Promise<boolean> {
        const candidates = this.selectCampaigns();
        if (candidates.length === 0) {
            return false;
        }

        let examined = 0;
        for (const campaign of candidates) {
            // Each attempt costs several API calls, so cap the search per cycle rather than
            // walking a hundred campaigns every time.
            if (examined >= MAX_CAMPAIGNS_PER_CYCLE) {
                logger.info(
                    `Checked ${examined} campaigns without finding a live channel; ` +
                        `${candidates.length - examined} not tried this cycle.`,
                );
                break;
            }

            const drop = campaign.nextDrop({
                attemptImpossible: this.config.attemptImpossibleCampaigns,
            });
            if (!drop) {
                continue;
            }
            examined++;

            if (this.config.warnUnlinkedAccounts && !campaign.isDeliverable) {
                logger.warn(
                    `${campaign.gameName} - "${campaign.name}" is not linked to your Twitch ` +
                        "account. Progress is tracked, but rewards will not reach the game.",
                );
            }

            const channel = await this.findChannel(campaign);
            if (!channel) {
                logger.debug(`No eligible channel online for ${campaign.gameName}.`);
                // Bench this campaign briefly so the next cycle starts further down the list.
                this.channelCooldowns.set(`campaign:${campaign.id}`, Date.now() + 5 * 60_000);
                continue;
            }

            await this.watch(channel, campaign, drop);
            return true;
        }

        return false;
    }

    /** Highest-priority campaign that is active and has work left. */
    private selectCampaign(): Campaign | null {
        return this.selectCampaigns()[0] ?? null;
    }

    /** Every campaign worth trying, best first. */
    private selectCampaigns(): Campaign[] {
        const now = Date.now();
        const candidates = [...this.campaigns.values()].filter((campaign) => {
            if (!campaign.isActive || campaign.isCompleted) {
                return false;
            }
            const cooldown = this.channelCooldowns.get(`campaign:${campaign.id}`);
            if (cooldown !== undefined && cooldown > now) {
                return false;
            }
            if (this.config.excludedGames.some((game) => this.matchesGame(game, campaign))) {
                return false;
            }
            if (!campaign.isDeliverable && !this.shouldMineUnlinked(campaign)) {
                return false;
            }
            if (
                this.config.priorityMode === "priority_only" &&
                !this.config.priorityGames.some((game) => this.matchesGame(game, campaign))
            ) {
                return false;
            }
            return (
                campaign.nextDrop({ attemptImpossible: this.config.attemptImpossibleCampaigns }) !==
                null
            );
        });

        const options = this.rankingOptions();
        candidates.sort((a, b) => compareCampaigns(a, b, options));
        return candidates;
    }

    /**
     * Whether an unlinked campaign is still worth the watch time.
     *
     * Under "ownedOrChosen" it is, but only where there is a real signal the user would go
     * and link it: they own the game on Steam, or they put it in the priority list
     * themselves. Anything else earns progress toward a reward nobody plans to collect.
     */
    private shouldMineUnlinked(campaign: Campaign): boolean {
        switch (this.config.unlinkedPolicy) {
            case "skip":
                return false;
            case "ownedOrChosen": {
                const chosen = this.config.priorityGames.some((game) =>
                    this.matchesGame(game, campaign),
                );
                return chosen || (this.steam?.owns(campaign.gameName) ?? false);
            }
            default:
                return true;
        }
    }

    private matchesGame(game: string, campaign: Campaign): boolean {
        return (
            game === campaign.gameId || game.toLowerCase() === campaign.gameName.toLowerCase()
        );
    }

    /**
     * Find a channel that will actually earn progress for this campaign.
     *
     * Searched in widening tiers, stopping as soon as a tier yields a channel that Twitch
     * confirms grants the campaign:
     *   1. the campaign's allow-list, or the user's preferred channels
     *   2. the game directory filtered to drops-enabled streams
     *   3. untagged streams whose title mentions drops
     *
     * Tier 3 exists because the drops-enabled filter is not reliable: streamers running a
     * campaign sometimes go untagged, and they usually say so in the title instead. The
     * eligibility check below is what actually decides, so the title is only a cheap way to
     * pick which untagged streams are worth a lookup.
     */
    private async findChannel(campaign: Campaign): Promise<Channel | null> {
        const allowed = campaign.allowedChannelIds;

        // A campaign restricted to specific channels must be mined on one of them.
        // Creator-program campaigns can allow hundreds of channels, and resolving each by
        // login is a request apiece, so only small lists are worth walking directly - the
        // directory tiers intersect against the same allow-list in a single request.
        const allowLogins = campaign.allowedChannelLogins;
        const preferred =
            allowLogins.length > 0
                ? allowLogins.length <= MAX_ALLOW_LIST_LOOKUPS
                    ? allowLogins
                    : []
                : this.config.preferredChannels;

        const tiers: (() => Promise<Channel[]>)[] = [
            // Channels PubSub already told us are live, so a failover costs no directory
            // lookups and no waiting.
            () => this.channelsFromLogins(this.onlineTrackedLogins(campaign), campaign),
            () => this.channelsFromLogins(preferred, campaign),
            () => this.channelsFromDirectory(campaign, allowed, { dropsOnly: true }),
            () => this.channelsFromDirectory(campaign, allowed, { dropsOnly: false }),
        ];

        for (const [index, tier] of tiers.entries()) {
            const candidates = await tier().catch(() => []);
            // Only the drops-enabled directory tier carries Twitch's own assurance, so it is
            // the only one allowed to fall back without positive confirmation.
            const trustDropsTag = index === 2;
            const found = await this.firstEligible(candidates, campaign, { trustDropsTag });
            if (found) {
                return found;
            }
        }
        return null;
    }

    /** Tracked channels currently known to be live and relevant to this campaign. */
    private onlineTrackedLogins(campaign: Campaign): string[] {
        return [...this.watchlist.values()]
            .filter(
                (entry) =>
                    entry.online &&
                    (entry.campaignIds.has(campaign.id) || entry.campaignIds.has("preferred")),
            )
            .map((entry) => entry.login);
    }

    /** Resolve explicit channel logins, keeping only those live with the campaign's game. */
    private async channelsFromLogins(logins: string[], campaign: Campaign): Promise<Channel[]> {
        const channels: Channel[] = [];
        for (const login of logins) {
            if (this.isOnCooldown(login) || this.isBlocked(login)) {
                continue;
            }
            const info = await this.gql.getStreamInfo(login.toLowerCase()).catch(() => null);
            if (!info?.stream) {
                continue;
            }
            // A preferred channel only helps if they are playing the campaign's game.
            if (info.broadcastSettings?.game?.id !== campaign.gameId) {
                continue;
            }
            const channel = new Channel(info.id, login.toLowerCase(), login, this.auth, this.gql);
            await channel.refresh();
            channels.push(channel);
        }
        return channels;
    }

    /** Live channels for the campaign's game, best candidates first. */
    private async channelsFromDirectory(
        campaign: Campaign,
        allowed: Set<string> | null,
        options: { dropsOnly: boolean },
    ): Promise<Channel[]> {
        const slug = await this.resolveSlug(campaign);
        if (!slug) {
            return [];
        }
        const nodes = await this.gql
            .getGameChannels(slug, {
                dropsOnly: options.dropsOnly,
                languages: this.config.broadcasterLanguages,
            })
            .catch(() => []);

        const channels: Channel[] = [];
        for (const node of nodes) {
            const channel = Channel.fromDirectory(node, this.auth, this.gql);
            if (!channel || this.isOnCooldown(channel.login) || this.isBlocked(channel.login)) {
                continue;
            }
            if (allowed && !allowed.has(channel.id)) {
                continue;
            }
            channels.push(channel);
        }

        if (!options.dropsOnly) {
            // Only streams that actually say "drops" in the title. Checking every untagged
            // stream in the directory would cost a request each for a poor hit rate; a
            // streamer running an untagged campaign almost always advertises it.
            return channels.filter(mentionsDrops);
        }
        return channels;
    }

    /**
     * Pick a channel for this campaign, preferring one Twitch positively confirms.
     *
     * DropsHighlightService_AvailableDrops is not trustworthy on its own. For a great many
     * campaigns it reports only unrelated site-wide promotions, naming neither the campaign
     * nor anything else useful - creator-program campaigns never appear, and plenty of
     * ordinary ones do not either. Treating it as authoritative meant rejecting fifty live
     * drops-enabled channels for a campaign that was perfectly minable.
     *
     * So it is used as evidence, not as a gate: a confirmed channel wins outright, and
     * failing that we fall back on what Twitch already told us by listing the channel under
     * its drops-enabled filter. The reference tool reaches the same conclusion from the
     * other direction, shipping with this check disabled by default.
     */
    private async firstEligible(
        candidates: Channel[],
        campaign: Campaign,
        options: { trustDropsTag?: boolean } = {},
    ): Promise<Channel | null> {
        // Bound the lookups: a directory page is 50 streams and each check is a request, so
        // a game with no live drops would otherwise cost 50 calls per attempt.
        const allowed = campaign.allowedChannelIds;

        for (const channel of candidates.slice(0, MAX_ELIGIBILITY_CHECKS)) {
            // Twitch listing a channel on the campaign's own allow-list is a stronger
            // statement than DropsHighlightService_AvailableDrops, which does not report
            // creator-program campaigns at all: for Battlefield 6's BCP campaign it returns
            // only an unrelated site-wide event, even for allow-listed channels streaming
            // the right game. Trusting the allow-list is what makes those campaigns minable.
            if (allowed?.has(channel.id) && !this.isBlocked(channel.login)) {
                logger.debug(`${channel.login} is allow-listed for ${campaign.name}`);
                return channel;
            }

            try {
                const available = await this.gql.getAvailableDrops(channel.id);
                // A drops-enabled tag is not enough: the channel may be running a different
                // campaign for the same game.
                const grantsCampaign = available.some(
                    (entry) =>
                        entry.id === campaign.id ||
                        (entry as unknown as { campaign?: { id: string } }).campaign?.id ===
                            campaign.id,
                );
                if (grantsCampaign) {
                    return channel;
                }
                logger.debug(`${channel.login} does not currently grant ${campaign.name}`);
            } catch (error) {
                logger.debug(`Could not check drops for ${channel.login}:`, error);
            }
        }

        // Nothing confirmed. If these came from the drops-enabled directory, Twitch has
        // already vouched for them running a campaign for this game; that is better
        // evidence than an endpoint which stayed silent.
        if (options.trustDropsTag && candidates.length > 0) {
            const fallback = candidates[0]!;
            logger.debug(
                `No channel confirmed ${campaign.name}; using drops-enabled ${fallback.login}`,
            );
            return fallback;
        }
        return null;
    }

    private async resolveSlug(campaign: Campaign): Promise<string | null> {
        if (campaign.gameSlug) {
            return campaign.gameSlug;
        }
        const cached = this.slugCache.get(campaign.gameId);
        if (cached) {
            return cached;
        }
        const slug = await this.gql.getGameSlug(campaign.gameName).catch(() => null);
        if (slug) {
            this.slugCache.set(campaign.gameId, slug);
        }
        return slug;
    }

    private isOnCooldown(login: string): boolean {
        const until = this.channelCooldowns.get(login.toLowerCase());
        return until !== undefined && until > Date.now();
    }

    /**
     * Channels the user never wants watched. Checked everywhere a candidate can enter,
     * including the campaign allow-list path - a blocked channel being allow-listed is
     * exactly when the user's own preference should win.
     */
    private isBlocked(login: string): boolean {
        const target = login.toLowerCase();
        return this.config.blockedChannels.some((entry) => entry.toLowerCase() === target);
    }

    /**
     * Watch `channel` until the drop is claimed, the stream ends, progress stalls, or a
     * higher-priority campaign appears.
     */
    private async watch(channel: Channel, campaign: Campaign, drop: Drop): Promise<void> {
        this.currentChannel = channel;
        this.currentDrop = drop;
        this.currentCampaign = campaign;
        this.miningSince = Date.now();
        this.lastProgressAt = Date.now();
        this.lastBeatAt = null;
        this.unconfirmedBeats = 0;
        this.switchRequested = false;
        let beatFailures = 0;

        const streamTopic = `video-playback-by-id.${channel.id}`;
        const pointsTopic = `community-points-user-v1.${this.auth.userId}`;
        this.pubsub?.listen(streamTopic);
        if (this.config.autoClaimPoints) {
            this.pubsub?.listen(pointsTopic);
        }

        logger.info(
            `Watching ${channel.displayName} for ${campaign.gameName} - ${drop.name} ` +
                `(${drop.currentMinutes}/${drop.requiredMinutes} min)`,
        );
        this.emit("watching", { channel, campaign, drop });
        this.pushFeed(
            "info",
            `Watching ${channel.displayName} for ${campaign.gameName} - ${drop.name}`,
        );

        try {
            // A stream that just came up will not credit watch time yet.
            while (!channel.isWatchable && channel.isOnline && !this.stopping) {
                logger.debug(`Waiting for ${channel.login} to settle before watching`);
                await sleep(15_000);
            }

            while (!this.stopping) {
                const beatStart = Date.now();
                if (!channel.isOnline) {
                    logger.info(`${channel.displayName} went offline.`);
                    return;
                }
                if (this.paused) {
                    logger.info("Paused; leaving the channel.");
                    return;
                }
                if (this.switchRequested) {
                    logger.info("Switching to a higher-priority campaign.");
                    return;
                }
                // A campaign can expire mid-session. Nothing further can be earned, and the
                // refresh will have stripped its drops, so keep beating and we would watch a
                // dead campaign indefinitely.
                if (!campaign.isActive) {
                    logger.info(`${campaign.gameName} - "${campaign.name}" has ended.`);
                    this.pushFeed("info", `${campaign.gameName} ended - moving on`);
                    return;
                }

                const accepted = await channel.sendWatch();
                if (!accepted) {
                    beatFailures++;
                    logger.warn(
                        `${channel.displayName} rejected the watch beat ` +
                            `(${beatFailures}/${MAX_BEAT_FAILURES}).`,
                    );
                    if (beatFailures >= MAX_BEAT_FAILURES) {
                        this.pushFeed("warn", `${channel.displayName} kept rejecting beats`);
                        this.penalise(channel);
                        return;
                    }
                    // A transient failure; wait out the interval and try the next beat.
                    await sleep(Math.max(0, WATCH_INTERVAL_MS - (Date.now() - beatStart)));
                    continue;
                }
                beatFailures = 0;
                this.lastBeatAt = Date.now();
                this.unconfirmedBeats++;
                this.emit("beat", { at: this.lastBeatAt });

                // Re-read through currentDrop: a refresh may have replaced the instance
                // this loop was handed.
                const live = this.currentDrop ?? drop;
                if (live.isClaimed) {
                    return;
                }

                // PubSub is the fast path for progress, but it can go quiet. Once enough
                // beats have gone unconfirmed, check the inventory before writing the
                // channel off - Twitch being silent is not the same as earning nothing.
                // Ask Twitch directly well before resorting to a full inventory sweep.
                if (
                    this.unconfirmedBeats === BEATS_BEFORE_SESSION_CHECK &&
                    !(await this.isSessionEarning(channel, live))
                ) {
                    logger.warn(
                        `${channel.displayName} is not crediting watch time; trying another channel.`,
                    );
                    this.pushFeed("warn", `${channel.displayName} credited nothing - switching`);
                    this.penalise(channel);
                    return;
                }

                if (this.unconfirmedBeats >= MAX_UNCONFIRMED_BEATS) {
                    const advanced = await this.reconcileProgress(live);
                    this.unconfirmedBeats = 0;
                    if (!advanced) {
                        logger.warn(
                            `${MAX_UNCONFIRMED_BEATS} minutes watched on ` +
                                `${channel.displayName} with no progress; trying another channel.`,
                        );
                        this.pushFeed(
                            "warn",
                            `${channel.displayName} benched for 30m - watched without earning`,
                        );
                        this.penalise(channel);
                        return;
                    }
                }

                if (live.isClaimable && this.config.autoClaimDrops) {
                    // claim() records completion itself, for every path that claims.
                    await this.claim(live, this.currentCampaign ?? campaign);
                    // Either the campaign is done or the next drop needs re-selecting.
                    return;
                }

                // Sleep the remainder of the interval rather than a flat 59s, so the work
                // above does not push successive beats past the minute Twitch credits.
                // Deliberately NOT jittered: the official player beats on a precise cadence,
                // so randomising here would make us less like it, not more.
                const elapsed = Date.now() - beatStart;
                await sleep(Math.max(0, WATCH_INTERVAL_MS - elapsed));
            }
        } finally {
            this.pubsub?.unlisten(streamTopic);
            this.currentChannel = null;
            this.currentDrop = null;
            this.currentCampaign = null;
            this.miningSince = null;
        }
    }

    /**
     * Ask Twitch whether the current session on this channel is being credited.
     *
     * Treated as innocent-until-proven-guilty: only an explicit "no session" verdict counts
     * against the channel, because a failed request or an unfamiliar shape is our problem,
     * not the streamer's.
     */
    private async isSessionEarning(channel: Channel, drop: Drop): Promise<boolean> {
        try {
            const session = await this.gql.getCurrentDropSession(channel.id);
            if (!session) {
                return false;
            }
            // Progress may legitimately land on a sibling drop of the same campaign.
            if (session.dropId === drop.id && session.currentMinutes > drop.currentMinutes) {
                drop.update({ currentMinutesWatched: session.currentMinutes });
                this.lastProgressAt = Date.now();
                this.unconfirmedBeats = 0;
            }
            return true;
        } catch (error) {
            logger.debug("Could not read the current drop session:", error);
            return true;
        }
    }

    /** Re-read progress from the inventory when PubSub has gone silent. */
    private async reconcileProgress(drop: Drop): Promise<boolean> {
        try {
            const inventory = await this.gql.getInventory();
            for (const campaign of inventory.dropCampaignsInProgress ?? []) {
                for (const entry of campaign.timeBasedDrops ?? []) {
                    if (entry.id !== drop.id || !entry.self) {
                        continue;
                    }
                    const advanced = entry.self.currentMinutesWatched > drop.currentMinutes;
                    drop.update(entry.self);
                    if (advanced) {
                        this.lastProgressAt = Date.now();
                        this.unconfirmedBeats = 0;
                        logger.debug(
                            `Inventory reports ${drop.currentMinutes}/${drop.requiredMinutes} min`,
                        );
                    }
                    return advanced;
                }
            }
        } catch (error) {
            logger.debug("Inventory reconciliation failed:", error);
        }
        return false;
    }

    private penalise(channel: Channel): void {
        this.channelCooldowns.set(channel.login, Date.now() + CHANNEL_COOLDOWN_MS);
    }

    private async claim(drop: Drop, campaign: Campaign): Promise<void> {
        if (this.claimedDropIds.has(drop.id) || this.failedClaimIds.has(drop.id)) {
            return;
        }
        // Twitch does not always hand back an instance ID, but it is composed of IDs we
        // already have, so derive it rather than abandoning a finished drop.
        const instanceId =
            drop.dropInstanceId ?? `${this.auth.userId}#${campaign.id}#${drop.id}`;
        if (this.dryRun) {
            logger.info(`[dry run] Would claim: ${drop.rewardNames} (${campaign.gameName})`);
            return;
        }

        // Claiming a drop on an unlinked campaign is the point of no return for some
        // publishers, so flag it - and optionally stop short of claiming.
        if (!campaign.isDeliverable && !this.notifiedUnlinkedClaims.has(drop.id)) {
            const held = this.config.holdClaimsWhenUnlinked;
            // Held drops stay claimable, so this would otherwise re-fire every refresh.
            this.notifiedUnlinkedClaims.add(drop.id);
            this.persistState();
            this.emit("unlinked-claim", { campaign, drop, held });
            if (held) {
                logger.warn(
                    `Holding the claim for ${drop.rewardNames} - ${campaign.gameName} is not ` +
                        "linked to your Twitch account.",
                );
                this.pushFeed(
                    "warn",
                    `Holding ${drop.rewardNames} - ${campaign.gameName} is not linked`,
                );
                return;
            }
        }
        try {
            const claimed = await this.gql.claimDrop(instanceId);
            if (claimed) {
                drop.isClaimed = true;
                this.claimedDropIds.add(drop.id);
                logger.info(`Claimed: ${drop.rewardNames} (${campaign.gameName})`);
                this.recentClaims.push({
                    at: Date.now(),
                    dropId: drop.id,
                    campaignId: campaign.id,
                    dropName: drop.rewardNames || drop.name,
                    gameName: campaign.gameName,
                    rewardImageURL: drop.data.benefitEdges[0]?.benefit.imageAssetURL ?? null,
                });
                if (this.recentClaims.length > 100) {
                    this.recentClaims.shift();
                }
                this.claimHistory.claims.push(this.recentClaims.at(-1)!);
                this.persistClaims();
                this.pushFeed("info", `Claimed ${drop.rewardNames} (${campaign.gameName})`);
                this.emit("drop-claimed", { drop, campaign });
                this.recordCompletionIfFinished(campaign);
            } else {
                // Almost always a drop Twitch considers ineligible rather than a transient
                // failure, so stop asking rather than repeating it every refresh.
                this.failedClaimIds.add(drop.id);
                this.persistState();
                logger.debug(`Twitch did not confirm the claim for ${drop.name}`);
            }
        } catch (error) {
            logger.error(`Failed to claim ${drop.name}:`, error);
        }
    }

    private attachPubSubHandlers(pubsub: PubSubPool): void {
        pubsub.on("drop-progress", (message: DropProgressMessage) => {
            const drop = this.findDropById(message.drop_id);
            if (!drop) {
                return;
            }
            const advanced = message.current_progress_min > drop.currentMinutes;
            drop.update({ currentMinutesWatched: message.current_progress_min });
            if (advanced) {
                this.lastProgressAt = Date.now();
                this.unconfirmedBeats = 0;
            }
            // Progress can land against a drop other than the one we targeted when a game
            // runs several campaigns at once; that still counts as the bot working.
            if (drop.id === this.currentDrop?.id) {
                this.emit("progress", {
                    drop,
                    minutes: message.current_progress_min,
                    required: message.required_progress_min,
                });
                logger.debug(
                    `${drop.name}: ${message.current_progress_min}/${message.required_progress_min} min`,
                );
            }
        });

        pubsub.on("drop-claim", async (message) => {
            const drop = this.findDropById(message.drop_id);
            if (!drop) {
                return;
            }
            drop.dropInstanceId = message.drop_instance_id;
            if (this.config.autoClaimDrops) {
                const campaign = this.campaigns.get(drop.campaign.id);
                await this.claim(drop, campaign ?? drop.campaign);
            }
        });

        pubsub.on("stream-up", ({ channelId }) => {
            this.onTrackedChannelUp(channelId);
        });

        pubsub.on("stream-down", ({ channelId }) => {
            const tracked = this.watchlist.get(channelId);
            if (tracked) {
                tracked.online = false;
            }
            const channel = this.currentChannel;
            if (channel !== null && channel.id === channelId) {
                logger.info(`${channel.displayName} ended their stream.`);
                channel.markOffline();
            }
        });

        pubsub.on("viewcount", ({ channelId, viewers }) => {
            const channel = this.currentChannel;
            if (channel !== null && channel.id === channelId && channel.stream) {
                channel.stream.viewers = viewers;
            }
        });

        pubsub.on("reward-notification", () => {
            logger.debug("Twitch reported a reward; refreshing campaigns.");
            void this.refreshCampaigns().catch((error) => {
                logger.debug("Refresh after reward notification failed:", error);
            });
        });

        pubsub.on("points-claim-available", async ({ channelId, claimId }) => {
            if (!this.config.autoClaimPoints || !claimId) {
                return;
            }
            try {
                await this.gql.query("claimChannelPoints", {
                    input: { claimID: claimId, channelID: channelId },
                });
                logger.debug(`Claimed channel points bonus on ${channelId}`);
            } catch (error) {
                logger.debug("Channel points claim failed:", error);
            }
        });
    }

    private findDropById(dropId: string): Drop | null {
        for (const campaign of this.campaigns.values()) {
            const drop = campaign.drops.find((candidate) => candidate.id === dropId);
            if (drop) {
                return drop;
            }
        }
        return null;
    }

    private scheduleCampaignRefresh(): void {
        const interval = this.config.campaignRefreshMinutes * 60_000;
        this.nextRefreshAt = Date.now() + interval;
        const tick = async () => {
            if (this.stopping) {
                return;
            }
            try {
                const previous = this.currentBestCampaignId();
                await this.refreshCampaigns();
                const next = this.currentBestCampaignId();
                // Only interrupt an in-progress watch if something genuinely better appeared.
                if (next && next !== previous && this.currentChannel) {
                    this.switchRequested = true;
                }
            } catch (error) {
                logger.error("Campaign refresh failed:", error);
            } finally {
                this.nextRefreshAt = Date.now() + interval;
                setTimeout(tick, interval).unref();
            }
        };
        setTimeout(tick, interval).unref();
    }

    /**
     * Point the running watch loop at the objects this refresh just built.
     *
     * A refresh replaces every Campaign and Drop instance, but the loop captured the old
     * ones. PubSub handlers and the claim sweep both resolve through the new map, so the
     * loop would go on inspecting a drop nothing updates any more: after a drop was claimed
     * at refresh time the loop kept beating, saw no progress for fifteen minutes, and
     * benched a perfectly good channel for thirty.
     */
    private rebindWatchedObjects(next: Map<string, Campaign>): void {
        const campaignId = this.currentCampaign?.id;
        const dropId = this.currentDrop?.id;
        if (!campaignId || !dropId) {
            return;
        }

        const campaign = next.get(campaignId);
        const drop = campaign?.drops.find((candidate) => candidate.id === dropId);

        if (!campaign || !drop || drop.isClaimed || !campaign.isActive) {
            // Nothing left to earn here; let the loop yield at its next beat.
            this.switchRequested = true;
            return;
        }
        this.currentCampaign = campaign;
        this.currentDrop = drop;
    }

    /**
     * Flag unlinked campaigns that already hold earned progress and are about to expire.
     *
     * This is the only moment the user can still act: linking the account before the
     * campaign ends converts watch time that would otherwise be discarded into a reward.
     * Fires once per campaign, since repeating it every refresh would train the user to
     * ignore it.
     */
    private warnAboutExpiringUnlinked(): void {
        const hours = this.config.unlinkedExpiryWarningHours;
        if (!hours || hours <= 0) {
            return;
        }
        const horizon = Date.now() + hours * 3_600_000;

        for (const campaign of this.campaigns.values()) {
            if (
                !campaign.isActive ||
                campaign.isDeliverable ||
                this.warnedExpiring.has(campaign.id) ||
                campaign.endAt.getTime() > horizon
            ) {
                continue;
            }
            const earned = campaign.drops.filter(
                (drop) => !drop.isClaimed && drop.currentMinutes > 0,
            );
            if (earned.length === 0) {
                continue;
            }

            this.warnedExpiring.add(campaign.id);
            this.persistState();
            const earnedMinutes = earned.reduce((sum, drop) => sum + drop.currentMinutes, 0);
            const hoursLeft = (campaign.endAt.getTime() - Date.now()) / 3_600_000;
            logger.warn(
                `${campaign.gameName} expires in ${hoursLeft.toFixed(1)}h with ` +
                    `${earnedMinutes} minutes earned but the account is not linked.`,
            );
            this.pushFeed(
                "warn",
                `${campaign.gameName}: ${earnedMinutes} min earned but not linked, expires soon`,
            );
            this.emit("unlinked-expiring", {
                campaign,
                earnedMinutes,
                rewards: earned.map((drop) => drop.rewardNames || drop.name),
                hoursLeft,
            });
        }
    }

    /**
     * Keep PubSub subscriptions in step with the channels worth knowing about: every
     * allow-list channel of a mineable campaign, plus the user's preferred channels.
     *
     * This is what makes restricted campaigns workable. Their eligible channels are often
     * offline, and without a subscription we would only discover one went live at the next
     * poll - by which point a short stream may already be over.
     */
    private async syncWatchlist(): Promise<void> {
        const desired = new Map<string, { login: string; displayName: string; campaignIds: Set<string> }>();

        const add = (id: string, login: string, displayName: string, campaignId: string) => {
            if (!id || !login || this.isBlocked(login)) {
                return;
            }
            const existing = desired.get(id);
            if (existing) {
                existing.campaignIds.add(campaignId);
                return;
            }
            if (desired.size >= MAX_TRACKED_CHANNELS) {
                return;
            }
            desired.set(id, { login, displayName, campaignIds: new Set([campaignId]) });
        };

        for (const campaign of this.getMineableCampaigns()) {
            for (const channel of campaign.data.allow?.channels ?? []) {
                const login = (channel.name ?? channel.displayName ?? "").toLowerCase();
                add(channel.id, login, channel.displayName ?? login, campaign.id);
            }
        }

        // Preferred channels are configured by login, so their IDs need resolving once each.
        for (const login of this.config.preferredChannels) {
            const key = login.toLowerCase();
            let id = this.channelIdCache.get(key);
            if (!id) {
                const info = await this.gql.getStreamInfo(key).catch(() => null);
                if (!info?.id) {
                    continue;
                }
                id = info.id;
                this.channelIdCache.set(key, id);
            }
            add(id, key, login, "preferred");
        }

        for (const [id, entry] of this.watchlist) {
            if (!desired.has(id)) {
                this.pubsub?.unlisten(`video-playback-by-id.${id}`);
                this.watchlist.delete(id);
            } else {
                entry.campaignIds = desired.get(id)!.campaignIds;
            }
        }

        for (const [id, entry] of desired) {
            if (this.watchlist.has(id)) {
                continue;
            }
            this.watchlist.set(id, { id, ...entry, online: false });
            this.pubsub?.listen(`video-playback-by-id.${id}`);
        }

        if (this.watchlist.size > 0) {
            logger.debug(`Tracking ${this.watchlist.size} channels for status changes`);
        }
    }

    /**
     * A tracked channel came online. Switch to it if it serves a campaign that outranks
     * whatever we are mining now.
     */
    private onTrackedChannelUp(channelId: string): void {
        const entry = this.watchlist.get(channelId);
        if (!entry) {
            return;
        }
        entry.online = true;

        const current = this.currentCampaign;
        if (!current) {
            // Idle: the main loop will pick this up on its next pass.
            return;
        }

        const ranked = this.getMineableCampaigns();
        const currentRank = ranked.findIndex((campaign) => campaign.id === current.id);
        const betterRank = ranked.findIndex(
            (campaign) => entry.campaignIds.has(campaign.id) || entry.campaignIds.has("preferred"),
        );
        if (betterRank !== -1 && currentRank !== -1 && betterRank < currentRank) {
            logger.info(`${entry.displayName} came online for a higher-priority campaign.`);
            this.pushFeed("info", `${entry.displayName} came online - switching`);
            this.switchRequested = true;
        }
    }

    /**
     * Refresh the moment a campaign or drop becomes available, rather than up to a full poll
     * interval later. Short campaigns - 15-minute drops are common - can otherwise be half
     * over before the regular refresh notices them.
     */
    private scheduleBoundaryRefresh(): void {
        if (this.boundaryTimer) {
            clearTimeout(this.boundaryTimer);
            this.boundaryTimer = null;
        }

        const now = Date.now();
        let soonest = Number.POSITIVE_INFINITY;
        for (const campaign of this.campaigns.values()) {
            for (const moment of [campaign.startAt.getTime(), campaign.endAt.getTime()]) {
                if (moment > now && moment < soonest) {
                    soonest = moment;
                }
            }
            // Tiered drops unlock on their own schedule, independent of the campaign's.
            for (const drop of campaign.drops) {
                const start = drop.startAt.getTime();
                if (start > now && start < soonest) {
                    soonest = start;
                }
            }
        }
        if (!Number.isFinite(soonest)) {
            return;
        }

        // A few seconds past the boundary, so Twitch has flipped the status before we ask.
        const delay = soonest - now + 5_000;
        const regularInterval = this.config.campaignRefreshMinutes * 60_000;
        if (delay >= regularInterval) {
            // The scheduled refresh already covers it.
            return;
        }

        this.boundaryTimer = setTimeout(
            () => {
                if (this.stopping) {
                    return;
                }
                logger.debug("Campaign boundary reached, refreshing early");
                void this.refreshCampaigns().catch((error) => {
                    logger.debug("Boundary refresh failed:", error);
                });
            },
            Math.max(60_000, delay),
        ).unref();
    }

    private currentBestCampaignId(): string | undefined {
        return this.selectCampaign()?.id;
    }

    /** Re-read every campaign and fold in our inventory progress. */
    /**
     * Exercise the whole pipeline without touching anything: log in, read campaigns and
     * progress, pick what would be mined, find a channel, and resolve its Spade URL.
     *
     * This proves every moving part except the watch beat itself, and sends no watch events
     * and claims nothing.
     */
    async runDryRun(): Promise<void> {
        this.dryRun = true;
        const line = "-".repeat(66);

        console.log(`\n${line}\nDRY RUN - nothing will be watched or claimed\n${line}`);
        console.log(`Account: ${this.auth.login} (id ${this.auth.userId})\n`);

        await this.refreshCampaigns();

        const all = [...this.campaigns.values()];
        const active = all.filter((campaign) => campaign.isActive);
        console.log(`Campaigns visible: ${all.length}  (${active.length} active)\n`);

        const mineable = active
            .filter((campaign) => !campaign.isCompleted)
            .sort((a, b) => compareCampaigns(a, b, this.rankingOptions()));

        if (mineable.length === 0) {
            console.log("No campaigns with work remaining. Nothing to mine right now.");
            console.log("This is a normal result - it depends on what Twitch is running today.\n");
        } else {
            console.log(`Campaigns with work remaining (${mineable.length}), in priority order:`);
            for (const campaign of mineable.slice(0, 12)) {
                const drop = campaign.nextDrop({ attemptImpossible: true });
                const progress = drop
                    ? `${drop.currentMinutes}/${drop.requiredMinutes} min - ${drop.rewardNames}`
                    : "no eligible drop";
                const linked = campaign.isAccountLinked ? "" : "  [ACCOUNT NOT LINKED]";
                console.log(`  ${campaign.gameName} - ${campaign.name}`);
                console.log(`      ${progress}${linked}`);
            }
            console.log("");
        }

        const upcoming = this.getUpcomingCampaigns();
        if (upcoming.length > 0) {
            console.log(`Upcoming campaigns (${upcoming.length}), soonest first:`);
            for (const campaign of upcoming.slice(0, 8)) {
                const days = (campaign.startAt.getTime() - Date.now()) / 86_400_000;
                const when =
                    days < 1
                        ? `in ${Math.max(1, Math.round(days * 24))}h`
                        : `in ${Math.round(days)}d`;
                const rewards = campaign.drops
                    .map((drop) => drop.rewardNames)
                    .filter(Boolean)
                    .join(", ");
                console.log(`  ${campaign.gameName} - ${campaign.name}  (starts ${when})`);
                if (rewards) {
                    console.log(`      ${rewards}`);
                }
            }
            console.log("");
        }

        const candidates = this.selectCampaigns();
        if (candidates.length === 0) {
            console.log("Nothing selected to mine. Dry run complete.\n");
            return;
        }

        // Mirror the real loop: walk down the ranking until a campaign has a live channel.
        console.log("Looking for a campaign with a live, eligible channel...\n");
        let channel = null;
        let target = null;
        let drop = null;
        let examined = 0;

        for (const campaign of candidates) {
            if (examined >= MAX_CAMPAIGNS_PER_CYCLE) {
                break;
            }
            const next = campaign.nextDrop({
                attemptImpossible: this.config.attemptImpossibleCampaigns,
            });
            if (!next) {
                continue;
            }
            examined++;
            process.stdout.write(`  ${examined}. ${campaign.gameName} - ${campaign.name} ... `);
            const found = await this.findChannel(campaign);
            if (!found) {
                console.log("no live channel");
                continue;
            }
            console.log(`${found.displayName} (${found.stream?.viewers ?? 0} viewers)`);
            channel = found;
            target = campaign;
            drop = next;
            break;
        }

        if (!channel || !target) {
            console.log(
                `\n  Checked ${examined} campaigns; none had a live, eligible channel right now.`,
            );
            console.log("  Channel selection ran correctly - this is simply what is online.\n");
            return;
        }

        console.log(`\nWould mine: ${target.gameName} - ${target.name}`);
        if (drop) {
            console.log(`Target drop: ${drop.rewardNames} (${drop.remainingMinutes} min remaining)`);
        }
        if (!target.isAccountLinked) {
            console.log("NOTE: this campaign is not linked to your Twitch account -");
            console.log("      progress is tracked but the reward will not reach the game.");
        }
        console.log(`Channel: ${channel.displayName} - verified it grants this campaign.`);

        // Resolving the Spade URL is the one piece most likely to rot, so prove it here.
        console.log("\nResolving the Spade watch endpoint...");
        try {
            const spade = await channel.probeSpadeUrl();
            console.log(`  OK: ${spade}`);
            console.log("  A real run would POST a minute-watched event here every 59s.");
        } catch (error) {
            console.log(`  FAILED: ${(error as Error).message}`);
            console.log("  Twitch likely changed the channel page; see README > Maintenance.");
        }

        console.log(`\n${line}\nDry run complete. Nothing was watched or claimed.\n${line}\n`);
    }

    private async refreshCampaigns(): Promise<void> {
        logger.debug("Refreshing campaigns...");
        const [listed, inventory] = await Promise.all([
            this.gql.getCampaigns(),
            this.gql.getInventory().catch(() => null),
        ]);

        // New shuffle each cycle, so "random" mode does not settle on a fixed order.
        this.randomKeys = new Map();

        const next = new Map<string, Campaign>();
        for (const data of listed) {
            if (data.status === "EXPIRED") {
                // Keep recently-ended campaigns so anything finished but unclaimed can still
                // be collected within the grace window. They cannot be mined - every drop is
                // inactive, so the campaign never becomes selectable.
                const endedAgo = Date.now() - new Date(data.endAt).getTime();
                if (endedAgo > CLAIM_GRACE_MS) {
                    continue;
                }
            }
            next.set(data.id, new Campaign(data));
            this.randomKeys.set(data.id, Math.random());
        }

        // The campaign list omits drop details, so fetch them for anything we might mine.
        // Restricting this to interesting campaigns keeps the request count sane.
        const interesting = [...next.values()]
            // Upcoming campaigns are included so we can show what is coming and what it
            // rewards, even though they cannot be mined yet. Recently-ended ones are included
            // because the campaign list carries no drops: without their details the claim
            // grace window has nothing to claim and quietly does nothing.
            .filter(
                (campaign) =>
                    campaign.isActive ||
                    campaign.isUpcoming ||
                    campaign.isInClaimGrace(CLAIM_GRACE_MS),
            )
            .filter(
                (campaign) =>
                    !this.config.excludedGames.some((game) => this.matchesGame(game, campaign)),
            )
            .filter(
                (campaign) =>
                    this.config.priorityMode !== "priority_only" ||
                    this.config.priorityGames.some((game) => this.matchesGame(game, campaign)),
            )
            .sort((a, b) => compareCampaigns(a, b, this.rankingOptions()));

        for (const campaign of interesting) {
            try {
                const details = await this.gql.getCampaignDetails(campaign.id);
                if (details) {
                    next.set(campaign.id, campaign.merge(details));
                }
            } catch (error) {
                logger.debug(`Could not fetch details for ${campaign.name}:`, error);
            }
        }

        // A fully claimed campaign disappears from dropCampaignsInProgress, and
        // DropCampaignDetails carries no `self` block at all, so nothing above knows the
        // drops were already collected - the campaign looks brand new and gets mined again
        // from zero. gameEventDrops is the surviving proof of ownership: it lists every
        // reward actually granted, so reconcile against it before trusting the zeroes.
        const ownedBenefits = new Map<string, number>();
        for (const reward of inventory?.gameEventDrops ?? []) {
            const awarded = Date.parse(reward.lastAwardedAt);
            for (const key of [reward.id, reward.name?.toLowerCase()]) {
                if (key) {
                    ownedBenefits.set(key, Number.isNaN(awarded) ? 0 : awarded);
                }
            }
        }

        if (ownedBenefits.size > 0) {
            for (const campaign of next.values()) {
                const startedAt = campaign.startAt.getTime();
                for (const drop of campaign.drops) {
                    if (drop.isClaimed || drop.data.benefitEdges.length === 0) {
                        continue;
                    }
                    // Every reward in the drop must be owned, and granted no earlier than
                    // the campaign began - the same reward can recur across seasons.
                    const owned = drop.data.benefitEdges.every((edge) => {
                        const awarded =
                            ownedBenefits.get(edge.benefit.id) ??
                            ownedBenefits.get(edge.benefit.name?.toLowerCase() ?? "");
                        return awarded !== undefined && awarded >= startedAt;
                    });
                    if (owned) {
                        drop.update({
                            isClaimed: true,
                            currentMinutesWatched: drop.requiredMinutes,
                        });
                        this.claimedDropIds.add(drop.id);
                    }
                }
            }
        }

        // Inventory is the authoritative source for how far along we are.
        for (const inProgress of inventory?.dropCampaignsInProgress ?? []) {
            const campaign = next.get(inProgress.id);
            if (!campaign) {
                continue;
            }
            for (const entry of inProgress.timeBasedDrops ?? []) {
                const drop = campaign.drops.find((candidate) => candidate.id === entry.id);
                if (drop && entry.self) {
                    drop.update(entry.self);
                    if (entry.self.isClaimed) {
                        this.claimedDropIds.add(drop.id);
                    }
                }
            }
        }

        this.campaigns = next;
        this.reconcileCompletions();
        this.rebindWatchedObjects(next);
        this.scheduleBoundaryRefresh();
        this.warnAboutExpiringUnlinked();
        await this.syncWatchlist();
        const mineable = [...next.values()].filter(
            (campaign) => campaign.isActive && !campaign.isCompleted,
        );
        logger.info(`${next.size} campaigns known, ${mineable.length} with work remaining.`);
        this.pushFeed(
            "info",
            `Refreshed campaigns: ${next.size} known, ${mineable.length} with work remaining`,
        );
        this.emit("campaigns-updated", [...next.values()]);

        // Claim anything that finished while we were not looking.
        if (this.config.autoClaimDrops && !this.dryRun) {
            for (const campaign of next.values()) {
                for (const drop of campaign.claimableDrops) {
                    await this.claim(drop, campaign);
                }
            }
        }
    }
}
