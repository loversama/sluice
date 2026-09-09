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

/**
 * The rule above fixes the cause that was found. This one is the backstop for the cause
 * that has not been found yet: whatever makes our idea of "claimed" diverge from Twitch's,
 * the answer is never to keep claiming.
 */
describe("the cap on repeated claims", () => {
    const MAX = 3;

    class Claimer {
        attempts = new Map<string, number>();
        givenUp = new Set<string>();
        calls = 0;

        /** What claim() does, reduced to the counting. */
        claim(id: string) {
            if ((this.attempts.get(id) ?? 0) >= MAX) {
                this.givenUp.add(id);
                return;
            }
            this.attempts.set(id, (this.attempts.get(id) ?? 0) + 1);
            this.calls += 1;
        }
    }

    it("stops after three, however many times it is asked", () => {
        const c = new Claimer();
        for (let i = 0; i < 41; i += 1) c.claim("gta-250k");
        expect(c.calls).toBe(MAX);
        expect(c.givenUp.has("gta-250k")).toBe(true);
    });

    it("leaves a normal claim alone", () => {
        const c = new Claimer();
        c.claim("d1");
        expect(c.calls).toBe(1);
        expect(c.givenUp.size).toBe(0);
    });

    it("counts each drop separately", () => {
        const c = new Claimer();
        for (let i = 0; i < 10; i += 1) { c.claim("a"); c.claim("b"); }
        expect(c.calls).toBe(MAX * 2);
    });
});
