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
 *
 * One exception, which cannot grow the list: a game that is *already* on it can be dragged
 * to a new place in it. The priority list always outranks the queue order, so without this
 * dragging a priority game did nothing - the drop was saved, the daemon re-ranked, and the
 * row slid back a couple of seconds later. Moving an entry within the list never adds one,
 * so neither of the failures above can come back through it.
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

/** Whether a queue row's game is on `list`, by name or by game ID - the list allows both. */
export function isListed(list, item) {
    const name = item?.game?.name;
    const id = item?.game?.id;
    return (list ?? []).some(
        (entry) => (name && sameName(entry, name)) || (id && String(entry) === String(id)),
    );
}

/**
 * The priority list after dragging the row at `movedIndex`, or null if that row's game is
 * not on the list (the queue order handles those).
 *
 * The game is placed just above the nearest priority game now below it in the queue, or
 * just below the nearest one above it if it was dropped beneath them all. Only the dragged
 * entry moves; nothing is added and nothing else changes place.
 */
export function reorderPriorityGames(queue, priorityGames, movedIndex) {
    const moved = queue?.[movedIndex];
    if (!moved || !isListed(priorityGames, moved)) return null;

    const isMoved = (entry) => isListed([entry], moved);
    const entry = priorityGames.find(isMoved);
    const without = priorityGames.filter((candidate) => !isMoved(candidate));
    const sameGame = (item) => isListed([entry], item);
    const slotOf = (item) => without.findIndex((candidate) => isListed([candidate], item));

    for (let index = movedIndex + 1; index < queue.length; index += 1) {
        const item = queue[index];
        if (sameGame(item)) continue;
        const slot = slotOf(item);
        if (slot !== -1) return [...without.slice(0, slot), entry, ...without.slice(slot)];
    }
    for (let index = movedIndex - 1; index >= 0; index -= 1) {
        const item = queue[index];
        if (sameGame(item)) continue;
        const slot = slotOf(item);
        if (slot !== -1) return [...without.slice(0, slot + 1), entry, ...without.slice(slot + 1)];
    }
    return [...priorityGames];
}

/** Whether any row below `movedIndex` is a priority game - which a drag can never pass. */
export function priorityGameBelow(queue, priorityGames, movedIndex) {
    return (queue ?? []).slice(movedIndex + 1).some((item) => isListed(priorityGames, item));
}
