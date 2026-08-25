import { describe, expect, it } from "vitest";

// @ts-expect-error - plain JS module shared with the dashboard build.
import { gamesIn, nextPriorityGames } from "../web/src/lib/ranking.js";

const campaign = (game: string, id = `${game}-1`) => ({ id, game: { name: game } });

/**
 * Dragging the queue in the narrow window edits the priority list, because the queue itself
 * is computed by the daemon and cannot be written to. That indirection is where the bugs
 * are, so the rule is pinned here rather than left to be noticed in use.
 */
describe("nextPriorityGames", () => {
    it("puts the dragged order into the priority list", () => {
        const queue = [campaign("Rust"), campaign("Dota 2"), campaign("Apex")];

        expect(nextPriorityGames(queue, [], null)).toEqual(["Rust", "Dota 2", "Apex"]);
    });

    it("keeps the game being mined ahead of the queue, so a drag cannot abandon it", () => {
        // The daemon re-ranks on every config change and switches channel if the top
        // campaign moved. Pinning the queue above the current game would do exactly that.
        const queue = [campaign("Rust"), campaign("Apex")];

        expect(nextPriorityGames(queue, [], "Valorant")[0]).toBe("Valorant");
    });

    it("does not duplicate the current game when it is already ranked", () => {
        const queue = [campaign("Rust")];
        const next = nextPriorityGames(queue, ["Valorant"], "Valorant");

        expect(next.filter((game) => game === "Valorant")).toHaveLength(1);
        expect(next).toEqual(["Valorant", "Rust"]);
    });

    it("matches the current game case-insensitively", () => {
        const next = nextPriorityGames([campaign("Rust")], ["valorant"], "Valorant");

        expect(next).toEqual(["valorant", "Rust"]);
    });

    it("leaves ranked games with no live campaign where they were", () => {
        // These cannot appear in the queue, so arranging the queue must not reshuffle them.
        const queue = [campaign("Rust"), campaign("Apex")];
        const existing = ["Off-season A", "Off-season B", "Apex", "Rust"];

        expect(nextPriorityGames(queue, existing, null)).toEqual([
            "Off-season A",
            "Off-season B",
            "Rust",
            "Apex",
        ]);
    });

    it("collapses several campaigns of one game to a single entry", () => {
        const queue = [campaign("Rust", "a"), campaign("Rust", "b"), campaign("Apex")];

        expect(nextPriorityGames(queue, [], null)).toEqual(["Rust", "Apex"]);
    });

    it("ignores queue entries with no game name", () => {
        expect(gamesIn([{ id: "x" }, campaign("Rust")])).toEqual(["Rust"]);
    });
});
