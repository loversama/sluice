import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("undici", () => ({ request: requestMock }));

// Imported after the mock so the client picks up the stub.
const { TwitchGql, AuthExpiredError, GqlError, retryAfterMs } = await import(
    "../packages/core/src/twitch/gql.js"
);

function reply(statusCode: number, body: unknown = {}, headers: Record<string, string> = {}) {
    return {
        statusCode,
        headers,
        body: {
            json: async () => body,
            text: async () => JSON.stringify(body),
            dump: async () => {},
        },
    };
}

const ok = () => reply(200, { data: { game: { slug: "a-game" } } });

/** Just enough of AuthState for the client: a token, headers, and a refresh to count. */
function fakeAuth(refresh: () => Promise<boolean> = async () => false) {
    const auth = {
        accessToken: "old",
        headers: () => ({}),
        refresh: vi.fn(refresh),
    };
    return auth;
}

describe("GQL retries", () => {
    beforeEach(() => {
        requestMock.mockReset();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("retries with a token someone else refreshed, without refreshing again", async () => {
        // Concurrent requests all fail with 401; whichever refreshes first rotates the
        // token, and the rest must not spend the new refresh token a second time.
        const auth = fakeAuth();
        requestMock
            .mockImplementationOnce(async () => {
                auth.accessToken = "new";
                return reply(401);
            })
            .mockResolvedValueOnce(ok());

        const result = new TwitchGql(auth as never).getGameSlug("A Game");
        await vi.runAllTimersAsync();

        expect(await result).toBe("a-game");
        expect(auth.refresh).not.toHaveBeenCalled();
    });

    it("refreshes once on a 401 and gives up if that does not help", async () => {
        const auth = fakeAuth(async () => false);
        requestMock.mockResolvedValue(reply(401));

        const result = new TwitchGql(auth as never).getGameSlug("A Game");
        const assertion = expect(result).rejects.toBeInstanceOf(AuthExpiredError);
        await vi.runAllTimersAsync();
        await assertion;

        expect(auth.refresh).toHaveBeenCalledTimes(1);
    });

    it("waits out a 429 and then succeeds", async () => {
        requestMock.mockResolvedValueOnce(reply(429, {}, { "retry-after": "5" })).mockResolvedValueOnce(ok());

        const result = new TwitchGql(fakeAuth() as never).getGameSlug("A Game");
        // Not before Twitch said to: the backoff alone would have retried at ~2s.
        await vi.advanceTimersByTimeAsync(4_000);
        expect(requestMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2_000);

        expect(await result).toBe("a-game");
        expect(requestMock).toHaveBeenCalledTimes(2);
    });

    it("gives up on a 429 that persists, after the usual number of attempts", async () => {
        requestMock.mockResolvedValue(reply(429, {}, { "retry-after": "1" }));

        const result = new TwitchGql(fakeAuth() as never).getGameSlug("A Game");
        const assertion = expect(result).rejects.toBeInstanceOf(GqlError);
        await vi.runAllTimersAsync();
        await assertion;

        expect(requestMock).toHaveBeenCalledTimes(4);
    });

    it("caps how long a Retry-After is honoured", async () => {
        requestMock
            .mockResolvedValueOnce(reply(429, {}, { "retry-after": "3600" }))
            .mockResolvedValueOnce(ok());

        const result = new TwitchGql(fakeAuth() as never).getGameSlug("A Game");
        await vi.advanceTimersByTimeAsync(70_000);

        expect(await result).toBe("a-game");
    });
});

describe("retryAfterMs", () => {
    it("reads seconds and HTTP dates, and ignores nonsense", () => {
        const now = Date.parse("2026-10-20T12:00:00Z");
        expect(retryAfterMs("7", now)).toBe(7_000);
        expect(retryAfterMs("Tue, 20 Oct 2026 12:00:30 GMT", now)).toBe(30_000);
        expect(retryAfterMs("soon", now)).toBe(0);
        expect(retryAfterMs(undefined, now)).toBe(0);
    });
});
