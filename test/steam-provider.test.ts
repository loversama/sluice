import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SteamLibrary } from "../packages/core/src/steam/library.js";
import type { LibraryProvider, LibrarySnapshot } from "../packages/core/src/steam/provider.js";
import type { OwnedGame } from "../packages/core/src/steam/client.js";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("undici", () => ({ request: requestMock }));

// Imported after the mock so the provider picks up the stub.
const { BrokerProvider, LibraryError } = await import("../packages/core/src/steam/provider.js");

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

function reply(
    statusCode: number,
    body: unknown,
    headers: Record<string, string> = {},
) {
    return {
        statusCode,
        headers,
        body: {
            json: async () => body,
            dump: async () => {},
        },
    };
}

const STEAM_ID = "76561197971203314";

describe("SteamLibrary recency signal", () => {
    it("ranks on last-played when Steam supplied timestamps", async () => {
        // Reachable only from a library cached back when the user held their own key, which
        // keeps ranking on real dates until the next refresh replaces it. The branch is
        // live, not dead.
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
        // The normal case, not an edge one: Steam fills in rtime_last_played only for a key
        // that owns the account being read, and the broker's key never does. Every freshly
        // read library looks like this.
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

describe("BrokerProvider", () => {
    beforeEach(() => requestMock.mockReset());

    it("maps the broker's library response onto owned games", async () => {
        requestMock.mockResolvedValue(
            reply(200, {
                steamId: STEAM_ID,
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

        const snapshot = await new BrokerProvider(STEAM_ID).fetchLibrary();

        expect(snapshot.steamId).toBe(STEAM_ID);
        expect(snapshot.personaName).toBe("Nathan");
        expect(snapshot.games).toEqual([
            { appid: 252490, name: "Rust", playtimeForever: 1200, playtimeRecent: 60, lastPlayed: 0 },
        ]);
        expect(snapshot.fetchedAt).toBe(1_700_000_000_000);
    });

    it("names the account in the query and the build in the header", async () => {
        requestMock.mockResolvedValue(
            reply(200, { steamId: STEAM_ID, games: [{ appid: 1, name: "Rust" }] }),
        );
        await new BrokerProvider(STEAM_ID, undefined, "slc_test").fetchLibrary();

        const [url, options] = requestMock.mock.calls[0];
        expect(url).toBe(
            `https://sinfulshadows.com/api/v1/sluice/steam/library?steamId=${STEAM_ID}`,
        );
        expect(options.headers["X-Sluice-Client"]).toBe("slc_test");
        // Nothing else identifies the caller: there is no key of the user's to send.
        expect(options.headers.authorization).toBeUndefined();
    });

    it("reads a summary without touching the library", async () => {
        requestMock.mockResolvedValue(
            reply(200, {
                steamId: STEAM_ID,
                personaName: "Nathan",
                avatarUrl: "https://avatars.steamstatic.com/x.jpg",
                visible: true,
                fetchedAt: 1_700_000_000_000,
                stale: false,
            }),
        );

        const summary = await new BrokerProvider(STEAM_ID).fetchSummary();

        expect(requestMock.mock.calls[0][0]).toContain("/sluice/steam/summary?");
        expect(summary).toEqual({
            steamId: STEAM_ID,
            personaName: "Nathan",
            avatarUrl: "https://avatars.steamstatic.com/x.jpg",
            visible: true,
            fetchedAt: 1_700_000_000_000,
            stale: false,
        });
    });

    it("passes a private library through as its own case, with somewhere to go", async () => {
        requestMock.mockResolvedValue(
            reply(409, {
                error: "library_private",
                message: "Set 'Game details' to Public in your Steam privacy settings.",
            }),
        );

        const error = await new BrokerProvider(STEAM_ID).fetchLibrary().catch((e) => e);
        expect(error).toBeInstanceOf(LibraryError);
        expect(error.code).toBe("library_private");
        // The broker names the exact setting; paraphrasing it here would lose that.
        expect(error.message).toContain("Game details");
        expect(error.actionUrl).toContain("steamcommunity.com");
    });

    it("treats an empty library as private rather than as owning nothing", async () => {
        // Steam answers a private profile with an empty list, not an error, so a library of
        // zero games is never worth reporting as one.
        requestMock.mockResolvedValue(reply(200, { steamId: STEAM_ID, games: [] }));

        await expect(new BrokerProvider(STEAM_ID).fetchLibrary()).rejects.toMatchObject({
            code: "library_private",
        });
    });

    it("tells the user to update when the broker has stopped answering this build", async () => {
        requestMock.mockResolvedValue(reply(426, { error: "client_outdated", message: "old" }));

        const error = await new BrokerProvider(STEAM_ID).fetchLibrary().catch((e) => e);
        expect(error.code).toBe("client_outdated");
        expect(error.message).toMatch(/update/i);
    });

    it("treats an unrecognised token the same as an outdated one", async () => {
        // 401 and 426 differ only in whether the broker ever knew the token. Neither is
        // something the user can act on except by updating.
        requestMock.mockResolvedValue(
            reply(401, { error: "client_token_invalid", message: "unknown" }),
        );

        await expect(new BrokerProvider(STEAM_ID).fetchLibrary()).rejects.toMatchObject({
            code: "client_outdated",
        });
    });

    it("takes the wait from the Retry-After header, not the body", async () => {
        // A proxy in between can rewrite one without the other, and the header is the one
        // that governs.
        requestMock.mockResolvedValue(
            reply(429, { error: "rate_limited", message: "slow down", retryAfter: 9999 }, {
                "retry-after": "42",
            }),
        );

        const error = await new BrokerProvider(STEAM_ID).fetchLibrary().catch((e) => e);
        expect(error.code).toBe("rate_limited");
        expect(error.retryAfterSeconds).toBe(42);
    });

    it("calls a deleted account its own thing, so it is not retried forever", async () => {
        // A 404 is permanent where every other failure here is transient. Mapped to
        // "unavailable" it would leave a renamed or deleted profile behind "Steam is
        // unavailable" indefinitely, with the library silently never updating again.
        requestMock.mockResolvedValue(
            reply(404, { error: "steam_profile_not_found", message: "no such profile" }),
        );

        const error = await new BrokerProvider(STEAM_ID).fetchLibrary().catch((e) => e);
        expect(error.code).toBe("profile_not_found");
        expect(error.message).toMatch(/link your steam account again/i);
    });

    it("leaves a malformed Steam ID as an ordinary outage", async () => {
        // IDs are validated before they are stored, so a 400 after linking is our bug and
        // not something to put in front of the user as an action.
        requestMock.mockResolvedValue(
            reply(400, { error: "invalid_steam_id", message: "not a SteamID64" }),
        );

        await expect(new BrokerProvider(STEAM_ID).fetchLibrary()).rejects.toMatchObject({
            code: "unavailable",
        });
    });

    it("treats a rationed Steam allowance as unavailable, not as the user's fault", async () => {
        // The broker sheds our traffic when the Steam allowance it shares with the rest of
        // the site runs low. Nothing is wrong with the account, the profile or the link,
        // and the broker's own message is written for its logs rather than for a user.
        requestMock.mockResolvedValue(
            reply(503, { error: "steam_budget_low", message: "daily budget exhausted" }, {
                "retry-after": "600",
            }),
        );

        const error = await new BrokerProvider(STEAM_ID).fetchLibrary().catch((e) => e);
        expect(error.code).toBe("unavailable");
        expect(error.retryAfterSeconds).toBe(600);
        expect(error.message).toMatch(/refresh on its own/i);
        // Nothing that could read as something to go and fix.
        expect(error.message).not.toMatch(/private|budget|profile|key/i);
    });

    it("reports the broker being down as retryable", async () => {
        requestMock.mockResolvedValue(
            reply(503, { error: "steam_unavailable", message: "Steam is unreachable." }, {
                "retry-after": "600",
            }),
        );

        const error = await new BrokerProvider(STEAM_ID).fetchLibrary().catch((e) => e);
        expect(error.code).toBe("unavailable");
        expect(error.retryAfterSeconds).toBe(600);
    });

    it("reports an unreachable host rather than throwing a raw network error", async () => {
        requestMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

        await expect(new BrokerProvider(STEAM_ID).fetchLibrary()).rejects.toMatchObject({
            code: "unavailable",
        });
    });

    it("keeps the broker's own timestamp when it served a cached copy", async () => {
        // Stale means real data that is merely old - Steam unreachable, or the broker
        // rationing a shared allowance; the two are not told apart and neither is a
        // failure. Stamping it with "now" would rest on it for a full refresh interval
        // instead of trying again sooner.
        const anHourAgo = Date.now() - 3_600_000;
        requestMock.mockResolvedValue(
            reply(200, {
                steamId: STEAM_ID,
                personaName: "Nathan",
                fetchedAt: anHourAgo,
                stale: true,
                games: [{ appid: 1, name: "Rust" }],
            }),
        );

        const snapshot = await new BrokerProvider(STEAM_ID).fetchLibrary();
        expect(snapshot.fetchedAt).toBe(anHourAgo);
        expect(snapshot.stale).toBe(true);
    });

    it("serves a rationed library from cache as an ordinary success", async () => {
        // With something cached, shedding never reaches us as an error at all: it arrives
        // as a 200 marked stale, and must behave like any other stale copy.
        requestMock.mockResolvedValue(
            reply(200, {
                steamId: STEAM_ID,
                personaName: "Nathan",
                fetchedAt: 1_700_000_000_000,
                stale: true,
                games: [{ appid: 1, name: "Rust" }],
            }),
        );

        const snapshot = await new BrokerProvider(STEAM_ID).fetchLibrary();
        expect(snapshot.stale).toBe(true);
        expect(snapshot.games).toHaveLength(1);
    });

    it("honours a custom base URL", async () => {
        requestMock.mockResolvedValue(
            reply(200, { steamId: STEAM_ID, games: [{ appid: 1, name: "Rust" }] }),
        );
        await new BrokerProvider(STEAM_ID, "http://localhost:5174/").fetchLibrary();
        expect(requestMock.mock.calls[0][0]).toBe(
            `http://localhost:5174/api/v1/sluice/steam/library?steamId=${STEAM_ID}`,
        );
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
