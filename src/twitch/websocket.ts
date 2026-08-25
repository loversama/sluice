import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import WebSocket from "ws";

import logger from "../logger.js";
import {
    MAX_SOCKETS,
    PING_INTERVAL_MS,
    PING_TIMEOUT_MS,
    PUBSUB_URL,
    TOPICS_PER_SOCKET,
} from "./constants.js";

export interface DropProgressMessage {
    drop_id: string;
    current_progress_min: number;
    required_progress_min: number;
}

export interface PubSubEvents {
    "drop-progress": [DropProgressMessage];
    "drop-claim": [{ drop_id: string; drop_instance_id: string }];
    "stream-up": [{ channelId: string }];
    "stream-down": [{ channelId: string }];
    viewcount: [{ channelId: string; viewers: number }];
    /** The channel changed category mid-stream; watch time may no longer count. */
    "category-change": [{ channelId: string; gameId: string; gameName: string }];
    "points-claim-available": [{ channelId: string; claimId: string }];
    /** A drop reward landed; the inventory is now stale. */
    "reward-notification": [{ notificationId: string }];
}

/**
 * Events the pool republishes from its sockets.
 *
 * This list used to be written out inline at the point of use, and adding an event to
 * PubSubEvents without adding it here compiled perfectly and simply never fired -
 * "category-change" shipped that way, so switchOnCategoryChange subscribed to the topic,
 * paid for it, and did nothing. The assertion below makes that a build error instead.
 */
const FORWARDED_EVENTS = [
    "drop-progress",
    "drop-claim",
    "stream-up",
    "stream-down",
    "viewcount",
    "category-change",
    "points-claim-available",
    "reward-notification",
] as const;

/** Resolves to `never` when every declared event is forwarded, and to the offender when not. */
type UnforwardedEvent = Exclude<keyof PubSubEvents, (typeof FORWARDED_EVENTS)[number]>;
const _everyEventIsForwarded: UnforwardedEvent extends never ? true : UnforwardedEvent = true;
void _everyEventIsForwarded;

/**
 * One PubSub connection. Twitch limits how many topics a single socket may hold, so
 * {@link PubSubPool} owns several of these and spreads topics across them.
 */
class PubSubSocket extends EventEmitter {
    private socket: WebSocket | null = null;
    private pingTimer: NodeJS.Timeout | null = null;
    private pongTimer: NodeJS.Timeout | null = null;
    private reconnectDelay = 1000;
    private closing = false;
    /**
     * The pending reconnect, if the socket dropped and we mean to come back.
     *
     * It has to be held rather than fired and forgotten: close() has to be able to cancel
     * it, or a socket closed during the backoff window reopens afterwards and starts
     * feeding events to whatever used to own it.
     */
    private reconnectTimer: NodeJS.Timeout | null = null;

    readonly topics = new Set<string>();

    /**
     * The token is read through a getter rather than captured: it can be refreshed while
     * sockets are open, and a reconnect that re-subscribed with the old one would fail
     * silently, stopping every progress event without any obvious symptom.
     */
    constructor(private readonly getAuthToken: () => string) {
        super();
    }

    get topicCount(): number {
        return this.topics.size;
    }

