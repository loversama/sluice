/**
 * Serializers for the HTTP API.
 *
 * `Campaign` and `Drop` expose almost everything through getters, which live on the
 * prototype and therefore vanish under `JSON.stringify`. These functions build explicit
 * plain-object shapes instead, and fold in values the daemon computes (priority rank,
 * exclusion) so the client stays free of ranking logic.
 */
import type { Config } from "../config.js";
import { isInLibraryScope } from "../models/campaign.js";
import type { Campaign, Drop } from "../models/campaign.js";

export interface RewardJson {
    name: string;
    imageURL: string | null;
}

export interface DropJson {
    id: string;
    name: string;
    rewards: RewardJson[];
    requiredMinutes: number;
    currentMinutes: number;
    startAt: string;
    endAt: string;
    isClaimed: boolean;
    isClaimable: boolean;
    isActive: boolean;
    isFinishable: boolean;
    preconditionIds: string[];
}

export interface CampaignJson {
    id: string;
    name: string;
    game: { id: string; name: string; slug: string | null; boxArtURL: string | null };
    status: "active" | "upcoming" | "expired";
    startAt: string;
    endAt: string;
    isAccountLinked: boolean;
    /** Reward can actually reach the user: linked, or a Twitch-native badge/emote. */
    isDeliverable: boolean;
    /** Rewards are badges or emotes, which need no game account link. */
    isTwitchNativeReward: boolean;
    /** The publisher's own account-linking page. */
    accountLinkUrl: string;
    /** Empty means any drops-enabled channel streaming the game qualifies. */
    allowedChannels: string[];
    inPriorities: boolean;
    /** False when the library policy will make the miner skip it. */
    inLibraryScope: boolean;
    /** True when the game is on the never-mine list. */
    priorityRank: number | null;
    isExcluded: boolean;
    isCompleted: boolean;
    /** Sent to the back of the queue with Next; cleared on restart or by restoring. */
    isDeferred: boolean;
    drops: DropJson[];
}

function matchesGame(game: string, campaign: Campaign): boolean {
    return game === campaign.gameId || game.toLowerCase() === campaign.gameName.toLowerCase();
}

export function serializeDrop(drop: Drop): DropJson {
    return {
        id: drop.id,
        name: drop.name,
        rewards: drop.data.benefitEdges.map((edge) => ({
            name: edge.benefit.name,
            imageURL: edge.benefit.imageAssetURL ?? null,
        })),
        requiredMinutes: drop.requiredMinutes,
        currentMinutes: drop.currentMinutes,
        startAt: drop.data.startAt,
        endAt: drop.data.endAt,
        isClaimed: drop.isClaimed,
        isClaimable: drop.isClaimable,
        isActive: drop.isActive,
        isFinishable: drop.isFinishable,
        preconditionIds: drop.preconditionIds,
    };
}

export function serializeCampaign(
    campaign: Campaign,
    config: Config,
    owns: ((name: string) => boolean) | null = null,
    deferred = false,
): CampaignJson {
    const rank = config.priorityGames.findIndex((game) => matchesGame(game, campaign));
    return {
        id: campaign.id,
        name: campaign.name,
        game: {
            id: campaign.gameId,
            name: campaign.gameName,
            slug: campaign.gameSlug,
            boxArtURL: campaign.boxArtUrl("72x96"),
        },
        status: campaign.isUpcoming ? "upcoming" : campaign.isActive ? "active" : "expired",
        startAt: campaign.data.startAt,
        endAt: campaign.data.endAt,
        isAccountLinked: campaign.isAccountLinked,
        isDeliverable: campaign.isDeliverable,
        isTwitchNativeReward: campaign.isTwitchNativeReward,
        accountLinkUrl: campaign.accountLinkUrl,
        allowedChannels: campaign.allowedChannelLogins,
        inPriorities: rank !== -1,
        // Why the miner will pass over this one, if it will. The queue is ranked by what
        // would be mined first, but the policy filters are applied later - so without this
        // the list showed dozens of campaigns it was never going to touch.
        inLibraryScope: isInLibraryScope(campaign, {
            policy: config.libraryPolicy,
            priorityGames: config.priorityGames,
            owns,
        }),
        priorityRank: rank === -1 ? null : rank,
        isExcluded: config.excludedGames.some((game) => matchesGame(game, campaign)),
        isCompleted: campaign.isCompleted,
        isDeferred: deferred,
        drops: campaign.drops.map(serializeDrop),
    };
}

/** Config with secrets replaced by a placeholder, safe to send to the browser. */
export function maskConfig(config: Config): Config {
    const mask = (value: string | undefined) => (value ? "********" : "");
    return {
        ...config,
        // Nothing under `steam` is a secret any more: a Steam ID names a public profile,
        // and the app holds no key of its own to leak.
        notifications: {
            ...(config.notifications.telegram && {
                telegram: {
                    botToken: mask(config.notifications.telegram.botToken),
                    chatId: config.notifications.telegram.chatId,
                },
            }),
            ...(config.notifications.discord && {
                discord: {
                    webhookUrl: mask(config.notifications.discord.webhookUrl),
                    botToken: mask(config.notifications.discord.botToken ?? ""),
                    channelId: config.notifications.discord.channelId ?? "",
                },
            }),
        },
    };
}

/** True if a submitted secret is the mask, meaning "keep the existing value". */
export function isMasked(value: string | undefined): boolean {
    return value === "********";
}
