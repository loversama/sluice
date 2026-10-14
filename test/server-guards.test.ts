import { describe, expect, it } from "vitest";

import { ApiServer, hostnameOf, isCrossOrigin, isKnownHost } from "../packages/server/src/server.js";
import { DEFAULT_CONFIG } from "../packages/core/src/config.js";

const local = { boundHost: "127.0.0.1", allowedHosts: [] as string[] };

describe("hostnameOf", () => {
    it("drops the port", () => {
        expect(hostnameOf("127.0.0.1:4400")).toBe("127.0.0.1");
    });

    it("keeps a bracketed IPv6 address intact", () => {
        expect(hostnameOf("[::1]:4400")).toBe("[::1]");
    });

    it("is case-insensitive", () => {
        expect(hostnameOf("LocalHost:4400")).toBe("localhost");
    });
});

describe("isKnownHost", () => {
    it("accepts the loopback names a browser really uses", () => {
        for (const host of ["localhost:4400", "127.0.0.1:4400", "[::1]:4400"]) {
            expect(isKnownHost(host, local)).toBe(true);
        }
    });

    it("refuses a domain pointed at us by someone else", () => {
        // The DNS-rebinding case: the attacker's domain resolves to 127.0.0.1, so the
        // request arrives here, but the Host header still names their domain.
        expect(isKnownHost("evil.example:4400", local)).toBe(false);
    });

    it("refuses a request with no Host at all", () => {
        expect(isKnownHost(undefined, local)).toBe(false);
    });

    it("accepts the address it was told to bind", () => {
        expect(isKnownHost("192.168.1.50:4400", { boundHost: "192.168.1.50", allowedHosts: [] }))
            .toBe(true);
    });

    it("accepts any bare IP address, which DNS rebinding cannot produce", () => {
        for (const host of ["192.168.1.50:4400", "10.0.0.7", "100.109.244.82:4400", "[fe80::1]:4400"]) {
            expect(isKnownHost(host, local)).toBe(true);
        }
    });

    it("still refuses a name that merely looks numeric", () => {
        expect(isKnownHost("192.168.1.50.evil.example:4400", local)).toBe(false);
        expect(isKnownHost("1.2.3.4.nip.io", local)).toBe(false);
    });

    it("accepts a hostname the user added for a reverse proxy", () => {
        expect(
            isKnownHost("drops.example.com", {
                boundHost: "127.0.0.1",
                allowedHosts: [" Drops.Example.com "],
            }),
        ).toBe(true);
    });
});

describe("isCrossOrigin", () => {
    it("treats a missing Origin as not from a page", () => {
        // curl and the CLI send none, and a browser cannot suppress it.
        expect(isCrossOrigin(undefined, "127.0.0.1:4400")).toBe(false);
    });

    it("allows the dashboard talking to itself", () => {
        expect(isCrossOrigin("http://127.0.0.1:4400", "127.0.0.1:4400")).toBe(false);
    });

    it("catches a hostile page posting to us", () => {
        // A plain form post needs no preflight, so this is reachable from any site.
        expect(isCrossOrigin("https://evil.example", "127.0.0.1:4400")).toBe(true);
    });

    it("catches a differing port on the same host", () => {
        expect(isCrossOrigin("http://127.0.0.1:9999", "127.0.0.1:4400")).toBe(true);
    });

    it("treats an opaque origin as cross-origin", () => {
        expect(isCrossOrigin("null", "127.0.0.1:4400")).toBe(true);
    });

    it("treats an unparseable Origin as cross-origin", () => {
        expect(isCrossOrigin("not a url", "127.0.0.1:4400")).toBe(true);
    });
});

/** The bare minimum an ApiServer needs to answer at all. */
function context(overrides: Record<string, unknown> = {}) {
    const { EventEmitter } = require("node:events") as typeof import("node:events");
    return {
        auth: {} as never,
        version: "test",
        startedAt: Date.now(),
        bus: new EventEmitter(),
        getAuthStatus: () => "pending" as const,
        getDeviceCode: () => null,
        getMiner: () => null,
        getConfig: () => DEFAULT_CONFIG,
        setConfig: async () => {},
        getNotifier: () => ({ send: async () => {} }) as never,
        getSteamLibrary: () => null,
        getSteamState: () => ({
            linked: null,
            steamId: null,
            personaName: null,
            gameCount: 0,
            recencySignal: null,
            stale: false,
            fetchedAt: null,
            lastError: null,
        }),
        searchGames: async () => [],
        connectSteam: async () => ({ personaName: "", gameCount: 0, error: null }),
        skipSteam: async () => {},
        logout: async () => ({ revoked: true }),
        refreshSteam: async () => 0,
        disconnectSteam: async () => {},
        ...overrides,
    };
}

