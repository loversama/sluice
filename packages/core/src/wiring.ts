import type { EventEmitter } from "node:events";

import type { Config } from "./config.js";
import type { Miner } from "./miner.js";
import type { Campaign } from "./models/campaign.js";
import type { NotifierGroup } from "./notifiers/index.js";
import { serializeCampaign } from "./api/serialize.js";
import { StaleQueryHashError, AuthExpiredError } from "./twitch/gql.js";

/**
 * Translate a session's miner events into the shapes the dashboard consumes, and into the
 * notifications the user receives.
 *
 * This lives apart from any one host because both distributions must say exactly the same
 * things. Left in the CLI entry point, every string here would have had to be duplicated
 * for the desktop build, and the two would have drifted the first time either was edited.
 *
 * Returns a function that detaches every listener. A session ends by discarding its miner,
 * but the bus outlives it, so a miner still unwinding must not keep writing to a stream
 * that now belongs to its successor.
 */
export function wireMinerToBus(deps: {
    miner: Miner;
    bus: EventEmitter;
    /**
     * Asked at the moment of sending rather than captured once. Saving settings builds a
     * new notifier, and a captured one went on delivering to the old Telegram chat or
     * webhook - or to none at all - until the next restart.
     */
    getNotifier(): NotifierGroup;
    getConfig(): Config;
}): () => void {
    const { miner, bus } = deps;

    // Translate miner events into the JSON shapes the dashboard consumes.
    miner.on("watching", ({ channel, campaign, drop }) => {
        bus.emit("watching", {
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
        });
    });
    miner.on("progress", ({ drop, minutes, required }) => {
        bus.emit("progress", {
            dropId: drop.id,
            campaignId: drop.campaign.id,
            minutes,
            required,
        });
    });
    miner.on("drop-claimed", ({ drop, campaign }) => {
        publishStats();
        bus.emit("drop-claimed", {
            dropId: drop.id,
            campaignId: campaign.id,
            dropName: drop.rewardNames || drop.name,
            gameName: campaign.gameName,
            rewardImageURL: drop.data.benefitEdges[0]?.benefit.imageAssetURL ?? null,
            at: Date.now(),
        });
        // An unlinked claim used to send two messages at once - a claim and a separate
        // warning about the same drop. The warning is folded in here instead.
        const deliverable = campaign.isDeliverable;
        void deps.getNotifier().send({
            kind: deliverable ? "claim" : "warning",
            title: deliverable ? "Drop claimed" : campaign.gameName,
            lines: [
                deliverable ? "" : "Drop claimed, but your account is not linked",
                drop.rewardNames || drop.name,
                `${campaign.gameName} - ${campaign.name}`,
                deliverable
                    ? ""
                    : "Link now - some publishers only honour a link made before claiming.",
            ].filter(Boolean),
            imageUrl: drop.data.benefitEdges[0]?.benefit.imageAssetURL ?? null,
            url: deliverable ? null : campaign.accountLinkUrl,
        });
    });
    /**
     * The totals beside the claim list.
     *
     * They are derived from claim history rather than stored, and only ever travelled in a
     * full snapshot - so a claim appeared in the list while "62 drops" beside it stayed at
     * 61 until something unrelated caused a refetch.
     */
    const publishStats = (): void => {
        bus.emit("stats", miner?.getClaimStats() ?? null);
    };

    miner.on("idle", (payload) => {
        bus.emit("idle", payload);
    });
    miner.on("loading", (payload) => {
        bus.emit("loading", payload);
    });
    miner.on("campaign-completed", (campaign) => {
        publishStats();
        bus.emit("campaign-completed", {
            campaignId: campaign.id,
            name: campaign.name,
            gameName: campaign.gameName,
            // The game's box art, so a completion is as recognisable as a claim. The
            // in-app notifier below has always had it; only the bus payload went without,
            // which left the desktop notification as the one announcement with no picture.
            boxArtUrl: campaign.boxArtUrl(),
        });
        void deps.getNotifier().send({
            kind: "complete",
            title: "Campaign complete",
            lines: [
                `${campaign.gameName} - ${campaign.name}`,
                `${campaign.drops.length} drop${campaign.drops.length === 1 ? "" : "s"} claimed`,
            ],
            imageUrl: campaign.boxArtUrl(),
        });
    });
    miner.on("campaigns-updated", (campaigns: Campaign[]) => {
        bus.emit("campaigns", {
            campaigns: campaigns.map((campaign) =>
                serializeCampaign(
                    campaign,
                    deps.getConfig(),
                    miner?.ownsPredicate ?? null,
                    miner?.isDeferred(campaign.id),
                ),
            ),
            queue: miner?.getMineableCampaigns().map((campaign) => campaign.id) ?? [],
            nextRefreshAt: miner?.getNextRefreshAt()
                ? new Date(miner.getNextRefreshAt()!).toISOString()
                : null,
        });
    });
    miner.on("unlinked-expiring", ({ campaign, earnedMinutes, rewards, hoursLeft }) => {
        const hours = hoursLeft < 1 ? "under an hour" : `${Math.round(hoursLeft)} hours`;
        void deps.getNotifier().send({
            kind: "warning",
            // Game name leads: it is what the reader recognises at a glance in a
            // notification list, with the reason for the alert on the line beneath.
            title: campaign.gameName,
            lines: [
                "Link your account to keep this drop",
                campaign.name,
                `${earnedMinutes} minutes earned, expires in ${hours}.`,
                rewards.length ? `At risk: ${rewards.join(", ")}` : "",
                "Your Twitch account is not linked, so this will not reach the game.",
            ].filter(Boolean),
            imageUrl: campaign.boxArtUrl(),
            url: campaign.accountLinkUrl,
        });
    });

    miner.on("unlinked-claim", ({ campaign, drop, held }) => {
        // Only a held drop needs its own message: nothing was claimed, so no claim
        // notification follows. When the drop is claimed the warning travels with it.
        if (!held) {
            return;
        }
        void deps.getNotifier().send({
            kind: "warning",
            title: campaign.gameName,
            lines: [
                "Drop ready but held - account not linked",
                drop.rewardNames || drop.name,
                "Link your account, then claim it from the Twitch inventory.",
            ],
            imageUrl: drop.data.benefitEdges[0]?.benefit.imageAssetURL ?? null,
            url: campaign.accountLinkUrl,
        });
    });

    miner.on("beat", (payload) => bus.emit("beat", payload));
    // No payload: the dashboard re-reads its state when it hears this.
    miner.on("status", () => bus.emit("status"));
    miner.on("feed", (entry) => bus.emit("feed", entry));
    miner.on("error", (error) => {
        const fatal = error instanceof StaleQueryHashError || error instanceof AuthExpiredError;
        bus.emit("problem", {
            level: fatal ? "fatal" : "warn",
            code:
                error instanceof StaleQueryHashError
                    ? "stale-hash"
                    : error instanceof AuthExpiredError
                      ? "auth"
                      : "generic",
            message: error.message,
        });
        if (fatal) {
            void deps.getNotifier().send({
                kind: "warning",
                title: "Mining stopped",
                lines: [error.message],
            });
        }
    });
    return () => {
        miner.removeAllListeners();
    };
}
