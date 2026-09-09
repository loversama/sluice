import { describe, expect, it } from "vitest";

/**
 * A drop claimed and confirmed by Twitch was being claimed again on every campaign refresh,
 * because Twitch's own inventory went on reporting it as unclaimed and the miner treated
 * inventory as the last word. On GTA V that produced forty-one claims of a single reward in
 * nine hours, a desktop notification each time, and a claim history that counted every one.
 *
 * The rule this pins: inventory may correct a guess, and may not correct a confirmed claim.
 */
describe("what inventory is allowed to take back", () => {
    // Mirrors the two sets in Miner, which cannot be constructed here without a live session.
    class Guard {
        readonly claimed = new Set<string>();
        readonly confirmed = new Set<string>();

        /** The owned-benefit inference: a guess, and correctable. */
        guess(id: string) {
            this.claimed.add(id);
        }
        /** Claimed through the API, and Twitch said yes. */
        confirm(id: string) {
            this.claimed.add(id);
            this.confirmed.add(id);
        }
        /** What a refresh does when inventory reports the drop as unclaimed. */
        inventorySaysUnclaimed(id: string) {
            if (!this.confirmed.has(id)) this.claimed.delete(id);
        }
        wouldClaimAgain(id: string) {
            return !this.claimed.has(id);
        }
    }

    it("takes back a guess, so a wrong one is not permanent", () => {
        const g = new Guard();
        g.guess("d1");
        g.inventorySaysUnclaimed("d1");
        expect(g.wouldClaimAgain("d1")).toBe(true);
    });

    it("does not take back a claim Twitch confirmed", () => {
        const g = new Guard();
        g.confirm("d1");
        g.inventorySaysUnclaimed("d1");
        expect(g.wouldClaimAgain("d1")).toBe(false);
    });

    it("holds across many refreshes, which is where the loop lived", () => {
        const g = new Guard();
        g.confirm("gta-250k");
        for (let refresh = 0; refresh < 41; refresh += 1) {
            g.inventorySaysUnclaimed("gta-250k");
            expect(g.wouldClaimAgain("gta-250k"), `refresh ${refresh}`).toBe(false);
        }
    });

    it("still lets a confirmed claim start from a guess", () => {
        // The inference runs first and the real claim can follow; the later one wins.
        const g = new Guard();
        g.guess("d1");
        g.confirm("d1");
        g.inventorySaysUnclaimed("d1");
        expect(g.wouldClaimAgain("d1")).toBe(false);
    });
});
