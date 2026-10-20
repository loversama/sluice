import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

import { Campaign } from "../packages/core/src/models/campaign.js";
import { WATCH_INTERVAL_MS } from "../packages/core/src/twitch/constants.js";
import { makeCampaign } from "./fixtures.js";

// The catalogue is a network fallback for an empty campaign list; nothing here wants it.
vi.mock("../packages/core/src/twitch/catalogue.js", () => ({ fetchCatalogue: async () => [] }));

const { Miner } = await import("../packages/core/src/miner.js");
const { DEFAULT_CONFIG } = await import("../packages/core/src/config.js");

class FakeAuth extends EventEmitter {
    userId = "1";
    login = "tester";
    accessToken = "t";
}

/** Twitch, as far as watching needs it: a session that is always earning. */
const gql = {
    async getCurrentDropSession() {
        return { dropId: "other", currentMinutes: 0 };
    },
    async getInventory() {
        return { dropCampaignsInProgress: [], gameEventDrops: [] };
    },
};

/** A live channel that accepts every beat. */
function fakeChannel() {
    return {
        id: "ch",
        login: "streamer",
        displayName: "Streamer",
        url: "https://www.twitch.tv/streamer",
        stream: { title: "", viewers: 1, gameName: "Game" },
        isOnline: true,
        isWatchable: true,
        startSegmentWatch() {},
        async stopSegmentWatch() {},
        sendWatch: vi.fn(async () => true),
    };
}

type Watching = {
    watch(channel: unknown, campaign: Campaign, drop: unknown): Promise<string>;
};

function makeMiner(config: Partial<typeof DEFAULT_CONFIG> = {}) {
    return new Miner(new FakeAuth() as never, gql as never, { ...DEFAULT_CONFIG, ...config });
}

describe("watching", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("counts a minute toward the daily limit for every accepted beat", async () => {
        // Counted once on entering a channel, an hour on one streamer was one minute.
        const miner = makeMiner();
        const campaign = new Campaign(makeCampaign({ id: "c" }));
        const channel = fakeChannel();
        const watching = (miner as unknown as Watching).watch(channel, campaign, campaign.drops[0]);

        await vi.advanceTimersByTimeAsync(4 * WATCH_INTERVAL_MS + 1_000);
        miner.stop();
        await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS);
        await watching;

        expect(channel.sendWatch).toHaveBeenCalledTimes(5);
        expect(miner.minedTodayMinutes).toBe(5);
    });

    it("counts nothing for a beat the channel rejected", async () => {
        const miner = makeMiner();
        const campaign = new Campaign(makeCampaign({ id: "c" }));
        const channel = fakeChannel();
        channel.sendWatch.mockResolvedValue(false);
        const watching = (miner as unknown as Watching).watch(channel, campaign, campaign.drops[0]);

        await vi.advanceTimersByTimeAsync(2 * WATCH_INTERVAL_MS + 1_000);
        miner.stop();
        await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS);
        await watching;

        expect(miner.minedTodayMinutes).toBe(0);
    });
});
