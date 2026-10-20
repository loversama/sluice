import { EventEmitter } from "node:events";

import logger from "./logger.js";
import type { Config } from "./config.js";
import { classifyIdle, sameIdle, type IdleState } from "./idle.js";
import {
    Campaign,
    compareCampaigns,
    isInLibraryScope,
    type Drop,
    type RankingOptions,
} from "./models/campaign.js";
import { Channel } from "./models/channel.js";
import type { AuthState } from "./twitch/auth.js";
import { AuthExpiredError, StaleQueryHashError, type TwitchGql } from "./twitch/gql.js";
import { fetchCatalogue } from "./twitch/catalogue.js";
import type { DropCampaign } from "./twitch/types.js";
import { PubSubPool, type DropProgressMessage } from "./twitch/websocket.js";
import type { SteamLibrary } from "./steam/library.js";
import { loadState, saveState } from "./state.js";
import { loadClaims, saveClaims, summarise, type ClaimHistory, type ClaimStats } from "./claims.js";
import { WATCH_INTERVAL_MS } from "./twitch/constants.js";
import { detectForeignSession, type ProgressSnapshot } from "./foreign-session.js";
import { dailyLimitVerdict, isWithinSchedule } from "./schedule.js";
import {
    applyKnownClaims,
    describeIdle,
    describeLeave,
    describeNext,
    isDeliberateStop,
    type WatchEnd,
} from "./transitions.js";

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
 * Consecutive rejected beats tolerated before benching the channel. A single CDN or playlist
 * hiccup is common and should not cost a thirty-minute exclusion.
 */
const MAX_BEAT_FAILURES = 3;
/** How long a channel that failed stays out of the rotation. */
const CHANNEL_COOLDOWN_MS = 30 * 60_000;
/**
 * How long a campaign whose finished drop cannot be claimed stays out of the rotation.
 * Long enough to break a tight loop, short enough that a claim Twitch was merely slow to
 * accept is retried the same hour.
 */
const CLAIM_STUCK_COOLDOWN_MS = 10 * 60_000;
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

/**
 * How much claim history to hold in memory.
 *
 * Matches the on-disk cap, so the two views agree. Anything older is still in the file;
 * nothing that reads this needs more than the recent run.
 */
const MAX_IN_MEMORY_CLAIMS = 1000;

function mentionsDrops(channel: Channel): boolean {
    return DROPS_IN_TITLE.test(channel.stream?.title ?? "");
}

/**
 * How many campaign detail requests are in flight at once.
 *
 * Four is a compromise, not a measurement: it takes the cold start from around 27s to
 * around 7s on a busy account while staying modest against an API that is not published
 * and not rate-limit documented. Raising it buys progressively less and risks a 429, whose
 * cost is a sweep that finds nothing rather than a sweep that is slow.
 */
const CAMPAIGN_DETAIL_CONCURRENCY = 4;

/**
 * How many times one drop may be claimed before the miner stops trying.
 *
 * Three, because the correct number is one and anything above that is a disagreement with
 * Twitch that claiming again will not settle.
 */
const MAX_CLAIM_ATTEMPTS = 3;

/**
 * How long the idle wait sleeps before re-checking of its own accord.
 *
 * Selection runs against campaigns already held in memory, so a pass costs almost nothing;
 * this is what catches an upcoming campaign's start time arriving with nobody to announce
 * it.
 */
const IDLE_RECHECK_MS = 60_000;

export interface MinerEvents {
    "campaigns-updated": [Campaign[]];
    "watching": [{ channel: Channel; campaign: Campaign; drop: Drop }];
    "progress": [{ drop: Drop; minutes: number; required: number }];
    "drop-claimed": [{ drop: Drop; campaign: Campaign }];
    "campaign-completed": [Campaign];
    /** Emitted after each accepted watch beat; drives the dashboard heartbeat. */
    beat: [{ at: number }];
    /**
     * There is nothing to watch, and why.
     *
     * Sent when the situation changes rather than on every pass, and cleared by the next
     * `watching`. Without it the dashboard cannot tell "between channels" from "finished",
     * and goes on showing the last thing it saw.
     */
    idle: [IdleState];
    /** A drop finished on a campaign the account is not linked to. */
    "unlinked-claim": [{ campaign: Campaign; drop: Drop; held: boolean }];
    /** Progress has been earned on an unlinked campaign that is about to expire. */
    "unlinked-expiring": [
        { campaign: Campaign; earnedMinutes: number; rewards: string[]; hoursLeft: number },
    ];
    /**
     * How far through starting up we are.
     *
     * Fetching campaign details is one request per campaign, sequentially, and on a busy
     * account that is half a minute during which the dashboard otherwise shows nothing and
     * looks broken. This is what it shows instead.
     */
    loading: [{ phase: LoadingPhase; done?: number; total?: number; background?: boolean }];
    /** Human-readable activity line for the dashboard feed. */
    feed: [FeedEntry];
    /**
     * Whether the miner is running has changed: paused or resumed, outside the schedule
     * or back in it, at the daily limit or past it, or off the channel it was watching.
     *
     * Carries nothing. It is sent after the change has been made, so anything read in
     * response - the dashboard's state snapshot - already reflects it.
     */
    status: [];
    error: [Error];
}

/** Startup stages, in the order they happen. */
export type LoadingPhase = "campaigns" | "details" | "choosing" | "ready";

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
    /**
     * Watch time this drop required, recorded here rather than looked up later.
     *
     * Deriving it from the live campaign store made the figure depend on state that is
     * empty for the first half-minute after a restart and that drops campaigns as they
     * rotate out - so the dashboard reported 0m on some loads and undercounted on all of
     * them. Optional only because records written before this change lack it.
     */
    requiredMinutes?: number;
    /** Whether the reward could actually reach the user, as judged when it was claimed. */
    deliverable?: boolean;
}

/** What the miner is doing right now, or null when idle. */
export interface MiningState {
    channel: {
        login: string;
        displayName: string;
        url: string;
        /** Live stream detail for the dashboard's channel panel. */
        title: string;
        viewers: number;
        game: string | null;
    };
    campaignId: string;
    dropId: string;
    since: number;
    /** When we started on this channel, unbroken across claims and campaign switches. */
    channelSince: number;
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
    /**
     * Channels and campaigns to leave alone until a timestamp passes.
     *
     * Pruned as it is read rather than merely consulted: entries were only ever added, one
     * per channel ever benched and one per campaign ever passed over, and campaign IDs turn
     * over constantly. A container restarted every deploy never noticed; a desktop app left
     * running for months would.
     */
    private readonly channelCooldowns = new Map<string, number>();
    /** Cleared whenever a claim lands or campaigns change; see getClaimStats. */
    private claimStats: ClaimStats | null = null;
    private readonly claimedDropIds = new Set<string>();
    /** Drops Twitch refused to claim, so a doomed claim is not retried every refresh. */
    private readonly failedClaimIds = new Set<string>();
    /**
     * Drops we asked Twitch to claim and Twitch said yes to.
     *
     * Kept apart from claimedDropIds, which also holds guesses made from the inventory's
     * owned-benefit list. Only a guess may be taken back.
     */
    private readonly confirmedClaimIds = new Set<string>();
    /**
     * How many times each drop has been claimed this session.
     *
     * A backstop rather than a mechanism. A drop is granted once, so claiming the same one
     * repeatedly always means our idea of what is claimed has diverged from Twitch's -
     * whatever the reason - and repeating it forever is never the right answer. One such
     * divergence produced forty-one claims of a GTA V reward in nine hours before anyone
     * noticed; this caps the damage from the next one at three.
     */
    private readonly claimAttempts = new Map<string, number>();

