/**
 * Embedding the Twitch player without borrowing the user's Twitch session.
 *
 * A plain iframe to player.twitch.tv carries the browser's twitch.tv cookies, so the player
 * runs *as the signed-in user* and registers a second watch session on the account. That is
 * the documented way to make a miner report false progress and stall - the dashboard would
 * be sabotaging the very thing it exists to report on.
 *
 * A `credentialless` iframe loads in an ephemeral, cookie-less context instead, so the
 * player is just an anonymous viewer. Verified against Chromium 142: a plain frame sends
 * the cookie, a credentialless frame does not.
 */

/**
 * Whether this engine can embed anonymously. Chromium 110+ only - Firefox and Safari have
 * not shipped it.
 *
 * This is a gate, not a hint. Where it is false the answer is no player at all: falling
 * back to an ordinary iframe would quietly reintroduce exactly the hazard the attribute is
 * there to remove, and a stalled miner is a much worse outcome than a static thumbnail.
 */
export function supportsAnonymousEmbed(view = globalThis) {
    const iframe = view?.HTMLIFrameElement;
    return Boolean(iframe && "credentialless" in iframe.prototype);
}

/**
 * Twitch refuses to frame the player unless `parent` names the embedding host, and it must
 * be the bare hostname - no port, no scheme.
 */
export function playerEmbedUrl(login, parentHost) {
    const params = new URLSearchParams({
        channel: login,
        parent: parentHost,
        muted: "true",
        autoplay: "true",
    });
    return `https://player.twitch.tv/?${params}`;
}

/** The live thumbnail Twitch publishes per channel. Costs the account nothing. */
export function previewImageUrl(login, nonce) {
    return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-640x360.jpg?v=${nonce}`;
}
