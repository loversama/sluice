import { describe, expect, it } from "vitest";

import {
    botFromUser,
    describeDiscordError,
    guildsFrom,
    textChannelsFrom,
} from "../packages/core/src/notifiers/discord-setup.js";
import { NotifierGroup } from "../packages/core/src/notifiers/index.js";
import { DEFAULT_CONFIG } from "../packages/core/src/config.js";

describe("textChannelsFrom", () => {
    it("keeps the channels a message can actually go to", () => {
        const payload = [
            { id: "1", name: "general", type: 0 },
            { id: "2", name: "announce", type: 5 },
        ];

        expect(textChannelsFrom(payload, "My Server")).toEqual([
            { id: "1", name: "general", guild: "My Server" },
            { id: "2", name: "announce", guild: "My Server" },
        ]);
    });

    it("drops everything a message cannot go to", () => {
        // Voice channels, categories, forums and stage channels all arrive in the same
        // list. Offering one means picking it and never seeing a notification again.
        const payload = [
            { id: "1", name: "Voice", type: 2 },
            { id: "2", name: "Category", type: 4 },
            { id: "3", name: "Forum", type: 15 },
            { id: "4", name: "Stage", type: 13 },
        ];

        expect(textChannelsFrom(payload, "My Server")).toEqual([]);
    });

    it("returns nothing rather than throwing on junk", () => {
        expect(textChannelsFrom(null, "g")).toEqual([]);
        expect(textChannelsFrom({ message: "401: Unauthorized" }, "g")).toEqual([]);
        expect(textChannelsFrom([{ type: 0 }], "g")).toEqual([]);
    });
});

describe("guildsFrom", () => {
    it("reads id and name", () => {
        expect(guildsFrom([{ id: "99", name: "SinfulShadows" }])).toEqual([
            { id: "99", name: "SinfulShadows" },
        ]);
    });

    it("survives an error body where a list was expected", () => {
        expect(guildsFrom({ message: "401: Unauthorized" })).toEqual([]);
        expect(guildsFrom(null)).toEqual([]);
    });
});

describe("botFromUser", () => {
    it("reads the bot's identity", () => {
        expect(botFromUser({ id: "8137604363", username: "GLaDOS" })).toEqual({
            id: "8137604363",
            username: "GLaDOS",
        });
    });

    it("rejects an error body", () => {
        expect(botFromUser({ message: "401: Unauthorized" })).toBeNull();
        expect(botFromUser(null)).toBeNull();
    });
});

describe("describeDiscordError", () => {
    it("names which token is wrong, which Discord's own wording does not", () => {
        expect(describeDiscordError(401, { message: "401: Unauthorized" })).toContain("bot token");
    });

    it("points at the invite when the bot is not allowed in", () => {
        expect(describeDiscordError(403, {})).toContain("invited");
    });
});

/**
 * Mining ignores delivery failures on purpose, so a broken webhook cannot interrupt it.
 * A test button is the one caller that must see them - "sent" while nothing arrives is
 * exactly the failure it exists to catch.
 */
describe("NotifierGroup.deliver", () => {
    const configWith = (discord: Record<string, string>) => ({
        ...DEFAULT_CONFIG,
        notifications: { discord: { webhookUrl: "", ...discord } },
    });

    it("knows which services are configured", () => {
        const group = new NotifierGroup(configWith({ botToken: "t", channelId: "c" }) as never);

        expect(group.has("discord")).toBe(true);
        expect(group.has("telegram")).toBe(false);
        expect(group.isEmpty).toBe(false);
    });

    it("does not configure a bot with only half of what it needs", () => {
        expect(new NotifierGroup(configWith({ botToken: "t" }) as never).isEmpty).toBe(true);
        expect(new NotifierGroup(configWith({ channelId: "c" }) as never).isEmpty).toBe(true);
    });

    it("sends by both routes when both are set up", () => {
        const group = new NotifierGroup(
            configWith({ webhookUrl: "https://discord.com/api/webhooks/x", botToken: "t", channelId: "c" }) as never,
        );

        expect(group.has("discord")).toBe(true);
    });

    it("reports a failure instead of swallowing it", async () => {
        const group = new NotifierGroup(
            configWith({ webhookUrl: "http://127.0.0.1:1/nothing-listening" }) as never,
        );

        const results = await group.deliver({ title: "test" });

        expect(results).toHaveLength(1);
        expect(results[0]?.ok).toBe(false);
        expect(results[0]?.label).toBe("Discord webhook");
        expect(results[0]?.error).toBeTruthy();
    });

    it("still swallows failures on the path mining uses", async () => {
        const group = new NotifierGroup(
            configWith({ webhookUrl: "http://127.0.0.1:1/nothing-listening" }) as never,
        );

        await expect(group.send({ title: "test" })).resolves.toBeUndefined();
    });
});
