import type { IdleState } from "./idle.js";
import type { Campaign, Drop } from "./models/campaign.js";

/**
 * Why a spell on one channel ended.
 *
 * Every exit from watching used to be a bare `return`, so the only evidence of why the miner
 * had moved on - or whether it had meant to - was whichever log line happened to precede it,
 * and some exits had none. A loop that re-entered the same drop every six seconds looked, in
 * the feed, like nothing at all.
 */
export type WatchEnd =
    /** The drop was claimed, or finished some other way. */
    | "claimed"
    /** Ready to claim, but nothing was claimed and nothing changed. Must not be re-entered at once. */
    | "claim_stuck"
    | "offline"
    | "benched"
    | "campaign_ended"
    | "better_campaign"
    | "paused"
    | "outside_window"
    | "stopped";

/** Whether leaving for this reason is one the user chose, so no "moving on" line is needed. */
export function isDeliberateStop(end: WatchEnd): boolean {
    return end === "paused" || end === "outside_window" || end === "stopped";
}

/**
 * Mark every drop we already know the outcome of: claimed, or given up on.
 *
 * Twitch's inventory can go on reporting a claimed drop as unclaimed - it has been seen doing
 * so on GTA V and on EVE Online - and the miner rightly refuses to claim it again. But the
 * refusal lived only in the claim step, so the drop itself still read "100%, not claimed":
 * selection kept choosing it, watching it ended instantly because the claim was declined, and
 * the loop turned over every few seconds without ever saying why.
 *
 * Applying what is known to the drop objects themselves removes the contradiction at its
 * source, so selection, completion and the dashboard all agree.
 *
 * `confirmed` are claims Twitch acknowledged; `givenUp` are drops the miner stopped trying to
 * claim after repeated attempts. Neither can be undone by a later inventory read. A given-up
 * drop is set aside rather than marked claimed: nothing says its reward ever arrived, and
 * reporting it as claimed - or its campaign as complete - would say otherwise. Returns how
 * many drops changed, so a caller can say so.
 */
export function applyKnownClaims(
    campaigns: Iterable<Campaign>,
    confirmed: ReadonlySet<string>,
    givenUp: ReadonlySet<string>,
): number {
    let changed = 0;
    for (const campaign of campaigns) {
        for (const drop of campaign.drops) {
            if (drop.isClaimed) {
                continue;
            }
            if (confirmed.has(drop.id)) {
                drop.update({ isClaimed: true });
                changed++;
            } else if (givenUp.has(drop.id) && !drop.givenUp) {
                drop.givenUp = true;
                changed++;
            }
        }
    }
    return changed;
}

function dropLabel(drop: Drop | null, campaign: Campaign): string {
    return drop ? `${campaign.gameName} - ${drop.rewardNames || drop.name}` : campaign.gameName;
}

/** One line saying why the miner left a channel, or null when another line already did. */
export function describeLeave(end: WatchEnd, channelName: string): string | null {
    switch (end) {
        case "offline":
            return `${channelName} went offline`;
        case "campaign_ended":
            return "The campaign ended";
        case "better_campaign":
            return "A higher-priority campaign is available";
        case "claim_stuck":
            return "The reward is ready but could not be claimed";
        // These are reported where they happen, with more to say than a reason code has.
        case "claimed":
        case "benched":
        case "paused":
        case "outside_window":
        case "stopped":
            return null;
    }
}

/** What the miner will do next, in the same breath as the reason it moved. */
export function describeNext(next: { campaign: Campaign; drop: Drop | null } | null): string {
    return next ? `Next up: ${dropLabel(next.drop, next.campaign)}` : "Nothing else to mine right now";
}

/**
 * The idle state in a sentence a person can act on: what is going on, and when the miner
 * will look again. The dashboard has the numbers; this is for the feed and the log.
 */
export function describeIdle(idle: IdleState, checkAgainMinutes: number, now = Date.now()): string {
    const { detail } = idle;
    const again = `Checking again in ${checkAgainMinutes} min`;

    const upcoming = (() => {
        if (!detail.nextUpcomingAt) {
            return "";
        }
        const minutes = Math.round((Date.parse(detail.nextUpcomingAt) - now) / 60_000);
        if (!Number.isFinite(minutes) || minutes <= 0) {
            return "";
        }
        const when =
            minutes >= 120 ? `in ${Math.round(minutes / 60)}h` : minutes >= 60 ? "in about an hour" : `in ${minutes} min`;
        return ` The next campaign starts ${when}.`;
    })();

    switch (idle.reason) {
        case "all_claimed":
            return `All caught up: everything available has been claimed.${upcoming} ${again}.`;
        case "nothing_eligible":
            return (
                `Idle: ${detail.activeCampaigns} campaigns are running, but your settings rule them ` +
                `all out.${upcoming} ${again}.`
            );
        case "no_campaigns":
            return `Idle: Twitch has no active drop campaigns right now.${upcoming} ${again}.`;
        case "no_live_channels":
            return (
                `Idle: ${detail.eligible} campaign${detail.eligible === 1 ? " is" : "s are"} ` +
                `available, but nobody suitable is streaming. ${again}.`
            );
    }
}
