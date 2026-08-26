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

/** Discord renders both routes from the same embed, so it is built in one place. */
export function discordEmbed(notification: Notification): Record<string, unknown> {
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
    return embed;
}

class DiscordNotifier implements Notifier {
    constructor(private readonly webhookUrl: string) {}

    async send(notification: Notification): Promise<void> {
        const embed = discordEmbed(notification);

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
 * Posting through a bot rather than a webhook.
 *
 * Same embed, different door: a webhook is bound to one channel and belongs to nobody,
 * whereas a bot posts under an identity you own and can be moved between channels without
 * reissuing anything.
 */
class DiscordBotNotifier implements Notifier {
    constructor(
        private readonly botToken: string,
        private readonly channelId: string,
    ) {}

    async send(notification: Notification): Promise<void> {
        const response = await request(
            `https://discord.com/api/v10/channels/${this.channelId}/messages`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    // "Bot " is not optional - Discord reads the scheme, and without it the
                    // token is treated as a user token and refused.
                    Authorization: `Bot ${this.botToken}`,
                },
                body: JSON.stringify({ embeds: [discordEmbed(notification)] }),
            },
        );
        await response.body.dump();
        if (response.statusCode >= 300) {
            throw new Error(`Discord returned ${response.statusCode}`);
        }
    }
}

/**
 * Fans a notification out to every configured service. Delivery failures are logged rather
 * than thrown - a broken webhook must never interrupt mining.
 */
export type NotifierService = "telegram" | "discord";

/** What one service made of a delivery. Only a test has any use for the failures. */
export interface DeliveryResult {
    service: NotifierService;
    label: string;
    ok: boolean;
    error?: string;
}

export class NotifierGroup implements Notifier {
    private readonly notifiers: { service: NotifierService; label: string; notifier: Notifier }[] =
        [];

    constructor(config: Config) {
        const { telegram, discord } = config.notifications;
        if (telegram?.botToken && telegram.chatId) {
            this.notifiers.push({
                service: "telegram",
                label: "Telegram",
                notifier: new TelegramNotifier(telegram.botToken, telegram.chatId),
            });
        }
        if (discord?.webhookUrl) {
            this.notifiers.push({
                service: "discord",
                label: "Discord webhook",
                notifier: new DiscordNotifier(discord.webhookUrl),
            });
        }
        // Both may be set, and then both send: someone who has configured a webhook and a
        // bot has said they want it in two places.
        if (discord?.botToken && discord.channelId) {
            this.notifiers.push({
                service: "discord",
                label: "Discord bot",
                notifier: new DiscordBotNotifier(discord.botToken, discord.channelId),
            });
        }
    }

    get isEmpty(): boolean {
        return this.notifiers.length === 0;
    }

    /** True if anything is configured for this service. */
    has(service: NotifierService): boolean {
        return this.notifiers.some((entry) => entry.service === service);
    }

    /**
     * Send, and say what happened to each.
     *
     * Mining calls send() and ignores this; a test button is the one caller that needs the
     * failures, because "sent" with nothing arriving is exactly the bug it exists to catch.
     */
    async deliver(
        notification: Notification,
        service?: NotifierService,
    ): Promise<DeliveryResult[]> {
        const targets = service
            ? this.notifiers.filter((entry) => entry.service === service)
            : this.notifiers;

        return Promise.all(
            targets.map(async ({ service: name, label, notifier }) => {
                try {
                    await notifier.send(notification);
                    return { service: name, label, ok: true };
                } catch (error) {
                    return {
                        service: name,
                        label,
                        ok: false,
                        error: error instanceof Error ? error.message : String(error),
                    };
                }
            }),
        );
    }

    async send(notification: Notification): Promise<void> {
        // Delivery failures are logged rather than thrown - a broken webhook must never
        // interrupt mining.
        for (const result of await this.deliver(notification)) {
            if (!result.ok) {
                logger.debug(`Notification via ${result.label} failed:`, result.error);
            }
        }
    }
}
