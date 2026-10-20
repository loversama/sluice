import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("undici", () => ({ request: requestMock }));

// Imported after the mock so the client picks up the stub.
const { TwitchGql, AuthExpiredError } = await import("../packages/core/src/twitch/gql.js");

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
});
