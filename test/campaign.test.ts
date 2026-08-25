import { describe, expect, it } from "vitest";

import { Campaign, compareCampaigns, type RankingOptions, isInLibraryScope } from "../packages/core/src/models/campaign.js";
import { iso, makeCampaign, makeDrop } from "./fixtures.js";

const rank = (options: Partial<RankingOptions> = {}): RankingOptions => ({
    priorityGames: [],
    ...options,
});

describe("Drop.isClaimable", () => {
    it("is true once the required minutes are watched", () => {
        const campaign = new Campaign(
            makeCampaign({
                id: "c",
                drops: [
                    makeDrop({
                        id: "d",
                        requiredMinutesWatched: 60,
                        self: { currentMinutesWatched: 60, dropInstanceID: "x", isClaimed: false },
                    }),
                ],
            }),
        );
        expect(campaign.drops[0]!.isClaimable).toBe(true);
    });

    it("does not require an instance ID, since one can be derived", () => {
        const campaign = new Campaign(
            makeCampaign({
                id: "c",
                drops: [
                    makeDrop({
                        id: "d",
                        requiredMinutesWatched: 60,
                        self: { currentMinutesWatched: 60, dropInstanceID: null, isClaimed: false },
                    }),
                ],
            }),
        );
        expect(campaign.drops[0]!.isClaimable).toBe(true);
    });

    it("is false for a drop needing no watch time", () => {
        // Regression: `0 >= 0` once made every event drop look permanently ready, and the
        // bot retried a claim Twitch would never accept on every refresh.
        const campaign = new Campaign(
            makeCampaign({
                id: "c",
                drops: [makeDrop({ id: "d", requiredMinutesWatched: 0 })],
            }),
        );
        expect(campaign.drops[0]!.isClaimable).toBe(false);
    });

    it("is false once claimed", () => {
        const campaign = new Campaign(
            makeCampaign({
                id: "c",
                drops: [
                    makeDrop({
                        id: "d",
                        requiredMinutesWatched: 60,
                        self: { currentMinutesWatched: 60, dropInstanceID: "x", isClaimed: true },
                    }),
                ],
            }),
        );
        expect(campaign.drops[0]!.isClaimable).toBe(false);
    });
});

describe("Campaign.nextDrop", () => {
    it("skips a drop whose precondition is unclaimed", () => {
        const campaign = new Campaign(
            makeCampaign({
                id: "c",
                drops: [
                    makeDrop({ id: "tier1" }),
                    makeDrop({ id: "tier2", preconditionDrops: [{ id: "tier1" }] }),
                ],
            }),
        );
        expect(campaign.nextDrop()?.id).toBe("tier1");
    });

    it("advances to the next tier once the precondition is claimed", () => {
        const campaign = new Campaign(
            makeCampaign({
                id: "c",
                drops: [
                    makeDrop({
                        id: "tier1",
                        self: { currentMinutesWatched: 60, dropInstanceID: "x", isClaimed: true },
                    }),
                    makeDrop({ id: "tier2", preconditionDrops: [{ id: "tier1" }] }),
                ],
            }),
        );
        expect(campaign.nextDrop()?.id).toBe("tier2");
    });

    it("skips a drop that needs no watch time, and moves to real work", () => {
        // An EWC campaign offered a 0-minute reward ahead of a 720-minute tier; the miner
        // parked on the former, which watching can never advance.
        const campaign = new Campaign(
            makeCampaign({
                id: "c",
                drops: [
                    makeDrop({ id: "bonus", requiredMinutesWatched: 0 }),
                    makeDrop({ id: "real", requiredMinutesWatched: 720, endAt: iso(6000) }),
                ],
            }),
        );
        expect(campaign.nextDrop()?.id).toBe("real");
    });

    it("does not let a zero-minute drop hold a campaign open", () => {
        const campaign = new Campaign(
            makeCampaign({
                id: "c",
                drops: [
                    makeDrop({
                        id: "done",
                        self: { currentMinutesWatched: 60, dropInstanceID: "x", isClaimed: true },
                    }),
                    makeDrop({ id: "bonus", requiredMinutesWatched: 0 }),
                ],
            }),
        );
        expect(campaign.isCompleted).toBe(true);
    });

    it("skips an unfinishable drop unless asked to attempt it", () => {
        const campaign = new Campaign(
            makeCampaign({
                id: "c",
                endAt: iso(10),
                drops: [makeDrop({ id: "d", endAt: iso(10), requiredMinutesWatched: 600 })],
            }),
        );
        expect(campaign.nextDrop()).toBeNull();
        expect(campaign.nextDrop({ attemptImpossible: true })?.id).toBe("d");
    });
});

