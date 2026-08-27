import { describe, expect, it } from "vitest";

import { dailyLimitVerdict, LIMIT_GRACE_MINUTES } from "../packages/core/src/schedule.js";

const limit = { enabled: true, hours: 4 };
const ALLOWANCE = 4 * 60;

/**
 * A daily cap that cut mid-drop would waste the whole session's watch time on it - drops
 * are all-or-nothing - so the limit bends by half an hour for something nearly finished,
 * and not otherwise.
 */
describe("dailyLimitVerdict", () => {
    it("allows mining below the allowance", () => {
        expect(dailyLimitVerdict(limit, ALLOWANCE - 1, 50)).toBe("allow");
    });

    it("stops at the allowance when nothing is nearly done", () => {
        expect(dailyLimitVerdict(limit, ALLOWANCE, 90)).toBe("stop");
    });

    it("stops at the allowance when nothing is in progress at all", () => {
        expect(dailyLimitVerdict(limit, ALLOWANCE, null)).toBe("stop");
    });

    it("runs on to finish a drop within the grace", () => {
        expect(dailyLimitVerdict(limit, ALLOWANCE, LIMIT_GRACE_MINUTES)).toBe("finishing");
        expect(dailyLimitVerdict(limit, ALLOWANCE + 20, 5)).toBe("finishing");
    });

    it("will not be strung along past the grace itself", () => {
        // A drop that keeps needing "just ten more minutes" cannot extend the day forever.
        expect(dailyLimitVerdict(limit, ALLOWANCE + LIMIT_GRACE_MINUTES, 5)).toBe("stop");
    });

    it("does not bend for a drop that needs more than the grace", () => {
        expect(dailyLimitVerdict(limit, ALLOWANCE, LIMIT_GRACE_MINUTES + 1)).toBe("stop");
    });

    it("allows everything when switched off or unset", () => {
        expect(dailyLimitVerdict({ enabled: false, hours: 4 }, 9999, null)).toBe("allow");
        expect(dailyLimitVerdict({ enabled: true, hours: 0 }, 9999, null)).toBe("allow");
        expect(dailyLimitVerdict(undefined, 9999, null)).toBe("allow");
    });
});
