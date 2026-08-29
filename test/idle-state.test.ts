import { describe, expect, it } from "vitest";

import { classifyIdle, sameIdle } from "../packages/core/src/idle.js";
import { Campaign } from "../packages/core/src/models/campaign.js";
import { iso, makeCampaign, makeDrop } from "./fixtures.js";

/**
 * The dashboard used to be told nothing when mining stopped, so it went on showing the last
 * thing it saw - a claimed drop under "choosing what to mine next", indefinitely, with the
 * heartbeat counting up beside it. These reasons are what replaced that silence, and the
 * distinction that matters most is "nothing left for you" against "nothing at all", because
 * only one of them is something the user can do anything about.
 */

const active = (id: string) => new Campaign(makeCampaign({ id }));

const claimed = (id: string) =>
    new Campaign(
        makeCampaign({
            id,
            drops: [
                makeDrop({
                    id: `${id}-d1`,
                    requiredMinutesWatched: 60,
                    self: { currentMinutesWatched: 60, dropInstanceID: "x", isClaimed: true },
                }),
            ],
        }),
    );

const upcoming = (id: string, startsInMinutes: number) =>
    new Campaign(makeCampaign({ id, startAt: iso(startsInMinutes), endAt: iso(startsInMinutes + 600) }));

const never = () => false;

describe("classifying why nothing is being mined", () => {
    it("says there are no campaigns when Twitch has none running", () => {
        const state = classifyIdle({ campaigns: [], eligible: [], isExcluded: never });
        expect(state.reason).toBe("no_campaigns");
        expect(state.detail.activeCampaigns).toBe(0);
    });

    it("counts upcoming campaigns and when the soonest starts", () => {
        const soon = upcoming("soon", 30);
        const later = upcoming("later", 600);
        const state = classifyIdle({ campaigns: [later, soon], eligible: [], isExcluded: never });
        expect(state.reason).toBe("no_campaigns");
        expect(state.detail.upcoming).toBe(2);
        expect(state.detail.nextUpcomingAt).toBe(soon.startAt.toISOString());
    });

    it("says everything is claimed when every running campaign is finished", () => {
        const state = classifyIdle({
            campaigns: [claimed("a"), claimed("b")],
            eligible: [],
            isExcluded: never,
        });
        expect(state.reason).toBe("all_claimed");
        expect(state.detail).toMatchObject({ activeCampaigns: 2, completed: 2, filteredByPolicy: 0 });
    });

    it("separates 'nothing for you' from 'all claimed'", () => {
        // Unfinished work exists; the settings are what rule it out. That is a different
        // sentence and a different thing for the user to do about it.
        const state = classifyIdle({
            campaigns: [claimed("done"), active("filtered")],
            eligible: [],
            isExcluded: never,
        });
        expect(state.reason).toBe("nothing_eligible");
        expect(state.detail).toMatchObject({ activeCampaigns: 2, completed: 1, filteredByPolicy: 1 });
    });

    it("counts games excluded by name apart from those the policy filtered", () => {
        const banned = active("banned");
        const state = classifyIdle({
            campaigns: [banned, active("filtered")],
            eligible: [],
            isExcluded: (campaign) => campaign.id === "banned",
        });
        expect(state.detail).toMatchObject({ excluded: 1, filteredByPolicy: 1 });
    });

    it("blames the channels when there was work but nothing to watch", () => {
        const ready = active("ready");
        const state = classifyIdle({ campaigns: [ready], eligible: [ready], isExcluded: never });
        expect(state.reason).toBe("no_live_channels");
        expect(state.detail.eligible).toBe(1);
    });

    it("never reports a negative count", () => {
        // eligible can only ever be a subset, but the arithmetic should not be able to
        // produce nonsense on the dashboard if that ever stops being true.
        const one = active("one");
        const state = classifyIdle({
            campaigns: [one],
            eligible: [one, active("phantom")],
            isExcluded: never,
        });
        expect(state.detail.filteredByPolicy).toBe(0);
    });
});

describe("deciding whether the situation has changed", () => {
    const of = (campaigns: Campaign[], eligible: Campaign[] = []) =>
        classifyIdle({ campaigns, eligible, isExcluded: never });

    it("treats the same situation as unchanged, so it is not announced twice", () => {
        expect(sameIdle(of([claimed("a")]), of([claimed("a")]))).toBe(true);
    });

    it("ignores the timestamp, which moves on every pass", () => {
        const first = { ...of([claimed("a")]), since: 1 };
        const second = { ...of([claimed("a")]), since: 999_999 };
        expect(sameIdle(first, second)).toBe(true);
    });

    it("notices a new campaign appearing", () => {
        expect(sameIdle(of([claimed("a")]), of([claimed("a"), active("b")]))).toBe(false);
    });

    it("notices the reason changing", () => {
        expect(sameIdle(of([]), of([claimed("a")]))).toBe(false);
    });

    it("handles the transitions in and out of idleness", () => {
        expect(sameIdle(null, null)).toBe(true);
        expect(sameIdle(null, of([claimed("a")]))).toBe(false);
        expect(sameIdle(of([claimed("a")]), null)).toBe(false);
    });
});