describe("deliverability", () => {
    it("treats an unlinked campaign as undeliverable", () => {
        const campaign = new Campaign(
            makeCampaign({ id: "c", self: { isAccountConnected: false } }),
        );
        expect(campaign.isDeliverable).toBe(false);
    });

    it("treats badge and emote rewards as deliverable without a link", () => {
        // Twitch grants these itself, so no game account link is involved.
        const campaign = new Campaign(
            makeCampaign({
                id: "c",
                self: { isAccountConnected: false },
                drops: [
                    makeDrop({
                        id: "d",
                        benefitEdges: [
                            { benefit: { id: "b", name: "Badge", distributionType: "BADGE" } },
                        ],
                    }),
                ],
            }),
        );
        expect(campaign.isTwitchNativeReward).toBe(true);
        expect(campaign.isDeliverable).toBe(true);
    });

    it("does not treat a mixed reward set as Twitch-native", () => {
        const campaign = new Campaign(
            makeCampaign({
                id: "c",
                self: { isAccountConnected: false },
                drops: [
                    makeDrop({
                        id: "d",
                        benefitEdges: [
                            { benefit: { id: "b1", name: "Badge", distributionType: "BADGE" } },
                            { benefit: { id: "b2", name: "Skin", distributionType: "DIRECT_ENTITLEMENT" } },
                        ],
                    }),
                ],
            }),
        );
        expect(campaign.isDeliverable).toBe(false);
    });
});

describe("compareCampaigns", () => {
    it("orders by position in the priority list first", () => {
        const first = new Campaign(makeCampaign({ id: "a", game: { id: "1", displayName: "Rust" } }));
        const second = new Campaign(makeCampaign({ id: "b", game: { id: "2", displayName: "Tarkov" } }));
        const options = rank({ priorityGames: ["Tarkov", "Rust"] });
        expect(compareCampaigns(first, second, options)).toBeGreaterThan(0);
        expect(compareCampaigns(second, first, options)).toBeLessThan(0);
    });

    it("prefers a deliverable campaign when priority is equal", () => {
        const linked = new Campaign(makeCampaign({ id: "a" }));
        const unlinked = new Campaign(
            makeCampaign({ id: "b", self: { isAccountConnected: false } }),
        );
        expect(compareCampaigns(linked, unlinked, rank())).toBeLessThan(0);
    });

    it("lets the priority list outrank deliverability", () => {
        // A game the user named explicitly should win even when it cannot pay out yet.
        const chosenUnlinked = new Campaign(
            makeCampaign({
                id: "a",
                self: { isAccountConnected: false },
                game: { id: "1", displayName: "Rust" },
            }),
        );
        const otherLinked = new Campaign(
            makeCampaign({ id: "b", game: { id: "2", displayName: "Tarkov" } }),
        );
        expect(
            compareCampaigns(chosenUnlinked, otherLinked, rank({ priorityGames: ["Rust"] })),
        ).toBeLessThan(0);
    });

    it("falls back to whichever ends soonest", () => {
        const soon = new Campaign(makeCampaign({ id: "a", endAt: iso(30) }));
        const later = new Campaign(makeCampaign({ id: "b", endAt: iso(300) }));
        expect(compareCampaigns(soon, later, rank({ mode: "ending_soonest" }))).toBeLessThan(0);
    });

    it("puts the tightest deadline first in tightest_deadline mode", () => {
        // Slack is time-left divided by work-left, so a long campaign with lots to do can be
        // tighter than a short one that is nearly finished.
        const tight = new Campaign(
            makeCampaign({
                id: "tight",
                endAt: iso(120),
                drops: [makeDrop({ id: "d", endAt: iso(120), requiredMinutesWatched: 100 })],
            }),
        );
        const relaxed = new Campaign(
            makeCampaign({
                id: "relaxed",
                endAt: iso(600),
                drops: [makeDrop({ id: "d", endAt: iso(600), requiredMinutesWatched: 10 })],
            }),
        );
        expect(compareCampaigns(tight, relaxed, rank({ mode: "tightest_deadline" }))).toBeLessThan(0);
    });

    it("keeps the current game together in one_game_at_a_time mode", () => {
        const current = new Campaign(
            makeCampaign({ id: "a", game: { id: "focus", displayName: "Focus" }, endAt: iso(600) }),
        );
        const other = new Campaign(
            makeCampaign({ id: "b", game: { id: "other", displayName: "Other" }, endAt: iso(30) }),
        );
        const options = rank({ mode: "one_game_at_a_time", focusGameId: "focus" });
        // Ends much later, but is the game already in progress.
        expect(compareCampaigns(current, other, options)).toBeLessThan(0);
    });

    it("ranks by Steam score, highest first", () => {
        const played = new Campaign(makeCampaign({ id: "a", endAt: iso(600) }));
        const unplayed = new Campaign(makeCampaign({ id: "b", endAt: iso(30) }));
        const options = rank({
            mode: "steam_playtime",
            steamScore: (campaign) => (campaign.id === "a" ? 5000 : 0),
        });
        expect(compareCampaigns(played, unplayed, options)).toBeLessThan(0);
    });

    it("is a consistent ordering, so sort() cannot misbehave", () => {
        const campaigns = [
            new Campaign(makeCampaign({ id: "a", endAt: iso(50) })),
            new Campaign(makeCampaign({ id: "b", endAt: iso(10), self: { isAccountConnected: false } })),
            new Campaign(makeCampaign({ id: "c", endAt: iso(90) })),
        ];
        const options = rank({ mode: "ending_soonest" });
        for (const x of campaigns) {
            for (const y of campaigns) {
                // Summing avoids Object.is treating 0 and -0 as different, which is
                // what a self-comparison produces.
                expect(
                    Math.sign(compareCampaigns(x, y, options)) +
                        Math.sign(compareCampaigns(y, x, options)),
                ).toBe(0);
            }
        }
    });
});

