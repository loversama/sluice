/**
 * Ordering a campaign's drops for display.
 *
 * Twitch does not return them in any order. On a real campaign they arrived 90, 120, 30,
 * 60 minutes - which put the only unclaimed tier second in the list and made a ladder with
 * work left on it look finished.
 */

/**
 * Sorted by the watch time each needs, with the ones watching cannot earn at the end.
 *
 * A drop requiring no minutes is not part of the progression: it is earned by some other
 * condition - playing the game, owning something, a linked account - so no amount of
 * watching will ever advance it, and it does not belong between two tiers that will.
 */
export function orderTiers(drops) {
    return [...(drops ?? [])].sort((a, b) => {
        const specialA = !a.requiredMinutes;
        const specialB = !b.requiredMinutes;
        if (specialA !== specialB) return specialA ? 1 : -1;
        return (a.requiredMinutes ?? 0) - (b.requiredMinutes ?? 0);
    });
}

/**
 * How many tiers watching can actually earn, and how many of those are done.
 *
 * Counting the rest would leave a finished ladder reading as unfinished for ever, because
 * nothing the miner does will ever tick them over.
 */
export function tierProgress(drops) {
    const earnable = (drops ?? []).filter((drop) => drop.requiredMinutes);
    return {
        total: earnable.length,
        claimed: earnable.filter((drop) => drop.isClaimed).length,
    };
}
