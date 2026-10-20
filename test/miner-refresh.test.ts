import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

import type { DropCampaign, Inventory } from "../packages/core/src/twitch/types.js";
import { Campaign } from "../packages/core/src/models/campaign.js";
import { iso, makeCampaign, makeDrop } from "./fixtures.js";

// The catalogue is a network fallback for an empty campaign list; nothing here wants it.
vi.mock("../packages/core/src/twitch/catalogue.js", () => ({ fetchCatalogue: async () => [] }));

const { Miner } = await import("../packages/core/src/miner.js");
const { DEFAULT_CONFIG } = await import("../packages/core/src/config.js");
const { serializeCampaign } = await import("../packages/core/src/api/serialize.js");
const { AuthExpiredError, GqlError, StaleQueryHashError } = await import(
    "../packages/core/src/twitch/gql.js"
);

class FakeAuth extends EventEmitter {
    userId = "1";
    login = "tester";
    accessToken = "t";
}

/**
 * A stand-in for Twitch: the campaign list, per-campaign details and the inventory, each
 * replaceable per test. Details default to the listed campaign itself, drops and all.
 */
class FakeGql {
    listed: DropCampaign[] = [];
    details: (id: string) => Promise<DropCampaign | null> = async (id) =>
        this.listed.find((campaign) => campaign.id === id) ?? null;
    inventory: () => Promise<Inventory> = async () => ({
        dropCampaignsInProgress: [],
        gameEventDrops: [],
    });
    claims: string[] = [];
    claimResult = true;

    async getCampaigns(): Promise<DropCampaign[]> {
        return this.listed;
    }
    getCampaignDetails(id: string): Promise<DropCampaign | null> {
        return this.details(id);
    }
    getInventory(): Promise<Inventory> {
        return this.inventory();
    }
    async claimDrop(instanceId: string): Promise<boolean> {
        this.claims.push(instanceId);
        return this.claimResult;
    }
    async getStreamInfo(): Promise<null> {
        return null;
    }
}

const miners: InstanceType<typeof Miner>[] = [];

function makeMiner(gql: FakeGql, config: Partial<typeof DEFAULT_CONFIG> = {}) {
    const miner = new Miner(new FakeAuth() as never, gql as never, {
        ...DEFAULT_CONFIG,
        ...config,
    });
    miners.push(miner);
    return miner;
}

function feedOf(miner: InstanceType<typeof Miner>): string[] {
    return miner.getFeed(200).map((entry) => entry.message);
}

afterEach(() => {
    // Stopping clears the boundary and refresh timers a refresh may have armed.
    for (const miner of miners.splice(0)) {
        miner.stop();
    }
});

describe("reading the inventory", () => {
    it("carries on without it, and says so", async () => {
        const gql = new FakeGql();
        gql.listed = [makeCampaign({ id: "c" })];
        gql.inventory = async () => {
            throw new GqlError("inventory failed after 4 attempts");
        };
        const miner = makeMiner(gql);

        await miner.refreshNow();

        expect(miner.getCampaigns()).toHaveLength(1);
        expect(feedOf(miner).some((line) => /inventory/i.test(line))).toBe(true);
    });

    it("says it once, not at every refresh while it keeps failing", async () => {
        const gql = new FakeGql();
        gql.listed = [makeCampaign({ id: "c" })];
        gql.inventory = async () => {
            throw new GqlError("nope");
        };
        const miner = makeMiner(gql);

        await miner.refreshNow();
        await miner.refreshNow();

        expect(feedOf(miner).filter((line) => /inventory/i.test(line))).toHaveLength(1);
    });

    it("passes on a dead token and a rotated hash, which nothing else will survive", async () => {
        for (const error of [new AuthExpiredError(), new StaleQueryHashError("Inventory")]) {
            const gql = new FakeGql();
            gql.listed = [makeCampaign({ id: "c" })];
            gql.inventory = async () => {
                throw error;
            };
            await expect(makeMiner(gql).refreshNow()).rejects.toBe(error);
        }
    });
});

