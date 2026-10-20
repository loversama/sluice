import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("undici", () => ({ request: requestMock }));

// Imported after the mock so AuthState picks up the stub.
const { AuthState } = await import("../packages/core/src/twitch/auth.js");
const { OAUTH_TOKEN_URL, OAUTH_VALIDATE_URL } = await import(
    "../packages/core/src/twitch/constants.js"
);

function reply(statusCode: number, body: unknown = {}) {
    return {
        statusCode,
        headers: {},
        body: {
            json: async () => body,
            text: async () => JSON.stringify(body),
            dump: async () => {},
        },
    };
}

/** Twitch's token endpoint, rotating both tokens on every successful refresh. */
function twitch(options: { refreshStatus?: number } = {}) {
    let issued = 0;
    requestMock.mockImplementation(async (url: string) => {
        if (url === OAUTH_TOKEN_URL) {
            // A real refresh is slow enough for other requests to fail in the meantime.
            await new Promise((r) => setTimeout(r, 20));
            if (options.refreshStatus && options.refreshStatus !== 200) {
                return reply(options.refreshStatus);
            }
            issued += 1;
            return reply(200, {
                access_token: `access-${issued}`,
                refresh_token: `refresh-${issued}`,
            });
        }
        if (url === OAUTH_VALIDATE_URL) {
            return reply(200, { user_id: "42", login: "tester" });
        }
        throw new Error(`unexpected request to ${url}`);
    });
    return {
        get refreshes() {
            return requestMock.mock.calls.filter(([url]) => url === OAUTH_TOKEN_URL).length;
        },
    };
}

function signedIn() {
    const auth = new AuthState();
    auth.accessToken = "expired";
    auth.refreshToken = "refresh-0";
    auth.userId = "42";
    auth.login = "tester";
    return auth;
}

describe("token refresh", () => {
    beforeEach(() => {
        requestMock.mockReset();
    });

    it("spends the refresh token once however many requests fail at the same time", async () => {
        // Twitch rotates the refresh token on use, so a second concurrent refresh would
        // present one that had just been spent.
        const endpoint = twitch();
        const auth = signedIn();

        const results = await Promise.all([auth.refresh(), auth.refresh(), auth.refresh()]);

        expect(results).toEqual([true, true, true]);
        expect(endpoint.refreshes).toBe(1);
        expect(auth.accessToken).toBe("access-1");
        expect(auth.refreshToken).toBe("refresh-1");
    });

    it("refreshes again once the previous refresh has finished", async () => {
        const endpoint = twitch();
        const auth = signedIn();

        await auth.refresh();
        await auth.refresh();

        expect(endpoint.refreshes).toBe(2);
        expect(auth.refreshToken).toBe("refresh-2");
    });

    it("hands the new tokens over to be saved", async () => {
        // Held only in memory, the next restart loaded the spent pair from disk.
        twitch();
        const auth = signedIn();
        const path = join(await mkdtemp(join(tmpdir(), "sluice-refresh-")), "auth.json");
        auth.onRefreshed = () => auth.save(path);

        await auth.refresh();

        const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
        expect(saved["accessToken"]).toBe("access-1");
        expect(saved["refreshToken"]).toBe("refresh-1");
    });

    it("saves nothing when Twitch refuses the refresh", async () => {
        twitch({ refreshStatus: 400 });
        const auth = signedIn();
        const saved = vi.fn();
        auth.onRefreshed = saved;

        expect(await auth.refresh()).toBe(false);
        expect(saved).not.toHaveBeenCalled();
        expect(auth.refreshToken).toBe("refresh-0");
    });

    it("reports a network failure as a failed refresh rather than throwing", async () => {
        requestMock.mockRejectedValue(new Error("getaddrinfo EAI_AGAIN id.twitch.tv"));
        const auth = signedIn();

        expect(await auth.refresh()).toBe(false);
    });

    it("does not save when the refresh fails to validate", async () => {
        twitch();
        requestMock.mockImplementation(async (url: string) =>
            url === OAUTH_TOKEN_URL
                ? reply(200, { access_token: "a", refresh_token: "r" })
                : reply(401),
        );
        const auth = signedIn();
        const saved = vi.fn();
        auth.onRefreshed = saved;

        expect(await auth.refresh()).toBe(false);
        expect(saved).not.toHaveBeenCalled();
    });
});