describe("listen", () => {
    it("reports the port it was actually given", async () => {
        // The desktop build asks for 0 so the OS picks a free one - which is what keeps it
        // from colliding with a running container - and then has to know where to point a
        // window. Returning void made that impossible.
        const server = new ApiServer(context() as never, "/nonexistent");
        const port = await server.listen("127.0.0.1", 0);
        try {
            expect(port).toBeGreaterThan(0);
            expect(port).not.toBe(0);
        } finally {
            server.close();
        }
    });

    it("gives out a different port each time, so two copies can coexist", async () => {
        const a = new ApiServer(context() as never, "/nonexistent");
        const b = new ApiServer(context() as never, "/nonexistent");
        const portA = await a.listen("127.0.0.1", 0);
        const portB = await b.listen("127.0.0.1", 0);
        try {
            expect(portA).not.toBe(portB);
        } finally {
            a.close();
            b.close();
        }
    });
});

/**
 * Steam is keyless now: the user supplies an account, never a credential. These pin the
 * shape the dashboard reads and the one thing about the sign-in round trip that is not
 * obvious - that it must not end in a redirect.
 */
describe("the Steam routes", () => {
    /** Stand the server up on a free port and hand back a fetch bound to it. */
    async function serving(overrides: Record<string, unknown> = {}) {
        const server = new ApiServer(context(overrides) as never, "/nonexistent");
        const port = await server.listen("127.0.0.1", 0);
        return {
            server,
            get: (path: string) => fetch(`http://127.0.0.1:${port}${path}`),
            post: (path: string, body?: unknown) =>
                fetch(`http://127.0.0.1:${port}${path}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body ?? {}),
                }),
        };
    }

    it("reports link state rather than whether a key is stored", async () => {
        const { server, get } = await serving({
            getSteamState: () => ({
                linked: "openid",
                steamId: "76561197971203314",
                personaName: "Nathan",
                gameCount: 412,
                recencySignal: "playtimeRecent",
                stale: false,
                fetchedAt: "2026-08-29T00:00:00.000Z",
                lastError: null,
            }),
        });
        try {
            const body = await (await get("/api/steam")).json();
            expect(body).toEqual({
                linked: "openid",
                steamId: "76561197971203314",
                personaName: "Nathan",
                gameCount: 412,
                recencySignal: "playtimeRecent",
                stale: false,
                fetchedAt: "2026-08-29T00:00:00.000Z",
                lastError: null,
            });
            // The old shape leaked whether a key was held; there is no key any more.
            expect(body).not.toHaveProperty("hasApiKey");
            expect(body).not.toHaveProperty("provider");
        } finally {
            server.close();
        }
    });

    it("records a skip, so the daemon remembers it rather than the browser", async () => {
        let skipped = false;
        const { server, post } = await serving({
            skipSteam: async () => {
                skipped = true;
            },
        });
        try {
            expect((await post("/api/steam/skip")).status).toBe(200);
            expect(skipped).toBe(true);
        } finally {
            server.close();
        }
    });

    it("takes a Steam ID and nothing else on connect", async () => {
        let seen: unknown = null;
        const { server, post } = await serving({
            connectSteam: async (input: unknown) => {
                seen = input;
                return { personaName: "Nathan", gameCount: 3, error: null };
            },
        });
        try {
            const body = await (await post("/api/steam/connect", {
                steamId: "https://steamcommunity.com/id/nathan",
                apiKey: "STEAMKEY",
            })).json();

            expect(seen).toEqual({ steamId: "https://steamcommunity.com/id/nathan", via: "profile" });
            expect(body).toMatchObject({ ok: true, personaName: "Nathan", gameCount: 3 });
        } finally {
            server.close();
        }
    });

    it("refuses a connect with no account named", async () => {
        const { server, post } = await serving();
        try {
            expect((await post("/api/steam/connect", { steamId: "  " })).status).toBe(400);
        } finally {
            server.close();
        }
    });

    it("answers the sign-in callback with a page, not a redirect", async () => {
        // This leg finishes in the user's own browser on the desktop build. Redirecting to
        // /#/settings opened a second dashboard there, connected to the same daemon.
        const { server, get } = await serving();
        try {
            const response = await get("/api/steam/callback");
            expect(response.status).toBe(400);
            expect(response.headers.get("location")).toBeNull();
            expect(response.headers.get("content-type")).toContain("text/html");
            expect(await response.text()).toContain("Close this tab");
        } finally {
            server.close();
        }
    });
});
