/**
 * Turning a dragged queue row into a stored order.
 *
 * The queue the dashboard shows is computed by the daemon and arrives read-only, so a drag
 * has to be written down somewhere. It is written to `queueOrder`, which exists only for
 * this, and never to the priority list.
 *
 * That separation is the whole point. The priority list is curated by hand and means "these
 * are the games I want"; dragging the queue means "not that one first", which is a much
 * smaller statement. An earlier version wrote drags into the priority list - and because
 * the wide queue shows every campaign, one drag enrolled fifty-odd games into a list the
 * user was keeping by hand, which then counted as owned and defeated "only mine games I
 * own" entirely.
 */

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

const has = (list, name) => list.some((entry) => sameName(entry, name));

/** Distinct game names in list order - one game can hold several queued campaigns. */
export function gamesIn(queue) {
    const out = [];
    for (const item of queue) {
        const name = item?.game?.name;
        if (name && !has(out, name)) out.push(name);
    }
    return out;
}

/**
 * The queue order after dragging the row now sitting at `movedIndex`.
 *
 * @param queue      the queue in the order the user has just dragged it into
 * @param existing   the stored queue order as it stands
 * @param movedIndex where the dragged row ended up
 *
 * Exactly one game moves, positioned after the last already-ordered game above the drop.
 * Everything the user has not dragged stays absent, and absent means "decided by whichever
 * ordering mode is set" - which is what lets ending-soonest and the Steam orderings go on
 * working for the rest of the queue.
 */
export function orderDraggedGame(queue, existing, movedIndex) {
    const game = queue?.[movedIndex]?.game?.name;
    if (!game) return [...(existing ?? [])];

    const without = (existing ?? []).filter((entry) => !sameName(entry, game));

    let anchor = null;
    for (let index = 0; index < movedIndex && index < queue.length; index += 1) {
        const name = queue[index]?.game?.name;
        if (name && !sameName(name, game) && has(without, name)) {
            anchor = name;
        }
    }

    const insertAt = anchor ? without.findIndex((entry) => sameName(entry, anchor)) + 1 : 0;
    return [...without.slice(0, insertAt), game, ...without.slice(insertAt)];
}
