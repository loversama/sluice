import logger from "../logger.js";

/** How often the stream's playlist is re-read. Segments are about two seconds long. */
export const SEGMENT_POLL_MS = 10_000;
/** How many segment URLs to remember for de-duplication; far more than a playlist holds. */
const MAX_REMEMBERED_SEGMENTS = 300;
/** A watcher with no successful segment request for this long is no longer earning. */
export const SEGMENT_HEALTHY_MS = 90_000;
/** Consecutive playlist failures before the (signed, expiring) playlist URL is re-resolved. */
const PLAYLIST_FAILURES_BEFORE_REFRESH = 2;

/**
 * The segment URLs in a media playlist, oldest first.
 *
 * Only plain segment lines count. `#EXT-X-TWITCH-PREFETCH` entries are announced ahead of
 * time and may not exist yet, so requesting them proves nothing and can hang.
 */
export function parseSegmentUrls(playlist: string): string[] {
    return playlist
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("http"));
}

/** Remembers which segments have already been requested, in a bounded amount of memory. */
export class SegmentTracker {
    private readonly seen = new Set<string>();

    /** The URLs not marked as seen yet, in the order given. */
    unseen(urls: string[]): string[] {
        const fresh: string[] = [];
        for (const url of urls) {
            if (!this.seen.has(url)) {
                fresh.push(url);
            }
        }
        return fresh;
    }

    markSeen(url: string): void {
        this.seen.add(url);
        if (this.seen.size > MAX_REMEMBERED_SEGMENTS) {
            // Sets iterate in insertion order, so the first entry is the oldest.
            const oldest = this.seen.values().next().value;
            if (oldest !== undefined) {
                this.seen.delete(oldest);
            }
        }
    }

    get size(): number {
        return this.seen.size;
    }
}

export interface SegmentSource {
    /** The signed media-playlist URL for the channel, or null when it cannot be had. */
    resolvePlaylistUrl(): Promise<string | null>;
    /** Forget the cached playlist URL so the next resolve fetches a fresh one. */
    invalidatePlaylistUrl(): void;
    /** Fetch the playlist text; null when the request failed or the stream is gone. */
    fetchPlaylist(url: string, signal: AbortSignal): Promise<string | null>;
    /** HEAD one segment and return its status code. */
    headSegment(url: string, signal: AbortSignal): Promise<number>;
}

/**
 * Keeps a channel's stream "watched" the way Twitch now requires.
 *
 * Twitch stopped crediting drop minutes for the analytics "minute-watched" event alone; it
 * wants to see the stream actually being pulled. The player does that by fetching every
 * segment as it is published, so this does the same without downloading any video: it
 * re-reads the playlist often and sends a HEAD request for each segment it has not asked
 * about yet. Asking once a minute, as the old fallback did, misses nearly all of them -
 * a playlist only holds the last dozen or so.
 */
export class SegmentWatcher {
    private readonly tracker = new SegmentTracker();
    private controller: AbortController | null = null;
    private loop: Promise<void> | null = null;
    private lastSuccessAt: number | null = null;
    private playlistFailures = 0;
    /** Settles once the first poll since start() has finished, however it went. */
    private firstPoll: Promise<void> = Promise.resolve();

    constructor(
        private readonly source: SegmentSource,
        private readonly label: string,
        private readonly pollMs: number = SEGMENT_POLL_MS,
    ) {}

    get running(): boolean {
        return this.controller !== null;
    }

    /** Whether a segment was fetched recently enough for this to count as watching. */
    get healthy(): boolean {
        return this.lastSuccessAt !== null && Date.now() - this.lastSuccessAt < SEGMENT_HEALTHY_MS;
    }

    start(): void {
        if (this.controller) {
            return;
        }
        const controller = new AbortController();
        this.controller = controller;
        this.lastSuccessAt = null;
        this.playlistFailures = 0;
        let polled!: () => void;
        this.firstPoll = new Promise<void>((resolve) => (polled = resolve));
        this.loop = this.run(controller.signal, polled);
    }

    /**
     * Wait until the first poll since start() has finished, or `timeoutMs` has passed.
     *
     * A watcher just started has had no chance to fetch anything, so it is not yet healthy
     * - which says nothing about the channel. Judging it before its first playlist read
     * would count a perfectly good channel's first beat as a failure.
     */
    async waitForFirstPoll(timeoutMs: number): Promise<void> {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
            this.firstPoll,
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            }),
        ]);
        clearTimeout(timer);
    }

    /** Stop and wait for any request in flight to be abandoned. */
    async stop(): Promise<void> {
        const loop = this.loop;
        this.controller?.abort();
        this.controller = null;
        this.loop = null;
        await loop;
    }

    /** One poll: read the playlist and request whatever is new. Exposed for tests. */
    async pollOnce(signal: AbortSignal): Promise<void> {
        const url = await this.source.resolvePlaylistUrl();
        if (!url) {
            this.noteFailure();
            return;
        }
        const playlist = await this.source.fetchPlaylist(url, signal);
        if (signal.aborted) {
            return;
        }
        if (playlist === null) {
            this.noteFailure();
            return;
        }
        this.playlistFailures = 0;

        for (const segment of this.tracker.unseen(parseSegmentUrls(playlist))) {
            if (signal.aborted) {
                return;
            }
            try {
                const status = await this.source.headSegment(segment, signal);
                if (status >= 200 && status < 300) {
                    this.tracker.markSeen(segment);
                    this.lastSuccessAt = Date.now();
                } else if (status === 404 || status === 410) {
                    // Rolled out of the window before we got to it; it will never succeed.
                    this.tracker.markSeen(segment);
                }
            } catch (error) {
                if (signal.aborted) {
                    return;
                }
                logger.debug(`Segment request failed for ${this.label}:`, error);
            }
        }
    }

    private noteFailure(): void {
        this.playlistFailures++;
        if (this.playlistFailures >= PLAYLIST_FAILURES_BEFORE_REFRESH) {
            // The URL is signed and expires; a fresh one costs a request and fixes that.
            this.source.invalidatePlaylistUrl();
            this.playlistFailures = 0;
        }
    }

    private async run(signal: AbortSignal, polled: () => void): Promise<void> {
        // Settled on the way out as well, so nobody waits on a watcher that was stopped.
        try {
            await this.poll(signal, polled);
        } finally {
            polled();
        }
    }

    private async poll(signal: AbortSignal, polled: () => void): Promise<void> {
        while (!signal.aborted) {
            const started = Date.now();
            try {
                await this.pollOnce(signal);
            } catch (error) {
                if (signal.aborted) {
                    return;
                }
                logger.debug(`Segment poll failed for ${this.label}:`, error);
                this.noteFailure();
            }
            polled();
            const wait = Math.max(0, this.pollMs - (Date.now() - started));
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, wait);
                signal.addEventListener(
                    "abort",
                    () => {
                        clearTimeout(timer);
                        resolve();
                    },
                    { once: true },
                );
            });
        }
    }
}
