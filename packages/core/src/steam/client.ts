import logger from "../logger.js";

export class SteamError extends Error {}

export interface OwnedGame {
    appid: number;
    name: string;
    /** Total minutes played, as recorded since Steam began tracking in 2009. */
    playtimeForever: number;
    /** Minutes played in the last two weeks. */
    playtimeRecent: number;
    /**
     * Unix seconds of the last session, or 0 if never played.
     *
     * NOTE: Steam exposes no purchase or "added to library" date - this is the closest
     * available recency signal, and Steam only fills it in for a key that belongs to the
     * account being read, which the broker's key does not.
     */
    lastPlayed: number;
}

/**
 * Resolve a custom profile name using Steam's community XML view.
 *
 * No API key, no broker, no account: this is a public page. It is what lets a pasted
 * profile URL identify an account before anything else has happened.
 */
async function resolveVanityWithoutKey(vanity: string): Promise<string | null> {
    try {
        // fetch() follows redirects, which the community view uses; undici's request does not.
        const response = await fetch(
            `https://steamcommunity.com/id/${encodeURIComponent(vanity)}/?xml=1`,
        );
        if (!response.ok) {
            return null;
        }
        const xml = await response.text();
        return /<steamID64>(\d{17})<\/steamID64>/.exec(xml)?.[1] ?? null;
    } catch (error) {
        logger.debug("Keyless vanity resolution failed:", error);
        return null;
    }
}

/**
 * Accept whatever the user pastes: a bare 64-bit ID, a /profiles/ URL, a /id/ vanity URL, or
 * a bare vanity name.
 */
export async function resolveSteamId(input: string): Promise<string> {
    const trimmed = input.trim();

    if (/^\d{17}$/.test(trimmed)) {
        return trimmed;
    }

    const profileMatch = trimmed.match(/steamcommunity\.com\/profiles\/(\d{17})/);
    if (profileMatch?.[1]) {
        return profileMatch[1];
    }

    const vanityMatch = trimmed.match(/steamcommunity\.com\/id\/([^/?#]+)/);
    const vanity = vanityMatch?.[1] ?? (/^[\w.-]+$/.test(trimmed) ? trimmed : null);
    if (vanity) {
        const resolved = await resolveVanityWithoutKey(vanity);
        if (resolved) {
            return resolved;
        }
        throw new SteamError(`Could not resolve "${vanity}" to a Steam account.`);
    }

    throw new SteamError("Enter a Steam ID, profile URL, or custom URL name.");
}
