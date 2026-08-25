/**
 * Turn a dragged queue order into a priority list the daemon will honour.
 *
 * The queue the dashboard shows is computed by the daemon and arrives read-only, so the
 * only place an order can actually be stored is the priority list. This is the translation
 * between the two, kept out of the component because getting it wrong is not visible in
 * the markup - it shows up as the miner leaving a stream it was halfway through.
 */

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

/** Distinct game names in list order - one game can hold several queued campaigns. */
export function gamesIn(queue) {
    const out = [];
    for (const item of queue) {
        const name = item?.game?.name;
        if (name && !out.some((game) => sameName(game, name))) out.push(name);
    }
    return out;
}

/**
 * @param queue     the queue in the order the user just dragged it into
 * @param existing  the priority list as it stands
 * @param current   the game being mined right now, if any
 *
 * Two things this protects:
 *
 * Games already ranked that have no mineable campaign right now are inert - they cannot
 * appear in the queue - so they keep their existing places. Without that, arranging the
 * queue would silently reshuffle a list curated on the priorities page.
 *
 * And whatever is being mined stays ahead of everything in the queue. The daemon re-ranks
 * as soon as config changes and switches channel if the top campaign moved, so pinning the
 * queue without this would mean nudging item three abandons the stream already in progress.
 */
export function nextPriorityGames(queue, existing, current) {
    const queued = gamesIn(queue);
    const untouched = existing.filter((game) => !queued.some((name) => sameName(name, game)));
    const keepsMining =
        current && !untouched.some((game) => sameName(game, current)) ? [current] : [];

    return [...keepsMining, ...untouched, ...queued];
}
