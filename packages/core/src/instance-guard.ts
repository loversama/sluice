import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { request } from "undici";

import { writeFileAtomic } from "./atomic-write.js";
import logger from "./logger.js";

/**
 * Mining one Twitch account from two places at once is actively harmful: the two watch
 * sessions contradict each other, Twitch credits neither reliably, and both write the same
 * progress files. The README says not to; this makes it hard to do by accident.
 *
 * Two different problems, needing two mechanisms. Two processes over one data directory are
 * caught by a lock file. A container and a desktop app cannot see each other's files at all
 * - the container's filesystem is its own - so those are caught by asking whoever is
 * already serving the dashboard who they are signed in as.
 */

/** How often the holder refreshes its claim. */
const HEARTBEAT_MS = 30_000;
/** Beyond this with no refresh, the holder is presumed gone rather than merely busy. */
const STALE_AFTER_MS = 90_000;

interface LockContents {
    pid: number;
    userId: string;
    login: string;
    startedAt: number;
    heartbeatAt: number;
}

export class InstanceLock {
    private timer: NodeJS.Timeout | null = null;
    private held = false;

    constructor(private readonly path: string) {}

    /**
     * Take the lock, or report who already holds it.
     *
     * A lock whose process is gone, or which has stopped refreshing, is taken over rather
     * than treated as permanent - otherwise a hard kill would lock the user out of their
     * own bot until they went looking for a file.
     */
    async acquire(owner: { userId: string; login: string }): Promise<{ heldBy: LockContents } | null> {
        const existing = await this.read();
        // Our own lock, from a previous session in this same process. Signing out and back
        // in must not be blocked by the claim we ourselves left behind.
        if (existing && existing.pid !== process.pid && this.looksAlive(existing)) {
            return { heldBy: existing };
        }
        if (existing) {
            logger.debug(`Taking over a stale instance lock from pid ${existing.pid}.`);
        }
        await this.write(owner);
        this.held = true;
        // The same lock is acquired again at every sign-in. Without this the previous
        // session's heartbeat kept running beside the new one, one more per sign-out.
        if (this.timer) {
            clearInterval(this.timer);
        }
        this.timer = setInterval(() => {
            void this.write(owner).catch(() => {});
        }, HEARTBEAT_MS);
        this.timer.unref();
        return null;
    }

    async release(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (!this.held) {
            return;
        }
        this.held = false;
        await rm(this.path, { force: true }).catch(() => {});
    }

    private looksAlive(lock: LockContents): boolean {
        if (Date.now() - lock.heartbeatAt > STALE_AFTER_MS) {
            return false;
        }
        // Same-machine only, and deliberately so: a pid from inside a container means
        // nothing out here, which is exactly why the heartbeat carries the real weight.
        try {
            process.kill(lock.pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    private async read(): Promise<LockContents | null> {
        try {
            return JSON.parse(await readFile(this.path, "utf8")) as LockContents;
        } catch {
            return null;
        }
    }

    private async write(owner: { userId: string; login: string }): Promise<void> {
        const now = Date.now();
        const existing = await this.read();
        await writeFileAtomic(
            this.path,
            JSON.stringify(
                {
                    pid: process.pid,
                    userId: owner.userId,
                    login: owner.login,
                    startedAt: existing?.pid === process.pid ? existing.startedAt : now,
                    heartbeatAt: now,
                } satisfies LockContents,
                null,
                2,
            ),
        );
    }
}

export function instanceLockPath(dataDir: string): string {
    return join(dataDir, "instance.lock");
}

/** Somebody else is already mining this account, and where they are answering. */
export interface ConflictingInstance {
    port: number;
    login: string;
    userId: string;
}

/**
 * Ports another copy of this bot is likely to be answering on.
 *
 * 4400 is the documented default and what docker-compose publishes, so in practice this
 * finds a running container from a desktop app on the same machine.
 */
const LIKELY_PORTS = [4400];

/**
 * Ask whoever is serving a dashboard on this machine which account they are mining.
 *
 * Deliberately narrow: a positive answer means another copy of *this* bot is signed in as
 * the same user, which is the case worth refusing. Anything else - nothing listening, a
 * different program, a different account - is not our business.
 */
export async function findConflictingInstance(
    userId: string,
    options: { ignorePort?: number; ports?: number[] } = {},
): Promise<ConflictingInstance | null> {
    for (const port of options.ports ?? LIKELY_PORTS) {
        if (port === options.ignorePort) {
            continue;
        }
        try {
            const response = await request(`http://127.0.0.1:${port}/api/state`, {
                method: "GET",
                headersTimeout: 2000,
                bodyTimeout: 2000,
            });
            if (response.statusCode !== 200) {
                await response.body.dump();
                continue;
            }
            const body = (await response.body.json()) as {
                auth?: { user?: { id?: string; displayName?: string } };
            };
            const other = body.auth?.user;
            if (other?.id && other.id === userId) {
                return { port, userId: other.id, login: other.displayName ?? "" };
            }
        } catch {
            // Nothing listening, or not something that answers our API. Either is fine.
        }
    }
    return null;
}
