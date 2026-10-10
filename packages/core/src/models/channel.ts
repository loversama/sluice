import { request } from "undici";

import logger from "../logger.js";
import type { AuthState } from "../twitch/auth.js";
import type { TwitchGql } from "../twitch/gql.js";
import { ONLINE_DELAY_MS, USHER_URL } from "../twitch/constants.js";
import { SegmentWatcher, parseSegmentUrls, type SegmentSource } from "../twitch/segments.js";
import type { StreamNode } from "../twitch/types.js";

export class WatchError extends Error {}

/** Matches `"spade_url": "https://..."` in either the channel page or its settings bundle. */
const SPADE_PATTERN = /"spade_?url": ?"(https:\/\/[.\w\-/]+)"/i;
const SETTINGS_PATTERN = /src="(https:\/\/[\w.]+\/config\/settings\.[0-9a-f]{32}\.js)"/i;

/**
 * A cheap video rendition from a master playlist: the last one listed, skipping audio-only.
 *
 * Twitch can list an audio-only rendition at the end, and fetching that would be pulling
 * something other than the stream. Which video rendition is chosen does not matter, only
 * that segments are fetched, so the smaller ones are preferred to save the user's bandwidth.
 */
export function lowestVideoVariant(master: string): string | null {
    const lines = master.trim().split("\n");
    let chosen: string | null = null;
    lines.forEach((line, index) => {
        if (!line.startsWith("http")) {
            return;
        }
        const info = lines[index - 1] ?? "";
        if (!/audio_only/i.test(info)) {
            chosen = line.trim();
        }
    });
    return chosen;
}

export interface StreamState {
    broadcastId: string;
    gameId: string | null;
    gameName: string | null;
    title: string;
    viewers: number;
}

/**
 * A Twitch channel the miner may watch.
 *
 * Watch credit does not require playing the video, but it does require the stream to be
 * pulled. Twitch used to credit the player's "minute-watched" analytics event on its own;
 * since October 2026 it only does so alongside real segment fetches, so the segment watcher
 * HEADs each new HLS segment (no video is downloaded) and the analytics event rides along.
 */
export class Channel {
    /** Cached per channel - resolving it costs one or two page fetches. */
    private spadeUrl: string | null = null;
    private streamUrl: string | null = null;
    private readonly segments: SegmentWatcher;
    /**
     * Set only when we learned this channel came online from a stream-up event. Twitch sends
     * that event slightly before the stream is actually ready, so watching immediately earns
     * nothing. A channel found already streaming needs no such wait.
     */
    private pendingOnlineUntil: number | null = null;

    stream: StreamState | null = null;
    /** Whether this channel currently grants progress for the campaign we care about. */
    dropsEnabled = false;

    constructor(
        readonly id: string,
        readonly login: string,
        readonly displayName: string,
        private readonly auth: AuthState,
        private readonly gql: TwitchGql,
    ) {
        this.segments = new SegmentWatcher(this.segmentSource(), login);
    }

    static fromDirectory(node: StreamNode, auth: AuthState, gql: TwitchGql): Channel | null {
        if (!node.broadcaster) {
            return null;
        }
        const channel = new Channel(
            node.broadcaster.id,
            node.broadcaster.login,
            node.broadcaster.displayName ?? node.broadcaster.login,
            auth,
            gql,
        );
        channel.stream = {
            broadcastId: node.id,
            gameId: node.game?.id ?? null,
            gameName: node.game?.name ?? node.game?.displayName ?? null,
            title: node.title ?? "",
            viewers: node.viewersCount ?? 0,
        };
        // Discovered mid-broadcast, so it is watchable right now.
        return channel;
    }

    get url(): string {
        return `https://www.twitch.tv/${this.login}`;
    }

    get isOnline(): boolean {
        return this.stream !== null;
    }

    /**
     * True once Twitch will actually credit watch time. Only a channel we saw come online
     * has to wait; one that was already streaming when we found it is ready immediately.
     */
    get isWatchable(): boolean {
        if (!this.stream) {
            return false;
        }
        return this.pendingOnlineUntil === null || Date.now() >= this.pendingOnlineUntil;
    }

    /** Note that this channel just came online, so hold off briefly before watching. */
    markPendingOnline(): void {
        this.pendingOnlineUntil = Date.now() + ONLINE_DELAY_MS;
    }

    markOffline(): void {
        this.stream = null;
        this.pendingOnlineUntil = null;
        // The Spade URL is per-broadcast; drop it so the next session re-resolves.
        this.spadeUrl = null;
        this.streamUrl = null;
        void this.stopSegmentWatch();
    }

    /** Begin requesting the stream's segments, which Twitch requires for watch credit. */
    startSegmentWatch(): void {
        this.segments.start();
    }

    stopSegmentWatch(): Promise<void> {
        return this.segments.stop();
    }

    /** Refresh live state from Twitch. Returns true if the channel is online. */
    async refresh(): Promise<boolean> {
        const info = await this.gql.getStreamInfo(this.login);
        if (!info?.stream) {
            this.markOffline();
            return false;
        }
        const previousBroadcast = this.stream?.broadcastId;
        this.stream = {
            broadcastId: info.stream.id,
            gameId: info.broadcastSettings?.game?.id ?? null,
            gameName: info.broadcastSettings?.game?.name ?? null,
            title: info.broadcastSettings?.title ?? "",
            viewers: info.stream.viewersCount ?? 0,
        };
        // A new broadcast ID means a fresh stream, so the cached Spade URL is stale.
        if (previousBroadcast && previousBroadcast !== this.stream.broadcastId) {
            this.spadeUrl = null;
            this.streamUrl = null;
            this.markPendingOnline();
        }
        return true;
    }