    private pubsub: PubSubPool | null = null;
    private currentChannel: Channel | null = null;
    private currentDrop: Drop | null = null;
    private foreignSessionAt: number | null = null;
    /** Whether the schedule allowed mining last time it was looked at, for logging changes. */
    private scheduleAllowed = true;

    /**
     * Minutes mined so far today, and which local day that is.
     *
     * Held in memory: a restart forgets the day's tally, which is a real hole for anyone
     * using the limit to divide time between machines. Persisting it belongs with the rest
     * of the daily bookkeeping rather than bolted on here.
     */
    private minedToday = 0;
    private minedTodayOn = new Date().toDateString();
    /** Whether the daily limit was stopping mining last time it was looked at. */
    private atDailyLimit = false;
    private lastProgressAt = 0;

    /** Drop minutes as of the last sweep, for spotting another session earning as us. */
    private lastProgress: ProgressSnapshot = { minutes: new Map(), dropId: null };
    /**
     * Campaigns pushed to the back by the Next button, by id, valued with when.
     *
     * Held in memory rather than config: it is a "not right now", not a preference, and
     * surviving a restart would silently sink a campaign the user had forgotten skipping.
     */
    private readonly deferredCampaigns = new Map<string, number>();
    /** Campaigns already warned about as unlinked while mining, so the warning is not repeated. */
    private readonly warnedUnlinkedMining = new Set<string>();

    /** Set when a better campaign appears, so the watch loop yields at its next beat. */
    private switchRequested = false;
    private stopping = false;
    /** Campaigns came from the public catalogue last refresh; logged once, not every sweep. */
    private usingCatalogue = false;
    /** The campaign sweep in progress, which any other caller joins rather than repeats. */
    private refreshing: Promise<void> | null = null;
    /** The last refresh could not read the inventory; reported once per run of failures. */
    private inventoryFailing = false;
    /** Why there is nothing to mine, or null while watching. */
    private idleState: IdleState | null = null;
    /** Resolves the interruptible idle wait early. Set only while that wait is in progress. */
    private wakeIdle: (() => void) | null = null;
    /** When true, the miner reads and reports but never sends watch beats or claims. */
    dryRun = false;
    /** Paused by the user. Campaigns keep refreshing; nothing is watched or claimed. */
    private paused = false;