describe("a campaign whose details could not be fetched", () => {
    /** The campaign list as Twitch sends it: no drops. */
    const listing = (id: string) => makeCampaign({ id, timeBasedDrops: undefined });

    it("keeps the drops the previous sweep found", async () => {
        const gql = new FakeGql();
        gql.listed = [listing("c")];
        gql.details = async (id) => makeCampaign({ id });
        const miner = makeMiner(gql);
        await miner.refreshNow();

        gql.details = async () => {
            throw new GqlError("DropCampaignDetails failed after 4 attempts");
        };
        await miner.refreshNow();

        const [campaign] = miner.getCampaigns();
        expect(campaign!.drops.map((drop) => drop.id)).toEqual(["c-d1"]);
        expect(campaign!.isCompleted).toBe(false);
        expect(miner.getMineableCampaigns().map((c) => c.id)).toEqual(["c"]);
    });

    it("does the same when Twitch answers with no campaign", async () => {
        const gql = new FakeGql();
        gql.listed = [listing("c")];
        gql.details = async (id) => makeCampaign({ id });
        const miner = makeMiner(gql);
        await miner.refreshNow();

        gql.details = async () => null;
        await miner.refreshNow();

        expect(miner.getCampaigns()[0]!.drops).toHaveLength(1);
    });

    it("is not shown as finished when it was never fetched at all", async () => {
        const gql = new FakeGql();
        gql.listed = [listing("c")];
        gql.details = async () => null;
        const miner = makeMiner(gql);

        await miner.refreshNow();

        const [campaign] = miner.getCampaigns();
        expect(campaign!.isCompleted).toBe(false);
        // Nor offered as work: there is nothing in it to watch for yet.
        expect(miner.getMineableCampaigns()).toEqual([]);
    });

    it("still counts as finished when its details really list no drops", async () => {
        const gql = new FakeGql();
        gql.listed = [listing("c")];
        gql.details = async (id) => makeCampaign({ id, drops: [] });
        const miner = makeMiner(gql);

        await miner.refreshNow();

        expect(miner.getCampaigns()[0]!.isCompleted).toBe(true);
        expect(miner.getMineableCampaigns()).toEqual([]);
    });
});

describe("account linking from the inventory", () => {
    it("marks a catalogue campaign unlinked when the inventory says so", async () => {
        // Catalogue campaigns carry no `self`, which read as linked - so progress went on
        // being earned toward rewards that could never arrive, without a word.
        const gql = new FakeGql();
        gql.listed = [makeCampaign({ id: "c", self: null })];
        gql.inventory = async () => ({
            dropCampaignsInProgress: [makeCampaign({ id: "c", self: { isAccountConnected: false } })],
            gameEventDrops: [],
        });
        const miner = makeMiner(gql);

        await miner.refreshNow();

        const [campaign] = miner.getCampaigns();
        expect(campaign!.isAccountLinked).toBe(false);
    });

    it("leaves a campaign alone when the inventory does not mention it", async () => {
        const gql = new FakeGql();
        gql.listed = [makeCampaign({ id: "c", self: null })];
        const miner = makeMiner(gql);

        await miner.refreshNow();

        expect(miner.getCampaigns()[0]!.isAccountLinked).toBe(true);
    });
});

