import { EventEmitter } from "node:events";

import logger from "./logger.js";
import type { Config } from "./config.js";
import { Campaign, compareCampaigns, type Drop } from "./models/campaign.js";
import { Channel } from "./models/channel.js";
import type { AuthState } from "./twitch/auth.js";
import { StaleQueryHashError, type TwitchGql } from "./twitch/gql.js";
import { PubSubPool, type DropProgressMessage } from "./twitch/websocket.js";
import { WATCH_INTERVAL_MS } from "./twitch/constants.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Give up on a channel that produces no progress within this window and try another. */
const NO_PROGRESS_TIMEOUT_MS = 8 * 60_000;
/** How long a channel that failed stays out of the rotation. */
const CHANNEL_COOLDOWN_MS = 30 * 60_000;

export interface MinerEvents {
    "campaigns-updated": [Campaign[]];
    "watching": [{ channel: Channel; campaign: Campaign; drop: Drop }];
    "progress": [{ drop: Drop; minutes: number; required: number }];
    "drop-claimed": [{ drop: Drop; campaign: Campaign }];
    "campaign-completed": [Campaign];
    error: [Error];
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

    private pubsub: PubSubPool | null = null;
    private currentChannel: Channel | null = null;
    private currentDrop: Drop | null = null;
    private lastProgressAt = 0;
    /** Set when a better campaign appears, so the watch loop yields at its next beat. */
    private switchRequested = false;
    private stopping = false;

    constructor(
        private readonly auth: AuthState,
        private readonly gql: TwitchGql,
        private readonly config: Config,
    ) {
        super();
    }

    async start(): Promise<void> {
        this.pubsub = new PubSubPool(this.auth.accessToken);
        this.attachPubSubHandlers(this.pubsub);
        // Drop events are account-wide, so this one subscription covers every campaign.
        this.pubsub.listen(`user-drop-events.${this.auth.userId}`);

        await this.refreshCampaigns();
        this.scheduleCampaignRefresh();

        while (!this.stopping) {
            try {
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
        this.pubsub?.close();
        this.pubsub = null;
    }

    /** Pick the best campaign and mine it. Returns false when there is nothing to do. */
    private async runOnce(): Promise<boolean> {
        const campaign = this.selectCampaign();
        if (!campaign) {
            return false;
        }
        const drop = campaign.nextDrop({
            attemptImpossible: this.config.attemptImpossibleCampaigns,
        });
        if (!drop) {
            return false;
        }

        if (this.config.warnUnlinkedAccounts && !campaign.isAccountLinked) {
            logger.warn(
                `${campaign.gameName} - "${campaign.name}" is not linked to your Twitch account. ` +
                    "Progress will be tracked, but rewards will not reach the game until you link it.",
            );
        }

        const channel = await this.findChannel(campaign);
        if (!channel) {
            logger.info(`No eligible channel online for ${campaign.gameName}.`);
            // Back off this campaign briefly so the loop moves on to another one.
            this.channelCooldowns.set(`campaign:${campaign.id}`, Date.now() + 5 * 60_000);
            return false;
        }

        await this.watch(channel, campaign, drop);
        return true;
    }

    /** Highest-priority campaign that is active and has work left. */
    private selectCampaign(): Campaign | null {
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
            if (
                !this.config.mineUnlistedGames &&
                !this.config.priorityGames.some((game) => this.matchesGame(game, campaign))
            ) {
                return false;
            }
            return (
                campaign.nextDrop({ attemptImpossible: this.config.attemptImpossibleCampaigns }) !==
                null
            );
        });

        candidates.sort((a, b) => compareCampaigns(a, b, this.config.priorityGames));
        return candidates[0] ?? null;
    }

    private matchesGame(game: string, campaign: Campaign): boolean {
        return (
            game === campaign.gameId || game.toLowerCase() === campaign.gameName.toLowerCase()
        );
    }

