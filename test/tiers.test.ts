import { describe, expect, it } from "vitest";

// @ts-expect-error - plain JS module shared with the dashboard build.
import { orderTiers, tierProgress } from "../web/src/lib/tiers.js";

const drop = (requiredMinutes: number, isClaimed = false, name = `${requiredMinutes}m`) => ({
    id: name,
    name,
    requiredMinutes,
    currentMinutes: isClaimed ? requiredMinutes : 0,
    isClaimed,
});

describe("orderTiers", () => {
    it("puts the ladder in the order it is actually climbed", () => {
        // The order a real campaign arrived in, which is not sorted: it put the only
        // unclaimed tier second and made a ladder with work left look finished.
        const drops = [drop(90, true), drop(120), drop(30, true), drop(60, true)];

        expect(orderTiers(drops).map((d) => d.requiredMinutes)).toEqual([30, 60, 90, 120]);
    });

    it("leaves the unclaimed tier last when the rest are done", () => {
        const drops = [drop(90, true), drop(120), drop(30, true), drop(60, true)];
        const ordered = orderTiers(drops);

        expect(ordered[ordered.length - 1]?.isClaimed).toBe(false);
    });

    it("sends tiers that watching cannot earn to the end", () => {
        // Zero required minutes means some other condition entirely - owning the game,
        // a linked account - so it never sits between two tiers that watching will reach.
        const drops = [drop(0, false, "special"), drop(60), drop(30)];

        expect(orderTiers(drops).map((d) => d.name)).toEqual(["30m", "60m", "special"]);
    });

    it("does not mutate what it is given", () => {
        const drops = [drop(60), drop(30)];
        orderTiers(drops);

        expect(drops.map((d) => d.requiredMinutes)).toEqual([60, 30]);
    });

    it("copes with nothing", () => {
        expect(orderTiers(undefined)).toEqual([]);
        expect(orderTiers([])).toEqual([]);
    });
});

describe("tierProgress", () => {
    it("counts only what watching can earn", () => {
        // Four tiers shown, three of them earnable: "3/3", not "3/4" - because the fourth
        // would never tick over however long the miner ran.
        const drops = [drop(30, true), drop(60, true), drop(90, true), drop(0, false, "special")];

        expect(tierProgress(drops)).toEqual({ total: 3, claimed: 3 });
    });

    it("reports a ladder still in progress honestly", () => {
        const drops = [drop(30, true), drop(60, true), drop(90, false)];

        expect(tierProgress(drops)).toEqual({ total: 3, claimed: 2 });
    });

    it("copes with nothing", () => {
        expect(tierProgress(undefined)).toEqual({ total: 0, claimed: 0 });
    });
});
