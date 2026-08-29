import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../packages/core/src/config.js";
import { isMasked, maskConfig } from "../packages/core/src/api/serialize.js";

async function tempConfig(contents: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "tdb-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify(contents));
    return path;
}

describe("loadConfig", () => {
    it("fills in defaults for keys a stored config omits", async () => {
        const config = await loadConfig(await tempConfig({ priorityGames: ["Rust"] }));
        expect(config.priorityGames).toEqual(["Rust"]);
        expect(config.priorityMode).toBe(DEFAULT_CONFIG.priorityMode);
        expect(config.unlinkedPolicy).toBe("mine");
        expect(config.blockedChannels).toEqual([]);
    });

    it("migrates the retired mineUnlistedGames flag", async () => {
        const config = await loadConfig(await tempConfig({ mineUnlistedGames: false }));
        expect(config.priorityMode).toBe("priority_only");
        expect(config.mineUnlistedGames).toBeUndefined();
    });

    it("leaves priorityMode alone when both are present", async () => {
        const config = await loadConfig(
            await tempConfig({ mineUnlistedGames: false, priorityMode: "random" }),
        );
        expect(config.priorityMode).toBe("random");
    });

    it("clamps a refresh interval that would risk rate limiting", async () => {
        const config = await loadConfig(await tempConfig({ campaignRefreshMinutes: 1 }));
        expect(config.campaignRefreshMinutes).toBe(5);
    });

    it("round-trips through save and load", async () => {
        const path = await tempConfig({});
        const original = { ...DEFAULT_CONFIG, priorityGames: ["A", "B"], unlinkedPolicy: "skip" as const };
        await saveConfig(path, original);
        const loaded = await loadConfig(path);
        expect(loaded.priorityGames).toEqual(["A", "B"]);
        expect(loaded.unlinkedPolicy).toBe("skip");
    });
});

/**
 * Steam used to be reached with a key the user supplied - their own Steam Web API key, or
 * one from sinfulshadows.com. It is a broker now and there is no key at all, so every one
 * of these is somebody's working install being carried across a change they did not ask
 * for. Nobody should lose their library, and nobody should have to do anything.
 */
describe("migrating a key-era Steam config", () => {
    /** What the config looked like when the user held their own Steam Web API key. */
    const DIRECT = {
        steam: {
            provider: "direct",
            apiKey: "STEAMKEY",
            steamId: "76561198000000000",
            sinfulshadows: { baseUrl: "https://sinfulshadows.com" },
            refreshHours: 24,
        },
    };

    /** What it looked like when sinfulshadows.com held the key and derived the account. */
    const BORROWED = {
        steam: {
            provider: "sinfulshadows",
            sinfulshadows: { apiKey: "ss_key", baseUrl: "https://sinfulshadows.com" },
            refreshHours: 24,
        },
    };

    it("keeps a direct key's account and throws the key away", async () => {
        const config = await loadConfig(await tempConfig(DIRECT));

        expect(config.steam.steamId).toBe("76561198000000000");
        expect(config.steam.linked).toBe("profile");
        // The key is gone from the object, so the next save takes it off disk too.
        expect(config.steam).not.toHaveProperty("apiKey");
        expect(config.steam).not.toHaveProperty("provider");
        expect(config.steam).not.toHaveProperty("sinfulshadows");
    });

    it("leaves a borrowed key's install unlinked, for app.ts to adopt from steam.json", async () => {
        // The Steam ID was never in this config: the site derived it from the linked
        // account, and the only copy on this machine is in the cached library.
        const config = await loadConfig(await tempConfig(BORROWED));

        expect(config.steam.linked).toBeNull();
        expect(config.steam.steamId).toBeUndefined();
        expect(config.steam).not.toHaveProperty("sinfulshadows");
    });

    it("keeps a base URL somebody pointed at a local backend", async () => {
        const config = await loadConfig(
            await tempConfig({
                steam: { provider: "sinfulshadows", sinfulshadows: { apiKey: "ss_key", baseUrl: "http://localhost:5174" } },
            }),
        );

        expect(config.steam.brokerBaseUrl).toBe("http://localhost:5174");
    });

    it("asks a config with neither key, so onboarding shows", async () => {
        const config = await loadConfig(await tempConfig({ priorityGames: ["Rust"] }));

        expect(config.steam.linked).toBeNull();
        expect(config.steam.brokerBaseUrl).toBe("https://sinfulshadows.com");
    });

    it("does not re-ask somebody who has already declined", async () => {
        const config = await loadConfig(await tempConfig({ steam: { linked: "skipped" } }));
        expect(config.steam.linked).toBe("skipped");
    });

    it("does not invent a link from a key that never named an account", async () => {
        // A key pasted and never connected identifies nothing, so there is nothing to keep.
        const config = await loadConfig(
            await tempConfig({ steam: { provider: "direct", apiKey: "STEAMKEY" } }),
        );

        expect(config.steam.linked).toBeNull();
        expect(config.steam.steamId).toBeUndefined();
    });

    it("survives a round trip, leaving no key behind on disk", async () => {
        const path = await tempConfig(DIRECT);
        const migrated = await loadConfig(path);
        await saveConfig(path, migrated);

        const { readFile } = await import("node:fs/promises");
        expect(await readFile(path, "utf8")).not.toContain("STEAMKEY");
        expect((await loadConfig(path)).steam.linked).toBe("profile");
    });
});

