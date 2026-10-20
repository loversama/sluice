import type { EventEmitter } from "node:events";

import { logger } from "@sluice/core";

/** How often to look, once the first check has happened. */
/** Three looks every two hours, which is often enough for a fix and gentle on the API. */
const CHECK_WINDOW_MS = 2 * 60 * 60 * 1000;
const CHECKS_PER_WINDOW = 3;

/**
 * How long until the next look.
 *
 * Anywhere in the back half of its slot, so two checks cannot land back to back and no two
 * installations ask GitHub at the same moment after a release - which is both rude and the
 * surest way to be rate limited. Exported so the spread can be tested without waiting.
 */
export function nextCheckDelay(random: () => number = Math.random): number {
    const slot = CHECK_WINDOW_MS / CHECKS_PER_WINDOW;
    return slot * (0.5 + random() * 0.5);
}
/** How long to wait when the release exists but its metadata has not appeared yet. */
const RETRY_AFTER_MS = 5 * 60 * 1000;

export type UpdateStatus =
    | { status: "idle" }
    | { status: "checking" }
    | { status: "available"; version: string }
    | { status: "downloading"; percent: number; bytesPerSecond?: number; transferred?: number; total?: number }
    | { status: "ready"; version: string }
    | { status: "installing" }
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
    private installOnQuit = true;

    /**
     * @param enabled whether automatic checking is switched on. Read at each check rather
     *                than captured, so turning it off in settings takes effect immediately
     *                instead of at the next restart.
     */
    constructor(
        private readonly bus: EventEmitter,
        private readonly enabled: () => boolean = () => true,
    ) {}

    get status(): UpdateStatus {
        return this.lastStatus;
    }

    private publish(status: UpdateStatus): void {
        this.lastStatus = status;
        this.bus.emit("update", status);
    }

    /**
     * @param installOnQuit whether a downloaded update installs by itself at the next quit.
     *                      Off for a deb install, where installing means a password prompt -
     *                      asking for one every time the app closes is worse than waiting
     *                      for the user to choose the moment. See installsOnQuit.
     */
    start(updater: UpdaterLike, installOnQuit = true): void {
        // Guarded because the caller loads this from a CommonJS module across an ESM
        // boundary, and got undefined in the packaged build while working in development.
        if (!updater || typeof updater.on !== "function") {
            logger.warn("No usable updater was provided; automatic updates are off.");
            this.publish({ status: "idle" });
            return;
        }
        this.updater = updater;
        // Downloading is fine unattended; installing is not, since it restarts the app and
        // would end a mining session without warning.
        updater.autoDownload = true;
        updater.autoInstallOnAppQuit = installOnQuit;
        this.installOnQuit = installOnQuit;

        updater.on("checking-for-update", () => this.publish({ status: "checking" }));
        updater.on("update-available", (info) =>
            this.publish({ status: "available", version: info?.version ?? "" }),
        );
        updater.on("update-not-available", () => this.publish({ status: "idle" }));
        updater.on("download-progress", (progress) =>
            this.publish({
                status: "downloading",
                percent: Math.round(progress?.percent ?? 0),
                bytesPerSecond: progress?.bytesPerSecond ?? 0,
                transferred: progress?.transferred ?? 0,
                total: progress?.total ?? 0,
            }),
        );
        updater.on("update-downloaded", (info) => {
            // Also fires on a later check when the download is already cached - which is
            // how a pending update announces itself again after the app is reopened.
            logger.info(
                `Update ${info?.version ?? ""} downloaded; ` +
                    (this.installOnQuit ? "it will install on quit." : "it installs when you choose to."),
            );
            this.publish({ status: "ready", version: info?.version ?? "" });
        });

        updater.on("error", (error) => {
            const message = error instanceof Error ? error.message : String(error);
            // A tag exists but its metadata has not finished uploading, or the machine is
            // briefly offline. Neither is worth showing anyone - the next look will find it.
            const transient = isTransientUpdateError(message);
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
        this.scheduleNext();
    }

    /**
     * Three looks every two hours, scattered rather than on the hour.
     *
     * A fixed interval means every installation in the world asks GitHub at the same second
     * after a release, which is both rude and the surest way to be rate limited. Spreading
     * each check randomly across its slot costs nothing and avoids the stampede.
     */
    private scheduleNext(): void {
        this.checkTimer = setTimeout(() => {
            this.check();
            this.scheduleNext();
        }, nextCheckDelay());
        this.checkTimer.unref();
    }

    /** A manual check, which happens whatever the automatic setting says. */
    checkNow(): void {
        this.check(true);
    }

    check(manual = false): void {
        if (!manual && !this.enabled()) {
            logger.debug("Automatic update check skipped: switched off.");
            return;
        }
        // Caught on the promise, not around it. `void` discards the promise, and a
        // try/catch only ever sees a synchronous throw - so a rejected check escaped as an
        // unhandled rejection and took over the screen with a stack trace, because GitHub
        // returned a 504 for a moment.
        // Wrapped rather than chained: the updater is typed loosely on purpose, because
        // what the CommonJS module actually hands back has caught us out before. This
        // handles a promise and a plain value alike.
        Promise.resolve(this.updater?.checkForUpdates()).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            // The `error` event fires for the same failure and decides what to show; this
            // is only here so the rejection is handled at all.
            logger.debug(`Update check rejected: ${message}`);
        });
    }

    /** Restart into the new version now, rather than waiting for the next quit. */
    installNow(): void {
        try {
            // Said before quitting, so the window shows why it is about to disappear
            // rather than simply vanishing mid-click.
            this.publish({ status: "installing" });
            this.updater?.quitAndInstall();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.publish({ status: "error", message });
        }
    }

    stop(): void {
        if (this.checkTimer) {
            clearTimeout(this.checkTimer);
            this.checkTimer = null;
        }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }
}

