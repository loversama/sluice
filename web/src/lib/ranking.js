/**
 * Turning a dragged queue row into a priority-list change.
 *
 * The queue the dashboard shows is computed by the daemon and arrives read-only, so the
 * only place an order can be stored is the priority list. The translation has to be a
 * minimal one: pin the game that moved, and touch nothing else.
 *
 * The first version of this snapshotted the whole visible queue into the list. On the
 * narrow layout, showing a handful of rows, that looked reasonable. On the full dashboard,
 * which shows all seventy, a single drag pinned about fifty games - which silently froze
 * ranking to that moment (a campaign appearing tomorrow sorts below fifty pinned games,
 * however soon it ends), disabled whichever ordering mode the user had chosen, and left a
 * fifty-row list with no undo. Snapshotting a derived list into a stored one always pins
 * the world; the fix is to stop doing it at all.
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
 * The priority list after dragging the row now sitting at `movedIndex`.
 *
 * @param queue      the queue in the order the user has just dragged it into
 * @param existing   the priority list as it stands
 * @param movedIndex where the dragged row ended up
 *
 * Exactly one game is added or moved. Its position is worked out from the pinned games it
 * was dropped below, so it lands where the user put it relative to the things that already
 * had a rank. Everything unpinned stays unpinned, which is what lets "ending soonest", the
 * Steam orderings and the rest keep deciding the games the user has expressed no opinion
 * about.
 */
export function pinDraggedGame(queue, existing, movedIndex) {
    const game = queue?.[movedIndex]?.game?.name;
    if (!game) return [...(existing ?? [])];

    const withoutMoved = (existing ?? []).filter((entry) => !sameName(entry, game));

    // The last already-pinned game above the drop point is the anchor: the dragged game
    // goes immediately after it. Nothing above the drop is reordered to make that true.
    let anchor = null;
    for (let index = 0; index < movedIndex && index < queue.length; index += 1) {
        const name = queue[index]?.game?.name;
        if (name && !sameName(name, game) && has(withoutMoved, name)) {
            anchor = name;
        }
    }

    const insertAt = anchor
        ? withoutMoved.findIndex((entry) => sameName(entry, anchor)) + 1
        : 0;

    return [...withoutMoved.slice(0, insertAt), game, ...withoutMoved.slice(insertAt)];
}