describe("isInLibraryScope", () => {
    const owned = (...names: string[]) => (name: string) => names.includes(name);

    const campaign = (gameName: string) =>
        new Campaign(
            makeCampaign({ id: "c1", game: { id: "g1", displayName: gameName } }),
        );

    it("mines a game the user owns on Steam", () => {
        expect(
            isInLibraryScope(campaign("Rust"), {
                policy: "ownedOrListed",
                priorityGames: [],
                owns: owned("Rust"),
            }),
        ).toBe(true);
    });

    it("skips a game the user neither owns nor asked for", () => {
        expect(
            isInLibraryScope(campaign("Some Mobile Gacha"), {
                policy: "ownedOrListed",
                priorityGames: ["Rust"],
                owns: owned("Rust"),
            }),
        ).toBe(false);
    });

    it("mines an unowned game that is on the priority list", () => {
        // The escape hatch for anything Steam cannot see - an Epic or console title, or a
        // Twitch category like "Special Events" that is not a game at all.
        expect(
            isInLibraryScope(campaign("Special Events"), {
                policy: "ownedOrListed",
                priorityGames: ["Special Events"],
                owns: owned("Rust"),
            }),
        ).toBe(true);
    });

    it("matches a priority entry regardless of case", () => {
        expect(
            isInLibraryScope(campaign("Black Desert"), {
                policy: "ownedOrListed",
                priorityGames: ["black desert"],
                owns: owned(),
            }),
        ).toBe(true);
    });

    it("matches a priority entry given by game id", () => {
        expect(
            isInLibraryScope(campaign("Black Desert"), {
                policy: "ownedOrListed",
                priorityGames: ["g1"],
                owns: owned(),
            }),
        ).toBe(true);
    });

    it("mines everything when no library is loaded", () => {
        // Without a library there is nothing to check ownership against; applying the rule
        // would quietly shrink mining to the priority list.
        expect(
            isInLibraryScope(campaign("Anything At All"), {
                policy: "ownedOrListed",
                priorityGames: [],
                owns: null,
            }),
        ).toBe(true);
    });

    it("mines everything when the policy is turned off", () => {
        expect(
            isInLibraryScope(campaign("Some Mobile Gacha"), {
                policy: "all",
                priorityGames: [],
                owns: owned("Rust"),
            }),
        ).toBe(true);
    });
});
