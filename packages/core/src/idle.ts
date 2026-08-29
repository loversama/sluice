import type { Campaign } from "./models/campaign.js";

/**
 * Why the miner is not watching anything.
 *
 * Idleness used to be the absence of a `watching` event, which meant the dashboard was
 * never told it had happened - the browser held the last thing it saw until something
 * forced a refetch, and a claimed drop sat under "choosing what to mine next" indefinitely.
 * Saying so out loud, with a reason, is the whole point of this module.
 *
 * These are only the reasons that come from having nothing to work on. Paused, outside the
 * schedule and at the daily cap are all deliberate stops, already reported separately, and
 * the view decides which of them to lead with.
 */
export type IdleReason =
    /** Everything the policy allows has been claimed. The good ending. */
    | "all_claimed"
    /** Campaigns are running, but the settings rule all of them out. */
    | "nothing_eligible"
    /** Twitch has no active campaigns at all. */
    | "no_campaigns"
    /** There is work, but nobody is streaming it this pass. */
    | "no_live_channels";

/**
 * The numbers behind the reason.
 *
 * Carried so the dashboard can state what it knows rather than infer it from whatever
 * campaign list it happens to hold - the two disagreed often enough to be worth removing
 * the possibility.
 */
export interface IdleDetail {
    /** Running now, whether or not they are any use to this account. */
    activeCampaigns: number;
    /** Running, and every drop already claimed. */
    completed: number;
    /** Ruled out by the library policy, the priority mode, or the unlinked policy. */
    filteredByPolicy: number;
    /** Ruled out by name, in the excluded list. */
    excluded: number;
    /** Passed every filter. Non-zero only when the reason is no_live_channels. */
    eligible: number;
    /** Not started yet. */
    upcoming: number;
    /** When the soonest of those starts, if any. */
    nextUpcomingAt: string | null;
}

export interface IdleState {
    reason: IdleReason;
    /** When this spell of idleness began, so the UI can age it. */
    since: number;
    detail: IdleDetail;
}

export interface IdleInputs {
    /** Every campaign known, active and upcoming alike. */
    campaigns: Campaign[];
    /**
     * The campaigns the miner would try, already filtered and ranked.
     *
     * Passed in rather than recomputed: this has to be the same list selection actually
     * used, or the dashboard explains a decision that was never made.
     */
    eligible: Campaign[];
    /** Excluded by name. */
    isExcluded(campaign: Campaign): boolean;
}

/** Why there is nothing to mine, given what the miner just decided. */
export function classifyIdle(inputs: IdleInputs, now = Date.now()): IdleState {
    const { campaigns, eligible, isExcluded } = inputs;

    const active = campaigns.filter((campaign) => campaign.isActive);
    const upcoming = campaigns.filter((campaign) => campaign.isUpcoming);
    const completed = active.filter((campaign) => campaign.isCompleted);
    const excluded = active.filter((campaign) => !campaign.isCompleted && isExcluded(campaign));

    const soonest = upcoming
        .map((campaign) => campaign.startAt.getTime())
        .sort((a, b) => a - b)[0];

    const detail: IdleDetail = {
        activeCampaigns: active.length,
        completed: completed.length,
        excluded: excluded.length,
        // Whatever is left once the claimed and the excluded are set aside: campaigns that
        // exist, are unfinished, and were still not picked.
        filteredByPolicy: Math.max(
            0,
            active.length - completed.length - excluded.length - eligible.length,
        ),
        eligible: eligible.length,
        upcoming: upcoming.length,
        nextUpcomingAt: soonest === undefined ? null : new Date(soonest).toISOString(),
    };

    return { reason: reasonFor(active, completed, eligible), since: now, detail };
}

function reasonFor(active: Campaign[], completed: Campaign[], eligible: Campaign[]): IdleReason {
    if (active.length === 0) {
        return "no_campaigns";
    }
    // Selection produced candidates and the pass still found nothing to watch, so the
    // shortage is of live channels rather than of work.
    if (eligible.length > 0) {
        return "no_live_channels";
    }
    // Nothing was eligible. If that is because it is all finished, say so as an
    // achievement; otherwise it is the settings ruling things out, which is a different
    // sentence and a different thing to do about it.
    return completed.length === active.length ? "all_claimed" : "nothing_eligible";
}

/** Whether two states describe the same situation, so it is only announced when it changes. */
export function sameIdle(a: IdleState | null, b: IdleState | null): boolean {
    if (a === null || b === null) {
        return a === b;
    }
    return (
        a.reason === b.reason &&
        a.detail.activeCampaigns === b.detail.activeCampaigns &&
        a.detail.completed === b.detail.completed &&
        a.detail.eligible === b.detail.eligible &&
        a.detail.filteredByPolicy === b.detail.filteredByPolicy &&
        a.detail.excluded === b.detail.excluded &&
        a.detail.upcoming === b.detail.upcoming
    );
}
