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

class FakeAuth {
    userId = "42";
    login = "tester";
    accessToken = "token";
    revoked = 0;
    constructor() {
        authsBuilt.push(this);
    }
    async load(): Promise<boolean> {
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

vi.mock("../src/miner.js", () => ({ Miner: FakeMiner }));
vi.mock("../src/twitch/auth.js", () => ({ AuthState: FakeAuth, AuthError: Error }));
vi.mock("../src/twitch/gql.js", async () => {
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

const { createApp } = await import("../src/app.js");
const { StaleQueryHashError } = await import("../src/twitch/gql.js");

async function makeApp() {
    const dataDir = await mkdtemp(join(tmpdir(), "tdb-session-"));
    return createApp({ dataDir });
}

/** Let the microtask queue and any zero-delay timers drain. */
const settle = async () => {
    for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
    }
};

describe("the session loop", () => {
    beforeEach(() => {
        minersBuilt.length = 0;
        authsBuilt.length = 0;
        nextStart = () => new Promise<void>(() => {});
    });

    it("builds one miner and reports itself signed in", async () => {
        const app = await makeApp();
        app.start();
        await settle();

        expect(minersBuilt).toHaveLength(1);
        expect(app.context.getAuthStatus()).toBe("ok");
        await app.stop();
    });

    it("starts a fresh session after a logout, in the same process", async () => {
        const app = await makeApp();
        app.start();
        await settle();
        expect(minersBuilt).toHaveLength(1);

        await app.context.logout();
        await settle();

        // A second miner means the loop came back around rather than the process dying.
        expect(minersBuilt).toHaveLength(2);
        expect(minersBuilt[0]!.stopped).toBe(true);
        await app.stop();
    });

    it("reuses the same AuthState across sessions", async () => {
        // Rebuilding it would regenerate the pinned device id and user agent, and Twitch
        // would see a different device on every sign-in.
        const app = await makeApp();
        app.start();
        await settle();

        await app.context.logout();
        await settle();

        expect(authsBuilt).toHaveLength(1);
        await app.stop();
    });

    it("revokes the token on the way out", async () => {
        const app = await makeApp();
        app.start();
        await settle();

        await app.context.logout();
        await settle();

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
        await settle();

        expect(minersBuilt).toHaveLength(1);
        expect(problems).toContainEqual(
            expect.objectContaining({ level: "fatal", code: "stale-hash" }),
        );
        await app.stop();
    });

    it("does not keep restarting after stop()", async () => {
        nextStart = () => Promise.resolve();
        const app = await makeApp();
        app.start();
        await settle();
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
});
