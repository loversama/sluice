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

describe("Campaign.isCompleted without drops", () => {
    it("is not finished when its drops were never fetched", () => {
        // The campaign list carries no drops. Reading the empty list as "all claimed" hid
        // a campaign as done every time its details request failed.
        const listed = new Campaign(makeCampaign({ id: "c", drops: [] }), false);
        expect(listed.isCompleted).toBe(false);
    });

    it("is still not mineable then, having nothing to work toward", () => {
        const listed = new Campaign(makeCampaign({ id: "c", drops: [] }), false);
        expect(listed.nextDrop({ attemptImpossible: true })).toBeNull();
    });

    it("is finished when its details really have no drops", () => {
        // A campaign with no time-based drops at all has nothing to watch for.
        const listed = new Campaign(makeCampaign({ id: "c", drops: [] }), false);
        const detailed = listed.merge(makeCampaign({ id: "c", drops: [] }));
        expect(detailed.detailed).toBe(true);
        expect(detailed.isCompleted).toBe(true);
        expect(detailed.nextDrop()).toBeNull();
    });

    it("takes its drops from the details once they arrive", () => {
        const listed = new Campaign(makeCampaign({ id: "c", drops: [] }), false);
        const detailed = listed.merge(makeCampaign({ id: "c" }));
        expect(detailed.isCompleted).toBe(false);
        expect(detailed.nextDrop()?.id).toBe("c-d1");
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

/**
 * The Next button works by pushing a campaign to the back of the ranking rather than
 * excluding it, so its progress and eligibility are untouched. The ordering is the whole
 * feature: a campaign that came straight back because it tops the priority list would make
 * the button look broken.
 */
describe("compareCampaigns with deferrals", () => {
    const rank = (options: RankingOptions, ...campaigns: Campaign[]) =>
        [...campaigns].sort((a, b) => compareCampaigns(a, b, options)).map((c) => c.id);

    const campaign = (id: string, game: string) =>
        new Campaign(makeCampaign({ id, game: { id: `g-${id}`, name: game, boxArtURL: "" } }));

    const a = campaign("a", "Rust");
    const b = campaign("b", "Dota 2");
    const c = campaign("c", "Apex Legends");

    it("sends a skipped campaign behind the others", () => {
        const deferred = new Map([["a", 1000]]);

        expect(rank({ priorityGames: [], deferred }, a, b, c)).toEqual(["b", "c", "a"]);
    });

    it("outranks the priority list, so Next is not undone by it", () => {
        // Without this the top priority game would be re-selected immediately and the
        // button would appear to do nothing at all.
        const deferred = new Map([["a", 1000]]);

        expect(rank({ priorityGames: ["Rust"], deferred }, a, b)).toEqual(["b", "a"]);
    });

    it("keeps skipped campaigns in the order they were skipped", () => {
        // So pressing Next repeatedly walks down the queue rather than cycling two.
        const deferred = new Map([
            ["b", 2000],
            ["a", 1000],
        ]);

        expect(rank({ priorityGames: [], deferred }, a, b)).toEqual(["a", "b"]);
    });

    it("changes nothing when nothing has been skipped", () => {
        const withMap = rank({ priorityGames: ["Rust"], deferred: new Map() }, a, b, c);
        const without = rank({ priorityGames: ["Rust"] }, a, b, c);

        expect(withMap).toEqual(without);
        expect(withMap[0]).toBe("a");
    });
});

/**
 * The queue order is stored apart from the priority list, and ranks below it: the list is a
 * deliberate statement about which games matter, a drag only about what should come next.
 */
describe("compareCampaigns with a dragged queue order", () => {
    const rank = (options: RankingOptions, ...campaigns: Campaign[]) =>
        [...campaigns].sort((a, b) => compareCampaigns(a, b, options)).map((c) => c.id);

    const make = (id: string, game: string) =>
        new Campaign(makeCampaign({ id, game: { id: `g-${id}`, name: game, boxArtURL: "" } }));

    const rust = make("rust", "Rust");
    const apex = make("apex", "Apex Legends");
    const dota = make("dota", "Dota 2");

    it("orders games the user dragged", () => {
        expect(rank({ priorityGames: [], queueOrder: ["Dota 2", "Rust"] }, rust, apex, dota))
            .toEqual(["dota", "rust", "apex"]);
    });

    it("still puts the curated list first", () => {
        // Dragging must not be able to outrank a game the user deliberately listed.
        expect(rank({ priorityGames: ["Apex Legends"], queueOrder: ["Rust"] }, rust, apex))
            .toEqual(["apex", "rust"]);
    });

    it("changes nothing when nothing has been dragged", () => {
        const withEmpty = rank({ priorityGames: ["Rust"], queueOrder: [] }, rust, apex, dota);
        const without = rank({ priorityGames: ["Rust"] }, rust, apex, dota);

        expect(withEmpty).toEqual(without);
    });
});

/**
 * The queue shown on the dashboard is not the list the miner works from: it keeps the
 * campaigns the policy will pass over, dimmed, so it is clear they exist. They were left
 * wherever the ranking happened to put them, which put rows that will never be mined above
 * rows that are genuinely next.
 */
describe("campaigns the policy will not mine", () => {
    const owned = new Campaign(makeCampaign({ id: "owned", game: { id: "1", displayName: "Owned" } }));
    const unowned = new Campaign(makeCampaign({ id: "unowned", game: { id: "2", displayName: "Unowned" } }));
    const skipped = (campaign: Campaign) => campaign.id === "unowned";

    it("sorts below one that will be", () => {
        expect(compareCampaigns(unowned, owned, rank({ skipped }))).toBeGreaterThan(0);
        expect(compareCampaigns(owned, unowned, rank({ skipped }))).toBeLessThan(0);
    });

    it("stays below even when it is top of the priority list", () => {
        // The priority list counts as owned, so this cannot arise from the library policy
        // alone - but an excluded game can still be named in it, and exclusion wins.
        const options = rank({ skipped, priorityGames: ["Unowned"] });
        expect(compareCampaigns(unowned, owned, options)).toBeGreaterThan(0);
    });

    it("stays below one the user has skipped by hand", () => {
        // Deferred is "not this one, now"; out of policy is "not at all" - so the deferred
        // campaign, which will come back around, still ranks first.
        const options = rank({ skipped, deferred: new Map([["owned", 1]]) });
        expect(compareCampaigns(unowned, owned, options)).toBeGreaterThan(0);
    });

    it("orders normally among themselves", () => {
        const alsoUnowned = new Campaign(
            makeCampaign({ id: "unowned2", game: { id: "3", displayName: "Other" } }),
        );
        const options = rank({
            skipped: () => true,
            priorityGames: ["Other"],
        });
        expect(compareCampaigns(alsoUnowned, unowned, options)).toBeLessThan(0);
    });

    it("changes nothing when no predicate is given", () => {
        expect(compareCampaigns(unowned, owned, rank())).toBe(
            compareCampaigns(unowned, owned, rank()),
        );
        expect(compareCampaigns(owned, unowned, rank({ skipped: () => false }))).toBe(
            compareCampaigns(owned, unowned, rank()),
        );
    });
});

describe("the queue as the dashboard shows it", () => {
    it("puts every campaign that will be mined above every one that will not", () => {
        // The reported symptom: a campaign that would really be mined sitting two rows
        // below dimmed ones, so the rank numbers beside them meant nothing.
        const games = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
        const campaigns = games.map(
            (name, index) =>
                new Campaign(makeCampaign({ id: name, game: { id: String(index), displayName: name } })),
        );
        const unowned = new Set(["Alpha", "Beta", "Delta"]);

        const ordered = [...campaigns].sort((a, b) =>
            compareCampaigns(a, b, rank({ skipped: (campaign) => unowned.has(campaign.id) })),
        );
        const willMine = ordered.map((campaign) => !unowned.has(campaign.id));

        expect(ordered.map((campaign) => campaign.id)).toEqual([
            "Gamma",
            "Epsilon",
            "Alpha",
            "Beta",
            "Delta",
        ]);
        // No mineable campaign appears after a skipped one.
        expect(willMine.indexOf(false)).toBeGreaterThan(willMine.lastIndexOf(true));
    });
});

/**
 * "Special Events" is a Twitch category, not a game. Nobody can own it on Steam, so a
 * library policy of "only games I own" answered the ownership question the only way it
 * could and hid every campaign in it - a Worlds badge, an esports event - from anyone with
 * a library connected, with nothing on screen to explain the absence.
 */
describe("special categories under a library policy", () => {
    const special = (id: string, name = "Special Events") =>
        new Campaign(makeCampaign({ id: "c1", game: { id, displayName: name } }));

    // The real category ids, from twitch/constants.ts.
    const SPECIAL = "509663";
    const ALSO_SPECIAL = "509672";

    const ownsNothing = { policy: "ownedOrListed" as const, priorityGames: [], owns: () => false };

    it("mines a special category even though it can never be owned", () => {
        expect(isInLibraryScope(special(SPECIAL), ownsNothing)).toBe(true);
        expect(isInLibraryScope(special(ALSO_SPECIAL), ownsNothing)).toBe(true);
    });

    it("does not need the priority list as a workaround any more", () => {
        // This is the behaviour being replaced: it used to be the only way in.
        expect(isInLibraryScope(special(SPECIAL), { ...ownsNothing, priorityGames: [] })).toBe(true);
    });

    it("goes by the category id, not by what the category is called", () => {
        // A game that merely calls itself Special Events gets no exemption; the id is what
        // Twitch actually keys the category on.
        expect(isInLibraryScope(special("not-special", "Special Events"), ownsNothing)).toBe(false);
    });

    it("still leaves ordinary games subject to the policy", () => {
        expect(isInLibraryScope(special("g1", "Rust"), ownsNothing)).toBe(false);
    });
});
