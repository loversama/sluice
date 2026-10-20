import { describe, expect, it } from "vitest";

import { classifyIdle } from "../packages/core/src/idle.js";
import { Campaign } from "../packages/core/src/models/campaign.js";
import {
    applyKnownClaims,
    describeIdle,
    describeLeave,
    describeNext,
    isDeliberateStop,
} from "../packages/core/src/transitions.js";
import { iso, makeCampaign, makeDrop } from "./fixtures.js";

/** A drop Twitch reports as fully watched and still unclaimed - the EVE Online loop. */
function finishedButUnclaimed(id = "eve") {
    return new Campaign(
        makeCampaign({
            id,
            drops: [
                makeDrop({
                    id: `${id}-d1`,
                    requiredMinutesWatched: 240,
                    self: { currentMinutesWatched: 240, dropInstanceID: null, isClaimed: false },
                }),
            ],
        }),
    );
}

describe("applyKnownClaims", () => {
    it("is the situation that looped: finished, unclaimed, and still chosen", () => {
        const campaign = finishedButUnclaimed();
        expect(campaign.nextDrop()).not.toBeNull();
        expect(campaign.isCompleted).toBe(false);
        expect(campaign.drops[0]!.isClaimable).toBe(true);
    });

    it("marks a confirmed claim as claimed, so it is neither chosen nor claimable", () => {
        const campaign = finishedButUnclaimed();
        const changed = applyKnownClaims([campaign], new Set(["eve-d1"]), new Set());
        expect(changed).toBe(1);
        expect(campaign.nextDrop()).toBeNull();
        expect(campaign.isCompleted).toBe(true);
        expect(campaign.drops[0]!.isClaimable).toBe(false);
    });

    it("sets aside a drop the miner gave up claiming, without calling it claimed", () => {
        const campaign = finishedButUnclaimed();
        expect(applyKnownClaims([campaign], new Set(), new Set(["eve-d1"]))).toBe(1);
        expect(campaign.nextDrop()).toBeNull();
        expect(campaign.drops[0]!.isClaimable).toBe(false);
        // Nothing says the reward arrived, so nothing may report that it did.
        expect(campaign.drops[0]!.isClaimed).toBe(false);
    });

    it("leaves drops it knows nothing about alone", () => {
        const campaign = finishedButUnclaimed();
        expect(applyKnownClaims([campaign], new Set(["other"]), new Set())).toBe(0);
        expect(campaign.drops[0]!.isClaimed).toBe(false);
    });

    it("holds across repeated refreshes that each rebuild the drop as unclaimed", () => {
        const confirmed = new Set(["eve-d1"]);
        for (let refresh = 0; refresh < 20; refresh++) {
            const campaign = finishedButUnclaimed();
            applyKnownClaims([campaign], confirmed, new Set());
            expect(campaign.nextDrop(), `refresh ${refresh}`).toBeNull();
        }
    });

    it("only changes the drops that were claimed in a multi-drop campaign", () => {
        const campaign = new Campaign(
            makeCampaign({
                id: "multi",
                drops: [
                    makeDrop({
                        id: "t1",
                        requiredMinutesWatched: 30,
                        self: { currentMinutesWatched: 30, dropInstanceID: null, isClaimed: false },
                    }),
                    makeDrop({ id: "t2", requiredMinutesWatched: 60 }),
                ],
            }),
        );
        applyKnownClaims([campaign], new Set(["t1"]), new Set());
        expect(campaign.nextDrop()?.id).toBe("t2");
    });
});

describe("describeLeave", () => {
    it("names the reasons the feed would not otherwise explain", () => {
        expect(describeLeave("offline", "Streamer")).toBe("Streamer went offline");
        expect(describeLeave("claim_stuck", "Streamer")).toMatch(/could not be claimed/);
        expect(describeLeave("better_campaign", "Streamer")).toMatch(/higher-priority/);
    });

    it("stays quiet for reasons already reported where they happen", () => {
        for (const end of ["claimed", "benched", "paused", "outside_window", "stopped"] as const) {
            expect(describeLeave(end, "Streamer")).toBeNull();
        }
    });

    it("treats pausing, the schedule and stopping as deliberate", () => {
        expect(isDeliberateStop("paused")).toBe(true);
        expect(isDeliberateStop("outside_window")).toBe(true);
        expect(isDeliberateStop("stopped")).toBe(true);
        expect(isDeliberateStop("offline")).toBe(false);
        expect(isDeliberateStop("claim_stuck")).toBe(false);
    });
});

describe("describeNext", () => {
    it("says what comes next", () => {
        const campaign = new Campaign(makeCampaign({ id: "x" }));
        expect(describeNext({ campaign, drop: campaign.nextDrop() })).toMatch(/^Next up: Game x - /);
    });

    it("says so when there is nothing", () => {
        expect(describeNext(null)).toMatch(/Nothing else to mine/);
    });
});

describe("describeIdle", () => {
    const campaigns = (n: number) =>
        Array.from({ length: n }, (_, i) => new Campaign(makeCampaign({ id: `c${i}` })));

    it("celebrates being caught up, and says when it will look again", () => {
        const done = finishedButUnclaimed();
        applyKnownClaims([done], new Set(["eve-d1"]), new Set());
        const idle = classifyIdle({ campaigns: [done], eligible: [], isExcluded: () => false });
        expect(idle.reason).toBe("all_claimed");
        expect(describeIdle(idle, 20)).toMatch(/All caught up.*Checking again in 20 min/);
    });

    it("explains when settings rule everything out", () => {
        const all = campaigns(4);
        const idle = classifyIdle({ campaigns: all, eligible: [], isExcluded: () => true });
        expect(describeIdle(idle, 20)).toMatch(/4 campaigns are running, but your settings rule them all out/);
    });

    it("explains when nobody is streaming, with correct plurals", () => {
        const one = campaigns(1);
        const idle = classifyIdle({ campaigns: one, eligible: one, isExcluded: () => false });
        expect(describeIdle(idle, 5)).toMatch(/1 campaign is available, but nobody suitable is streaming/);
        const two = campaigns(2);
        const idle2 = classifyIdle({ campaigns: two, eligible: two, isExcluded: () => false });
        expect(describeIdle(idle2, 5)).toMatch(/2 campaigns are available/);
    });

    it("mentions the next campaign when one is coming", () => {
        const upcoming = new Campaign(
            makeCampaign({ id: "soon", startAt: iso(45), endAt: iso(645) }),
        );
        const idle = classifyIdle({ campaigns: [upcoming], eligible: [], isExcluded: () => false });
        expect(describeIdle(idle, 20)).toMatch(/next campaign starts in 4\d min/);
    });
});
