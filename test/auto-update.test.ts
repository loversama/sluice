import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

import { nextCheckDelay, AutoUpdate, type UpdaterLike } from "../packages/desktop/src/main/auto-update.js";

/** Stands in for electron-updater, so a test can decide what it reports and when. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
    autoDownload = false;
    autoInstallOnAppQuit = false;
    checks = 0;
    installs = 0;

    checkForUpdates(): Promise<unknown> {
        this.checks += 1;
        return Promise.resolve();
    }
    quitAndInstall(): void {
        this.installs += 1;
    }
}

describe("AutoUpdate", () => {
    let bus: EventEmitter;
    let updater: FakeUpdater;
    let seen: unknown[];

    beforeEach(() => {
        vi.useFakeTimers();
        bus = new EventEmitter();
        updater = new FakeUpdater();
        seen = [];
        bus.on("update", (s) => seen.push(s));
    });

    afterEach(() => vi.useRealTimers());

    it("checks as soon as it starts", () => {
        new AutoUpdate(bus).start(updater);
        expect(updater.checks).toBe(1);
    });

    it("downloads on its own but never installs unasked", () => {
        // Installing restarts the app, which would end a mining session without warning.
        new AutoUpdate(bus).start(updater);
        expect(updater.autoDownload).toBe(true);
        expect(updater.autoInstallOnAppQuit).toBe(true);
        expect(updater.installs).toBe(0);
    });

    it("reports progress through to ready", () => {
        const updates = new AutoUpdate(bus);
        updates.start(updater);

        updater.emit("update-available", { version: "1.2.0" });
        updater.emit("download-progress", {
            percent: 41.6,
            bytesPerSecond: 2_500_000,
            transferred: 42_000_000,
            total: 101_000_000,
        });
        updater.emit("update-downloaded", { version: "1.2.0" });

        expect(seen).toContainEqual({ status: "available", version: "1.2.0" });
        // Speed and size travel with it, so the banner can say how long this will take
        // rather than only how far along it is.
        expect(seen).toContainEqual(
            expect.objectContaining({ status: "downloading", percent: 42, bytesPerSecond: 2_500_000 }),
        );
        expect(updates.status).toEqual({ status: "ready", version: "1.2.0" });
    });

    it("treats a release still being built as nothing to report", () => {
        // A tag exists before its latest.yml finishes uploading. Showing the user an error
        // for a release that is simply not ready yet would be noise.
        const updates = new AutoUpdate(bus);
        updates.start(updater);
        seen.length = 0;

        updater.emit("error", new Error("HttpError: 404 latest.yml not found"));

        expect(updates.status).toEqual({ status: "idle" });
        expect(seen.some((s: any) => s.status === "error")).toBe(false);
    });

    it("looks again a few minutes after a release was not ready", () => {
        new AutoUpdate(bus).start(updater);
        updater.emit("error", new Error("404 latest.yml"));
        expect(updater.checks).toBe(1);

        vi.advanceTimersByTime(5 * 60 * 1000);
        expect(updater.checks).toBe(2);
    });

    it("stays quiet when the machine is briefly offline", () => {
        const updates = new AutoUpdate(bus);
        updates.start(updater);

        updater.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"));

        expect(updates.status).toEqual({ status: "idle" });
    });

    it("reports a real failure rather than swallowing it", () => {
        const updates = new AutoUpdate(bus);
        updates.start(updater);

        updater.emit("error", new Error("signature verification failed"));

        expect(updates.status).toEqual({
            status: "error",
            message: "signature verification failed",
        });
    });

    it("keeps looking, about three times every two hours", () => {
        new AutoUpdate(bus).start(updater);
        vi.advanceTimersByTime(2 * 60 * 60 * 1000);

        // One on start, then a scattered three-ish per window - never none, never a flood.
        expect(updater.checks).toBeGreaterThanOrEqual(4);
        expect(updater.checks).toBeLessThanOrEqual(7);
    });

    it("does not check automatically when switched off", () => {
        new AutoUpdate(bus, () => false).start(updater);
        vi.advanceTimersByTime(4 * 60 * 60 * 1000);

        expect(updater.checks).toBe(0);
    });

    it("still checks when asked directly, however the setting is set", () => {
        // The button in settings is an instruction, not a suggestion.
        const updates = new AutoUpdate(bus, () => false);
        updates.start(updater);
        updates.checkNow();

        expect(updater.checks).toBe(1);
    });

    it("stops checking once stopped", () => {
        const updates = new AutoUpdate(bus);
        updates.start(updater);
        updates.stop();
        const before = updater.checks;

        vi.advanceTimersByTime(60 * 60 * 1000);

        expect(updater.checks).toBe(before);
    });

    it("installs when actually asked", () => {
        const updates = new AutoUpdate(bus);
        updates.start(updater);
        updates.installNow();
        expect(updater.installs).toBe(1);
    });
});

/**
 * Every installation asking GitHub at the same second after a release is both rude and the
 * surest way to be rate limited, so the delay is deliberately scattered.
 */
describe("nextCheckDelay", () => {
    const SLOT = (2 * 60 * 60 * 1000) / 3;

    it("never waits less than half a slot, so two checks cannot land together", () => {
        expect(nextCheckDelay(() => 0)).toBe(SLOT / 2);
    });

    it("never waits longer than its slot, so three still fit in the window", () => {
        expect(nextCheckDelay(() => 1)).toBe(SLOT);
    });

    it("lands somewhere different each time", () => {
        const seen = new Set(Array.from({ length: 20 }, () => nextCheckDelay()));

        expect(seen.size).toBeGreaterThan(1);
    });
});

describe("installing", () => {
    it("says it is installing before it disappears", () => {
        // quitAndInstall closes the window; without this the app simply vanishes mid-click.
        const bus = new EventEmitter();
        const seen: unknown[] = [];
        bus.on("update", (status) => seen.push(status));

        const updater = new FakeUpdater();
        const updates = new AutoUpdate(bus);
        updates.start(updater as never);
        updates.installNow();

        expect(seen).toContainEqual({ status: "installing" });
    });
});
