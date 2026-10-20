import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every Miner the app builds, so a test can prove sessions do not share one. */
const minersBuilt: FakeMiner[] = [];
/** Every AuthState, to prove the opposite: that one is reused across sessions. */
const authsBuilt: FakeAuth[] = [];

type StartBehaviour = () => Promise<void>;
let nextStart: StartBehaviour = () => new Promise<void>(() => {});

class FakeMiner extends EventEmitter {
    stopped = false;
    constructor() {
        super();
        minersBuilt.push(this);
    }
    async loadPersistedState(): Promise<void> {}
    async loadClaimHistory(): Promise<void> {}
    setSteamLibrary(): void {}
    applyConfig(): void {}
    getCampaigns(): unknown[] {
        return [];
    }
    getMineableCampaigns(): unknown[] {
        return [];
    }
    getNextRefreshAt(): number | null {
        return null;
    }
    stop(): void {
        this.stopped = true;
    }
    start(): Promise<void> {
        return nextStart();
    }
    async runDryRun(): Promise<void> {}
}

let authLoadFails = false;

class FakeAuth {
    userId = "42";
    login = "tester";
    accessToken = "token";
    revoked = 0;
    constructor() {
        authsBuilt.push(this);
    }
    async load(): Promise<boolean> {
        if (authLoadFails) {
            authLoadFails = false; // fail once, then recover
            throw Object.assign(new Error("getaddrinfo EAI_AGAIN id.twitch.tv"), {
                code: "EAI_AGAIN",
            });
        }
        return true;
    }
    async validate(): Promise<boolean> {
        return true;
    }
    async authorize(): Promise<void> {}
    async save(): Promise<void> {}
    async revoke(): Promise<boolean> {
        this.revoked += 1;
        return true;
    }
    clear(): void {}
}

vi.mock("../packages/core/src/miner.js", () => ({ Miner: FakeMiner }));
vi.mock("../packages/core/src/twitch/auth.js", () => ({ AuthState: FakeAuth, AuthError: Error }));
vi.mock("../packages/core/src/twitch/gql.js", async () => {
    class StaleQueryHashError extends Error {}
    class AuthExpiredError extends Error {}
    return {
        TwitchGql: class {
            async searchGames(): Promise<unknown[]> {
                return [];
            }
        },
        StaleQueryHashError,
        AuthExpiredError,
        GqlError: Error,
    };
});

const { createApp } = await import("../packages/core/src/app.js");
const { StaleQueryHashError } = await import("../packages/core/src/twitch/gql.js");

async function makeApp() {
    const dataDir = await mkdtemp(join(tmpdir(), "tdb-session-"));
    return createApp({ dataDir });
}

/**
 * Wait for a condition rather than a fixed number of ticks.
 *
 * Starting a session does real asynchronous work - reading files, and asking whether
 * another instance is already mining this account - so any tick count is a guess that
 * eventually becomes wrong.
 */
async function until(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timed out waiting for: ${what}`);
}

/** Let anything already resolved settle, without depending on how much there is. */
const settle = async () => {
    for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 5));
    }
};

describe("the session loop", () => {
    beforeEach(() => {
        minersBuilt.length = 0;
        authsBuilt.length = 0;
        authLoadFails = false;
        nextStart = () => new Promise<void>(() => {});
    });

    it("builds one miner and reports itself signed in", async () => {
        const app = await makeApp();
        app.start();
        await until(() => minersBuilt.length === 1, "the first miner");

        expect(app.context.getAuthStatus()).toBe("ok");
        await app.stop();
    });

    it("starts a fresh session after a logout, in the same process", async () => {
        const app = await makeApp();
        app.start();
        await until(() => minersBuilt.length === 1, "the first miner");

        await app.context.logout();
        await until(() => minersBuilt.length === 2, "a second miner after logout");

        // A second miner means the loop came back around rather than the process dying.
        expect(minersBuilt[0]!.stopped).toBe(true);
        await app.stop();
    });

    it("reuses the same AuthState across sessions", async () => {
        // Rebuilding it would regenerate the pinned device id and user agent, and Twitch
        // would see a different device on every sign-in.
        const app = await makeApp();
        app.start();
        await until(() => minersBuilt.length === 1, "the first miner");

        await app.context.logout();
        await until(() => minersBuilt.length === 2, "a second miner after logout");

        expect(authsBuilt).toHaveLength(1);
        await app.stop();
    });

    it("revokes the token on the way out", async () => {
        const app = await makeApp();
        app.start();
        await until(() => minersBuilt.length === 1, "the first miner");

        await app.context.logout();
        await until(() => authsBuilt[0]!.revoked === 1, "the token to be revoked");

        expect(authsBuilt[0]!.revoked).toBe(1);
        await app.stop();
    });

    it("parks instead of looping when a query hash has rotated", async () => {
        // There is nothing to retry - a rotated hash needs new code - so the loop must stop
        // while leaving the server and dashboard up to explain themselves.
        nextStart = () => Promise.reject(new StaleQueryHashError("hash rotated"));
        const app = await makeApp();
        const problems: unknown[] = [];
        app.bus.on("problem", (p) => problems.push(p));

        app.start();
        await until(() => problems.length > 0, "a problem to be reported");

        expect(minersBuilt).toHaveLength(1);
        expect(problems).toContainEqual(
            expect.objectContaining({ level: "fatal", code: "stale-hash" }),
        );
        await app.stop();
    });

    it("stops the miner of a session that crashed", async () => {
        // Unwiring alone left its PubSub sockets and timers running, one more set per crash.
        nextStart = () => Promise.reject(new Error("boom"));
        const app = await makeApp();
        const problems: unknown[] = [];
        app.bus.on("problem", (p) => problems.push(p));

        app.start();
        await until(() => problems.length > 0, "the crash to be reported");

        expect(minersBuilt[0]!.stopped).toBe(true);
        await app.stop();
    });

    it("does not keep restarting after stop()", async () => {
        nextStart = () => Promise.resolve();
        const app = await makeApp();
        app.start();
        await until(() => minersBuilt.length === 1, "the first miner");
        await app.stop();
        const built = minersBuilt.length;
        await settle();

        expect(minersBuilt).toHaveLength(built);
    });

    it("exposes the bus and context before any session exists", async () => {
        // The dashboard has to be able to render a login screen before login happens.
        const app = await makeApp();
        expect(app.context.getAuthStatus()).toBe("pending");
        expect(app.context.getMiner()).toBeNull();
        expect(app.bus).toBeInstanceOf(EventEmitter);
    });

    it("recovers from a network failure while signing in", async () => {
        // A name lookup that fails while the machine is waking up, or a container is being
        // rebuilt, used to throw past the loop and end it - leaving the process up, the
        // dashboard served, and nothing mining until somebody noticed.
        authLoadFails = true;
        const app = await makeApp();
        const problems: unknown[] = [];
        app.bus.on("problem", (p) => problems.push(p));

        app.start();
        await until(() => problems.length > 0, "the failure to be reported");

        expect(problems).toContainEqual(
            expect.objectContaining({ code: "session-start" }),
        );
        // And it is not fatal: the loop is still alive and will try again.
        expect(problems.every((p: any) => p.level !== "fatal")).toBe(true);
        await app.stop();
    });
});