describe("secret masking", () => {
    it("masks secrets but keeps non-secret fields readable", () => {
        const masked = maskConfig({
            ...DEFAULT_CONFIG,
            steam: { linked: "profile", refreshHours: 24, brokerBaseUrl: "https://sinfulshadows.com", steamId: "76561198000000000" },
            notifications: {
                telegram: { botToken: "REALTOKEN", chatId: "12345" },
                discord: { webhookUrl: "https://discord.com/api/webhooks/real" },
            },
        });
        expect(masked.notifications.telegram?.botToken).toBe("********");
        expect(masked.notifications.discord?.webhookUrl).toBe("********");
        // Not secrets - the UI needs to show these. A Steam ID names a public profile, and
        // there is no longer any Steam credential to mask.
        expect(masked.steam.steamId).toBe("76561198000000000");
        expect(masked.steam.linked).toBe("profile");
        expect(masked.notifications.telegram?.chatId).toBe("12345");
    });

    it("recognises the mask so a resubmitted value is never stored verbatim", () => {
        // The failure this guards: writing "********" to disk as if it were a real token.
        expect(isMasked("********")).toBe(true);
        expect(isMasked("REALKEY")).toBe(false);
        expect(isMasked(undefined)).toBe(false);
    });
});

describe("category-change switching", () => {
    it("stays off unless asked for, so the stall watchdog remains the default", async () => {
        const config = await loadConfig(await tempConfig({ priorityGames: [] }));
        expect(config.switchOnCategoryChange).toBe(false);
    });

    it("honours an explicit opt-in", async () => {
        const config = await loadConfig(await tempConfig({ switchOnCategoryChange: true }));
        expect(config.switchOnCategoryChange).toBe(true);
    });
});

describe("a corrupt config file", () => {
    it("starts from defaults instead of refusing to boot", async () => {
        // A machine that lost power mid-save used to leave the daemon unable to start at
        // all - and on the desktop build that would be a window that never appears.
        const dir = await mkdtemp(join(tmpdir(), "tdb-"));
        const path = join(dir, "config.json");
        await writeFile(path, '{"priorityGames": ["Rust"');

        const config = await loadConfig(path);

        expect(config.priorityMode).toBe(DEFAULT_CONFIG.priorityMode);
        expect(config.priorityGames).toEqual([]);
    });

    it("sets the unreadable file aside rather than destroying it", async () => {
        const dir = await mkdtemp(join(tmpdir(), "tdb-"));
        const path = join(dir, "config.json");
        await writeFile(path, "{ broken");

        await loadConfig(path);

        const { readdir } = await import("node:fs/promises");
        const left = await readdir(dir);
        expect(left.some((name) => name.startsWith("config.json.corrupt-"))).toBe(true);
    });
});
