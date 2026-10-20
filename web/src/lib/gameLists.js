/**
 * Edits to the three game lists, as plain functions over the lists.
 *
 * The priority list, the excluded list and the queue order were each edited in two or three
 * places with their own idea of what "the same game" meant - one compared names exactly, so
 * "rust" could be prioritised twice, and none understood that an entry may be a Twitch game
 * ID. These match the way the daemon does (see matchesGame), and keep the two rules that
 * hold between the lists: a game is never both prioritised and excluded, and nothing is
 * added twice.
 *
 * A game is a name or { name, id }. New entries are written as the name, as they always were.
 */
import { matchesGame } from "./ranking.js";

const nameOf = (game) => (typeof game === "string" ? game : game?.name ?? "");

/** Where `game` sits in `list`, or -1. */
export function indexIn(list, game) {
    return (list ?? []).findIndex((entry) => matchesGame(entry, game));
}

export function isOn(list, game) {
    return indexIn(list, game) !== -1;
}

/** `list` without any entry naming `game`. */
export function without(list, game) {
    return (list ?? []).filter((entry) => !matchesGame(entry, game));
}

/**
 * Prioritise a game. Taking it off the excluded list is part of saying you want it.
 *
 * A game already on the list keeps its place unless `top` is asked for, when it moves to
 * the front - its own entry, so an ID stays an ID.
 */
export function prioritise({ priorityGames = [], excludedGames = [] }, game, { top = false } = {}) {
    const at = indexIn(priorityGames, game);
    const entry = at === -1 ? nameOf(game) : priorityGames[at];
    let next = [...priorityGames];
    if (at === -1) {
        next = top ? [entry, ...next] : [...next, entry];
    } else if (top) {
        next = [entry, ...without(priorityGames, game)];
    }
    return { priorityGames: next, excludedGames: without(excludedGames, game) };
}

export function removePriority({ priorityGames = [] }, game) {
    return { priorityGames: without(priorityGames, game) };
}

/** Exclude a game. It leaves the priority list and the queue order too: never means never. */
export function exclude({ priorityGames = [], excludedGames = [], queueOrder = [] }, game) {
    return {
        priorityGames: without(priorityGames, game),
        excludedGames: isOn(excludedGames, game) ? [...excludedGames] : [...excludedGames, nameOf(game)],
        queueOrder: without(queueOrder, game),
    };
}

export function unexclude({ excludedGames = [] }, game) {
    return { excludedGames: without(excludedGames, game) };
}

/** Take one game out of the dragged order, leaving it to the ordering mode again. */
export function unorder({ queueOrder = [] }, game) {
    return { queueOrder: without(queueOrder, game) };
}