    /**
     * Find a channel that will actually earn progress for this campaign: preferred channels
     * first, then the game directory filtered to drops-enabled streams.
     */
    private async findChannel(campaign: Campaign): Promise<Channel | null> {
        const allowed = campaign.allowedChannelIds;
        const candidates: Channel[] = [];

        // A campaign restricted to specific channels must be mined on one of them.
        const preferred = campaign.allowedChannelLogins.length
            ? campaign.allowedChannelLogins
            : this.config.preferredChannels;

        for (const login of preferred) {
            if (this.isOnCooldown(login)) {
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
            const channel = new Channel(
                info.id,
                login.toLowerCase(),
                login,
                this.auth,
                this.gql,
            );
            await channel.refresh();
            candidates.push(channel);
        }

        if (candidates.length === 0) {
            const slug = await this.resolveSlug(campaign);
            if (slug) {
                const nodes = await this.gql
                    .getGameChannels(slug, { dropsOnly: true })
                    .catch(() => []);
                for (const node of nodes) {
                    const channel = Channel.fromDirectory(node, this.auth, this.gql);
                    if (!channel || this.isOnCooldown(channel.login)) {
                        continue;
                    }
                    if (allowed && !allowed.has(channel.id)) {
                        continue;
                    }
                    candidates.push(channel);
                }
            }
        }

        // Confirm Twitch really will credit this campaign here. A drops-enabled tag is not
        // enough - the channel may be running a different campaign for the same game.
        for (const channel of candidates) {
            try {
                const available = await this.gql.getAvailableDrops(channel.id);
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
     * Watch `channel` until the drop is claimed, the stream ends, progress stalls, or a
     * higher-priority campaign appears.
     */
    private async watch(channel: Channel, campaign: Campaign, drop: Drop): Promise<void> {
        this.currentChannel = channel;
        this.currentDrop = drop;
        this.lastProgressAt = Date.now();
        this.switchRequested = false;

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

        try {
            // A stream that just came up will not credit watch time yet.
            while (!channel.isWatchable && channel.isOnline && !this.stopping) {
                logger.debug(`Waiting for ${channel.login} to settle before watching`);
                await sleep(15_000);
            }

            while (!this.stopping) {
                if (!channel.isOnline) {
                    logger.info(`${channel.displayName} went offline.`);
                    return;
                }
                if (this.switchRequested) {
                    logger.info("Switching to a higher-priority campaign.");
                    return;
                }

                const accepted = await channel.sendWatch();
                if (!accepted) {
                    logger.warn(`${channel.displayName} rejected the watch beat.`);
                    this.penalise(channel);
                    return;
                }

                if (drop.isClaimed) {
                    return;
                }

                // PubSub is the fast path for progress, but it can go quiet. If it does,
                // fall back to polling the inventory before writing the channel off.
                if (Date.now() - this.lastProgressAt > NO_PROGRESS_TIMEOUT_MS) {
                    const advanced = await this.reconcileProgress(drop);
                    if (!advanced) {
                        logger.warn(
                            `No progress from ${channel.displayName} in ` +
                                `${NO_PROGRESS_TIMEOUT_MS / 60_000} minutes; trying another channel.`,
                        );
                        this.penalise(channel);
                        return;
                    }
                }

                if (drop.isClaimable && this.config.autoClaimDrops) {
                    await this.claim(drop, campaign);
                    if (campaign.isCompleted) {
                        logger.info(`Completed campaign: ${campaign.gameName} - ${campaign.name}`);
                        this.emit("campaign-completed", campaign);
                        return;
                    }
                    // Move on to the next drop in this campaign.
                    return;
                }

                await sleep(WATCH_INTERVAL_MS);
            }
        } finally {
            this.pubsub?.unlisten(streamTopic);
            this.currentChannel = null;
            this.currentDrop = null;
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
        if (!drop.dropInstanceId || this.claimedDropIds.has(drop.id)) {
            return;
        }
        try {
            const claimed = await this.gql.claimDrop(drop.dropInstanceId);
            if (claimed) {
                drop.isClaimed = true;
                this.claimedDropIds.add(drop.id);
                logger.info(`Claimed: ${drop.rewardNames} (${campaign.gameName})`);
                this.emit("drop-claimed", { drop, campaign });
            } else {
                logger.warn(`Twitch did not confirm the claim for ${drop.name}`);
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

        pubsub.on("stream-down", ({ channelId }) => {
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
                setTimeout(tick, interval).unref();
            }
        };
        setTimeout(tick, interval).unref();
    }

    private currentBestCampaignId(): string | undefined {
        return this.selectCampaign()?.id;
    }

    /** Re-read every campaign and fold in our inventory progress. */
    private async refreshCampaigns(): Promise<void> {
        logger.debug("Refreshing campaigns...");
        const [listed, inventory] = await Promise.all([
            this.gql.getCampaigns(),
            this.gql.getInventory().catch(() => null),
        ]);

        const next = new Map<string, Campaign>();
        for (const data of listed) {
            if (data.status === "EXPIRED") {
                continue;
            }
            next.set(data.id, new Campaign(data));
        }

        // The campaign list omits drop details, so fetch them for anything we might mine.
        // Restricting this to interesting campaigns keeps the request count sane.
        const interesting = [...next.values()]
            .filter((campaign) => campaign.isActive)
            .filter(
                (campaign) =>
                    !this.config.excludedGames.some((game) => this.matchesGame(game, campaign)),
            )
            .filter(
                (campaign) =>
                    this.config.mineUnlistedGames ||
                    this.config.priorityGames.some((game) => this.matchesGame(game, campaign)),
            )
            .sort((a, b) => compareCampaigns(a, b, this.config.priorityGames));

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
        const mineable = [...next.values()].filter(
            (campaign) => campaign.isActive && !campaign.isCompleted,
        );
        logger.info(`${next.size} campaigns known, ${mineable.length} with work remaining.`);
        this.emit("campaigns-updated", [...next.values()]);

        // Claim anything that finished while we were not looking.
        if (this.config.autoClaimDrops) {
            for (const campaign of next.values()) {
                for (const drop of campaign.claimableDrops) {
                    await this.claim(drop, campaign);
                }
            }
        }
    }
}
