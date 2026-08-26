/**
 * Noticing that something else is watching Twitch as you.
 *
 * Twitch credits one watch session per account. Open Sluice twice - the desktop app and the
 * container, or two machines - or simply watch a stream in a browser, and only one of them
 * earns anything. The loser sends its beats, gets a cheerful acknowledgement, and earns
 * nothing at all.
 *
 * The miner already spots its own drop going nowhere, but it blames the channel and moves
 * to another one, then another, for as long as the other session runs. The signal that
 * tells the two apart is elsewhere in the inventory: if a drop we are *not* watching gained
 * minutes while the one we are watching did not, the account is plainly still earning -
 * just not here.
 */

export interface ProgressSnapshot {
    /** Minutes watched, by drop id, as Twitch last reported them. */
    minutes: Map<string, number>;
    dropId: string | null;
}

export interface ForeignSession {
    /** The drop that moved without us, for saying which game it was. */
    dropId: string;
    gainedMinutes: number;
}

/**
 * Whether another session appears to be earning on this account.
 *
 * Deliberately narrow. It needs our own drop to be *stationary* - not merely slow - and
 * another one to have moved in the same window, which is not something an idle account can
 * produce. Twitch reporting our progress late would show as both moving, and a campaign
 * ending or being claimed shows as no movement at all.
 */
export function detectForeignSession(
    before: ProgressSnapshot,
    after: ProgressSnapshot,
): ForeignSession | null {
    // Only meaningful while we are actually watching something, and watching the same thing
    // we were: a drop we switched away from is expected to stand still.
    if (!before.dropId || before.dropId !== after.dropId) {
        return null;
    }

    const ourBefore = before.minutes.get(before.dropId);
    const ourAfter = after.minutes.get(before.dropId);
    if (ourBefore === undefined || ourAfter === undefined || ourAfter > ourBefore) {
        return null;
    }

    for (const [dropId, minutes] of after.minutes) {
        if (dropId === before.dropId) continue;

        const previous = before.minutes.get(dropId);
        // Unknown before means newly discovered, not newly progressed - a campaign refresh
        // routinely turns up drops with minutes already on them.
        if (previous === undefined || minutes <= previous) continue;

        return { dropId, gainedMinutes: minutes - previous };
    }

    return null;
}
