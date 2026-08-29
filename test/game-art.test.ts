import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GameArtCache, exactMatch, REFRESH_AFTER_MS } from "../packages/core/src/game-art.js";

/**
 * A game on the priority list with no campaign running had no poster, because every game the
 * dashboard knew about came from the campaigns it was holding. Star Citizen's art was never
 * missing - Twitch serves it perfectly well - we just never asked for it.
 */
describe("remembering box art for games we have no campaign for", () => {
    let dir: string;
    let path: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "sluice-art-"));
        path = join(dir, "game-art.json");
        vi.useFakeTimers();
    });
    afterEach(() => vi.useRealTimers());

    const art = (id: string, name: string) => ({ id, name, boxArtURL: `art/${id}.jpg`, at: Date.now() });

    it("looks a game up once and then answers from memory", async () => {
        const lookup = vi.fn(async (name: string) => art("71375", name));
        const cache = new GameArtCache(path, lookup);

        await cache.ensure(["Star Citizen"]);
        await cache.ensure(["Star Citizen"]);
        await cache.ensure(["star citizen"]); // the user's capitalisation is their own business

        expect(lookup).toHaveBeenCalledTimes(1);
        expect(cache.get("STAR CITIZEN")?.id).toBe("71375");
    });

    it("asks again once a day has passed", async () => {
        const lookup = vi.fn(async (name: string) => art("71375", name));
        const cache = new GameArtCache(path, lookup);

        await cache.ensure(["Star Citizen"]);
        vi.advanceTimersByTime(REFRESH_AFTER_MS - 1000);
        await cache.ensure(["Star Citizen"]);
        expect(lookup).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(2000);
        await cache.ensure(["Star Citizen"]);
        expect(lookup).toHaveBeenCalledTimes(2);
    });

    it("keeps showing the old poster while it is stale", async () => {
        // Blanking a row because its art is a day old would be a flicker for no gain.
        const cache = new GameArtCache(path, async (name) => art("71375", name));
        await cache.ensure(["Star Citizen"]);
        vi.advanceTimersByTime(REFRESH_AFTER_MS * 3);
        expect(cache.get("Star Citizen")?.id).toBe("71375");
    });

    it("stops asking for a game Twitch has never heard of", async () => {
        const lookup = vi.fn(async () => null);
        const cache = new GameArtCache(path, lookup);

        await cache.ensure(["Not A Real Game"]);
        await cache.ensure(["Not A Real Game"]);
        expect(lookup).toHaveBeenCalledTimes(1);

        // ...but tries again eventually, in case it simply did not exist yet.
        vi.advanceTimersByTime(REFRESH_AFTER_MS + 1000);
        await cache.ensure(["Not A Real Game"]);
        expect(lookup).toHaveBeenCalledTimes(2);
    });

    it("keeps what it had when a lookup fails", async () => {
        let fail = false;
        const cache = new GameArtCache(path, async (name) => {
            if (fail) throw new Error("Twitch is having a moment");
            return art("71375", name);
        });

        await cache.ensure(["Star Citizen"]);
        fail = true;
        vi.advanceTimersByTime(REFRESH_AFTER_MS + 1000);
        await expect(cache.ensure(["Star Citizen"])).resolves.toBeUndefined();
        expect(cache.get("Star Citizen")?.id).toBe("71375");
    });

    it("survives a restart", async () => {
        const first = new GameArtCache(path, async (name) => art("71375", name));
        await first.ensure(["Star Citizen"]);

        const lookup = vi.fn(async (name: string) => art("71375", name));
        const second = new GameArtCache(path, lookup);
        await second.load();

        expect(second.get("Star Citizen")?.id).toBe("71375");
        await second.ensure(["Star Citizen"]);
        expect(lookup).not.toHaveBeenCalled();
    });

    it("starts empty rather than failing when the file is corrupt", async () => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, "{ this is not json");
        const cache = new GameArtCache(path, async (name) => art("1", name));
        await expect(cache.load()).resolves.toBeUndefined();
        expect(cache.get("Star Citizen")).toBeNull();
    });

    it("hands the dashboard a lookup keyed by name", async () => {
        const cache = new GameArtCache(path, async (name) => art("71375", name));
        await cache.ensure(["Star Citizen"]);
        expect(cache.toRecord()["star citizen"]).toMatchObject({ id: "71375" });
    });

    it("writes the cache where it can be read back", async () => {
        const cache = new GameArtCache(path, async (name) => art("71375", name));
        await cache.ensure(["Star Citizen"]);
        expect(JSON.parse(await readFile(path, "utf8"))["star citizen"].id).toBe("71375");
    });
});

describe("picking the right category out of a search", () => {
    const results = [
        { id: "1", name: "Rust Console Edition", boxArtURL: "a.jpg" },
        { id: "263490", name: "Rust", boxArtURL: "b.jpg" },
    ];

    it("takes the exact name, not the first result", () => {
        // Hanging "Rust Console Edition" art on the Rust row is worse than leaving it blank.
        expect(exactMatch("Rust", results)?.id).toBe("263490");
    });

    it("ignores case and stray spacing", () => {
        expect(exactMatch("  rUsT ", results)?.id).toBe("263490");
    });

    it("returns nothing when only near-misses come back", () => {
        expect(exactMatch("Rustt", results)).toBeNull();
    });
});
