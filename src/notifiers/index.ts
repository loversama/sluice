import { request } from "undici";

import logger from "../logger.js";
import type { Config } from "../config.js";

/**
 * A notification as content rather than pre-rendered text, so each service can present it
 * natively - Telegram as a photo with caption, Discord as an embed.
 */
export interface Notification {
    title: string;
    /** Lines of detail, rendered under the title. */
    lines?: string[];
    imageUrl?: string | null;
    /** Link the reader should follow, if there is a useful one. */
    url?: string | null;
    /** Accent for services that support it. */
    kind?: "claim" | "complete" | "warning" | "info";
}

export interface Notifier {
    send(notification: Notification): Promise<void>;
}

const KIND_EMOJI: Record<string, string> = {
    claim: "\u{1F381}",
    complete: "\u{2705}",
    warning: "\u{26A0}\u{FE0F}",
    info: "\u{2139}\u{FE0F}",
};

const KIND_COLOR: Record<string, number> = {
    claim: 0x3ddc84,
    complete: 0xa970ff,
    warning: 0xffb454,
    info: 0x4cc2ff,
};

/** Telegram parses a small HTML subset; anything interpolated must be escaped. */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

class TelegramNotifier implements Notifier {
    constructor(
        private readonly botToken: string,
        private readonly chatId: string,
    ) {}

    async send(notification: Notification): Promise<void> {
        const emoji = KIND_EMOJI[notification.kind ?? "info"] ?? "";
        const parts = [`${emoji} <b>${escapeHtml(notification.title)}</b>`];
        for (const line of notification.lines ?? []) {
            parts.push(escapeHtml(line));
        }
        if (notification.url) {
            parts.push(`<a href="${escapeHtml(notification.url)}">Open on Twitch</a>`);
        }
        const text = parts.join("\n");

        // A photo carries the reward art, which is most of the value of the message. Falling
        // back matters: Twitch's CDN occasionally refuses Telegram's fetch, and a claim
        // notification that silently vanishes is worse than one without a picture.
        if (notification.imageUrl) {
            const sent = await this.call("sendPhoto", {
                chat_id: this.chatId,
                photo: notification.imageUrl,
                caption: text,
                parse_mode: "HTML",
            });
            if (sent) {
                return;
            }
            logger.debug("Telegram rejected the image; sending as text instead.");
        }

        const ok = await this.call("sendMessage", {
            chat_id: this.chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
        });
        if (!ok) {
            throw new Error("Telegram rejected the message");
        }
    }

    private async call(method: string, body: unknown): Promise<boolean> {
        const response = await request(
            `https://api.telegram.org/bot${this.botToken}/${method}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            },
        );
        const payload = (await response.body.json().catch(() => ({}))) as {
            ok?: boolean;
            description?: string;
        };
        if (!payload.ok) {
            logger.debug(`Telegram ${method} failed: ${payload.description ?? response.statusCode}`);
        }
        return payload.ok === true;
    }
}

class DiscordNotifier implements Notifier {
    constructor(private readonly webhookUrl: string) {}

    async send(notification: Notification): Promise<void> {
        const embed: Record<string, unknown> = {
            title: notification.title,
            color: KIND_COLOR[notification.kind ?? "info"] ?? KIND_COLOR.info,
        };
        if (notification.lines?.length) {
            embed["description"] = notification.lines.join("\n");
        }
        if (notification.imageUrl) {
            embed["thumbnail"] = { url: notification.imageUrl };
        }
        if (notification.url) {
            embed["url"] = notification.url;
        }

        const response = await request(this.webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ embeds: [embed] }),
        });
        await response.body.dump();
        if (response.statusCode >= 300) {
            throw new Error(`Discord webhook returned ${response.statusCode}`);
        }
    }
}

/**
 * Fans a notification out to every configured service. Delivery failures are logged rather
 * than thrown - a broken webhook must never interrupt mining.
 */
export class NotifierGroup implements Notifier {
    private readonly notifiers: Notifier[] = [];

    constructor(config: Config) {
        const { telegram, discord } = config.notifications;
        if (telegram?.botToken && telegram.chatId) {
            this.notifiers.push(new TelegramNotifier(telegram.botToken, telegram.chatId));
        }
        if (discord?.webhookUrl) {
            this.notifiers.push(new DiscordNotifier(discord.webhookUrl));
        }
    }

    get isEmpty(): boolean {
        return this.notifiers.length === 0;
    }

    async send(notification: Notification): Promise<void> {
        await Promise.all(
            this.notifiers.map((notifier) =>
                notifier.send(notification).catch((error) => {
                    logger.debug("Notification failed:", error);
                }),
            ),
        );
    }
}