    /**
     * Send one "minute watched" beat. Returns true if this channel is being watched.
     *
     * The analytics event alone no longer earns anything, so the beat counts as accepted if
     * either it went through or the segment watcher has been fetching recently. A channel
     * where both fail is genuinely unwatchable and gets benched by the caller.
     */
    async sendWatch(): Promise<boolean> {
        if (!this.stream) {
            return false;
        }
        // Idempotent: covers a channel whose watcher was stopped by a brief offline blip.
        this.segments.start();
        let spadeOk = false;
        try {
            spadeOk = await this.sendWatchSpade();
        } catch (error) {
            logger.debug(`Spade watch failed for ${this.login}:`, error);
        }
        return spadeOk || this.segments.healthy;
    }

    /**
     * Resolve and cache this channel's Spade URL without sending anything.
     * Used by the dry run to prove the scrape still works against Twitch's current page.
     */
    async probeSpadeUrl(): Promise<string> {
        if (!this.spadeUrl) {
            this.spadeUrl = await this.resolveSpadeUrl();
        }
        return this.spadeUrl;
    }

    /** Primary method: POST a minute-watched event to the channel's Spade endpoint. */
    private async sendWatchSpade(): Promise<boolean> {
        if (!this.spadeUrl) {
            this.spadeUrl = await this.resolveSpadeUrl();
        }
        const payload = [
            {
                event: "minute-watched",
                properties: {
                    broadcast_id: this.stream!.broadcastId,
                    channel_id: this.id,
                    channel: this.login,
                    client_time: new Date().toISOString(),
                    game: this.stream!.gameName ?? "",
                    game_id: this.stream!.gameId ?? "",
                    hidden: false,
                    is_live: true,
                    live: true,
                    logged_in: true,
                    minutes_logged: 1,
                    muted: false,
                    user_id: this.auth.userId,
                },
            },
        ];
        const body = new URLSearchParams({
            data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
        }).toString();

        const response = await request(this.spadeUrl, {
            method: "POST",
            headers: {
                ...this.auth.headers(),
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body,
        });
        await response.body.dump();
        // Spade acknowledges with 204 No Content.
        return response.statusCode === 204;
    }

    /**
     * The Spade URL is not exposed by any API. It lives in the channel page, or - more often
     * now - in the settings JavaScript bundle the page loads.
     *
     * Redirects must be followed: twitch.tv answers the Android user-agent we identify as
     * with a 302 to m.twitch.tv, and undici does not follow redirects unless asked. The
     * mobile page carries the same settings bundle, so the rest of the walk is unchanged.
     */
    private async resolveSpadeUrl(): Promise<string> {
        const pageHeaders = { ...this.auth.headers(), Accept: "*/*" };

        // fetch() follows redirects by default; undici's request() does not.
        const pageResponse = await fetch(this.url, { headers: pageHeaders });
        const html = await pageResponse.text();

        const direct = SPADE_PATTERN.exec(html);
        if (direct?.[1]) {
            return direct[1];
        }

        const settings = SETTINGS_PATTERN.exec(html);
        if (!settings?.[1]) {
            throw new WatchError(`Could not locate the settings bundle for ${this.login}`);
        }
        const settingsResponse = await fetch(settings[1], { headers: pageHeaders });
        const js = await settingsResponse.text();
        const nested = SPADE_PATTERN.exec(js);
        if (!nested?.[1]) {
            throw new WatchError(`Could not locate the Spade URL for ${this.login}`);
        }
        return nested[1];
    }

    /** How the segment watcher reaches this channel's stream. */
    private segmentSource(): SegmentSource {
        return {
            resolvePlaylistUrl: async () => {
                if (!this.stream) {
                    return null;
                }
                this.streamUrl ??= await this.resolveStreamUrl();
                return this.streamUrl;
            },
            invalidatePlaylistUrl: () => {
                this.streamUrl = null;
            },
            fetchPlaylist: async (url, signal) => {
                const response = await request(url, {
                    method: "GET",
                    headers: this.auth.headers(),
                    signal,
                });
                if (response.statusCode >= 400) {
                    // A 404 here means the stream ended or the signed URL expired.
                    await response.body.dump();
                    return null;
                }
                const text = await response.body.text();
                return parseSegmentUrls(text).length ? text : null;
            },
            headSegment: async (url, signal) => {
                const response = await request(url, {
                    method: "HEAD",
                    headers: this.auth.headers(),
                    signal,
                });
                await response.body.dump();
                return response.statusCode;
            },
        };
    }

    /** Obtain a signed HLS playlist URL for this channel. */
    private async resolveStreamUrl(): Promise<string | null> {
        const data = await this.gql.query<{
            streamPlaybackAccessToken: { value: string; signature: string } | null;
        }>("playbackAccessToken", { login: this.login });
        const token = data.streamPlaybackAccessToken;
        if (!token) {
            return null;
        }
        const master = `${USHER_URL}/${this.login}.m3u8?${new URLSearchParams({
            sig: token.signature,
            token: token.value,
            allow_source: "true",
            fast_bread: "true",
        })}`;
        const response = await request(master, { method: "GET", headers: this.auth.headers() });
        if (response.statusCode !== 200) {
            await response.body.dump();
            return null;
        }
        const text = await response.body.text();
        return lowestVideoVariant(text);
    }
}
