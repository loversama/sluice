import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("undici", () => ({ request: requestMock }));

// Imported after the mock so the channel picks up the stub.
const { Channel } = await import("../packages/core/src/models/channel.js");

const auth = { userId: "1", accessToken: "t", headers: () => ({}) };

/** A live channel whose segment watcher reports whatever the test says. */
function channel(segmentsHealthy: boolean) {
    const live = new Channel("ch", "streamer", "Streamer", auth as never, {} as never);
    live.stream = { broadcastId: "b", gameId: "g", gameName: "Game", title: "", viewers: 1 };
    (live as unknown as { segments: unknown }).segments = {
        start() {},
        async stop() {},
        async waitForFirstPoll() {},
        healthy: segmentsHealthy,
    };
    return live;
}

/** The channel page, carrying a Spade URL or not. */
function page(html: string) {
    const fetchMock = vi.fn(async () => ({ text: async () => html }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

const WITH_SPADE = '<script>{"spade_url": "https://spade.example/track"}</script>';

describe("Channel.sendWatch", () => {
    beforeEach(() => {
        requestMock.mockReset();
        requestMock.mockResolvedValue({ statusCode: 204, body: { dump: async () => {} } });
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("does not count a beat Spade accepted when no segments are being fetched", async () => {
        // Spade says 204 whether or not anything is earned; segments are what Twitch credits.
        page(WITH_SPADE);
        expect(await channel(false).sendWatch()).toBe(false);
        expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it("counts a beat on segment health alone", async () => {
        page("<html>no spade here</html>");
        expect(await channel(true).sendWatch()).toBe(true);
    });

    it("stops fetching the channel page every beat once the Spade URL is not on it", async () => {
        const fetchMock = page("<html>no spade here</html>");
        const live = channel(true);

        for (let beat = 0; beat < 5; beat += 1) {
            await live.sendWatch();
        }

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("looks again once a new broadcast starts", async () => {
        const fetchMock = page("<html>no spade here</html>");
        const live = channel(true);
        await live.sendWatch();

        live.markOffline();
        live.stream = { broadcastId: "b2", gameId: "g", gameName: "Game", title: "", viewers: 1 };
        await live.sendWatch();

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
