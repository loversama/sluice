import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

/**
 * These cover the things that only go wrong slowly: collections that grow without bound and
 * work that carries on after a stop. A container restarted on every deploy hides all of it;
 * a desktop app left running for months does not.
 */
class FakeAuth extends EventEmitter {
    userId = "1";
    login = "tester";
    accessToken = "t";
}
vi.mock("../packages/core/src/twitch/gql.js", async () => {
    class StaleQueryHashError extends Error {}
    class AuthExpiredError extends Error {}
    return {
        TwitchGql: class {
            async getCampaignDetails(): Promise<null> {
                return null;
            }
        },
        StaleQueryHashError,
        AuthExpiredError,
        GqlError: Error,
    };
});

const { Miner } = await import("../packages/core/src/miner.js");
const { DEFAULT_CONFIG } = await import("../packages/core/src/config.js");

function makeMiner() {
    return new Miner(new FakeAuth() as never, {} as never, { ...DEFAULT_CONFIG });
}

describe("channel cooldowns", () => {
    /** Reach the private map directly: this is a test about internal bookkeeping. */
    function cooldowns(miner: unknown): Map<string, number> {
        return (miner as { channelCooldowns: Map<string, number> }).channelCooldowns;
    }

    it("forgets a cooldown once it has expired", () => {
        const miner = makeMiner();
        cooldowns(miner).set("someone", Date.now() - 1000);
        expect(miner.cooldownCount).toBe(1);

        // Selection is what prunes, and it runs constantly during normal operation.
        miner.getMineableCampaigns();

        expect(miner.cooldownCount).toBe(0);
    });

    it("keeps one that has not expired yet", () => {
        const miner = makeMiner();
        cooldowns(miner).set("someone", Date.now() + 60 * 60 * 1000);

        miner.getMineableCampaigns();

        expect(miner.cooldownCount).toBe(1);
    });

    it("does not accumulate an entry per channel ever benched", () => {
        // The failure this guards against: one entry per channel benched and one per
        // campaign passed over, kept for the life of the process. Invisible in a container
        // restarted on every deploy; not in an app left running for months.
        const miner = makeMiner();
        for (let i = 0; i < 500; i += 1) {
            cooldowns(miner).set(`channel-${i}`, Date.now() - 1);
            cooldowns(miner).set(`campaign:${i}`, Date.now() - 1);
        }
        expect(miner.cooldownCount).toBe(1000);

        miner.getMineableCampaigns();

        expect(miner.cooldownCount).toBe(0);
    });

    it("prunes only what has expired, leaving live entries alone", () => {
        const miner = makeMiner();
        cooldowns(miner).set("expired", Date.now() - 1);
        cooldowns(miner).set("live", Date.now() + 60 * 60 * 1000);

        miner.getMineableCampaigns();

        expect(miner.cooldownCount).toBe(1);
        expect(cooldowns(miner).has("live")).toBe(true);
    });
});

describe("claim statistics", () => {
    it("answers repeatedly without recomputing", () => {
        // The dashboard asks on every poll; the answer only moves when a claim lands or
        // campaigns refresh.
        const miner = makeMiner();
        const first = miner.getClaimStats();
        const second = miner.getClaimStats();
        expect(second).toBe(first);
    });
});
