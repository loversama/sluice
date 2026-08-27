import { describe, expect, it } from "vitest";

// @ts-expect-error - plain JS module shared with the dashboard build.
import { gamesIn, orderDraggedGame } from "../web/src/lib/ranking.js";

const campaign = (game: string, id = game) => ({ id, game: { name: game } });

/**
 * Dragging a queue row writes a queue order, which is stored apart from the priority list.
 *
 * Two versions of this have been wrong. The first snapshotted the whole visible queue into
 * the priority list - one drag on the full dashboard enrolled about fifty games. The second
 * moved only one game but still wrote it to the priority list, which on an account set to
 * "only games I own" made every dragged game count as owned. Neither should be possible
 * now: this writes to queueOrder and the priority list is only ever edited by hand.
 */
describe("orderDraggedGame", () => {
    it("moves only the game that moved", () => {
        const queue = [campaign("Rust"), campaign("Dota 2"), campaign("Apex")];

        // Apex dragged to the top.
        expect(orderDraggedGame([queue[2], queue[0], queue[1]], [], 0)).toEqual(["Apex"]);
    });

    it("does not order the world, however long the queue is", () => {
        // The regression that prompted this rewrite: a seventy-row queue, one drag.
        const queue = Array.from({ length: 70 }, (_, i) => campaign(`Game ${i}`));
        const dragged = [queue[40], ...queue.filter((_, i) => i !== 40)];

        const next = orderDraggedGame(dragged, [], 0);

        expect(next).toEqual(["Game 40"]);
        expect(next).toHaveLength(1);
    });

    it("leaves games the user never dragged out of it, so the mode still decides them", () => {
        // Anything absent from the list is ranked by mode - ending soonest, Steam playtime,
        // whatever was chosen. Pinning everything is what silently disabled that.
        const queue = [campaign("Rust"), campaign("Dota 2"), campaign("Apex")];

        expect(orderDraggedGame(queue, [], 1)).toEqual(["Rust", "Dota 2"].slice(1, 2));
    });

    it("drops below the pinned game it was dropped under", () => {
        const queue = [campaign("Rust"), campaign("Apex"), campaign("Dota 2")];

        // Apex dropped below Rust, which is already pinned.
        expect(orderDraggedGame(queue, ["Rust", "Valorant"], 1)).toEqual([
            "Rust",
            "Apex",
            "Valorant",
        ]);
    });

    it("goes to the top when nothing pinned sits above the drop", () => {
        const queue = [campaign("Apex"), campaign("Rust")];

        expect(orderDraggedGame(queue, ["Rust"], 0)).toEqual(["Apex", "Rust"]);
    });

    it("moves rather than duplicates a game already in the list", () => {
        const queue = [campaign("Rust"), campaign("Apex")];
        const next = orderDraggedGame(queue, ["Apex", "Rust"], 1);

        expect(next.filter((game) => game === "Apex")).toHaveLength(1);
        expect(next).toEqual(["Rust", "Apex"]);
    });

    it("matches existing entries case-insensitively rather than adding a second spelling", () => {
        const queue = [campaign("Rust"), campaign("Apex")];
        const next = orderDraggedGame(queue, ["apex"], 1);

        expect(next).toHaveLength(1);
    });

    it("returns the list untouched when the drop makes no sense", () => {
        expect(orderDraggedGame([], ["Rust"], 0)).toEqual(["Rust"]);
        expect(orderDraggedGame([{ id: "x" }], ["Rust"], 0)).toEqual(["Rust"]);
    });

    it("does not mutate the list it was given", () => {
        const existing = ["Rust"];
        orderDraggedGame([campaign("Apex")], existing, 0);

        expect(existing).toEqual(["Rust"]);
    });
});

describe("gamesIn", () => {
    it("collapses several campaigns of one game", () => {
        expect(gamesIn([campaign("Rust", "a"), campaign("Rust", "b"), campaign("Apex")]))
            .toEqual(["Rust", "Apex"]);
    });

    it("ignores entries with no game name", () => {
        expect(gamesIn([{ id: "x" }, campaign("Rust")])).toEqual(["Rust"]);
    });
});

/**
 * The complaint that prompted the split: an account set to "only mine games I own" was
 * mining Kirka.io and Mir Korabley, because every game dragged in the queue had been added
 * to the priority list - and the priority list counts as owned by design, so people can
 * include titles Steam cannot see.
 */
describe("the priority list", () => {
    it("is never written by a drag", () => {
        // orderDraggedGame returns a queue order. Nothing in this module can reach the
        // priority list at all, which is the guarantee that matters.
        const queue = [campaign("Rust"), campaign("Kirka.io")];
        const result = orderDraggedGame(queue, [], 1);

        expect(result).toEqual(["Kirka.io"]);
        expect(result).not.toContain("Rust");
    });
});
