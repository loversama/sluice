import { describe, expect, it, vi } from "vitest";

import { SegmentTracker, SegmentWatcher, parseSegmentUrls, type SegmentSource } from "../packages/core/src/twitch/segments.js";
import { lowestVideoVariant } from "../packages/core/src/models/channel.js";

const PLAYLIST = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXTINF:2.000,live",
    "https://cdn.example/seg1.ts",
    "#EXTINF:2.000,live",
    "https://cdn.example/seg2.ts",
    "#EXT-X-TWITCH-PREFETCH:https://cdn.example/seg3.ts",
].join("\n");

describe("parseSegmentUrls", () => {
    it("returns segments in order and ignores tags and prefetch entries", () => {
        expect(parseSegmentUrls(PLAYLIST)).toEqual([
            "https://cdn.example/seg1.ts",
            "https://cdn.example/seg2.ts",
        ]);
    });

    it("handles carriage returns", () => {
        expect(parseSegmentUrls("#EXTM3U\r\nhttps://cdn.example/a.ts\r\n")).toEqual(["https://cdn.example/a.ts"]);
    });
});

describe("SegmentTracker", () => {
    it("reports only segments not yet marked", () => {
        const tracker = new SegmentTracker();
        tracker.markSeen("a");
        expect(tracker.unseen(["a", "b", "c"])).toEqual(["b", "c"]);
    });

    it("stays bounded", () => {
        const tracker = new SegmentTracker();
        for (let i = 0; i < 1000; i++) {
            tracker.markSeen(`s${i}`);
        }
        expect(tracker.size).toBeLessThanOrEqual(300);
    });
});

function source(overrides: Partial<SegmentSource> = {}): SegmentSource {
    return {
        resolvePlaylistUrl: async () => "https://cdn.example/index.m3u8",
        invalidatePlaylistUrl: vi.fn(),
        fetchPlaylist: async () => PLAYLIST,
        headSegment: async () => 200,
        ...overrides,
    };
}

describe("SegmentWatcher", () => {
    it("requests each segment once across repeated polls", async () => {
        const head = vi.fn(async () => 200);
        const watcher = new SegmentWatcher(source({ headSegment: head }), "chan");
        const signal = new AbortController().signal;
        await watcher.pollOnce(signal);
        await watcher.pollOnce(signal);
        expect(head).toHaveBeenCalledTimes(2);
        expect(watcher.healthy).toBe(true);
    });

    it("requests only the new segments when the playlist advances", async () => {
        const head = vi.fn(async () => 200);
        let text = PLAYLIST;
        const watcher = new SegmentWatcher(source({ headSegment: head, fetchPlaylist: async () => text }), "chan");
        const signal = new AbortController().signal;
        await watcher.pollOnce(signal);
        text = PLAYLIST + "\nhttps://cdn.example/seg4.ts";
        await watcher.pollOnce(signal);
        expect(head.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
            "https://cdn.example/seg1.ts",
            "https://cdn.example/seg2.ts",
            "https://cdn.example/seg4.ts",
        ]);
    });

    it("retries a segment whose request failed", async () => {
        const head = vi.fn().mockResolvedValueOnce(503).mockResolvedValue(200);
        const watcher = new SegmentWatcher(source({ headSegment: head }), "chan");
        const signal = new AbortController().signal;
        await watcher.pollOnce(signal);
        await watcher.pollOnce(signal);
        // seg1 failed once and was retried; seg2 succeeded the first time.
        expect(head).toHaveBeenCalledTimes(3);
    });

    it("is not healthy until a segment has succeeded", async () => {
        const watcher = new SegmentWatcher(source({ headSegment: async () => 500 }), "chan");
        await watcher.pollOnce(new AbortController().signal);
        expect(watcher.healthy).toBe(false);
    });

    it("refreshes the playlist URL after repeated failures", async () => {
        const invalidate = vi.fn();
        const watcher = new SegmentWatcher(
            source({ fetchPlaylist: async () => null, invalidatePlaylistUrl: invalidate }),
            "chan",
        );
        const signal = new AbortController().signal;
        await watcher.pollOnce(signal);
        expect(invalidate).not.toHaveBeenCalled();
        await watcher.pollOnce(signal);
        expect(invalidate).toHaveBeenCalledTimes(1);
    });

    it("polls on a timer until stopped", async () => {
        const fetchPlaylist = vi.fn(async () => PLAYLIST);
        const watcher = new SegmentWatcher(source({ fetchPlaylist }), "chan", 5);
        watcher.start();
        await new Promise((resolve) => setTimeout(resolve, 60));
        await watcher.stop();
        const calls = fetchPlaylist.mock.calls.length;
        expect(calls).toBeGreaterThan(2);
        expect(watcher.running).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(fetchPlaylist.mock.calls.length).toBe(calls);
    });
});

describe("SegmentWatcher.waitForFirstPoll", () => {
    it("waits for the first playlist read, so a fresh watcher is not judged unread", async () => {
        let release: () => void = () => {};
        const watcher = new SegmentWatcher(
            source({
                fetchPlaylist: async () => {
                    await new Promise<void>((resolve) => (release = resolve));
                    return PLAYLIST;
                },
            }),
            "chan",
            1_000,
        );
        watcher.start();
        expect(watcher.healthy).toBe(false);

        let waited = false;
        const waiting = watcher.waitForFirstPoll(5_000).then(() => (waited = true));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(waited).toBe(false);

        release();
        await waiting;
        expect(watcher.healthy).toBe(true);
        await watcher.stop();
    });

    it("gives up waiting on a poll that hangs", async () => {
        const watcher = new SegmentWatcher(
            source({ fetchPlaylist: () => new Promise<string | null>(() => {}) }),
            "chan",
        );
        watcher.start();
        const started = Date.now();
        await watcher.waitForFirstPoll(30);
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(watcher.healthy).toBe(false);
        void watcher.stop();
    });

    it("does not wait once the first poll is done", async () => {
        const watcher = new SegmentWatcher(source(), "chan", 1_000);
        watcher.start();
        await watcher.waitForFirstPoll(5_000);
        const started = Date.now();
        await watcher.waitForFirstPoll(5_000);
        expect(Date.now() - started).toBeLessThan(100);
        await watcher.stop();
    });
});

describe("lowestVideoVariant", () => {
    it("skips the audio-only rendition at the end of the list", () => {
        const master = [
            "#EXTM3U",
            '#EXT-X-STREAM-INF:BANDWIDTH=6000000,VIDEO="chunked"',
            "https://usher.example/chunked.m3u8",
            '#EXT-X-STREAM-INF:BANDWIDTH=300000,VIDEO="160p30"',
            "https://usher.example/160p.m3u8",
            '#EXT-X-STREAM-INF:BANDWIDTH=100000,VIDEO="audio_only"',
            "https://usher.example/audio.m3u8",
        ].join("\n");
        expect(lowestVideoVariant(master)).toBe("https://usher.example/160p.m3u8");
    });

    it("returns null when there is nothing to watch", () => {
        expect(lowestVideoVariant("#EXTM3U")).toBeNull();
    });
});