    connect(): void {
        if (this.socket) {
            return;
        }
        // Once closed, stay closed. This used to clear `closing` unconditionally, so a
        // reconnect scheduled before close() ran would undo it and resurrect the socket -
        // complete with its old topics, still wired to a pool its owner had discarded.
        if (this.closing) {
            return;
        }
        const socket = new WebSocket(PUBSUB_URL);
        this.socket = socket;

        socket.on("open", () => {
            logger.debug("PubSub socket opened");
            this.reconnectDelay = 1000;
            this.schedulePing();
            if (this.topics.size > 0) {
                // Re-subscribe after a reconnect; Twitch does not remember our topics.
                this.send({
                    type: "LISTEN",
                    nonce: randomUUID(),
                    data: { topics: [...this.topics], auth_token: this.getAuthToken() },
                });
            }
        });

        socket.on("message", (raw) => this.handleMessage(String(raw)));

        socket.on("error", (error) => {
            logger.debug("PubSub socket error:", error);
        });

        socket.on("close", () => {
            this.clearTimers();
            this.socket = null;
            if (this.closing) {
                return;
            }
            logger.debug(`PubSub socket closed, reconnecting in ${this.reconnectDelay}ms`);
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                this.connect();
            }, this.reconnectDelay);
            this.reconnectTimer.unref();
            // Back off up to 60s so a Twitch-side outage does not turn into a hot loop.
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
        });
    }

    /** Shut the socket down for good: no reconnect, no retained topics. */
    close(): void {
        this.closing = true;
        this.clearTimers();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.socket?.close();
        this.socket = null;
        // Held only so a reconnect can re-subscribe. Keeping them after close means a
        // resurrected socket would silently restore someone else's subscriptions.
        this.topics.clear();
        this.removeAllListeners();
    }


    listen(topic: string): void {
        if (this.topics.has(topic)) {
            return;
        }
        this.topics.add(topic);
        this.send({
            type: "LISTEN",
            nonce: randomUUID(),
            data: { topics: [topic], auth_token: this.getAuthToken() },
        });
    }

    unlisten(topic: string): void {
        if (!this.topics.delete(topic)) {
            return;
        }
        this.send({
            type: "UNLISTEN",
            nonce: randomUUID(),
            data: { topics: [topic], auth_token: this.getAuthToken() },
        });
    }

    private send(payload: unknown): void {
        if (this.socket?.readyState !== WebSocket.OPEN) {
            return;
        }
        try {
            this.socket.send(JSON.stringify(payload));
        } catch (error) {
            logger.debug("Failed to send on PubSub socket:", error);
        }
    }

    private schedulePing(): void {
        this.clearTimers();
        this.pingTimer = setInterval(() => {
            this.send({ type: "PING" });
            // No PONG within the timeout means the connection is wedged - drop it so the
            // close handler reconnects. A silently dead socket costs us drop progress.
            this.pongTimer = setTimeout(() => {
                logger.debug("PubSub PONG timed out, forcing reconnect");
                this.socket?.terminate();
            }, PING_TIMEOUT_MS);
        }, PING_INTERVAL_MS);
    }

    private clearTimers(): void {
        if (this.pingTimer) clearInterval(this.pingTimer);
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pingTimer = null;
        this.pongTimer = null;
    }

    private handleMessage(raw: string): void {
        let payload: { type: string; error?: string; data?: { topic: string; message: string } };
        try {
            payload = JSON.parse(raw);
        } catch {
            return;
        }

        if (payload.type === "PONG") {
            if (this.pongTimer) clearTimeout(this.pongTimer);
            this.pongTimer = null;
            return;
        }
        if (payload.type === "RECONNECT") {
            logger.debug("PubSub asked us to reconnect");
            this.socket?.close();
            return;
        }
        if (payload.type === "RESPONSE") {
            if (payload.error) {
                logger.warn(`PubSub subscription error: ${payload.error}`);
            }
            return;
        }
        if (payload.type !== "MESSAGE" || !payload.data) {
            return;
        }

        // Topics arrive as "<name>.<target-id>"; the name may itself contain dots, so split
        // from the right to recover the target.
        const fullTopic = payload.data.topic;
        const separator = fullTopic.lastIndexOf(".");
        const topicName = separator === -1 ? fullTopic : fullTopic.slice(0, separator);
        const targetId = separator === -1 ? "" : fullTopic.slice(separator + 1);

        let message: Record<string, unknown>;
        try {
            message = JSON.parse(payload.data.message);
        } catch {
            return;
        }
        this.dispatch(topicName, targetId, message);
    }

    private dispatch(topic: string, targetId: string, message: Record<string, unknown>): void {
        const type = String(message["type"] ?? "");
        const data = (message["data"] ?? {}) as Record<string, unknown>;

        switch (topic) {
            case "user-drop-events":
                if (type === "drop-progress") {
                    this.emit("drop-progress", data as unknown as DropProgressMessage);
                } else if (type === "drop-claim") {
                    this.emit("drop-claim", data);
                }
                return;

            case "video-playback-by-id":
                if (type === "stream-up") {
                    this.emit("stream-up", { channelId: targetId });
                } else if (type === "stream-down") {
                    this.emit("stream-down", { channelId: targetId });
                } else if (type === "viewcount") {
                    this.emit("viewcount", {
                        channelId: targetId,
                        viewers: Number(message["viewers"] ?? 0),
                    });
                }
                return;

            case "broadcast-settings-update":
                // Fired when a streamer edits their title, tags or category mid-stream.
                // Only the category matters here: watch time stops counting the moment the
                // channel leaves the campaign's own category.
                this.emit("category-change", {
                    channelId: targetId,
                    gameId: String(message["game_id"] ?? ""),
                    gameName: String(message["game"] ?? ""),
                });
                return;

            case "onsite-notifications":
                if (type === "create-notification") {
                    const notification = (data["notification"] ?? {}) as Record<string, unknown>;
                    const kind = String(notification["type"] ?? "");
                    // Twitch announces a granted reward here, which is a second, faster
                    // signal that the inventory has changed.
                    if (
                        kind === "user_drop_reward_reminder_notification" ||
                        kind === "quests_viewer_reward_campaign_earned_emote"
                    ) {
                        this.emit("reward-notification", {
                            notificationId: String(notification["id"] ?? ""),
                        });
                    }
                }
                return;

            case "community-points-user-v1":
                if (type === "claim-available") {
                    const claim = (data["claim"] ?? {}) as Record<string, unknown>;
                    this.emit("points-claim-available", {
                        channelId: String(claim["channel_id"] ?? ""),
                        claimId: String(claim["id"] ?? ""),
                    });
                }
                return;

            default:
                logger.debug(`Unhandled PubSub topic: ${topic}`);
        }
    }
}

