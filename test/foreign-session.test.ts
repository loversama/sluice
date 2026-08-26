import { describe, expect, it } from "vitest";

import { detectForeignSession } from "../packages/core/src/foreign-session.js";

const snap = (dropId: string | null, minutes: Record<string, number>) => ({
    dropId,
    minutes: new Map(Object.entries(minutes)),
});

/**
 * Twitch credits one watch session per account, so a second Sluice - or a browser tab -
 * silently starves this one. The miner's own stall detection blames the channel and hops to
 * another, which never helps and hides the real cause.
 */
describe("detectForeignSession", () => {
    it("spots our drop standing still while another moves", () => {
        const before = snap("ours", { ours: 40, other: 10 });
        const after = snap("ours", { ours: 40, other: 15 });

        expect(detectForeignSession(before, after)).toEqual({ dropId: "other", gainedMinutes: 5 });
    });

    it("says nothing while we are earning normally", () => {
        const before = snap("ours", { ours: 40, other: 10 });
        const after = snap("ours", { ours: 45, other: 15 });

        expect(detectForeignSession(before, after)).toBeNull();
    });

    it("says nothing when the whole account is idle", () => {
        // A stalled channel looks like this, and it is a different problem with a different
        // fix - switching channels does help there.
        const before = snap("ours", { ours: 40, other: 10 });
        const after = snap("ours", { ours: 40, other: 10 });

        expect(detectForeignSession(before, after)).toBeNull();
    });

    it("does not read a drop it has only just discovered as progress", () => {
        // A refresh routinely turns up drops that already have minutes on them.
        const before = snap("ours", { ours: 40 });
        const after = snap("ours", { ours: 40, discovered: 90 });

        expect(detectForeignSession(before, after)).toBeNull();
    });

    it("says nothing when we changed drop in between", () => {
        const before = snap("ours", { ours: 40, other: 10 });
        const after = snap("other", { ours: 40, other: 15 });

        expect(detectForeignSession(before, after)).toBeNull();
    });

    it("says nothing when nothing is being watched", () => {
        expect(detectForeignSession(snap(null, { a: 1 }), snap(null, { a: 2 }))).toBeNull();
    });

    it("says nothing when our drop is unknown to either snapshot", () => {
        expect(detectForeignSession(snap("ours", { other: 1 }), snap("ours", { other: 2 }))).toBeNull();
    });
});
