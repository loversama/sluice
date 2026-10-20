import { describe, expect, it } from "vitest";

// @ts-expect-error - plain JS module shared with the dashboard build.
import { idleCopy, idleHeadline, idleTooltip } from "../web/src/lib/idleCopy.js";

const state = (reason: string, detail: Record<string, number> = {}) => ({ reason, detail });

/**
 * Three surfaces show this text and they drifted apart when each held its own wording, so
 * it lives in one function. What is tested here is mostly that the sentences stay true to
 * the numbers behind them - a count worded as a plural when it is one is the sort of thing
 * nobody notices until a user quotes it back.
 */
describe("what the dashboard says when nothing is being mined", () => {
    it("treats everything claimed as an achievement, not a fault", () => {
        const copy = idleCopy(state("all_claimed", { completed: 3, activeCampaigns: 3 }));
        expect(copy.title).toBe("All caught up");
        expect(copy.tone).toBe("good");
        expect(copy.body).toContain("3 campaigns");
    });

    it("names the setting responsible when the settings are responsible", () => {
        const copy = idleCopy(state("nothing_eligible", { activeCampaigns: 12, filteredByPolicy: 10, excluded: 2 }));
        expect(copy.title).toBe("Nothing eligible for you");
        expect(copy.body).toContain("library and priority settings");
        expect(copy.body).toContain("excluded list");
        // It is the only idle state the user can do something about, so it offers the way.
        expect(copy.action).toBe("priorities");
    });

    it("distinguishes nothing-for-you from nothing-at-all", () => {
        expect(idleCopy(state("nothing_eligible", { activeCampaigns: 5 })).title).not.toBe(
            idleCopy(state("no_campaigns")).title,
        );
    });

    it("mentions an upcoming campaign when one is due", () => {
        expect(idleCopy(state("no_campaigns", { upcoming: 2 })).body).toContain("2 are due to start");
        expect(idleCopy(state("no_campaigns", { upcoming: 0 })).body).not.toContain("due to start");
    });

    it("says the shortage is of streamers, not of work", () => {
        const copy = idleCopy(state("no_live_channels", { eligible: 1 }));
        expect(copy.body).toContain("1 campaign is waiting");
        expect(copy.body).toContain("nobody is streaming it");
    });

    it("promises it resumes on its own, whatever the reason", () => {
        for (const reason of ["all_claimed", "nothing_eligible", "no_campaigns", "no_live_channels"]) {
            const body = idleCopy(state(reason, { activeCampaigns: 1, eligible: 1 })).body.toLowerCase();
            expect(body).toMatch(/by itself|on its own|the moment|starts again|starts the moment/);
        }
    });

    it("says nothing at all when nothing is idle", () => {
        expect(idleCopy(null).title).toBe("");
    });

    it("survives a reason it has never heard of", () => {
        const copy = idleCopy(state("something_new"));
        expect(copy.title).toBe("Not mining");
        expect(copy.body).not.toContain("undefined");
    });

    it("keeps the tray tooltip to one short line", () => {
        for (const reason of ["all_claimed", "nothing_eligible", "no_campaigns", "no_live_channels"]) {
            const tip = idleTooltip(state(reason));
            expect(tip.length).toBeLessThan(60);
            expect(tip).not.toContain("\n");
        }
        expect(idleTooltip(null)).toBe("Sluice");
    });
});

/**
 * Both layouts take their idle headline from here. The narrow one used to say "Nothing being
 * mined right now" whether it was paused, out of hours or simply out of campaigns.
 */
describe("idleHeadline", () => {
    const idle = state("all_claimed", { completed: 2 });

    it("puts a pause ahead of everything else", () => {
        expect(idleHeadline({ paused: true, atDailyLimit: true, outsideSchedule: true, idle }).title).toBe("Paused");
    });

    it("then the daily limit, then the schedule", () => {
        expect(idleHeadline({ atDailyLimit: true, outsideSchedule: true, idle }).title).toBe("Daily limit reached");
        expect(idleHeadline({ outsideSchedule: true, idle }).title).toBe("Outside your hours");
    });

    it("otherwise says what the daemon said", () => {
        expect(idleHeadline({ idle })).toEqual({ title: idleCopy(idle).title, body: idleCopy(idle).body });
    });

    it("never leaves the band blank", () => {
        const headline = idleHeadline({});
        expect(headline.title).not.toBe("");
        expect(headline.body).not.toBe("");
    });
});
