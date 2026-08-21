import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/config.js";
import { isMasked, maskConfig } from "../src/api/serialize.js";

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

describe("secret masking", () => {
    it("masks secrets but keeps non-secret fields readable", () => {
        const masked = maskConfig({
            ...DEFAULT_CONFIG,
            steam: { refreshHours: 24, apiKey: "REALKEY", steamId: "76561198000000000" },
            notifications: {
                telegram: { botToken: "REALTOKEN", chatId: "12345" },
                discord: { webhookUrl: "https://discord.com/api/webhooks/real" },
            },
        });
        expect(masked.steam.apiKey).toBe("********");
        expect(masked.notifications.telegram?.botToken).toBe("********");
        expect(masked.notifications.discord?.webhookUrl).toBe("********");
        // Not secrets - the UI needs to show these.
        expect(masked.steam.steamId).toBe("76561198000000000");
        expect(masked.notifications.telegram?.chatId).toBe("12345");
    });

    it("does not invent a mask where no secret is stored", () => {
        const masked = maskConfig(DEFAULT_CONFIG);
        expect(masked.steam.apiKey).toBe("");
        expect(isMasked(masked.steam.apiKey)).toBe(false);
    });

    it("recognises the mask so a resubmitted value is never stored verbatim", () => {
        // The failure this guards: writing "********" to disk as if it were a real key.
        expect(isMasked("********")).toBe(true);
        expect(isMasked("REALKEY")).toBe(false);
        expect(isMasked(undefined)).toBe(false);
    });
});
