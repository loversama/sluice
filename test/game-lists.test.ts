import { describe, expect, it } from "vitest";

// @ts-expect-error - plain JS module shared with the dashboard build.
import { exclude, indexIn, prioritise, removePriority, unexclude, unorder } from "../web/src/lib/gameLists.js";

const rust = { name: "Rust", id: "263490" };

/**
 * Every page that edits the game lists goes through these. The Campaigns buttons used to
 * compare names exactly and ignore game IDs, so a game could be prioritised twice, or stay
 * on the excluded list it had just been "un-excluded" from under a different spelling.
 */
describe("game list edits", () => {
    it("finds a game by name in any case, or by its Twitch ID", () => {
        expect(indexIn(["Warframe", "rust"], rust)).toBe(1);
        expect(indexIn(["Warframe", "263490"], rust)).toBe(1);
        expect(indexIn(["Warframe"], rust)).toBe(-1);
        expect(indexIn(["Warframe", "RUST"], "Rust")).toBe(1);
    });

    it("prioritises once, at the end, and takes the game off the excluded list", () => {
        const lists = { priorityGames: ["Warframe"], excludedGames: ["rust", "Dota 2"] };
        expect(prioritise(lists, rust)).toEqual({
            priorityGames: ["Warframe", "Rust"],
            excludedGames: ["Dota 2"],
        });
    });

    it("does not add a game already listed under another spelling or its ID", () => {
        expect(prioritise({ priorityGames: ["RUST"], excludedGames: [] }, rust).priorityGames).toEqual(["RUST"]);
        expect(prioritise({ priorityGames: ["263490"], excludedGames: [] }, rust).priorityGames).toEqual([
            "263490",
        ]);
    });

    it("moves a listed game to the top as its own entry", () => {
        const lists = { priorityGames: ["Warframe", "263490", "Apex"], excludedGames: [] };
        expect(prioritise(lists, rust, { top: true }).priorityGames).toEqual(["263490", "Warframe", "Apex"]);
        expect(prioritise({ priorityGames: ["Warframe"] }, rust, { top: true }).priorityGames).toEqual([
            "Rust",
            "Warframe",
        ]);
    });

    it("removes every entry naming the game and nothing else", () => {
        expect(removePriority({ priorityGames: ["rust", "Warframe", "263490"] }, rust)).toEqual({
            priorityGames: ["Warframe"],
        });
    });

    it("excludes once, and takes the game off the priority list and the dragged order", () => {
        const lists = { priorityGames: ["Rust", "Warframe"], excludedGames: ["Dota 2"], queueOrder: ["rust", "Apex"] };
        expect(exclude(lists, rust)).toEqual({
            priorityGames: ["Warframe"],
            excludedGames: ["Dota 2", "Rust"],
            queueOrder: ["Apex"],
        });
        expect(exclude({ excludedGames: ["263490"] }, rust).excludedGames).toEqual(["263490"]);
    });

    it("un-excludes whatever spelling it was excluded under", () => {
        expect(unexclude({ excludedGames: ["263490", "Dota 2"] }, rust)).toEqual({ excludedGames: ["Dota 2"] });
    });

    it("takes one game out of the dragged order", () => {
        expect(unorder({ queueOrder: ["Apex", "rust"] }, rust)).toEqual({ queueOrder: ["Apex"] });
    });

    it("never edits the lists it was given", () => {
        const lists = { priorityGames: ["Warframe"], excludedGames: ["Rust"], queueOrder: [] };
        prioritise(lists, rust, { top: true });
        exclude(lists, "Warframe");
        expect(lists).toEqual({ priorityGames: ["Warframe"], excludedGames: ["Rust"], queueOrder: [] });
    });
});
