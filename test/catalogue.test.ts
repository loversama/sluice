import { describe, expect, it } from "vitest";

import { campaignsFromCatalogue } from "../packages/core/src/twitch/catalogue.js";

const NOW = Date.parse("2026-10-14T20:00:00Z");

function reward(id: string, endAt: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        name: `Campaign ${id}`,
        status: "ACTIVE",
        startAt: "2026-10-01T00:00:00Z",
        endAt,
        game: { id: "66170", slug: "warframe", displayName: "Warframe" },
        timeBasedDrops: [],
        ...extra,
    };
}

const body = (rewards: unknown[]) => ({
    lastUpdatedAt: "2026-10-14T19:59:00Z",
    refreshIntervalSeconds: 60,
    data: [
        {
            gameId: "66170",
            gameDisplayName: "Warframe",
            gameBoxArtURL: "https://example/box.jpg",
            rewards,
        },
    ],
});

/**
 * TV-client logins - the only kind Twitch still issues - see an empty campaign dashboard,
 * so campaigns come from a public catalogue grouped by game. It has to come out looking
 * exactly like Twitch's own list, or the miner quietly finds nothing to do.
 */
describe("campaignsFromCatalogue", () => {
    it("flattens the per-game grouping into campaigns", () => {
        const out = campaignsFromCatalogue(
            body([reward("a", "2026-10-20T00:00:00Z"), reward("b", "2026-10-21T00:00:00Z")]) as never,
            NOW,
        );
        expect(out.map((campaign) => campaign.id)).toEqual(["a", "b"]);
        expect(out[0]?.game.boxArtURL).toBe("https://example/box.jpg");
    });

    it("marks a campaign expired once its end has passed, whatever the snapshot says", () => {
        const [campaign] = campaignsFromCatalogue(body([reward("a", "2026-10-14T19:00:00Z")]) as never, NOW);
        expect(campaign?.status).toBe("EXPIRED");
    });

    it("never carries account state it cannot know", () => {
        const [campaign] = campaignsFromCatalogue(
            body([reward("a", "2026-10-20T00:00:00Z", { self: { isAccountConnected: false } })]) as never,
            NOW,
        );
        expect(campaign?.self).toBeNull();
    });

    it("skips malformed entries rather than failing the whole list", () => {
        const out = campaignsFromCatalogue(
            body([null, { id: "x" }, reward("a", "2026-10-20T00:00:00Z")]) as never,
            NOW,
        );
        expect(out.map((campaign) => campaign.id)).toEqual(["a"]);
    });
});