/**
 * Manages a set of PubSub connections and routes topic subscriptions across them, so the bot
 * can watch far more channels than one socket allows.
 */
export class PubSubPool extends EventEmitter {
    private readonly sockets: PubSubSocket[] = [];
    private readonly topicOwners = new Map<string, PubSubSocket>();

    /**
     * The token is read through a getter rather than captured: it can be refreshed while
     * sockets are open, and a reconnect that re-subscribed with the old one would fail
     * silently, stopping every progress event without any obvious symptom.
     */
    constructor(private readonly getAuthToken: () => string) {
        super();
    }

    get topicCount(): number {
        return this.topicOwners.size;
    }

    listen(topic: string): void {
        if (this.topicOwners.has(topic)) {
            return;
        }
        const socket = this.acquireSocket();
        if (!socket) {
            logger.warn(`Topic capacity reached; ignoring subscription to ${topic}`);
            return;
        }
        socket.listen(topic);
        this.topicOwners.set(topic, socket);
    }

    unlisten(topic: string): void {
        const socket = this.topicOwners.get(topic);
        if (!socket) {
            return;
        }
        socket.unlisten(topic);
        this.topicOwners.delete(topic);
    }

    close(): void {
        for (const socket of this.sockets) {
            socket.close();
        }
        this.sockets.length = 0;
        this.topicOwners.clear();
    }

    /** Find a socket with room, opening a new one if all are full. */
    private acquireSocket(): PubSubSocket | null {
        for (const socket of this.sockets) {
            if (socket.topicCount < TOPICS_PER_SOCKET) {
                return socket;
            }
        }
        if (this.sockets.length >= MAX_SOCKETS) {
            return null;
        }
        const socket = new PubSubSocket(this.getAuthToken);
        // Forward every event so consumers subscribe to the pool, not individual sockets.
        for (const event of FORWARDED_EVENTS) {
            socket.on(event, (payload) => this.emit(event, payload));
        }
        socket.connect();
        this.sockets.push(socket);
        return socket;
    }
}