describe("overlapping refreshes", () => {
    it("joins the sweep already running instead of starting another", async () => {
        const gql = new FakeGql();
        gql.listed = [makeCampaign({ id: "c" })];
        const list = vi.spyOn(gql, "getCampaigns");
        const miner = makeMiner(gql);

        await Promise.all([miner.refreshNow(), miner.refreshNow(), miner.refreshNow()]);

        expect(list).toHaveBeenCalledTimes(1);
    });

    it("starts a new sweep once the last has finished", async () => {
        const gql = new FakeGql();
        gql.listed = [makeCampaign({ id: "c" })];
        const list = vi.spyOn(gql, "getCampaigns");
        const miner = makeMiner(gql);

        await miner.refreshNow();
        await miner.refreshNow();

        expect(list).toHaveBeenCalledTimes(2);
    });

    it("claims a finished drop once, however many sweeps were asked for", async () => {
        const gql = new FakeGql();
        gql.listed = [
            makeCampaign({
                id: "c",
                drops: [
                    makeDrop({
                        id: "d",
                        self: { currentMinutesWatched: 60, dropInstanceID: "i", isClaimed: false },
                    }),
                ],
            }),
        ];
        // Twitch slow to confirm, which is when overlapping sweeps both reached the claim.
        gql.claimDrop = async (id: string) => {
            gql.claims.push(id);
            await new Promise((r) => setTimeout(r, 20));
            return true;
        };
        const miner = makeMiner(gql);

        await Promise.all([miner.refreshNow(), miner.refreshNow()]);

        expect(gql.claims).toEqual(["i"]);
    });
});

describe("re-arming the refresh timer", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("keeps one chain of refreshes when re-armed in the middle of one", async () => {
        vi.useFakeTimers();
        const gql = new FakeGql();
        gql.listed = [makeCampaign({ id: "c" })];
        let release: () => void = () => {};
        let calls = 0;
        gql.getCampaigns = async () => {
            calls += 1;
            // The first scheduled sweep is still running when the interval is changed.
            if (calls === 1) {
                await new Promise<void>((resolve) => (release = resolve));
            }
            return gql.listed;
        };
        const miner = makeMiner(gql, { campaignRefreshMinutes: 20 });
        (miner as unknown as { scheduleCampaignRefresh(): void }).scheduleCampaignRefresh();

        await vi.advanceTimersByTimeAsync(20 * 60_000);
        expect(calls).toBe(1);

        miner.applyConfig({ ...miner.getConfig(), campaignRefreshMinutes: 30 });
        release();
        await vi.advanceTimersByTimeAsync(0);

        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(calls).toBe(2);
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(calls).toBe(3);
    });

    it("schedules nothing more once stopped mid-refresh", async () => {
        vi.useFakeTimers();
        const gql = new FakeGql();
        gql.listed = [makeCampaign({ id: "c" })];
        let release: () => void = () => {};
        let calls = 0;
        gql.getCampaigns = async () => {
            calls += 1;
            await new Promise<void>((resolve) => (release = resolve));
            return gql.listed;
        };
        const miner = makeMiner(gql, { campaignRefreshMinutes: 20 });
        (miner as unknown as { scheduleCampaignRefresh(): void }).scheduleCampaignRefresh();

        await vi.advanceTimersByTimeAsync(20 * 60_000);
        miner.stop();
        release();
        await vi.advanceTimersByTimeAsync(0);

        // Not even a timer waiting to find out it should do nothing: one would keep the
        // stopped Miner reachable for a whole interval.
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(calls).toBe(1);
    });
});

describe("the idle wait", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    type Internals = {
        campaigns: Map<string, Campaign>;
        channelCooldowns: Map<string, number>;
        waitWhileIdle(ms: number): Promise<void>;
    };

    /** Start the wait and report, as fake time passes, whether it has ended. */
    function waiting(miner: InstanceType<typeof Miner>) {
        let done = false;
        void (miner as unknown as Internals).waitWhileIdle(20 * 60_000).then(() => (done = true));
        return () => done;
    }

    it("ends when a campaign starts", async () => {
        vi.useFakeTimers();
        const miner = makeMiner(new FakeGql());
        const startsAt = iso(1.5);
        (miner as unknown as Internals).campaigns = new Map([
            [
                "c",
                new Campaign(
                    makeCampaign({
                        id: "c",
                        startAt: startsAt,
                        drops: [makeDrop({ id: "d", startAt: startsAt })],
                    }),
                ),
            ],
        ]);
        const ended = waiting(miner);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(ended()).toBe(false);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(ended()).toBe(true);
    });

    it("ends when a benched campaign's time is up", async () => {
        vi.useFakeTimers();
        const miner = makeMiner(new FakeGql());
        const internals = miner as unknown as Internals;
        internals.campaigns = new Map([["c", new Campaign(makeCampaign({ id: "c" }))]]);
        internals.channelCooldowns.set("campaign:c", Date.now() + 3 * 60_000);
        const ended = waiting(miner);

        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(ended()).toBe(false);
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(ended()).toBe(true);
    });

    it("sits out the wait when nothing new has become possible", async () => {
        // Candidates that were already on offer and found no channel are not a reason to
        // search again every minute.
        vi.useFakeTimers();
        const miner = makeMiner(new FakeGql());
        (miner as unknown as Internals).campaigns = new Map([
            ["c", new Campaign(makeCampaign({ id: "c" }))],
        ]);
        const ended = waiting(miner);

        await vi.advanceTimersByTimeAsync(19 * 60_000);
        expect(ended()).toBe(false);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(ended()).toBe(true);
    });
});

