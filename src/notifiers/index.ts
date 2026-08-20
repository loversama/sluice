import { request } from "undici";

import logger from "../logger.js";
import type { Config } from "../config.js";

export interface Notifier {
    send(message: string): Promise<void>;
}

class TelegramNotifier implements Notifier {
    constructor(
        private readonly botToken: string,
        private readonly chatId: string,
    ) {}

    async send(message: string): Promise<void> {
        const response = await request(
            `https://api.telegram.org/bot${this.botToken}/sendMessage`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: this.chatId,
                    text: message,
                    parse_mode: "HTML",
                    disable_web_page_preview: true,
                }),
            },
        );
        await response.body.dump();
        if (response.statusCode !== 200) {
            throw new Error(`Telegram returned ${response.statusCode}`);
        }
    }
}

class DiscordNotifier implements Notifier {
    constructor(private readonly webhookUrl: string) {}

    async send(message: string): Promise<void> {
        const response = await request(this.webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: message }),
        });
        await response.body.dump();
        if (response.statusCode >= 300) {
            throw new Error(`Discord webhook returned ${response.statusCode}`);
        }
    }
}

/**
 * Fans a message out to every configured notifier. Delivery failures are logged rather than
 * thrown - a broken webhook must never interrupt mining.
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

    async send(message: string): Promise<void> {
        await Promise.all(
            this.notifiers.map((notifier) =>
                notifier.send(message).catch((error) => {
                    logger.debug("Notification failed:", error);
                }),
            ),
        );
    }
}
