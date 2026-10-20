/**
 * What to say when nothing is being mined.
 *
 * Kept apart from the components because three surfaces show it - the dashboard panel, the
 * narrow layout, and the tray tooltip - and they disagreed the last time each carried its
 * own wording. It is a plain function over the daemon's `idle` payload so it can be tested
 * like any other, rather than only by looking at it.
 *
 * The tone matters here. Idle is not an error and not a stop: mining resumes on its own the
 * moment there is something to mine, and every message has to leave the reader sure of that.
 */

/** A count, worded so it reads in a sentence. */
function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
}

/**
 * Headline and explanation for an idle state.
 *
 * @param {{reason: string, detail: object}|null} idle
 * @returns {{title: string, body: string, tone: "good"|"neutral", action: string|null}}
 */
export function idleCopy(idle) {
    if (!idle) {
        return { title: "", body: "", tone: "neutral", action: null };
    }
    const detail = idle.detail ?? {};

    switch (idle.reason) {
        case "all_claimed":
            return {
                title: "All caught up",
                body: `Every drop available to you has been claimed${
                    detail.completed ? ` across ${plural(detail.completed, "campaign", "campaigns")}` : ""
                }. Mining starts again by itself when a new campaign appears.`,
                tone: "good",
                action: null,
            };

        case "nothing_eligible": {
            // The one case the user can actually act on, so it says which setting did it.
            const reasons = [];
            if (detail.filteredByPolicy) {
                reasons.push(`${plural(detail.filteredByPolicy, "campaign is", "campaigns are")} outside your library and priority settings`);
            }
            if (detail.excluded) {
                reasons.push(`${plural(detail.excluded, "is", "are")} on your excluded list`);
            }
            if (detail.completed) {
                reasons.push(`${plural(detail.completed, "is", "are")} already claimed`);
            }
            return {
                title: "Nothing eligible for you",
                body: `${plural(detail.activeCampaigns ?? 0, "campaign is", "campaigns are")} running${
                    reasons.length ? `, but ${reasons.join(", and ")}` : ""
                }. Mining starts again by itself when something matches - widening your settings would give it more to work with.`,
                tone: "neutral",
                action: "priorities",
            };
        }

        case "no_campaigns":
            return {
                title: "Nothing to mine anywhere",
                body: detail.upcoming
                    ? `Twitch has no drop campaigns running. ${plural(detail.upcoming, "is", "are")} due to start; mining begins on its own when the first one does.`
                    : "Twitch has no drop campaigns running at the moment. Mining starts again by itself when one appears.",
                tone: "neutral",
                action: null,
            };

        case "no_live_channels":
            return {
                title: "Waiting for a channel",
                body: `${plural(detail.eligible ?? 0, "campaign is", "campaigns are")} waiting, but nobody is streaming ${
                    (detail.eligible ?? 0) === 1 ? "it" : "them"
                } right now. Mining starts the moment someone goes live.`,
                tone: "neutral",
                action: null,
            };

        default:
            return {
                title: "Not mining",
                body: "Nothing to work on right now. Mining resumes by itself.",
                tone: "neutral",
                action: null,
            };
    }
}

/**
 * What the top of the dashboard says while nothing is being mined, in either layout.
 *
 * Pausing, the daily limit and the schedule come first: each is a setting doing its job, and
 * the daemon's idle reason underneath is beside the point until it lifts. The narrow layout
 * used to skip all of this and say "Nothing being mined right now" whatever the reason.
 *
 * @returns {{title: string, body: string}}
 */
export function idleHeadline({ paused = false, atDailyLimit = false, outsideSchedule = false, idle = null } = {}) {
    if (paused) {
        return { title: "Paused", body: "Nothing is being watched or claimed until you resume." };
    }
    if (atDailyLimit) {
        return { title: "Daily limit reached", body: "Today's allowance is used up. Mining resumes tomorrow." };
    }
    if (outsideSchedule) {
        return {
            title: "Outside your hours",
            body: "Mining is set to certain hours, and now is not one of them.",
        };
    }
    const copy = idleCopy(idle);
    return {
        title: copy.title || "Nothing to mine right now",
        body: copy.body || "Nothing available to mine right now.",
    };
}

/** The same thing in one line, for the tray tooltip, which Windows truncates without mercy. */
export function idleTooltip(idle) {
    if (!idle) return "Sluice";
    switch (idle.reason) {
        case "all_claimed":
            return "All drops claimed - watching for new campaigns";
        case "nothing_eligible":
            return "Nothing matches your settings - watching for new campaigns";
        case "no_campaigns":
            return "No campaigns running - watching for new ones";
        case "no_live_channels":
            return "Waiting for someone to go live";
        default:
            return "Not mining";
    }
}
