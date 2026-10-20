import { describe, expect, it } from "vitest";

// @ts-expect-error - plain JS module shared with the dashboard build.
import { priorityGameBelow, reorderPriorityGames } from "../web/src/lib/ranking.js";
import { Campaign, compareCampaigns } from "../packages/core/src/models/campaign.js";

const row = (game: string, id = game) => ({ id: `${id}-c`, game: { name: game, id } });

/** A real Campaign the daemon would rank, ending at a fixed time so only priority decides. */
function campaign(game: string): Campaign {
    return new Campaign({
        id: `${game}-c`,
        name: game,
        status: "ACTIVE",
        startAt: "2026-10-01T00:00:00Z",
        endAt: "2026-12-01T00:00:00Z",
        game: { id: game, displayName: game },
        timeBasedDrops: [],
    });
}

/** The queue as the daemon would order it for this priority list. */
function ranked(games: string[], priorityGames: string[]): string[] {
    return games
        .map(campaign)
        .sort((a, b) => compareCampaigns(a, b, { priorityGames }))
        .map((c) => c.gameName);
}

/**
 * The priority list outranks the queue order, so a dragged priority game used to be saved
 * and then re-ranked straight back, a couple of seconds after the drop. A drag of a game
 * already on the list now moves it within the list - and must never add anything to it.
 */
describe("reorderPriorityGames", () => {
    it("moves a priority game above the one it was dropped on", () => {
        // Queue after dragging Cyberpunk from the bottom to the top.
        const dragged = [row("Cyberpunk 2077"), row("Star Citizen"), row("Warframe")];
        expect(reorderPriorityGames(dragged, ["Star Citizen", "Warframe", "Cyberpunk 2077"], 0)).toEqual([
            "Cyberpunk 2077",
            "Star Citizen",
            "Warframe",
        ]);
    });

    it("leaves priority games that are not queued where they were", () => {
        const dragged = [row("Warframe"), row("Star Citizen")];
        // EVE Online is not queued, so it keeps its place right after Star Citizen.
        expect(reorderPriorityGames(dragged, ["Star Citizen", "EVE Online", "Warframe"], 0)).toEqual([
            "Warframe",
            "Star Citizen",
            "EVE Online",
        ]);
    });

    it("places a game dropped below every other priority game after the last one", () => {
        const dragged = [row("Warframe"), row("Rust"), row("Star Citizen")];
        expect(reorderPriorityGames(dragged, ["Star Citizen", "Warframe"], 2)).toEqual(["Warframe", "Star Citizen"]);
    });

    it("matches a priority entry stored as a game ID", () => {
        const dragged = [row("Cyberpunk 2077", "65876"), row("Warframe")];
        expect(reorderPriorityGames(dragged, ["Warframe", "65876"], 0)).toEqual(["65876", "Warframe"]);
    });

    it("never adds a game to the list", () => {
        const dragged = [row("Rust"), row("Warframe")];
        expect(reorderPriorityGames(dragged, ["Warframe"], 0)).toBeNull();
    });

    it("keeps the dragged order once the daemon re-ranks with the new list", () => {
        const priority = ["Star Citizen", "Black Desert", "Warframe", "Cyberpunk 2077"];
        const before = ranked(["Warframe", "Cyberpunk 2077", "Star Citizen", "Black Desert"], priority);
        expect(before).toEqual(priority);

        // Drag Cyberpunk (last) up to second place.
        const dragged = [before[0], before[3], before[1], before[2]].map((g) => row(g!));
        const next = reorderPriorityGames(dragged, priority, 1);

        expect(ranked(before, next)).toEqual(["Star Citizen", "Cyberpunk 2077", "Black Desert", "Warframe"]);
    });
});

describe("priorityGameBelow", () => {
    it("spots a non-priority game dropped above a priority one", () => {
        expect(priorityGameBelow([row("Rust"), row("Warframe")], ["Warframe"], 0)).toBe(true);
        expect(priorityGameBelow([row("Warframe"), row("Rust")], ["Warframe"], 1)).toBe(false);
    });
});
