/**
 * Helpers for connecting Discord.
 *
 * A webhook needs no help - you copy a URL out of channel settings. A bot does: Discord
 * hides channel IDs behind a Developer Mode toggle most people have never turned on, and
 * the usual advice is to enable it, right-click the channel and "Copy ID". The bot can
 * simply be asked which channels it can see, so that is what these are for.
 */

export interface DiscordBot {
    username: string;
    id: string;
}

export interface DiscordChannel {
    id: string;
    name: string;
    guild: string;
}

/** Text channels a bot may post in. */
const TEXT_CHANNEL = 0;
const ANNOUNCEMENT_CHANNEL = 5;

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** The bot's own identity, from GET /users/@me. */
export function botFromUser(payload: unknown): DiscordBot | null {
    const body = asRecord(payload);
    const username = typeof body?.username === "string" ? body.username : null;
    const id = body?.id;
    if (!username || (typeof id !== "string" && typeof id !== "number")) return null;
    return { username, id: String(id) };
}

/** Guild ids and names, from GET /users/@me/guilds. */
export function guildsFrom(payload: unknown): { id: string; name: string }[] {
    if (!Array.isArray(payload)) return [];
    const guilds: { id: string; name: string }[] = [];
    for (const entry of payload) {
        const guild = asRecord(entry);
        const id = guild?.id;
        if (typeof id !== "string" && typeof id !== "number") continue;
        guilds.push({ id: String(id), name: typeof guild?.name === "string" ? guild.name : String(id) });
    }
    return guilds;
}

/**
 * Postable channels in one guild, from GET /guilds/{id}/channels.
 *
 * Voice categories and forums come back in the same list and would only offer somewhere a
 * message cannot go, so only the two kinds that accept one are kept.
 */
export function textChannelsFrom(payload: unknown, guild: string): DiscordChannel[] {
    if (!Array.isArray(payload)) return [];
    const channels: DiscordChannel[] = [];
    for (const entry of payload) {
        const channel = asRecord(entry);
        const type = Number(channel?.type);
        if (type !== TEXT_CHANNEL && type !== ANNOUNCEMENT_CHANNEL) continue;

        const id = channel?.id;
        if (typeof id !== "string" && typeof id !== "number") continue;
        channels.push({
            id: String(id),
            name: typeof channel?.name === "string" ? channel.name : String(id),
            guild,
        });
    }
    return channels;
}

/**
 * Turn a Discord failure into something worth reading.
 *
 * 401 is the one that actually happens, and Discord's own wording for it ("401: Unauthorized")
 * tells a user nothing about which of the several tokens on screen is wrong.
 */
export function describeDiscordError(status: number, payload: unknown): string {
    const message = asRecord(payload)?.message;
    const detail = typeof message === "string" ? message : "";

    if (status === 401) return "Discord rejected that bot token. Check it was copied whole.";
    if (status === 403) return "That bot is not allowed to do this. Check it has been invited to the server.";
    if (status === 429) return "Discord is rate limiting us. Wait a moment and try again.";
    return detail || `Discord returned ${status}.`;
}