/**
 * Whether a downloaded update should install itself when the app quits, given the contents
 * of the `package-type` file electron-builder ships in resources (null when there is none).
 *
 * Everywhere but a deb, yes. A deb update goes through pkexec, so installing on quit would
 * ask for a password every time the app closed with an update waiting - including at
 * shutdown, where nobody is there to answer. The dashboard's install button still works.
 */
export function installsOnQuit(packageType: string | null): boolean {
    return packageType?.trim() !== "deb";
}

/** The slice of electron-updater this uses, so tests need not stand the real one up. */
export interface UpdaterLike {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    on(event: string, listener: (payload: any) => void): unknown;
    checkForUpdates(): Promise<unknown> | unknown;
    quitAndInstall(): void;
}

/**
 * Whether an update failure is worth telling anyone about.
 *
 * Almost none of them are. A release whose metadata is still uploading, a machine briefly
 * offline, GitHub returning a 504 for a minute - all of these fix themselves by the next
 * look, and none of them says anything about this installation. Reporting them trains
 * people to ignore the one message that matters, which is that an update is waiting.
 */
export function isTransientUpdateError(message: string): boolean {
    return (
        message.includes("latest.yml") ||
        // The same file for Linux builds, which does not contain "latest.yml".
        message.includes("latest-linux.yml") ||
        message.includes("404") ||
        message.includes("ENOTFOUND") ||
        message.includes("ECONNRESET") ||
        message.includes("net::ERR") ||
        // GitHub having a bad minute: a gateway timeout, or any other 5xx. Matched as an
        // HTTP status rather than as a bare number - "1.502.0" is a version, and treating
        // it as a status would quietly bury a failure that does need reporting.
        /(?:HttpError|status(?:\s*code)?)\s*[:=]?\s*5\d\d\b/i.test(message) ||
        /\b(?:Gateway Timeout|Service Unavailable|Bad Gateway|Internal Server Error)\b/i.test(message) ||
        message.includes("ETIMEDOUT") ||
        message.includes("EAI_AGAIN") ||
        message.includes("socket hang up") ||
        // What electron-updater says when the feed itself would not load.
        message.includes("Unable to find latest version")
    );
}
