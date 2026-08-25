import { describe, expect, it } from "vitest";

import {
    botFromGetMe,
    chatFromUpdates,
    describeTelegramError,
    looksLikeBotToken,
} from "../packages/core/src/notifiers/telegram-setup.js";

const update = (id: number, key: string, chat: Record<string, unknown>) => ({
    update_id: id,
    [key]: { chat },
});

/**
 * Finding the chat ID is the step people give up on, so this reads it off a message the
 * user sends their own bot. Every failure here looks the same to the user - "nothing
 * found" - which is the worst possible feedback, because their next move is to repeat the
 * thing that already worked. Hence the coverage.
 */
describe("chatFromUpdates", () => {
    it("reads the id and a human label off a direct message", () => {
        const payload = { ok: true, result: [update(1, "message", { id: 7310322437, first_name: "Nathan" })] };

        expect(chatFromUpdates(payload)).toEqual({ chatId: "7310322437", label: "Nathan" });
    });

    it("takes the newest chat, so a second try can correct the first", () => {
        const payload = {
            ok: true,
            result: [
                update(1, "message", { id: 111, first_name: "Wrong" }),
                update(9, "message", { id: 222, first_name: "Right" }),
            ],
        };

        expect(chatFromUpdates(payload)?.chatId).toBe("222");
    });

    it("is not fooled by the order the array happens to arrive in", () => {
        const payload = {
            ok: true,
            result: [
                update(9, "message", { id: 222, first_name: "Right" }),
                update(1, "message", { id: 111, first_name: "Wrong" }),
            ],
        };

        expect(chatFromUpdates(payload)?.chatId).toBe("222");
    });

    it("handles groups and channels, not just direct messages", () => {
        // Taking only `message` would report "nothing found" for a group, which is
        // indistinguishable from not having messaged the bot at all.
        expect(chatFromUpdates({ ok: true, result: [update(1, "channel_post", { id: -100, title: "My Channel" })] }))
            .toEqual({ chatId: "-100", label: "My Channel" });

        expect(chatFromUpdates({ ok: true, result: [update(1, "my_chat_member", { id: -55, title: "Group" })] }))
            .toEqual({ chatId: "-55", label: "Group" });
    });

    it("prefers a title, then a username, then a first name", () => {
        const chat = { id: 5, title: "T", username: "u", first_name: "f" };
        expect(chatFromUpdates({ ok: true, result: [update(1, "message", chat)] })?.label).toBe("T");

        const noTitle = { id: 5, username: "u", first_name: "f" };
        expect(chatFromUpdates({ ok: true, result: [update(1, "message", noTitle)] })?.label).toBe("u");
    });

    it("falls back to the id when the chat is anonymous", () => {
        expect(chatFromUpdates({ ok: true, result: [update(1, "message", { id: 42 })] })?.label).toBe("Chat 42");
    });

    it("returns null when nobody has messaged the bot yet", () => {
        expect(chatFromUpdates({ ok: true, result: [] })).toBeNull();
    });

    it("returns null rather than throwing on junk", () => {
        expect(chatFromUpdates(null)).toBeNull();
        expect(chatFromUpdates({ ok: false, description: "Unauthorized" })).toBeNull();
        expect(chatFromUpdates({ ok: true, result: "not an array" })).toBeNull();
        expect(chatFromUpdates({ ok: true, result: [{ update_id: 1 }] })).toBeNull();
    });
});

describe("botFromGetMe", () => {
    it("names the bot so the user can confirm it is theirs", () => {
        const payload = { ok: true, result: { id: 8137604363, username: "sluice_bot", first_name: "Sluice" } };

        expect(botFromGetMe(payload)).toEqual({ username: "sluice_bot", name: "Sluice" });
    });

    it("rejects a failed lookup", () => {
        expect(botFromGetMe({ ok: false, description: "Unauthorized" })).toBeNull();
        expect(botFromGetMe(null)).toBeNull();
    });
});

describe("looksLikeBotToken", () => {
    it("accepts the shape BotFather hands out", () => {
        expect(looksLikeBotToken("8137604363:AAHk9Q2mVx7pLdR3nT5wYzB1cE6gJ8kM0oP")).toBe(true);
    });

    it("rejects a half-copied token", () => {
        expect(looksLikeBotToken("8137604363")).toBe(false);
        expect(looksLikeBotToken("not-a-token")).toBe(false);
        expect(looksLikeBotToken("")).toBe(false);
    });
});

describe("describeTelegramError", () => {
    it("explains the webhook clash, which the stock text does not", () => {
        expect(describeTelegramError(409, { description: "Conflict" })).toContain("webhook");
    });

    it("says a bad token is a bad token", () => {
        expect(describeTelegramError(401, { description: "Unauthorized" })).toContain("token");
    });

    it("passes Telegram's own wording through when it has some", () => {
        expect(describeTelegramError(400, { description: "chat not found" })).toBe("chat not found");
    });
});
