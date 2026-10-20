import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

import type { DropCampaign, Inventory } from "../packages/core/src/twitch/types.js";
import { makeCampaign, makeDrop } from "./fixtures.js";

// The catalogue is a network fallback for an empty campaign list; nothing here wants it.
vi.mock("../packages/core/src/twitch/catalogue.js", () => ({ fetchCatalogue: async () => [] }));

const { Miner } = await import("../packages/core/src/miner.js");
const { DEFAULT_CONFIG } = await import("../packages/core/src/config.js");
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