    private currentCampaign: Campaign | null = null;
    private miningSince: number | null = null;
    /**
     * Continuous time on the current channel, kept across re-entries into the watch loop.
     *
     * The loop is re-entered after every claim and every priority switch, so resetting on
     * entry reported "watched 4m" after an hour on the same streamer. This only restarts
     * when the channel genuinely changes.
     */
    private channelWatchStart: number | null = null;
    private lastWatchedLogin: string | null = null;
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
    /** Held so a config change can re-arm it, and so stop() can actually cancel it. */
    private refreshTimer: NodeJS.Timeout | null = null;
    /** Bumped each time the refresh timer is armed; a tick from an older chain stops. */
    private refreshGeneration = 0;
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
        state.confirmedClaims?.forEach((id: string) => {
            this.confirmedClaimIds.add(id);
            this.claimedDropIds.add(id);
        });
        logger.debug(
            `Restored notification state: ${this.warnedExpiring.size} warned campaigns, ` +
                `${this.notifiedUnlinkedClaims.size} flagged claims`,
        );
    }

    /** Restore the durable record of what has been earned. */
    async loadClaimHistory(path: string): Promise<void> {
        this.claimStats = null;
        this.claimsPath = path;
        this.claimHistory = await loadClaims(path);
        // Seed the in-memory view so a fresh process still shows recent claims.
        this.recentClaims.push(...this.claimHistory.claims.slice(-100));
        // Backfill the activity feed too, carrying each claim's real timestamp, so the log
        // has history behind it rather than starting blank at every restart.
        this.feedEntries.unshift(
            ...this.claimHistory.claims.slice(-60).map((claim) => ({
                at: claim.at,
                level: "info" as const,
                message: `Claimed ${claim.dropName} (${claim.gameName})`,
            })),
        );
        this.feedEntries.sort((a, b) => a.at - b.at);
        logger.debug(`Restored ${this.claimHistory.claims.length} claims from history`);
    }

    /** Lifetime totals for the dashboard. */
    /**
     * Lifetime totals for the dashboard.
     *
     * Memoised because the dashboard asks on every poll and the answer only changes when a
     * drop is claimed or campaigns are refreshed - both of which clear it. Recomputing it
     * meant walking the whole claim history several times a minute, for a number that had
     * not moved.
     */
    getClaimStats(): ClaimStats {
        if (this.claimStats) {
            return this.claimStats;
        }
        const required = new Map<string, number>();
        const deliverable = new Map<string, boolean>();
        for (const campaign of this.campaigns.values()) {
            deliverable.set(campaign.id, campaign.isDeliverable);
            for (const drop of campaign.drops) {
                required.set(drop.id, drop.requiredMinutes);
            }
        }
        this.claimStats = summarise(this.claimHistory, required, deliverable);
        return this.claimStats;
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
        // Done with, but not complete: a drop that could not be claimed is a reward the
        // user does not have, and "Campaign complete" would tell them they do.
        if (campaign.drops.some((drop) => drop.givenUp)) {
            return;
        }
        this.claimHistory.completedCampaignIds.push(campaign.id);
        this.persistClaims();
        logger.info(`Completed campaign: ${campaign.gameName} - ${campaign.name}`);
        this.emit("campaign-completed", campaign);
    }

    /**
     * Fill in numbers on claims written before the record carried them, using whatever the
     * campaign store still knows. Runs on refresh, so a claim keeps its figures even after
     * its campaign rotates out of view.
     */
    private backfillClaimRecords(): void {
        let changed = false;
        for (const claim of this.claimHistory.claims) {
            if (claim.requiredMinutes !== undefined && claim.deliverable !== undefined) {
                continue;
            }
            const campaign = this.campaigns.get(claim.campaignId);
            if (!campaign) {
                continue;
            }
            const drop = campaign.drops.find((candidate) => candidate.id === claim.dropId);
            if (claim.requiredMinutes === undefined && drop) {
                claim.requiredMinutes = drop.requiredMinutes;
                changed = true;
            }
            if (claim.deliverable === undefined) {
                claim.deliverable = campaign.isDeliverable;
                changed = true;
            }
        }
        if (changed) {
            this.persistClaims();
        }
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
            confirmedClaims: [...this.confirmedClaimIds],
        });
    }

    /**
     * Whether the clock currently allows mining.
     *
     * Logged on change rather than every call: this is asked every few seconds, and the
     * interesting moment is the transition, not the state.
     */
    /** One accepted beat is one minute watched. Rolls over at local midnight. */
    private countMinuteMined(): void {
        const today = new Date().toDateString();
        if (today !== this.minedTodayOn) {
            this.minedTodayOn = today;
            this.minedToday = 0;
        }
        this.minedToday += 1;
    }

    /** Minutes mined today, for the dashboard. */
    get minedTodayMinutes(): number {
        return this.minedTodayOn === new Date().toDateString() ? this.minedToday : 0;
    }

    /**
     * Whether the day's allowance still permits mining, and says so once when it does not.
     */
    withinDailyLimit(): boolean {
        const drop = this.currentDrop;
        const remaining = drop ? Math.max(0, drop.requiredMinutes - drop.currentMinutes) : null;
        const verdict = dailyLimitVerdict(this.config.dailyLimit, this.minedTodayMinutes, remaining);

        const stop = verdict === "stop";
        // On change, in both directions. Only arriving was ever noticed, and the flag that
        // noticed it was reset by the next minute mined - which, at the limit, never came -
        // so the second day's limit passed without a word.
        if (stop !== this.atDailyLimit) {
            this.atDailyLimit = stop;
            if (stop) {
                logger.info("Daily mining limit reached; stopping until tomorrow.");
                this.pushFeed("info", "Daily limit reached - mining again tomorrow");
            } else {
                logger.info("A new day's mining allowance; mining again.");
            }
            this.emit("status");
        }
        return !stop;
    }

    withinSchedule(): boolean {
        const allowed = isWithinSchedule(this.config.schedule, new Date());
        if (allowed !== this.scheduleAllowed) {
            this.scheduleAllowed = allowed;
            logger.info(allowed ? "Schedule window opened; mining." : "Outside the mining schedule; waiting.");
            this.pushFeed("info", allowed ? "Schedule window opened" : "Outside the mining schedule");
            this.emit("status");
        }
        return allowed;
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
        this.emit("status");
    }

    resume(): void {
        // Resuming should not wait out an idle sleep begun before the pause.
        this.wake();
        if (!this.paused) {
            return;
        }
        this.paused = false;
        logger.info("Resumed by request.");
        this.pushFeed("info", "Resumed");
        this.emit("status");
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

    /**
     * Move on to the next campaign, sending this one to the back of the queue.
     *
     * Distinct from skipChannel, which keeps the campaign and finds another streamer for
     * it. This is "I do not want this reward right now" - the campaign keeps its progress
     * and stays eligible, it simply stops being chosen ahead of everything else.
     */
    skipCampaign(): boolean {
        const campaign = this.currentCampaign;
        if (!campaign) {
            return false;
        }

        this.deferredCampaigns.set(campaign.id, Date.now());
        this.switchRequested = true;
        logger.info(`Deferring ${campaign.gameName} - ${campaign.name} by request.`);
        this.pushFeed("info", `Moved ${campaign.gameName} to the back of the queue`);
        return true;
    }

    /** Whether a campaign was sent to the back of the queue with Next. */
    isDeferred(campaignId: string): boolean {
        return this.deferredCampaigns.has(campaignId);
    }

    /** Put everything skipped by hand back in its usual place. */
    clearDeferrals(): number {
        const count = this.deferredCampaigns.size;
        this.deferredCampaigns.clear();
        if (count) {
            this.pushFeed("info", `Restored ${count} skipped campaign${count === 1 ? "" : "s"}`);
        }
        return count;
    }

    /**
     * Notice when the account is earning somewhere that is not here.
     *
     * Twitch credits one watch session per account, so a second copy of this - or a browser
     * tab left on a stream - silently starves whichever one loses. The existing stall
     * handling blames the channel and hops to another, which never helps and buries the
     * cause; this reports it instead.
     *
     * It only warns. Pausing on its own evidence would be worse when wrong: a false stop
     * earns nothing at all, whereas a false warning costs a line of text.
     */
    private checkForForeignSession(next: Map<string, Campaign>): void {
        const minutes = new Map<string, number>();
        for (const campaign of next.values()) {
            for (const drop of campaign.drops) {
                minutes.set(drop.id, drop.currentMinutes);
            }
        }

        const snapshot: ProgressSnapshot = { minutes, dropId: this.currentDrop?.id ?? null };
        const foreign = detectForeignSession(this.lastProgress, snapshot);
        this.lastProgress = snapshot;

        if (!foreign) {
            this.foreignSessionAt = null;
            return;
        }

        // One line per occurrence, not per sweep: it stays true for as long as the other
        // session runs, and a feed full of the same warning is its own problem.
        if (this.foreignSessionAt) {
            return;
        }
        this.foreignSessionAt = Date.now();

        const owner = [...next.values()].find((campaign) =>
            campaign.drops.some((drop) => drop.id === foreign.dropId),
        );
        const where = owner ? ` (${owner.gameName})` : "";

        logger.warn(
            `Another session is earning on this account: ${foreign.dropId}${where} gained ` +
                `${foreign.gainedMinutes} minutes while this one earned nothing. ` +
                "Twitch credits one watch session per account.",
        );
        this.pushFeed(
            "warn",
            `Something else is watching as you${where} - Twitch only credits one session, ` +
                "so nothing is being earned here",
        );
    }

    /** Refresh campaigns immediately rather than waiting for the next scheduled sweep. */
    async refreshNow(): Promise<void> {
        await this.refreshCampaigns();
    }

    /** Attach a Steam library so ownership and playtime can influence ranking. */
    setSteamLibrary(library: SteamLibrary | null): void {
        this.steam = library;
        // Ownership and playtime feed the ranking, so a new library reorders the queue
        // even though not one campaign has changed.
        this.publishRanking();
    }

    /**
     * Push the queue after something that changes the order without changing the campaigns.
     *
     * The queue is derived from the ranking rather than stored, so editing priorities used
     * to change what the miner would do next without changing what the dashboard was
     * showing. The list then sat wrong until the next sweep, which can be twenty minutes
     * away - long enough to read as the setting having been ignored.
     */
    private publishRanking(): void {
        this.emit("campaigns-updated", this.getCampaigns());
    }

    /** The ranking rules in force right now, including live focus and shuffle state. */
    private rankingOptions(): RankingOptions {
        const steam = this.steam;
        const mode = this.config.priorityMode;
        return {
            priorityGames: this.config.priorityGames,
            queueOrder: this.config.queueOrder,
            mode,
            randomKeys: this.randomKeys,
            focusGameId: this.currentCampaign?.gameId ?? null,
            deferred: this.deferredCampaigns,
            // Matches exactly what the dashboard dims, so the order it shows and the
            // reason it gives for a row being greyed out never disagree.
            skipped: (campaign) =>
                !this.isInLibraryScope(campaign) ||
                this.config.excludedGames.some((game) => this.matchesGame(game, campaign)),
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
                title: channel.stream?.title ?? "",
                viewers: channel.stream?.viewers ?? 0,
                game: channel.stream?.gameName ?? null,
            },
            campaignId: campaign.id,
            dropId: drop.id,
            since: this.miningSince,
            channelSince: this.channelWatchStart ?? this.miningSince,
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
        // New settings can make something mineable that was not a moment ago.
        this.wake();
        const previousInterval = this.config.campaignRefreshMinutes;
        this.config = config;
        this.pushFeed("info", "Configuration updated");

        // A pending tick was scheduled against the old interval, so shortening it would
        // otherwise not take effect until after one more wait at the old length.
        if (config.campaignRefreshMinutes !== previousInterval && !this.stopping) {
            this.rearmCampaignRefresh();
        }

        // Re-rank straight away. Editing priorities and then watching the bot carry on with
        // the old campaign for another refresh interval reads as the setting not working.
        const best = this.getMineableCampaigns()[0];
        if (this.currentChannel && best && best.id !== this.currentCampaign?.id) {
            logger.info(`Priorities changed; switching to ${best.gameName}.`);
            this.pushFeed("info", `Priorities changed - switching to ${best.gameName}`);
            this.switchRequested = true;
        }

        // Whether or not it switches, the order has moved and the dashboard is showing the
        // old one. Dragging a game to the top and watching the queue ignore you is the
        // clearest possible way to look broken.
        this.publishRanking();
    }

    /** Why there is nothing to mine, or null while something is being mined. */
    getIdleState(): IdleState | null {
        return this.idleState;
    }

    /**
     * Work out why nothing is being mined and say so, if it has changed.
     *
     * Announced on change rather than every pass: this runs each time the loop comes up
     * empty, and a dashboard told the same thing every twenty minutes learns nothing while
     * a feed full of it hides everything else.
     */
    private reportIdle(): void {
        const next = classifyIdle({
            campaigns: this.getCampaigns(),
            eligible: this.selectCampaigns(),
            isExcluded: (campaign) =>
                this.config.excludedGames.some((game) => this.matchesGame(game, campaign)),
        });
        if (sameIdle(this.idleState, next)) {
            return;
        }
        this.idleState = next;
        const sentence = describeIdle(next, this.config.campaignRefreshMinutes);
        logger.info(sentence);
        this.pushFeed("info", sentence);
        this.emit("idle", next);
    }

    /**
     * Wait, but no longer than something interesting takes to happen.
     *
     * Capped well below the full interval as well, because the decision is made from
     * campaigns already in memory: re-checking is nearly free, and it covers the cases
     * nothing thinks to wake us for, such as a campaign whose start time has simply
     * arrived.
     */
    private async waitWhileIdle(totalMs: number): Promise<void> {
        const deadline = Date.now() + totalMs;
        // What selection offered as the wait began. Only something new is worth ending the
        // wait for: a campaign that has started, or one whose bench has run out. Ending it
        // merely because candidates exist would re-search the same channel-less campaigns
        // every minute, at several requests apiece.
        const offered = new Set(this.selectCampaigns().map((campaign) => campaign.id));
        while (!this.stopping && Date.now() < deadline) {
            const slice = Math.min(IDLE_RECHECK_MS, deadline - Date.now());
            const woken = await new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => {
                    this.wakeIdle = null;
                    resolve(false);
                }, slice);
                this.wakeIdle = () => {
                    clearTimeout(timer);
                    this.wakeIdle = null;
                    resolve(true);
                };
            });
            if (woken) {
                return;
            }
            if (this.selectCampaigns().some((campaign) => !offered.has(campaign.id))) {
                return;
            }
        }
    }

    /**
     * Cut the idle wait short, because something changed that could make mining possible.
     *
     * Safe to call at any time; it does nothing unless a wait is actually in progress.
     */
    wake(): void {
        this.wakeIdle?.();
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
        // Also a sweep point: the dashboard polls this steadily, so expired cooldowns are
        // cleared even while mining is paused and selectCampaigns is not running.
        this.pruneCooldowns(Date.now());
        return this.getCampaigns()
            .filter(
                // A campaign whose drops could not be fetched is not finished, but it is
                // not work the miner can do yet either, and ranking it here would have
                // the priority checks switching toward it.
                (campaign) =>
                    campaign.isActive && !campaign.isCompleted && campaign.drops.length > 0,
            )
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
                if (!this.withinSchedule() || !this.withinDailyLimit()) {
                    // Checked here rather than on a timer: the loop already wakes every few
                    // seconds, and a limit that takes effect within that is plenty.
                    await sleep(5_000);
                    continue;
                }
                const worked = await this.runOnce();
                if (!worked) {
                    this.reportIdle();
                    logger.info("Nothing to mine right now. Waiting for the next refresh.");
                    // Interruptible: a campaign starting, a tracked channel coming up, or a
                    // settings change all make this pass worth retrying, and sitting out a
                    // twenty-minute sleep to notice is the difference between resuming in
                    // seconds and resuming after the drop everyone wanted has ended.
                    await this.waitWhileIdle(this.config.campaignRefreshMinutes * 60_000);
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
        // Otherwise a stop issued during an idle wait leaves a timer holding the process
        // open for the rest of the interval.
        this.wake();
        if (this.boundaryTimer) {
            clearTimeout(this.boundaryTimer);
            this.boundaryTimer = null;
        }
        // Guarded rather than cancelled, this kept the whole Miner - its campaigns, claim
        // history and feed - reachable from a pending closure for a full refresh interval
        // after every stop. Harmless in a container that is about to exit; not in a desktop
        // app that stops and starts a session without the process going anywhere.
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
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

            // Once per campaign: this runs on every channel hop, and a log that repeats the
            // same warning for hours buries the lines that matter.
            if (
                this.config.warnUnlinkedAccounts &&
                !campaign.isDeliverable &&
                !this.warnedUnlinkedMining.has(campaign.id)
            ) {
                this.warnedUnlinkedMining.add(campaign.id);
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

            const end = await this.watch(channel, campaign, drop);
            this.reportTransition(end, channel);
            return true;
        }

        return false;
    }

    /**
     * Say why a spell of watching ended and what comes next.
     *
     * The loop goes straight from one channel to the next, so without this the feed shows a
     * claim, then a new "Watching" line, and nothing about the decision in between.
     */
    private reportTransition(end: WatchEnd, channel: Channel): void {
        if (this.stopping || isDeliberateStop(end)) {
            return;
        }
        const reason = describeLeave(end, channel.displayName);
        const top = this.selectCampaigns()[0] ?? null;
        const next = top
            ? {
                  campaign: top,
                  drop: top.nextDrop({ attemptImpossible: this.config.attemptImpossibleCampaigns }),
              }
            : null;
        const line = reason ? `${reason}. ${describeNext(next)}` : describeNext(next);
        logger.info(line);
        if (reason || next) {
            this.pushFeed("info", line);
        }
    }

    /** Highest-priority campaign that is active and has work left. */
    private selectCampaign(): Campaign | null {
        return this.selectCampaigns()[0] ?? null;
    }

    /** Every campaign worth trying, best first. */
    private selectCampaigns(): Campaign[] {
        const now = Date.now();
        this.pruneCooldowns(now);
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
            if (!this.isInLibraryScope(campaign)) {
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
     * Whether a campaign is for a game the user actually has a claim on.
     *
     * Twitch runs campaigns for hundreds of games at once, and watching one you neither own
     * nor asked for buys a reward you cannot use. Owning it on Steam counts, and so does
     * naming it in the priority list - which is the escape hatch for anything Steam does not
     * know about: a console or Epic title, or a Twitch category like "Special Events" that
     * is not a game at all.
     *
     * Inert until a Steam library is loaded. Without one there is nothing to test ownership
     * against, and applying the rule would silently reduce mining to the priority list.
     */
    /**
     * Ownership test for the dashboard, so the queue can say which campaigns the library
     * policy will actually let it mine rather than listing everything and quietly skipping
     * most of it.
     */
    get ownsPredicate(): ((name: string) => boolean) | null {
        const steam = this.steam;
        return steam?.isLoaded ? (name: string) => steam.owns(name) : null;
    }

    private isInLibraryScope(campaign: Campaign): boolean {
        const steam = this.steam;
        return isInLibraryScope(campaign, {
            policy: this.config.libraryPolicy,
            priorityGames: this.config.priorityGames,
            owns: steam?.isLoaded ? (name: string) => steam.owns(name) : null,
        });
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

    /** Drop cooldowns that have expired. Cheap, and the only thing that ever removes them. */
    private pruneCooldowns(now: number): void {
        for (const [key, until] of this.channelCooldowns) {
            if (until <= now) {
                this.channelCooldowns.delete(key);
            }
        }
    }

    /** How many cooldowns are being held. Exposed so a test can prove they do not pile up. */
    get cooldownCount(): number {
        return this.channelCooldowns.size;
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
            // A preferred channel only helps if they are playing the campaign's game -
            // except under a category earned anywhere, where the campaign names its
            // channels outright and they stream whatever they are actually playing. An
            // esports campaign's channels are never in the "Special Events" category.
            if (
                !campaign.isSpecialCategory &&
                info.broadcastSettings?.game?.id !== campaign.gameId
            ) {
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
    private async watch(channel: Channel, campaign: Campaign, drop: Drop): Promise<WatchEnd> {
        // Watching again, so whatever idleness was reported is over. The `watching`
        // event that follows is what tells the dashboard; there is no separate "resumed".
        this.idleState = null;
        this.currentChannel = channel;
        this.currentDrop = drop;
        this.currentCampaign = campaign;
        this.miningSince = Date.now();
        if (this.lastWatchedLogin !== channel.login || this.channelWatchStart === null) {
            this.channelWatchStart = Date.now();
        }
        this.lastWatchedLogin = channel.login;
        this.lastProgressAt = Date.now();
        this.lastBeatAt = null;
        this.unconfirmedBeats = 0;
        this.switchRequested = false;
        let beatFailures = 0;

        const streamTopic = `video-playback-by-id.${channel.id}`;
        const pointsTopic = `community-points-user-v1.${this.auth.userId}`;
        const settingsTopic = `broadcast-settings-update.${channel.id}`;
        this.pubsub?.listen(streamTopic);
        if (this.config.autoClaimPoints) {
            this.pubsub?.listen(pointsTopic);
        }
        if (this.config.switchOnCategoryChange) {
            this.pubsub?.listen(settingsTopic);
        }

        logger.info(
            `Watching ${channel.displayName} for ${campaign.gameName} - ${drop.name} ` +
                `(${drop.currentMinutes}/${drop.requiredMinutes} min)`,
        );
        this.emit("watching", { channel, campaign, drop });
        // Whatever the dashboard was showing about starting up, it is now out of date.
        this.emit("loading", { phase: "ready" });
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

            channel.startSegmentWatch();
            while (!this.stopping) {
                const beatStart = Date.now();
                if (!channel.isOnline) {
                    logger.info(`${channel.displayName} went offline.`);
                    return "offline";
                }
                if (!this.withinSchedule() || !this.withinDailyLimit()) {
                    logger.info("Outside the mining window; leaving the channel.");
                    this.switchRequested = true;
                    return "outside_window";
                }
                if (this.paused) {
                    logger.info("Paused; leaving the channel.");
                    return "paused";
                }
                if (this.switchRequested) {
                    logger.info("Switching to a higher-priority campaign.");
                    return "better_campaign";
                }
                // A campaign can expire mid-session. Nothing further can be earned, and the
                // refresh will have stripped its drops, so keep beating and we would watch a
                // dead campaign indefinitely.
                if (!campaign.isActive) {
                    logger.info(`${campaign.gameName} - "${campaign.name}" has ended.`);
                    this.pushFeed("info", `${campaign.gameName} ended - moving on`);
                    return "campaign_ended";
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
                        return "benched";
                    }
                    // A transient failure; wait out the interval and try the next beat.
                    await sleep(Math.max(0, WATCH_INTERVAL_MS - (Date.now() - beatStart)));
                    continue;
                }
                beatFailures = 0;
                this.lastBeatAt = Date.now();
                // Here, per accepted beat. Counted on entering the channel instead, the
                // daily limit measured how often the miner switched rather than how long
                // it watched - every claim and switch re-enters - and an hour on one
                // streamer counted as a single minute.
                this.countMinuteMined();
                this.unconfirmedBeats++;
                this.emit("beat", { at: this.lastBeatAt });

                // Re-read through currentDrop: a refresh may have replaced the instance
                // this loop was handed.
                const live = this.currentDrop ?? drop;
                if (live.isClaimed) {
                    return "claimed";
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
                    return "benched";
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
                        return "benched";
                    }
                }

                if (live.isClaimable && this.config.autoClaimDrops) {
                    // claim() records completion itself, for every path that claims.
                    const owner = this.currentCampaign ?? campaign;
                    await this.claim(live, owner);
                    // Out of attempts; giveUpClaim has already said so.
                    if (live.givenUp) {
                        return "claim_stuck";
                    }
                    // Either the campaign is done or the next drop needs re-selecting - unless
                    // the claim did nothing. A finished drop that stays unclaimed is picked
                    // again at once, and that is how this once turned over every six seconds
                    // for an hour. Take the campaign out of the rotation for a while instead.
                    if (live.isClaimable) {
                        this.channelCooldowns.set(
                            `campaign:${owner.id}`,
                            Date.now() + CLAIM_STUCK_COOLDOWN_MS,
                        );
                        logger.warn(
                            `${live.rewardNames || live.name} (${owner.gameName}) is finished but ` +
                                `was not claimed; setting it aside for ${CLAIM_STUCK_COOLDOWN_MS / 60_000} minutes.`,
                        );
                        this.pushFeed(
                            "warn",
                            `${live.rewardNames || live.name} is ready but could not be claimed - ` +
                                `trying again in ${CLAIM_STUCK_COOLDOWN_MS / 60_000} min`,
                        );
                        return "claim_stuck";
                    }
                    return "claimed";
                }

                // Sleep the remainder of the interval rather than a flat 59s, so the work
                // above does not push successive beats past the minute Twitch credits.
                // Deliberately NOT jittered: the official player beats on a precise cadence,
                // so randomising here would make us less like it, not more.
                const elapsed = Date.now() - beatStart;
                await sleep(Math.max(0, WATCH_INTERVAL_MS - elapsed));
            }
            return "stopped";
        } finally {
            await channel.stopSegmentWatch();
            this.pubsub?.unlisten(streamTopic);
            // Per-channel, unlike the points topic, so it has to go when the channel does.
            this.pubsub?.unlisten(settingsTopic);
            this.currentChannel = null;
            this.currentDrop = null;
            this.currentCampaign = null;
            this.miningSince = null;
            // After the clearing, so a dashboard re-reading its state on this no longer
            // finds the channel it just left.
            this.emit("status");
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
        if (this.lastWatchedLogin === channel.login) {
            this.lastWatchedLogin = null;
            this.channelWatchStart = null;
        }
    }

    private async claim(drop: Drop, campaign: Campaign): Promise<void> {
        // A stopped miner must not still be claiming. Nothing about a claim is unsafe on
        // its own, but it writes the claim file - and after a sign-out the session that
        // replaced this one owns that file.
        if (this.stopping) {
            return;
        }
        const attempts = this.claimAttempts.get(drop.id) ?? 0;
        if (attempts >= MAX_CLAIM_ATTEMPTS) {
            this.giveUpClaim(drop, campaign, attempts);
            return;
        }
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
            this.claimAttempts.set(drop.id, attempts + 1);
            const claimed = await this.gql.claimDrop(instanceId);
            if (claimed) {
                drop.isClaimed = true;
                this.claimedDropIds.add(drop.id);
                this.confirmedClaimIds.add(drop.id);
                this.persistState();
                logger.info(`Claimed: ${drop.rewardNames} (${campaign.gameName})`);
                this.recentClaims.push({
                    at: Date.now(),
                    dropId: drop.id,
                    campaignId: campaign.id,
                    dropName: drop.rewardNames || drop.name,
                    gameName: campaign.gameName,
                    rewardImageURL: drop.data.benefitEdges[0]?.benefit.imageAssetURL ?? null,
                    requiredMinutes: drop.requiredMinutes,
                    deliverable: campaign.isDeliverable,
                });
                if (this.recentClaims.length > 100) {
                    this.recentClaims.shift();
                }
                this.claimHistory.claims.push(this.recentClaims.at(-1)!);
                // Kept to the same bound the file is written with. The array used to grow
                // without limit while the file stayed capped, so a long-running process
                // held history it would never save - and getClaimStats walks all of it on
                // every dashboard poll.
                if (this.claimHistory.claims.length > MAX_IN_MEMORY_CLAIMS) {
                    this.claimHistory.claims.splice(
                        0,
                        this.claimHistory.claims.length - MAX_IN_MEMORY_CLAIMS,
                    );
                }
                this.claimStats = null;
                this.persistClaims();
                this.pushFeed("info", `Claimed ${drop.rewardNames} (${campaign.gameName})`);
                this.emit("drop-claimed", { drop, campaign });
                this.recordCompletionIfFinished(campaign);
            } else {
                // Not the end of it on the first refusal. One reply used to settle a drop
                // for good - persisted, so not even a restart retried it - and a refusal
                // that was only Twitch being slow cost the reward outright. The watch loop
                // sets the campaign aside for a while and the next sweep asks again, up to
                // the cap.
                const made = attempts + 1;
                logger.warn(
                    `Twitch did not accept the claim for ${drop.name} (${campaign.gameName}); ` +
                        `attempt ${made} of ${MAX_CLAIM_ATTEMPTS}.`,
                );
                if (made >= MAX_CLAIM_ATTEMPTS) {
                    this.giveUpClaim(drop, campaign, made);
                }
            }
        } catch (error) {
            logger.error(`Failed to claim ${drop.name}:`, error);
        }
    }

    /**
     * Stop trying to claim a drop, and remember that across restarts.
     *
     * Said once, loudly, and then never again: something is wrong that retrying will not
     * resolve, and the useful thing is a record of it. The drop is set aside rather than
     * marked claimed, so nothing reports a reward the user may not have.
     */
    private giveUpClaim(drop: Drop, campaign: Campaign, attempts: number): void {
        drop.givenUp = true;
        if (this.failedClaimIds.has(drop.id)) {
            return;
        }
        logger.warn(
            `${drop.name} (${campaign.gameName}) could not be claimed after ${attempts} ` +
                "attempts. Giving up on it; if it is still listed in your Twitch inventory, " +
                "it can be claimed there.",
        );
        this.pushFeed(
            "warn",
            `Could not claim ${drop.rewardNames || drop.name} - claim it from your Twitch inventory`,
        );
        this.failedClaimIds.add(drop.id);
        this.persistState();
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

        pubsub.on("category-change", ({ channelId, gameId, gameName }) => {
            const channel = this.currentChannel;
            const campaign = this.currentCampaign;
            if (channel === null || campaign === null || channel.id !== channelId) {
                return;
            }
            if (channel.stream) {
                channel.stream.gameName = gameName || channel.stream.gameName;
            }
            // A campaign earned outside its own category does not care what is being
            // streamed, so only a genuine mismatch is worth leaving over.
            if (campaign.isSpecialCategory || gameId === campaign.gameId) {
                return;
            }
            logger.info(
                `${channel.displayName} switched to ${gameName || "another category"}; ` +
                    "leaving rather than watching for nothing.",
            );
            this.pushFeed(
                "warn",
                `${channel.displayName} switched to ${gameName || "another category"}`,
            );
            this.switchRequested = true;
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

    /** Cancel the pending refresh and schedule a fresh one on the current interval. */
    private rearmCampaignRefresh(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.scheduleCampaignRefresh();
    }

    private scheduleCampaignRefresh(): void {
        // Read from config on every tick rather than capturing it once. Captured, the
        // interval could never change without restarting the process: editing it in
        // Settings updated the file and the countdown and left the actual cadence alone.
        const interval = () => this.config.campaignRefreshMinutes * 60_000;
        // Which chain of ticks this is. Re-arming while a tick was mid-refresh cleared a
        // timer that had already fired, started a second chain, and then the running tick
        // scheduled its successor anyway - two sweeps per interval from then on.
        const generation = ++this.refreshGeneration;
        const current = () => !this.stopping && generation === this.refreshGeneration;
        this.nextRefreshAt = Date.now() + interval();
        const tick = async () => {
            if (!current()) {
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
                // Superseded or stopped while refreshing: the chain ends here.
                if (current()) {
                    this.nextRefreshAt = Date.now() + interval();
                    this.refreshTimer = setTimeout(tick, interval());
                    this.refreshTimer.unref();
                }
            }
        };
        this.refreshTimer = setTimeout(tick, interval());
        this.refreshTimer.unref();
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

        if (!campaign || !drop || drop.isClaimed || drop.givenUp || !campaign.isActive) {
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
            // Idle. This is exactly the event worth waking for - the channel is up now, and
            // waiting out the rest of the refresh interval could miss the whole stream.
            this.wake();
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

    /**
     * Carry on without the inventory, but say so.
     *
     * Without it every drop reads as unstarted and nothing already earned is claimed, so a
     * silent failure looked like progress being lost. A rotated hash or a dead token is not
     * this kind of failure: nothing else will work either, and those go to the caller.
     */
    private inventoryFailed(error: unknown): null {
        if (error instanceof StaleQueryHashError || error instanceof AuthExpiredError) {
            throw error;
        }
        if (!this.inventoryFailing) {
            this.inventoryFailing = true;
            logger.warn(
                `Could not read the drop inventory: ${(error as Error).message}. ` +
                    "Progress and claims will catch up on a later refresh.",
            );
            this.pushFeed("warn", "Could not read your drop inventory - progress may look behind");
        } else {
            logger.debug("Inventory still unavailable:", error);
        }
        return null;
    }

    /**
     * Refresh, or join the refresh already running.
     *
     * Four things start one - the timer, a campaign boundary, a reward notification and the
     * dashboard - and they overlap. Two sweeps at once doubled the requests, let the one
     * that finished last overwrite the other's newer answer, and both ran the claim pass
     * over the same finished drops.
     */
    private refreshCampaigns(): Promise<void> {
        this.refreshing ??= this.sweepCampaigns().finally(() => {
            this.refreshing = null;
        });
        return this.refreshing;
    }

    private async sweepCampaigns(): Promise<void> {
        // Whatever this finds, the idle loop's decision was made against older data.
        // Waking is cheap and the recheck is against memory.
        this.wake();
        const startedAt = Date.now();
        // A sweep that runs while a channel is already being watched is background work -
        // a claim triggers one, and the dashboard announcing "starting up" every time a
        // drop lands is both wrong and alarming.
        const background = this.currentChannel !== null;
        this.emit("loading", { phase: "campaigns", background });
        logger.debug("Refreshing campaigns...");
        let [listed, inventory] = await Promise.all([
            this.gql.getCampaigns(),
            this.gql.getInventory().catch((error: unknown) => this.inventoryFailed(error)),
        ]);
        if (inventory) {
            this.inventoryFailing = false;
        }

        // A login made with the TV client is shown an empty dashboard - the only kind of
        // login Twitch still issues. The public catalogue supplies the campaigns and their
        // details instead; everything about this account still comes from Twitch.
        let catalogue: Map<string, DropCampaign> | null = null;
        if (listed.length === 0) {
            const fromCatalogue = await fetchCatalogue();
            if (fromCatalogue.length > 0) {
                if (!this.usingCatalogue) {
                    logger.info(
                        "Twitch lists no campaigns for this login, so they come from the " +
                            `public drops catalogue instead (${fromCatalogue.length} found). ` +
                            "Progress and claiming still go through Twitch.",
                    );
                }
                listed = fromCatalogue;
                catalogue = new Map(fromCatalogue.map((campaign) => [campaign.id, campaign]));
            }
        }
        this.usingCatalogue = catalogue !== null;

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
            // Not detailed: the list carries no drops, and they are fetched below.
            next.set(data.id, new Campaign(data, false));
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

        // Timed and counted: this is the slow part, and a silent slow part is the reason
        // the window looked broken on open.
        // Nothing known yet means nothing to disturb, which is what makes it safe below to
        // publish the queue as it is learned rather than only at the end.
        const firstSweep = this.campaigns.size === 0;
        const listedAt = Date.now();
        logger.debug(`Campaign list fetched in ${((listedAt - startedAt) / 1000).toFixed(1)}s.`);
        this.emit("loading", { phase: "details", done: 0, total: interesting.length, background });

        let cursor = 0;
        let fetched = 0;
        let failures = 0;
        let abandoned = false;

        /**
         * Hold on to what the last sweep knew when this one could not fetch a campaign.
         *
         * A failed request left the campaign with no drops, so one bad response took a
         * campaign out of the queue - and, if it was the one being watched, pulled the
         * miner off a channel that was earning. Its drops from twenty minutes ago are far
         * closer to the truth than none; the inventory below brings their progress up to
         * date regardless.
         */
        const keepPrevious = (id: string): void => {
            const previous = this.campaigns.get(id);
            if (previous?.detailed && previous.drops.length > 0) {
                next.set(id, previous);
            }
        };

        /**
         * One worker takes the next campaign until there are none left.
         *
         * A few at a time rather than one: the list is fetched in rank order, so the
         * campaigns that decide what gets mined first are still fetched first. Kept
         * deliberately low - this is Twitch's private API, and the failure mode for asking
         * too hard is being rate limited into fetching nothing at all, which is far worse
         * than being slow.
         */
        const worker = async (): Promise<void> => {
            for (;;) {
                // Without this check, stopping or signing out waited for the whole sweep,
                // and an abandoned session carried on spending requests against an account
                // its successor was already using.
                if (this.stopping) {
                    abandoned = true;
                    return;
                }

                const index = cursor;
                cursor += 1;
                const campaign = interesting[index];
                if (!campaign) {
                    return;
                }

                try {
                    const details =
                        catalogue?.get(campaign.id) ?? (await this.gql.getCampaignDetails(campaign.id));
                    if (details) {
                        next.set(campaign.id, campaign.merge(details));
                    } else {
                        // An empty answer is a failure, not a campaign with nothing in it:
                        // without its drops the campaign counts as finished and is quietly
                        // never mined. Counting it here is what lets the warning below fire.
                        failures += 1;
                        keepPrevious(campaign.id);
                    }
                } catch (error) {
                    failures += 1;
                    keepPrevious(campaign.id);
                    logger.debug(`Could not fetch details for ${campaign.name}:`, error);
                }

                fetched += 1;
                // Every few rather than every one: the browser only needs to see it moving,
                // and one frame per request would be a message every quarter second.
                if (fetched % 5 === 0 || fetched === interesting.length) {
                    this.emit("loading", {
                        phase: "details",
                        done: fetched,
                        total: interesting.length,
                        background,
                    });
                }

                // Hand over what is known so far at intervals, so the queue fills in as it
                // is learned instead of staying blank and then arriving all at once.
                // Coarser than the progress ticks above because this payload is the whole
                // campaign list, not a counter.
                if (fetched % 25 === 0 && fetched < interesting.length) {
                    // Publishing partway is only safe on the very first sweep, when there
                    // is nothing to disturb. On a later refresh the miner is already
                    // watching something, and letting it rank against a half-fetched list
                    // could make it switch away on evidence that is about to change.
                    if (firstSweep) {
                        this.campaigns = new Map(next);
                    }
                    this.emit("campaigns-updated", [...next.values()]);
                }
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(CAMPAIGN_DETAIL_CONCURRENCY, interesting.length) }, () =>
                worker(),
            ),
        );

        if (abandoned) {
            logger.debug("Campaign refresh abandoned: stopping.");
            return;
        }

        const elapsed = (Date.now() - listedAt) / 1000;
        logger.info(
            `Campaign details: ${interesting.length} fetched in ${elapsed.toFixed(1)}s ` +
                `(list took ${((listedAt - startedAt) / 1000).toFixed(1)}s).`,
        );

        // Loud on purpose. A rate-limited sweep still "succeeds" - the campaigns simply
        // arrive without their drops, drop out of the queue, and the bot looks like it has
        // decided there is nothing to mine. That is the one failure worth reading a log for.
        if (failures > 0) {
            const share = Math.round((failures / interesting.length) * 100);
            const message = `${failures} of ${interesting.length} campaign details failed (${share}%).`;
            if (share >= 20) {
                logger.warn(`${message} Twitch may be rate limiting; queue will be short.`);
                this.pushFeed("warn", message);
            } else {
                logger.debug(message);
            }
        }

        // "Choosing" only makes sense before anything has been chosen. A refresh that runs
        // while already watching is background work, and leaving the dashboard on a startup
        // message afterwards stranded it there: the ready signal rides on the watching
        // event, which a refresh that changes nothing never fires.
        this.emit("loading", { phase: this.currentChannel ? "ready" : "choosing", background });

        // A fully claimed campaign disappears from dropCampaignsInProgress, and
        // DropCampaignDetails carries no `self` block at all, so nothing above knows the
        // drops were already collected - the campaign looks brand new and gets mined again
        // from zero. gameEventDrops is the surviving proof of ownership: it lists every
        // reward actually granted, so reconcile against it before trusting the zeroes.
        //
        // Keyed on benefit ID alone. Matching by reward name as well seemed a safe fallback
        // for when IDs do not line up, but Twitch reuses names freely - between tiers of one
        // campaign and between concurrent ones - and every collision marked the wrong drop
        // collected, which then suppressed its claim for good. Three separate bugs came from
        // it, and the IDs turned out to line up anyway. DevilXD matches on ID only.
        const ownedBenefits = new Map<string, number>();
        for (const reward of inventory?.gameEventDrops ?? []) {
            if (!reward.id) {
                continue;
            }
            const awarded = Date.parse(reward.lastAwardedAt);
            ownedBenefits.set(reward.id, Number.isNaN(awarded) ? 0 : awarded);
        }

        if (ownedBenefits.size > 0) {
            for (const campaign of next.values()) {
                for (const drop of campaign.drops) {
                    if (drop.isClaimed || drop.data.benefitEdges.length === 0) {
                        continue;
                    }
                    // Bound the award to this drop's own window, not merely to some point
                    // after the campaign opened. A reward granted by a neighbouring tier,
                    // or by a rerun of the same campaign, falls outside it and no longer
                    // counts as proof this drop was collected. Matches DevilXD.
                    const openedAt = drop.startAt.getTime();
                    const closedAt = drop.endAt.getTime();
                    const owned = drop.data.benefitEdges.every((edge) => {
                        const awarded = ownedBenefits.get(edge.benefit.id);
                        return awarded !== undefined && awarded >= openedAt && awarded < closedAt;
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
            // Including whether the account is linked. A campaign from the public catalogue
            // knows nothing about this account and carries no `self`, which reads as linked;
            // the inventory is the one place Twitch still says, for anything in progress.
            if (inProgress.self) {
                campaign.data.self = inProgress.self;
            }
            for (const entry of inProgress.timeBasedDrops ?? []) {
                const drop = campaign.drops.find((candidate) => candidate.id === entry.id);
                if (drop && entry.self) {
                    drop.update(entry.self);
                    if (entry.self.isClaimed) {
                        this.claimedDropIds.add(drop.id);
                    } else if (!this.confirmedClaimIds.has(drop.id)) {
                        // Inventory can take back a guess, but not a claim we made and
                        // Twitch confirmed.
                        //
                        // The guess is the owned-benefit inference above, and without a way
                        // to undo it a wrong one is permanent - claim() skips anything in
                        // this set, so the drop would sit finished and unclaimed until the
                        // campaign expired. That is what this branch is for.
                        //
                        // Undoing a real claim is a different thing entirely. Twitch's
                        // inventory has been seen reporting a drop as unclaimed minutes
                        // after confirming the claim - on GTA V it never caught up at all -
                        // and each refresh then claimed it again: forty-one claims of one
                        // drop in nine hours, a notification every time, and a claim history
                        // full of rewards granted once.
                        this.claimedDropIds.delete(drop.id);
                    }
                }
            }
        }

        // After the inventory read, so nothing it says can put a known claim back.
        const settled = applyKnownClaims(next.values(), this.confirmedClaimIds, this.failedClaimIds);
        if (settled > 0) {
            logger.debug(
                `Treating ${settled} drop${settled === 1 ? "" : "s"} as claimed or given up, as recorded.`,
            );
        }

        this.checkForForeignSession(next);
        this.campaigns = next;
        // The stats read required minutes and deliverability from the campaigns, so a
        // refresh can change the answer even when no drop was claimed.
        this.claimStats = null;
        this.backfillClaimRecords();
        this.reconcileCompletions();
        this.rebindWatchedObjects(next);
        this.scheduleBoundaryRefresh();
        this.warnAboutExpiringUnlinked();
        await this.syncWatchlist();
        const mineable = [...next.values()].filter(
            (campaign) => campaign.isActive && !campaign.isCompleted && campaign.drops.length > 0,
        );
        // A filter that silently discards work is hard to trust, so say how much it took.
        const outOfScope = mineable.filter((campaign) => !this.isInLibraryScope(campaign)).length;
        const scopeNote = outOfScope > 0 ? `, ${outOfScope} skipped as not owned` : "";
        logger.info(
            `${next.size} campaigns known, ${mineable.length} with work remaining${scopeNote}.`,
        );
        this.pushFeed(
            "info",
            `Refreshed campaigns: ${next.size} known, ${mineable.length} with work remaining${scopeNote}`,
        );
        this.emit("campaigns-updated", [...next.values()]);

        // Claim anything that finished while we were not looking.
        if (this.config.autoClaimDrops && !this.dryRun) {
            for (const campaign of next.values()) {
                for (const drop of campaign.claimableDrops) {
                    if (this.stopping) {
                        return;
                    }
                    await this.claim(drop, campaign);
                }
            }
        }
    }
}