describe("a claim Twitch refuses", () => {
    function finished() {
        return makeCampaign({
            id: "c",
            drops: [
                makeDrop({
                    id: "d",
                    self: { currentMinutesWatched: 60, dropInstanceID: "i", isClaimed: false },
                }),
            ],
        });
    }

    it("is asked again rather than abandoned at the first refusal", async () => {
        const gql = new FakeGql();
        gql.listed = [finished()];
        gql.claimResult = false;
        const miner = makeMiner(gql);

        await miner.refreshNow();
        await miner.refreshNow();

        expect(gql.claims).toEqual(["i", "i"]);
        expect(miner.getCampaigns()[0]!.drops[0]!.isClaimable).toBe(true);
    });

    it("lands if Twitch accepts a later attempt", async () => {
        const gql = new FakeGql();
        gql.listed = [finished()];
        gql.claimResult = false;
        const miner = makeMiner(gql);

        await miner.refreshNow();
        gql.claimResult = true;
        await miner.refreshNow();

        expect(miner.getCampaigns()[0]!.drops[0]!.isClaimed).toBe(true);
    });

    it("is given up after the capped number of attempts, and not reported as claimed", async () => {
        const gql = new FakeGql();
        gql.listed = [finished()];
        gql.claimResult = false;
        const miner = makeMiner(gql);
        const completed = vi.fn();
        miner.on("campaign-completed", completed);

        for (let refresh = 0; refresh < 6; refresh += 1) {
            await miner.refreshNow();
        }

        expect(gql.claims).toHaveLength(3);
        const [campaign] = miner.getCampaigns();
        const drop = campaign!.drops[0]!;
        expect(drop.isClaimed).toBe(false);
        expect(drop.givenUp).toBe(true);
        expect(campaign!.nextDrop({ attemptImpossible: true })).toBeNull();
        expect(completed).not.toHaveBeenCalled();
        expect(feedOf(miner).filter((line) => /Could not claim/.test(line))).toHaveLength(1);
    });
});

describe("campaigns skipped with Next", () => {
    it("are reported as deferred to the dashboard until restored", async () => {
        const gql = new FakeGql();
        gql.listed = [makeCampaign({ id: "a" }), makeCampaign({ id: "b" })];
        const miner = makeMiner(gql);
        await miner.refreshNow();
        const [a] = miner.getCampaigns();
        (miner as unknown as { currentCampaign: unknown }).currentCampaign = a;

        expect(miner.skipCampaign()).toBe(true);
        const shown = () =>
            miner
                .getCampaigns()
                .map((c) => [c.id, serializeCampaign(c, DEFAULT_CONFIG, null, miner.isDeferred(c.id)).isDeferred]);
        expect(shown()).toEqual([
            ["a", true],
            ["b", false],
        ]);

        miner.clearDeferrals();
        expect(shown()).toEqual([
            ["a", false],
            ["b", false],
        ]);
    });

    it("default to not deferred where the caller does not say", () => {
        const campaign = new Campaign(makeCampaign({ id: "a" }));
        expect(serializeCampaign(campaign, DEFAULT_CONFIG).isDeferred).toBe(false);
    });
});
