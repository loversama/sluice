import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

import { AutoUpdate, type UpdaterLike } from "../packages/desktop/src/main/auto-update.js";

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
        updater.emit("download-progress", { percent: 41.6 });
        updater.emit("update-downloaded", { version: "1.2.0" });

        expect(seen).toContainEqual({ status: "available", version: "1.2.0" });
        expect(seen).toContainEqual({ status: "downloading", percent: 42 });
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

    it("keeps looking on a schedule", () => {
        new AutoUpdate(bus).start(updater);
        vi.advanceTimersByTime(15 * 60 * 1000);
        expect(updater.checks).toBe(2);
        vi.advanceTimersByTime(15 * 60 * 1000);
        expect(updater.checks).toBe(3);
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
