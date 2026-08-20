import { request } from "undici";

import logger from "../logger.js";
import type { AuthState } from "../twitch/auth.js";
import type { TwitchGql } from "../twitch/gql.js";
import { ONLINE_DELAY_MS, USHER_URL } from "../twitch/constants.js";
import type { StreamNode } from "../twitch/types.js";

export class WatchError extends Error {}

/** Matches `"spade_url": "https://..."` in either the channel page or its settings bundle. */
const SPADE_PATTERN = /"spade_?url": ?"(https:\/\/[.\w\-/]+)"/i;
const SETTINGS_PATTERN = /src="(https:\/\/[\w.]+\/config\/settings\.[0-9a-f]{32}\.js)"/i;

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
 * Watch credit does not require playing the video. Twitch's player reports viewing by POSTing
 * a "minute-watched" analytics event to a per-channel Spade endpoint; sending that event
 * directly is sufficient to advance drop progress, which is why this bot needs no browser.
 */
export class Channel {
    /** Cached per channel - resolving it costs one or two page fetches. */
    private spadeUrl: string | null = null;
    private streamUrl: string | null = null;
    private onlineSince: number | null = null;

    stream: StreamState | null = null;
    /** Whether this channel currently grants progress for the campaign we care about. */
    dropsEnabled = false;

    constructor(
        readonly id: string,
        readonly login: string,
        readonly displayName: string,
        private readonly auth: AuthState,
        private readonly gql: TwitchGql,
    ) {}

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
        channel.onlineSince = Date.now();
        return channel;
    }

    get url(): string {
        return `https://www.twitch.tv/${this.login}`;
    }

    get isOnline(): boolean {
        return this.stream !== null;
    }

    /**
     * True once the stream has been up long enough for Twitch to credit watch time.
     * Watching immediately after a stream-up event yields no progress.
     */
    get isWatchable(): boolean {
        if (!this.stream || this.onlineSince === null) {
            return false;
        }
        return Date.now() - this.onlineSince >= ONLINE_DELAY_MS;
    }

    markOnline(): void {
        if (this.onlineSince === null) {
            this.onlineSince = Date.now();
        }
    }

    markOffline(): void {
        this.stream = null;
        this.onlineSince = null;
        // The Spade URL is per-broadcast; drop it so the next session re-resolves.
        this.spadeUrl = null;
        this.streamUrl = null;
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
            this.onlineSince = Date.now();
        }
        this.markOnline();
        return true;
    }

    /**
     * Send one "minute watched" beat. Returns true if Twitch accepted it.
     *
     * Falls back to fetching a stream chunk if the Spade endpoint fails, since Twitch has
     * moved between these two mechanisms more than once.
     */
    async sendWatch(): Promise<boolean> {
        if (!this.stream) {
            return false;
        }
        try {
            if (await this.sendWatchSpade()) {
                return true;
            }
        } catch (error) {
            logger.debug(`Spade watch failed for ${this.login}:`, error);
        }
        try {
            return await this.sendWatchPlaylist();
        } catch (error) {
            logger.debug(`Playlist watch failed for ${this.login}:`, error);
            return false;
        }
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
     */
    private async resolveSpadeUrl(): Promise<string> {
        const pageResponse = await request(this.url, {
            method: "GET",
            headers: { ...this.auth.headers(), Accept: "text/html" },
        });
        const html = await pageResponse.body.text();

        const direct = SPADE_PATTERN.exec(html);
        if (direct?.[1]) {
            return direct[1];
        }

        const settings = SETTINGS_PATTERN.exec(html);
        if (!settings?.[1]) {
            throw new WatchError(`Could not locate the settings bundle for ${this.login}`);
        }
        const settingsResponse = await request(settings[1], {
            method: "GET",
            headers: this.auth.headers(),
        });
        const js = await settingsResponse.body.text();
        const nested = SPADE_PATTERN.exec(js);
        if (!nested?.[1]) {
            throw new WatchError(`Could not locate the Spade URL for ${this.login}`);
        }
        return nested[1];
    }

    /**
     * Fallback: request the head of a live stream chunk. Twitch counts the CDN fetch as
     * viewing, without us downloading the segment body.
     */
    private async sendWatchPlaylist(): Promise<boolean> {
        const playlistUrl = this.streamUrl ?? (await this.resolveStreamUrl());
        if (!playlistUrl) {
            return false;
        }
        this.streamUrl = playlistUrl;

        const response = await request(playlistUrl, {
            method: "GET",
            headers: { ...this.auth.headers(), Connection: "close" },
        });
        if (response.statusCode >= 400) {
            // A 404 here means the stream ended.
            await response.body.dump();
            this.streamUrl = null;
            return false;
        }
        const playlist = await response.body.text();
        const lines = playlist
            .trim()
            .split("\n")
            .filter((line) => line.startsWith("http"));
        const chunk = lines.at(-1);
        if (!chunk) {
            return false;
        }
        const head = await request(chunk, { method: "HEAD", headers: this.auth.headers() });
        await head.body.dump();
        return head.statusCode === 200;
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
        // The master playlist lists qualities best-first; the last is the lowest bitrate.
        const variants = text
            .trim()
            .split("\n")
            .filter((line) => line.startsWith("http"));
        return variants.at(-1) ?? null;
    }
}
