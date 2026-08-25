import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { SteamLibrary } from "../src/steam/library.js";
import type { LibraryProvider, LibrarySnapshot } from "../src/steam/provider.js";
import type { OwnedGame } from "../src/steam/client.js";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("undici", () => ({ request: requestMock }));

// Imported after the mock so the provider picks up the stub.
const { SinfulShadowsProvider, LibraryError } = await import("../src/steam/provider.js");

function game(partial: Partial<OwnedGame> & { name: string }): OwnedGame {
    return {
        appid: 1,
        playtimeForever: 0,
        playtimeRecent: 0,
        lastPlayed: 0,
        ...partial,
    };
}

function providerReturning(snapshot: Partial<LibrarySnapshot>): LibraryProvider {
    return {
        label: "test",
        fetchLibrary: async () => ({
            steamId: "76561197971203314",
            personaName: "Nathan",
            fetchedAt: Date.now(),
            games: [],
            ...snapshot,
        }),
    };
}

function reply(statusCode: number, body: unknown) {
    return {
        statusCode,
        body: {
            json: async () => body,
            dump: async () => {},
        },
    };
}

describe("config migration", () => {
    it("defaults an existing config with no provider to the direct Steam key", async () => {
        const dir = await mkdtemp(join(tmpdir(), "tdb-"));
        const path = join(dir, "config.json");
        await writeFile(path, JSON.stringify({ steam: { apiKey: "abc", steamId: "123" } }));

        const config = await loadConfig(path);

        expect(config.steam.provider).toBe("direct");
        expect(config.steam.apiKey).toBe("abc");
        expect(config.steam.sinfulshadows.baseUrl).toBe("https://sinfulshadows.com");
    });
});

describe("SteamLibrary recency signal", () => {
    it("ranks on last-played when Steam supplied timestamps", async () => {
        const library = new SteamLibrary();
        await library.refresh(
            providerReturning({
                games: [
                    game({ appid: 1, name: "Rust", lastPlayed: 1_700_000_000, playtimeForever: 10 }),
                    game({ appid: 2, name: "Factorio", lastPlayed: 1_600_000_000, playtimeForever: 900 }),
                ],
            }),
        );

        expect(library.recencySignal).toBe("lastPlayed");
        expect(library.score("Rust", "recent")).toBeGreaterThan(library.score("Factorio", "recent"));
    });

    it("falls back to two-week playtime when no game has a last-played time", async () => {
        // What a library read through a shared key looks like: Steam only fills in
        // rtime_last_played when the querying key belongs to the queried account.
        const library = new SteamLibrary();
        await library.refresh(
            providerReturning({
                games: [
                    game({ appid: 1, name: "Rust", playtimeRecent: 300, playtimeForever: 500 }),
                    game({ appid: 2, name: "Factorio", playtimeRecent: 10, playtimeForever: 9000 }),
                ],
            }),
        );

        expect(library.recencySignal).toBe("playtimeRecent");
        expect(library.score("Rust", "recent")).toBeGreaterThan(library.score("Factorio", "recent"));
    });

    it("falls back to total playtime when nothing has been played recently", async () => {
        const library = new SteamLibrary();
        await library.refresh(
            providerReturning({
                games: [
                    game({ appid: 1, name: "Rust", playtimeForever: 50 }),
                    game({ appid: 2, name: "Factorio", playtimeForever: 900 }),
                ],
            }),
        );

        expect(library.recencySignal).toBe("playtimeForever");
        expect(library.score("Factorio", "recent")).toBeGreaterThan(library.score("Rust", "recent"));
    });

    it("still ranks an owned but unplayed game above one that is not owned", async () => {
        const library = new SteamLibrary();
        await library.refresh(
            providerReturning({ games: [game({ appid: 1, name: "Rust" })] }),
        );

        expect(library.score("Rust", "recent")).toBeGreaterThan(0);
        expect(library.score("Some Unowned Game", "recent")).toBe(0);
    });

    it("keeps the provider's timestamp so cached data is not treated as a fresh sync", async () => {
        const library = new SteamLibrary();
        const anHourAgo = Date.now() - 3_600_000;
        await library.refresh(
            providerReturning({
                games: [game({ appid: 1, name: "Rust" })],
                fetchedAt: anHourAgo,
                stale: true,
            }),
        );

        expect(library.fetchedAt).toBe(anHourAgo);
        expect(library.stale).toBe(true);
    });
});

