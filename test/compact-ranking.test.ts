import { describe, expect, it } from "vitest";

// @ts-expect-error - plain JS module shared with the dashboard build.
import { gamesIn, pinDraggedGame } from "../web/src/lib/ranking.js";

const campaign = (game: string, id = game) => ({ id, game: { name: game } });

/**
 * Dragging a queue row edits the priority list, because the queue itself is computed by the
 * daemon and cannot be written to. The rule has to be minimal: exactly one game moves.
 *
 * The version this replaced snapshotted the whole visible queue into the list, which on the
 * full dashboard meant one drag pinned about fifty games - freezing ranking to that moment
 * and disabling whichever ordering mode was chosen. These tests exist mostly to stop that
 * coming back.
 */
describe("pinDraggedGame", () => {
    it("pins only the game that moved", () => {
        const queue = [campaign("Rust"), campaign("Dota 2"), campaign("Apex")];

        // Apex dragged to the top.
        expect(pinDraggedGame([queue[2], queue[0], queue[1]], [], 0)).toEqual(["Apex"]);
    });

    it("does not pin the world, however long the queue is", () => {
        // The regression that prompted this rewrite: a seventy-row queue, one drag.
        const queue = Array.from({ length: 70 }, (_, i) => campaign(`Game ${i}`));
        const dragged = [queue[40], ...queue.filter((_, i) => i !== 40)];

        const next = pinDraggedGame(dragged, [], 0);

        expect(next).toEqual(["Game 40"]);
        expect(next).toHaveLength(1);
    });

    it("leaves games the user never touched unpinned, so the ordering mode still decides them", () => {
        // Anything absent from the list is ranked by mode - ending soonest, Steam playtime,
        // whatever was chosen. Pinning everything is what silently disabled that.
        const queue = [campaign("Rust"), campaign("Dota 2"), campaign("Apex")];

        expect(pinDraggedGame(queue, [], 1)).toEqual(["Rust", "Dota 2"].slice(1, 2));
    });

    it("drops below the pinned game it was dropped under", () => {
        const queue = [campaign("Rust"), campaign("Apex"), campaign("Dota 2")];

        // Apex dropped below Rust, which is already pinned.
        expect(pinDraggedGame(queue, ["Rust", "Valorant"], 1)).toEqual([
            "Rust",
            "Apex",
            "Valorant",
        ]);
    });

    it("goes to the top when nothing pinned sits above the drop", () => {
        const queue = [campaign("Apex"), campaign("Rust")];

        expect(pinDraggedGame(queue, ["Rust"], 0)).toEqual(["Apex", "Rust"]);
    });

    it("moves rather than duplicates a game already in the list", () => {
        const queue = [campaign("Rust"), campaign("Apex")];
        const next = pinDraggedGame(queue, ["Apex", "Rust"], 1);

        expect(next.filter((game) => game === "Apex")).toHaveLength(1);
        expect(next).toEqual(["Rust", "Apex"]);
    });

    it("matches existing entries case-insensitively rather than adding a second spelling", () => {
        const queue = [campaign("Rust"), campaign("Apex")];
        const next = pinDraggedGame(queue, ["apex"], 1);

        expect(next).toHaveLength(1);
    });

    it("returns the list untouched when the drop makes no sense", () => {
        expect(pinDraggedGame([], ["Rust"], 0)).toEqual(["Rust"]);
        expect(pinDraggedGame([{ id: "x" }], ["Rust"], 0)).toEqual(["Rust"]);
    });

    it("does not mutate the list it was given", () => {
        const existing = ["Rust"];
        pinDraggedGame([campaign("Apex")], existing, 0);

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
