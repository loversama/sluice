import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * A stand-in for the real socket that lets a test decide when it opens and closes.
 * Every instance is recorded so a test can assert how many were ever created.
 */
class FakeWebSocket extends EventEmitter {
    static instances: FakeWebSocket[] = [];
    readyState = 0;
    sent: string[] = [];
    closed = false;

    constructor(readonly url: string) {
        super();
        FakeWebSocket.instances.push(this);
    }

    send(payload: string): void {
        this.sent.push(payload);
    }

    close(): void {
        this.closed = true;
        this.emit("close");
    }

    terminate(): void {
        this.close();
    }

    /** Drive the socket as Twitch would. */
    open(): void {
        this.readyState = 1;
        this.emit("open");
    }

    drop(): void {
        this.emit("close");
    }
}

vi.mock("ws", () => ({
    default: FakeWebSocket,
    WebSocket: FakeWebSocket,
}));

const { PubSubPool } = await import("../src/twitch/websocket.js");

describe("PubSub socket lifecycle", () => {
    beforeEach(() => {
        FakeWebSocket.instances = [];
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("reconnects after the socket drops on its own", () => {
        const pool = new PubSubPool(() => "token");
        pool.listen("user-drop-events.1");
        expect(FakeWebSocket.instances).toHaveLength(1);

        FakeWebSocket.instances[0]!.drop();
        vi.advanceTimersByTime(1000);

        expect(FakeWebSocket.instances).toHaveLength(2);
        pool.close();
    });

    it("does not reconnect a socket that was closed deliberately", () => {
        // The zombie: close() during the backoff window used to be undone by the pending
        // reconnect, which reset `closing` and reopened a socket its owner had discarded.
        const pool = new PubSubPool(() => "token");
        pool.listen("user-drop-events.1");
        const socket = FakeWebSocket.instances[0]!;

        socket.drop();            // schedules a reconnect ~1s out
        pool.close();             // owner gives up before it fires
        vi.advanceTimersByTime(120_000);

        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it("stays closed even if a reconnect was already in flight", () => {
        const pool = new PubSubPool(() => "token");
        pool.listen("user-drop-events.1");
        FakeWebSocket.instances[0]!.drop();

        pool.close();
        vi.advanceTimersByTime(600_000);

        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it("forgets its topics on close, so nothing is re-subscribed later", () => {
        const pool = new PubSubPool(() => "token");
        pool.listen("user-drop-events.1");
        pool.listen("video-playback-by-id.99");
        const socket = FakeWebSocket.instances[0]!;

        pool.close();
        expect(socket.topics ?? new Set()).not.toContain("user-drop-events.1");
    });

    it("emits nothing to its old owner once closed", () => {
        const pool = new PubSubPool(() => "token");
        pool.listen("user-drop-events.1");
        const socket = FakeWebSocket.instances[0]!;
        const seen: unknown[] = [];
        pool.on("stream-up", (payload) => seen.push(payload));

        pool.close();
        // A late frame from a socket that has not finished tearing down must go nowhere.
        socket.emit(
            "message",
            JSON.stringify({
                type: "MESSAGE",
                data: {
                    topic: "video-playback-by-id.99",
                    message: JSON.stringify({ type: "stream-up" }),
                },
            }),
        );

        expect(seen).toHaveLength(0);
    });
});
