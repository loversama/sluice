import type { EventEmitter } from "node:events";

import { logger } from "@tdb/core";

/** How often to look, once the first check has happened. */
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
/** How long to wait when the release exists but its metadata has not appeared yet. */
const RETRY_AFTER_MS = 5 * 60 * 1000;

export type UpdateStatus =
    | { status: "idle" }
    | { status: "checking" }
    | { status: "available"; version: string }
    | { status: "downloading"; percent: number }
    | { status: "ready"; version: string }
    | { status: "error"; message: string };

/**
 * Keep the app up to date, and say so on the bus.
 *
 * This matters more here than in most apps. Twitch rotates the persisted GraphQL query
 * hashes without notice, and when it does the bot cannot mine until the new hashes ship.
 * Someone running the container pulls and rebuilds; someone running an installer has no
 * way to do that themselves. Updating is the only route a fix has to reach them, which is
 * why it is wired in from the first release rather than added later.
 *
 * The updater is passed in rather than imported so this can be exercised without Electron.
 */
export class AutoUpdate {
    private checkTimer: NodeJS.Timeout | null = null;
    private retryTimer: NodeJS.Timeout | null = null;
    private updater: UpdaterLike | null = null;
    private lastStatus: UpdateStatus = { status: "idle" };

    constructor(private readonly bus: EventEmitter) {}

    get status(): UpdateStatus {
        return this.lastStatus;
    }

    private publish(status: UpdateStatus): void {
        this.lastStatus = status;
        this.bus.emit("update", status);
    }

    start(updater: UpdaterLike): void {
        this.updater = updater;
        // Downloading is fine unattended; installing is not, since it restarts the app and
        // would end a mining session without warning.
        updater.autoDownload = true;
        updater.autoInstallOnAppQuit = true;

        updater.on("checking-for-update", () => this.publish({ status: "checking" }));
        updater.on("update-available", (info) =>
            this.publish({ status: "available", version: info?.version ?? "" }),
        );
        updater.on("update-not-available", () => this.publish({ status: "idle" }));
        updater.on("download-progress", (progress) =>
            this.publish({ status: "downloading", percent: Math.round(progress?.percent ?? 0) }),
        );
        updater.on("update-downloaded", (info) => {
            logger.info(`Update ${info?.version ?? ""} downloaded; it will install on quit.`);
            this.publish({ status: "ready", version: info?.version ?? "" });
        });

        updater.on("error", (error) => {
            const message = error instanceof Error ? error.message : String(error);
            // A tag exists but its metadata has not finished uploading, or the machine is
            // briefly offline. Neither is worth showing anyone - the next look will find it.
            const transient =
                message.includes("latest.yml") ||
                message.includes("404") ||
                message.includes("ENOTFOUND") ||
                message.includes("ECONNRESET") ||
                message.includes("net::ERR");
            if (transient) {
                logger.debug(`Update check deferred: ${message}`);
                this.publish({ status: "idle" });
                this.retryTimer?.refresh() ??
                    (this.retryTimer = setTimeout(() => this.check(), RETRY_AFTER_MS));
                this.retryTimer?.unref();
                return;
            }
            logger.warn(`Update check failed: ${message}`);
            this.publish({ status: "error", message });
        });

        this.check();
        this.checkTimer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
        this.checkTimer.unref();
    }

    check(): void {
        try {
            void this.updater?.checkForUpdates();
        } catch (error) {
            logger.debug("Update check threw:", error);
        }
    }

    /** Restart into the new version now, rather than waiting for the next quit. */
    installNow(): void {
        try {
            this.updater?.quitAndInstall();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.publish({ status: "error", message });
        }
    }

    stop(): void {
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
            this.checkTimer = null;
        }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }
}

/** The slice of electron-updater this uses, so tests need not stand the real one up. */
export interface UpdaterLike {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    on(event: string, listener: (payload: any) => void): unknown;
    checkForUpdates(): Promise<unknown> | unknown;
    quitAndInstall(): void;
}
