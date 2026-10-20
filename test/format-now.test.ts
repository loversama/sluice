import { describe, expect, it } from "vitest";

// @ts-expect-error - plain JS module shared with the dashboard build.
import { formatRelative, formatUntil } from "../web/src/lib/format.js";

const at = Date.parse("2026-10-20T12:00:00Z");

/**
 * Relative times read the clock they are given. They used to read Date.now() themselves,
 * which Vue cannot track, so "just now" and "in 3h" stayed frozen until the row re-rendered
 * for some other reason.
 */
describe("relative times follow the clock passed in", () => {
    it("ages a claim as the clock moves", () => {
        const claimed = new Date(at).toISOString();
        expect(formatRelative(claimed, at + 10_000)).toBe("just now");
        expect(formatRelative(claimed, at + 5 * 60_000)).toBe("5m ago");
        expect(formatRelative(claimed, at + 3 * 3_600_000)).toBe("3h ago");
        expect(formatRelative(claimed, at + 2 * 86_400_000)).toBe("2d ago");
    });

    it("counts down to an end time as the clock moves", () => {
        const ends = new Date(at + 4 * 3_600_000).toISOString();
        expect(formatUntil(ends, at)).toBe("in 4h");
        expect(formatUntil(ends, at + 3.5 * 3_600_000)).toBe("in 30m");
        expect(formatUntil(ends, at + 4 * 3_600_000)).toBe("now");
    });

    it("still defaults to the real clock", () => {
        expect(formatRelative(new Date().toISOString())).toBe("just now");
    });
});
