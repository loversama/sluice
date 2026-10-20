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

describe("the status event", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    /** Count status events, and record what the miner reported at the moment of each. */
    function listen(miner: InstanceType<typeof Miner>) {
        const seen: { mining: unknown; paused: boolean }[] = [];
        miner.on("status", (...args: unknown[]) => {
            expect(args).toEqual([]);
            seen.push({ mining: miner.getMiningState(), paused: miner.isPaused });
        });
        return seen;
    }

    it("is sent on pause and resume, once per change", () => {
        const miner = makeMiner();
        const seen = listen(miner);

        miner.pause();
        miner.pause();
        expect(seen).toEqual([{ mining: null, paused: true }]);

        miner.resume();
        miner.resume();
        expect(seen).toHaveLength(2);
        expect(seen[1]!.paused).toBe(false);
    });

    it("is sent when the schedule closes and opens", () => {
        const closed = { enabled: true, windows: [{ days: [], from: "00:00", to: "00:01" }] };
        const miner = makeMiner({ schedule: closed });
        const seen = listen(miner);

        expect(miner.withinSchedule()).toBe(false);
        expect(miner.withinSchedule()).toBe(false);
        expect(seen).toHaveLength(1);

        miner.applyConfig({ ...miner.getConfig(), schedule: { enabled: false, windows: [] } });
        expect(miner.withinSchedule()).toBe(true);
        expect(seen).toHaveLength(2);
    });

    it("is sent on reaching the daily limit, and again on a new day's allowance", () => {
        const miner = makeMiner({ dailyLimit: { enabled: true, hours: 1 } });
        const internals = miner as unknown as { minedToday: number; minedTodayOn: string };
        internals.minedToday = 60;
        const seen = listen(miner);

        expect(miner.withinDailyLimit()).toBe(false);
        expect(miner.withinDailyLimit()).toBe(false);
        expect(seen).toHaveLength(1);

        // Midnight: yesterday's tally no longer counts.
        internals.minedTodayOn = "a day long gone";
        expect(miner.withinDailyLimit()).toBe(true);
        expect(seen).toHaveLength(2);

        // And the limit is announced again when today's is reached.
        internals.minedTodayOn = new Date().toDateString();
        internals.minedToday = 60;
        expect(miner.withinDailyLimit()).toBe(false);
        expect(seen).toHaveLength(3);
    });

    it("is sent on leaving a channel, after the channel is cleared", async () => {
        const miner = makeMiner();
        const seen = listen(miner);
        const campaign = new Campaign(makeCampaign({ id: "c" }));
        const watching = (miner as unknown as Watching).watch(
            fakeChannel(),
            campaign,
            campaign.drops[0],
        );
        await vi.advanceTimersByTimeAsync(1_000);
        expect(miner.getMiningState()).not.toBeNull();
        expect(seen).toHaveLength(0);

        miner.pause();
        await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS);
        expect(await watching).toBe("paused");

        // Once for the pause itself, once for leaving - and by then nothing is being mined.
        expect(seen).toHaveLength(2);
        expect(seen.at(-1)!.mining).toBeNull();
    });
});
