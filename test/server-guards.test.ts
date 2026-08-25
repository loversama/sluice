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

describe("listen", () => {
    /** The bare minimum an ApiServer needs to answer at all. */
    function context() {
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
            searchGames: async () => [],
            connectSteam: async () => 0,
            logout: async () => ({ revoked: true }),
            refreshSteam: async () => 0,
            disconnectSteam: async () => {},
        };
    }

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
