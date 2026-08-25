/**
 * Helpers for walking someone through connecting a Telegram bot.
 *
 * Creating the bot is easy; finding the chat ID is where people give up. Telegram never
 * shows it in the app, and the usual advice is to message a third-party "get my ID" bot -
 * which means handing your account to a stranger to read a number the API will tell us for
 * free. So the flow here is: you message your own bot, we read the ID off that update.
 */

export interface TelegramChat {
    chatId: string;
    /** Whatever the chat calls itself, for confirming it picked the right one. */
    label: string;
}

export interface TelegramBot {
    username: string;
    name: string;
}

/**
 * Tokens are `<bot id>:<secret>`. Worth checking before spending a round trip, but only as
 * a typo catch - the API is the authority on whether a token is real.
 */
export function looksLikeBotToken(value: string): boolean {
    return /^\d{5,}:[\w-]{30,}$/.test(value.trim());
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** The bot's own identity, from getMe. */
export function botFromGetMe(payload: unknown): TelegramBot | null {
    const body = asRecord(payload);
    if (!body || body.ok !== true) return null;

    const result = asRecord(body.result);
    const username = typeof result?.username === "string" ? result.username : null;
    if (!username) return null;

    const name = typeof result?.first_name === "string" ? result.first_name : username;
    return { username, name };
}

/**
 * The most recent chat that has spoken to the bot, from getUpdates.
 *
 * Newest wins rather than first: someone who tries it, gets the wrong chat, and messages
 * again from the right one should be able to just press the button a second time.
 *
 * Several update kinds carry a chat, and which one arrives depends on where the message
 * came from. Taking only `message` would silently fail for a group or a channel, which
 * looks identical to "you did not message the bot yet" - the worst possible feedback,
 * because the user's next move is to do the thing they already did.
 */
export function chatFromUpdates(payload: unknown): TelegramChat | null {
    const body = asRecord(payload);
    if (!body || body.ok !== true || !Array.isArray(body.result)) return null;

    const sorted = [...body.result].sort((a, b) => {
        const left = Number(asRecord(a)?.update_id ?? 0);
        const right = Number(asRecord(b)?.update_id ?? 0);
        return right - left;
    });

    for (const update of sorted) {
        const fields = asRecord(update);
        if (!fields) continue;

        for (const key of ["message", "edited_message", "channel_post", "my_chat_member"]) {
            const chat = asRecord(asRecord(fields[key])?.chat);
            const id = chat?.id;
            if (typeof id !== "number" && typeof id !== "string") continue;

            const label =
                [chat?.title, chat?.username, chat?.first_name].find(
                    (value) => typeof value === "string" && value,
                ) ?? `Chat ${id}`;
            return { chatId: String(id), label: String(label) };
        }
    }

    return null;
}

/**
 * Turn a Telegram error into something worth reading.
 *
 * The two that actually happen get named. A bot with a webhook set cannot be polled, and
 * Telegram reports that as a 409 whose stock text explains nothing about what to do.
 */
export function describeTelegramError(status: number, payload: unknown): string {
    const description = asRecord(payload)?.description;
    const detail = typeof description === "string" ? description : "";

    if (status === 401) return "Telegram rejected that token. Check it was copied whole.";
    if (status === 409) {
        return "That bot has a webhook set, so its messages cannot be read here. Remove the webhook, or use a bot made for this.";
    }
    return detail || `Telegram returned ${status}.`;
}