describe("SinfulShadowsProvider", () => {
    beforeEach(() => requestMock.mockReset());

    it("maps the proxy response onto owned games", async () => {
        requestMock.mockResolvedValue(
            reply(200, {
                steamId: "76561197971203314",
                personaName: "Nathan",
                fetchedAt: 1_700_000_000_000,
                stale: false,
                games: [
                    {
                        appid: 252490,
                        name: "Rust",
                        playtimeForever: 1200,
                        playtimeRecent: 60,
                        lastPlayed: 0,
                    },
                ],
            }),
        );

        const snapshot = await new SinfulShadowsProvider("ss_key").fetchLibrary();

        expect(snapshot.steamId).toBe("76561197971203314");
        expect(snapshot.games).toEqual([
            { appid: 252490, name: "Rust", playtimeForever: 1200, playtimeRecent: 60, lastPlayed: 0 },
        ]);
        expect(snapshot.fetchedAt).toBe(1_700_000_000_000);
    });

    it("sends the key as a bearer token and asks for no Steam ID", async () => {
        requestMock.mockResolvedValue(reply(200, { steamId: "1", games: [{ appid: 1, name: "Rust" }] }));
        await new SinfulShadowsProvider("ss_secret").fetchLibrary();

        const [url, options] = requestMock.mock.calls[0];
        expect(url).toBe("https://sinfulshadows.com/api/v1/steam/library");
        expect(options.headers.authorization).toBe("Bearer ss_secret");
        expect(url).not.toContain("steamid");
    });

    it("reports a revoked key distinctly, so it can be surfaced once", async () => {
        requestMock.mockResolvedValue(reply(401, { error: "key_invalid", message: "nope" }));

        await expect(new SinfulShadowsProvider("ss_key").fetchLibrary()).rejects.toMatchObject({
            code: "key_invalid",
        });
    });

    it("explains an unlinked Steam account with somewhere to go", async () => {
        requestMock.mockResolvedValue(
            reply(409, { error: "steam_not_linked", message: "not linked" }),
        );

        const error = await new SinfulShadowsProvider("ss_key").fetchLibrary().catch((e) => e);
        expect(error).toBeInstanceOf(LibraryError);
        expect(error.code).toBe("steam_not_linked");
        expect(error.actionUrl).toContain("/settings/connections");
    });

    it("passes a private library through as its own case", async () => {
        requestMock.mockResolvedValue(reply(409, { error: "library_private", message: "private" }));
        await expect(new SinfulShadowsProvider("ss_key").fetchLibrary()).rejects.toMatchObject({
            code: "library_private",
        });
    });

    it("treats being rate limited as retryable rather than fatal", async () => {
        requestMock.mockResolvedValue(reply(429, { error: "rate_limited", message: "slow down" }));
        await expect(new SinfulShadowsProvider("ss_key").fetchLibrary()).rejects.toMatchObject({
            code: "rate_limited",
        });
    });

    it("reports an unreachable host rather than throwing a raw network error", async () => {
        requestMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

        await expect(new SinfulShadowsProvider("ss_key").fetchLibrary()).rejects.toMatchObject({
            code: "unavailable",
        });
    });

    it("treats a server error as unavailable rather than a bad key", async () => {
        requestMock.mockResolvedValue(reply(500, { message: "boom" }));
        await expect(new SinfulShadowsProvider("ss_key").fetchLibrary()).rejects.toMatchObject({
            code: "unavailable",
        });
    });

    it("honours a custom base URL", async () => {
        requestMock.mockResolvedValue(reply(200, { steamId: "1", games: [{ appid: 1, name: "Rust" }] }));
        await new SinfulShadowsProvider("ss_key", "http://localhost:5174/").fetchLibrary();
        expect(requestMock.mock.calls[0][0]).toBe("http://localhost:5174/api/v1/steam/library");
    });

    it("verifies a key without fetching the library", async () => {
        requestMock.mockResolvedValue(
            reply(200, { userId: 7, scopes: [], steam: { linked: true, personaName: "Nathan" } }),
        );

        await expect(new SinfulShadowsProvider("ss_key").verify()).resolves.toEqual({
            userId: 7,
            steamLinked: true,
            personaName: "Nathan",
        });
        expect(requestMock.mock.calls[0][0]).toContain("/api/v1/me");
    });
});

describe("SteamLibrary.load isolation between accounts", () => {
    async function loadedLibrary(): Promise<SteamLibrary> {
        const library = new SteamLibrary();
        await library.refresh(
            providerReturning({
                steamId: "111",
                personaName: "UserA",
                games: [
                    game({ appid: 1, name: "Rust", playtimeForever: 500 }),
                    game({ appid: 2, name: "Factorio", playtimeForever: 900 }),
                ],
            }),
        );
        return library;
    }

    it("forgets the previous account when the new one has no cache", async () => {
        // Signing in as a second account whose library was never fetched must not inherit
        // the first account's games: they drive ownership gating and playtime ranking.
        const library = await loadedLibrary();
        expect(library.size).toBe(2);

        const missing = join(await mkdtemp(join(tmpdir(), "tdb-")), "steam.json");
        await expect(library.load(missing)).resolves.toBe(false);

        expect(library.size).toBe(0);
        expect(library.isLoaded).toBe(false);
        expect(library.owns("Rust")).toBe(false);
        expect(library.score("Rust", "playtime")).toBe(0);
        expect(library.steamId).toBe("");
        expect(library.personaName).toBe("");
    });

    it("forgets the previous account when the new cache is corrupt", async () => {
        const library = await loadedLibrary();
        const dir = await mkdtemp(join(tmpdir(), "tdb-"));
        const corrupt = join(dir, "steam.json");
        await writeFile(corrupt, "{ not json");

        await expect(library.load(corrupt)).resolves.toBe(false);
        expect(library.size).toBe(0);
    });

    it("does not answer from a stale match cache after clearing", async () => {
        const library = await loadedLibrary();
        // Prime the memoised matcher before the switch.
        expect(library.owns("Rust")).toBe(true);

        library.clear();

        expect(library.match("Rust")).toBeNull();
        expect(library.recencySignal).toBe("lastPlayed");
    });

    it("replaces one account's library with another's on a successful load", async () => {
        const library = await loadedLibrary();
        const dir = await mkdtemp(join(tmpdir(), "tdb-"));
        const path = join(dir, "steam.json");
        await writeFile(
            path,
            JSON.stringify({
                steamId: "222",
                personaName: "UserB",
                fetchedAt: 1_700_000_000_000,
                games: [game({ appid: 3, name: "Terraria", playtimeForever: 10 })],
            }),
        );

        await expect(library.load(path)).resolves.toBe(true);

        expect(library.personaName).toBe("UserB");
        expect(library.owns("Terraria")).toBe(true);
        expect(library.owns("Rust")).toBe(false);
        expect(library.size).toBe(1);
    });
});
