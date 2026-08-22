/** Shared formatting helpers so durations and times read the same everywhere. */

export function formatDuration(minutes) {
    if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) {
        return "-";
    }
    const total = Math.max(0, Math.round(minutes));
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    if (hours === 0) {
        return `${rest}m`;
    }
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Wall-clock time, which answers "will this finish tonight" better than a duration. */
export function formatClock(date) {
    return new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(date) {
    return new Date(date).toLocaleString([], {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        day: "numeric",
        month: "short",
    });
}

export function formatRelative(timestamp) {
    const seconds = Math.round((Date.now() - new Date(timestamp)) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

/** "in 3d" / "in 4h" - used for campaign start and end countdowns. */
export function formatUntil(date) {
    const ms = new Date(date) - Date.now();
    if (ms <= 0) return "now";
    const minutes = ms / 60_000;
    if (minutes < 60) return `in ${Math.round(minutes)}m`;
    const hours = minutes / 60;
    if (hours < 48) return `in ${Math.round(hours)}h`;
    return `in ${Math.round(hours / 24)}d`;
}

export function totalRemainingMinutes(campaign) {
    return campaign.drops
        .filter((drop) => !drop.isClaimed)
        .reduce((sum, drop) => sum + Math.max(0, drop.requiredMinutes - drop.currentMinutes), 0);
}

/**
 * Twitch's box art for a game id. The plain `<id>-WxH` form resolves to a grey 404
 * placeholder; the _IGDB variant is the one that carries real art.
 */
export function boxArt(gameId, size = "72x96") {
    return gameId ? `https://static-cdn.jtvnw.net/ttv-boxart/${gameId}_IGDB-${size}.jpg` : null;
}
