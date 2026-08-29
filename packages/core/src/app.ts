import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { GameArtCache, exactMatch } from "./game-art.js";

import { loadConfig, saveConfig, DEFAULT_CONFIG, type Config } from "./config.js";
import logger from "./logger.js";
import { Miner } from "./miner.js";
import { NotifierGroup } from "./notifiers/index.js";
import { resolveUserPaths, type LegacyPaths, type UserPaths } from "./paths.js";
import {
    InstanceLock,
    instanceLockPath,
    findConflictingInstance,
} from "./instance-guard.js";
import { serializeCampaign } from "./api/serialize.js";
import { SteamLibrary } from "./steam/library.js";
import { resolveSteamId } from "./steam/client.js";
import { BrokerProvider, LibraryError } from "./steam/provider.js";
import { AuthState } from "./twitch/auth.js";
import { TwitchGql, StaleQueryHashError } from "./twitch/gql.js";
import { VERSION } from "./version.js";
import { wireMinerToBus } from "./wiring.js";
import type {
    DeviceCodeInfo,
    ServerContext,
    SteamConnectResult,
    SteamState,
} from "./api/context.js";

export interface AppOptions {
    /** Root of all persisted state: auth.json and users/<id>/ live beneath it. */
    dataDir: string;
    /**
     * The pre-per-user file locations, read once to seed the first account that signs in.
     * Omit when there is nothing to migrate from - a fresh desktop install, say.
     */
    legacyPaths?: LegacyPaths;
    /** Defaults this distribution differs on, layered over DEFAULT_CONFIG. */
    configDefaults?: Partial<Config>;
    /** Ignore stored credentials and go straight to a device-code login. */
    forceLogin?: boolean;
    /** Report what would be mined, then stop. */
    dryRun?: boolean;
    /** A login has begun and is waiting on the user. Fires on first run and after logout. */
    onDeviceCode?(info: DeviceCodeInfo): void;
    /** Credentials have been revoked; the next login round is about to start. */
    onLogout?(): void;
    /** Something the host may want to surface natively - a tray balloon, a dialog. */
    onProblem?(problem: { level: "warn" | "fatal"; code: string; message: string }): void;
    /**
     * The port this host serves its own dashboard on, so the conflict check does not
     * mistake us for a rival.
     *
     * Read when the check runs rather than taken up front: the server usually binds after
     * createApp is called, and a port captured too early would be undefined - leaving the
     * daemon to find itself on 4400 and refuse to start.
     */
    getOwnPort?(): number | null;
}

export interface AppHandle {
    /** The stream the dashboard is fed from. Hosts may emit onto it too. */
    readonly bus: EventEmitter;
    /** Handed to an ApiServer by the host; the core knows nothing about HTTP. */
    readonly context: ServerContext;
    /** Begin the login-then-mine loop. Returns immediately; the work is in the background. */
    start(): void;
    /** Stop for good. Bounded: it signals and flushes rather than waiting things out. */
    stop(): Promise<void>;
    /** Run the dry-run report instead of mining. */
    runDryRun(): Promise<void>;
}

/** How a session ended, which decides what the loop does next. */
type SessionOutcome = "logout" | "stopped" | "stale-hash" | "crashed";

/**
 * Everything the bot is, minus how it is delivered.
 *
 * The split that matters is between what survives a sign-out and what does not. Credentials,
 * the event bus and the dashboard's view of the world persist, so a browser tab watching the
 * SSE stream keeps working across a logout. The miner, the notifier and the account's files
 * belong to one session and are rebuilt for the next.
 *
 * This used to be the back half of a CLI entry point, where signing out meant exiting and
 * letting Docker start the process again. A desktop app has nothing to restart it.
 */
export function createApp(options: AppOptions): AppHandle {
    const dataDir = options.dataDir;
    const authPath = join(dataDir, "auth.json");
    const bus = new EventEmitter();
    // Sessions come and go; these do not. Rebuilding AuthState would regenerate the pinned
    // device ID and user agent, which Twitch reads as a different device on every sign-in.
    const auth = new AuthState();
    const gqlForSearch = new TwitchGql(auth);
    // Box art for games that have no campaign running. Kept at the data root rather than
    // per user: which poster Twitch uses for a game is not anybody's private business.
    const gameArt = new GameArtCache(join(dataDir, "game-art.json"), async (name) =>
        exactMatch(name, await gqlForSearch.searchGames(name)),
    );
    const steamLibrary = new SteamLibrary();

    let paths: UserPaths | null = null;
    let config: Config = { ...DEFAULT_CONFIG, ...(options.configDefaults ?? {}) };
    let notifier = new NotifierGroup(config);
    let miner: Miner | null = null;
    let unwire: (() => void) | null = null;
    let authStatus: "pending" | "ok" = "pending";
    let deviceCode: DeviceCodeInfo | null = null;
    let steamLastError: { code: string; message: string } | null = null;
    let warnedClientOutdated = false;
    let steamRetryTimer: NodeJS.Timeout | null = null;

    let stopped = false;
    let logoutRequested: (() => void) | null = null;
    const lock = new InstanceLock(instanceLockPath(dataDir));

    const problem = (level: "warn" | "fatal", code: string, message: string): void => {
        bus.emit("problem", { level, code, message });
        options.onProblem?.({ level, code, message });
    };

    /**
     * The soonest to try again when a library has never loaded at all.
     *
     * Once there is a cached library, a failed refresh costs nothing: mining carries on
     * ranking against yesterday's copy and the next scheduled refresh picks it up. With no
     * library at all the whole library policy is inert - every game counts as unowned - so
     * the gap between a broker hiccup and the next daily refresh is a day of mining the
     * wrong things. One retry closes that without turning into a poll.
     *
     * A floor, not a schedule. The broker's per-minute burst allowance counts every call,
     * cached ones included, so retrying hard would earn a 429 on top of whatever went
     * wrong; and when it names a wait of its own, that wins.
     */
    const FIRST_LIBRARY_RETRY_MS = 15 * 60_000;

    const buildSteamProvider = (): BrokerProvider => {
        const { steamId, brokerBaseUrl } = config.steam;
        if (!steamId) {
            throw new Error("No Steam account connected.");
        }
        return new BrokerProvider(steamId, brokerBaseUrl);
    };

    const steamState = (): SteamState => ({
        linked: config.steam.linked,
        steamId: config.steam.steamId ?? null,
        personaName: steamLibrary.personaName || null,
        gameCount: steamLibrary.size,
        recencySignal: steamLibrary.isLoaded ? steamLibrary.recencySignal : null,
        stale: steamLibrary.stale,
        fetchedAt: steamLibrary.fetchedAt ? new Date(steamLibrary.fetchedAt).toISOString() : null,
        lastError: steamLastError,
    });

    /**
     * Tell the dashboard Steam changed.
     *
     * Without this a sign-in that finishes in the external browser leaves the window
     * showing the old state until something reloads it - and on the desktop build the
     * browser is where the round trip always ends.
     */
    const emitSteam = (): void => {
        bus.emit("steam", steamState());
    };

    /** Try again later, once, because there is no library to fall back on. */
    const scheduleFirstLibraryRetry = (retryAfterSeconds?: number): void => {
        if (steamRetryTimer || steamLibrary.isLoaded || !config.steam.steamId) {
            return;
        }
        const delay = Math.max(FIRST_LIBRARY_RETRY_MS, (retryAfterSeconds ?? 0) * 1000);
        steamRetryTimer = setTimeout(() => {
            steamRetryTimer = null;
            void refreshSteam()
                .then(() => miner?.setSteamLibrary(steamLibrary))
                .catch((error) => {
                    logger.debug(`Steam library retry failed: ${(error as Error).message}`);
                });
        }, delay).unref();
    };

    const refreshSteam = async (): Promise<number> => {
        if (!paths) {
            throw new Error("Not signed in yet.");
        }
        const provider = buildSteamProvider();
        try {
            const count = await steamLibrary.refresh(provider);
            await steamLibrary.save(paths.steam);
            steamLastError = null;
            warnedClientOutdated = false;
            emitSteam();
            return count;
        } catch (error) {
            const failure =
                error instanceof LibraryError
                    ? { code: error.code, message: error.message }
                    : { code: "unavailable", message: (error as Error).message };
            steamLastError = failure;
            emitSteam();

            // The one failure the user cannot wait out: this build has been cut off and
            // will keep failing until it is updated. Said once, not every refresh.
            if (failure.code === "client_outdated" && !warnedClientOutdated) {
                warnedClientOutdated = true;
                await notifier
                    .send({
                        title: "Sluice needs updating to read Steam",
                        lines: [
                            failure.message,
                            steamLibrary.isLoaded
                                ? `Mining continues on the cached library (${steamLibrary.size} games).`
                                : "Campaign ranking is running without a Steam library until then.",
                        ],
                        url: null,
                        kind: "warning",
                    })
                    .catch(() => {});
            }
            // Nothing to wait for when the account itself is gone: retrying a 404 on a
            // timer would spend calls forever on an answer that cannot change until the
            // user links a different account.
            if (failure.code !== "profile_not_found") {
                scheduleFirstLibraryRetry(
                    error instanceof LibraryError ? error.retryAfterSeconds : undefined,
                );
            }
            throw error;
        }
    };

    const context: ServerContext = {
        auth,
        version: VERSION,
        startedAt: Date.now(),
        bus,
        getAuthStatus: () => authStatus,
        getDeviceCode: () => deviceCode,
        getMiner: () => miner,
        getConfig: () => config,
        setConfig: async (next: Config) => {
            config = next;
            // Before the first sign-in there is no account directory to save into, and the
            // pre-login config is only ever defaults - nothing worth persisting.
            if (paths) {
                await saveConfig(paths.config, next);
            }
            notifier = new NotifierGroup(next);
            miner?.applyConfig(next);
            // A game just added to the list has no campaign to learn its art from, so go
            // and find it. Nothing waits on this.
            void gameArt.ensure(next.priorityGames);
            if (miner) {
                bus.emit("campaigns", {
                    campaigns: miner.getCampaigns().map((c) => serializeCampaign(c, next, miner?.ownsPredicate ?? null)),
                    queue: miner.getMineableCampaigns().map((c) => c.id),
                });
            }
        },
        getNotifier: () => notifier,
        getSteamLibrary: () => (steamLibrary.isLoaded ? steamLibrary : null),
        getSteamState: steamState,
        searchGames: (term: string) => gqlForSearch.searchGames(term),
        getGameArt: () => gameArt.toRecord(),
        connectSteam: async (input): Promise<SteamConnectResult> => {
            // Throws if the input names nothing Steam recognises, which is the only part of
            // this the user got wrong rather than something being unavailable.
            const steamId = await resolveSteamId(input.steamId);

            // Whose account it is, before the library, so a link that sticks can still say
            // who it linked when the library turns out to be private. Two calls rather than
            // one - the summary is cached and charged separately - which is why this is
            // done here and nowhere else.
            const summary = await new BrokerProvider(steamId, config.steam.brokerBaseUrl)
                .fetchSummary()
                .catch(() => null);

            // A different account means the games we hold belong to somebody else.
            if (config.steam.steamId && config.steam.steamId !== steamId) {
                steamLibrary.clear();
                miner?.setSteamLibrary(null);
            }
            if (summary?.personaName) {
                steamLibrary.personaName = summary.personaName;
            }
            await context.setConfig({
                ...config,
                steam: { ...config.steam, linked: input.via, steamId },
            });

            try {
                const gameCount = await refreshSteam();
                miner?.setSteamLibrary(steamLibrary);
                return { personaName: steamLibrary.personaName, gameCount, error: null };
            } catch (error) {
                // The link is made and stays made. Reading a library and identifying an
                // account are separate things, and a private profile fails only the first.
                const failure =
                    error instanceof LibraryError
                        ? { code: error.code, message: error.message }
                        : { code: "unavailable", message: (error as Error).message };
                return {
                    personaName: summary?.personaName ?? steamLibrary.personaName,
                    gameCount: steamLibrary.size,
                    error: failure,
                };
            }
        },
        skipSteam: async () => {
            await context.setConfig({ ...config, steam: { ...config.steam, linked: "skipped" } });
            emitSteam();
        },
        logout: async () => {
            logger.info("Signing out by request.");
            // Revoke first: deleting the file alone leaves the token live on Twitch, still
            // listed among the account's authorised connections.
            const revoked = await auth.revoke();
            await rm(authPath, { force: true });
            logger.info(
                revoked
                    ? "Token revoked and credentials removed."
                    : "Credentials removed; Twitch did not confirm the revocation.",
            );
            // Signalled, not awaited. The miner's loop can be parked in a sleep for up to a
            // refresh interval, and the user is waiting on a screen that should change now.
            // Phase 1 made its sockets unable to come back, so letting it unwind is safe.
            miner?.stop();
            logoutRequested?.();
            return { revoked };
        },
        refreshSteam,
        disconnectSteam: async () => {
            // The games go with the account. Leaving them behind would keep ownership
            // gating and playtime ranking running off a library nothing is linked to, and
            // the dashboard would report a persona for an account it no longer holds.
            steamLibrary.clear();
            miner?.setSteamLibrary(null);
            if (paths) {
                await rm(paths.steam, { force: true }).catch(() => {});
            }
            steamLastError = null;
            await context.setConfig({
                ...config,
                // Back to null rather than "skipped": disconnecting is not the same as
                // declining, and the offer to link should come back.
                steam: { ...config.steam, linked: null, steamId: undefined },
            });
            emitSteam();
        },
    };

    /**
     * Sign in and build everything a session needs, stopping short of actually mining.
     *
     * Returns false when the app was told to stop while a login was still outstanding -
     * a device-code prompt can sit unanswered for half an hour.
     */
    async function prepareSession(forceLogin: boolean): Promise<boolean> {
        authStatus = "pending";
        deviceCode = null;

        const restored = forceLogin ? false : await auth.load(authPath);
        if (!restored || !(await auth.validate())) {
            if (restored) {
                logger.warn("Stored credentials are no longer valid; logging in again.");
            }
            await auth.authorize((verificationUri, userCode, expiresIn) => {
                deviceCode = {
                    code: userCode,
                    url: verificationUri,
                    // Twitch's own lifetime rather than a guess: the countdown on screen has
                    // to match the code it is counting down, or it lies at one end or both.
                    expiresAt: Date.now() + expiresIn * 1000,
                };
                bus.emit("auth", { status: "pending", device: deviceCode });
                options.onDeviceCode?.(deviceCode);
            });
            await auth.save(authPath);
        } else {
            logger.info(`Logged in as ${auth.login}`);
            // Re-save so an older credential file picks up newer fields, keeping the
            // install's identity stable from here on.
            await auth.save(authPath);
        }

        if (stopped) {
            return false;
        }

        paths = await resolveUserPaths(dataDir, options.legacyPaths ?? legacyFallback(dataDir), {
            userId: auth.userId,
            login: auth.login,
        });
        config = {
            ...(await loadConfig(paths.config)),
            ...(options.configDefaults ?? {}),
        };
        notifier = new NotifierGroup(config);
        await steamLibrary.load(paths.steam);
        // Someone who read their library through a SinfulShadows key never had a Steam ID
        // in their config - the site derived it from the linked account, and the only copy
        // that reached this machine is the one in steam.json. Adopt it, so the change to a
        // keyless broker costs them nothing and asks them nothing.
        if (!config.steam.steamId && !config.steam.linked && steamLibrary.steamId) {
            config = {
                ...config,
                steam: { ...config.steam, linked: "profile", steamId: steamLibrary.steamId },
            };
            await saveConfig(paths.config, config);
            logger.info(
                `Kept your linked Steam account (${steamLibrary.personaName || steamLibrary.steamId}); ` +
                    "no key is needed for it any more.",
            );
        }
        await gameArt.load();
        // Not awaited: a poster is never worth delaying the start of mining for.
        void gameArt.ensure(config.priorityGames);
        logger.info(`Data for ${auth.login}: ${paths.dir}`);

        // Two copies mining one account contradict each other's watch sessions and write
        // the same files. Both ways that can happen are checked before doing any of it.
        const heldBy = await lock.acquire({ userId: auth.userId, login: auth.login });
        if (heldBy) {
            const message =
                `Another copy of the bot (pid ${heldBy.heldBy.pid}) is already using ` +
                `${dataDir}. Close it before starting this one.`;
            logger.error(message);
            problem("fatal", "already-running", message);
            return false;
        }
        const rival = await findConflictingInstance(auth.userId, {
            ignorePort: options.getOwnPort?.() ?? undefined,
        });
        if (rival) {
            const message =
                `Another copy of the bot is already mining this account on port ${rival.port} - ` +
                "probably the Docker container. Mining twice on one account makes Twitch " +
                "credit neither session reliably. Stop the other one, then try again.";
            logger.error(message);
            problem("fatal", "already-mining", message);
            await lock.release();
            return false;
        }

        authStatus = "ok";
        deviceCode = null;
        bus.emit("auth", { status: "ok", user: { id: auth.userId, displayName: auth.login } });

        const gql = new TwitchGql(auth);
        // A fresh Miner every session: its `stopping` latch is one-way by design.
        miner = new Miner(auth, gql, config);
        await miner.loadPersistedState(paths.state);
        await miner.loadClaimHistory(paths.claims);
        miner.setSteamLibrary(steamLibrary.isLoaded ? steamLibrary : null);

        if (config.steam.steamId) {
            const ageHours = (Date.now() - steamLibrary.fetchedAt) / 3_600_000;
            if (!steamLibrary.isLoaded || ageHours >= config.steam.refreshHours) {
                try {
                    await refreshSteam();
                    miner.setSteamLibrary(steamLibrary);
                } catch (error) {
                    // A stale library still ranks better than none, so keep going. When
                    // there is no library at all, refreshSteam has already booked a retry.
                    logger.warn(`Could not refresh the Steam library: ${(error as Error).message}`);
                }
            }
        }

        unwire = wireMinerToBus({
            miner,
            bus,
            notifier,
            getConfig: () => config,
        });
        return true;
    }

    /** Sign in, then mine until something ends the session. */
    async function runSession(forceLogin: boolean): Promise<SessionOutcome> {
        // Signing in touches the network before any of the mining code runs, and a name
        // lookup that fails while the machine is waking up or a container is being rebuilt
        // used to throw straight past the loop and end it - leaving the process alive,
        // serving a dashboard, and mining nothing until somebody noticed. Anything that
        // goes wrong before the miner exists is a crash like any other: back off and try
        // again.
        try {
            if (!(await prepareSession(forceLogin))) {
                return "stopped";
            }
        } catch (error) {
            logger.warn(`Could not start a session: ${(error as Error).message}`);
            problem("warn", "session-start", (error as Error).message);
            return "crashed";
        }
        const active = miner;
        if (!active) {
            return "stopped";
        }

        const logoutSignal = new Promise<SessionOutcome>((resolveSignal) => {
            logoutRequested = () => resolveSignal("logout");
        });

        try {
            return await Promise.race([
                active.start().then((): SessionOutcome => "stopped"),
                logoutSignal,
            ]);
        } catch (error) {
            if (error instanceof StaleQueryHashError) {
                logger.error(error.message);
                logger.error("Mining is paused. The dashboard remains available.");
                problem("fatal", "stale-hash", error.message);
                return "stale-hash";
            }
            logger.error("Mining stopped unexpectedly:", error);
            problem("warn", "generic", (error as Error).message);
            return "crashed";
        } finally {
            unwire?.();
            unwire = null;
            logoutRequested = null;
        }
    }

    async function loop(): Promise<void> {
        let backoff = 30_000;
        let forceLogin = options.forceLogin ?? false;

        while (!stopped) {
            const outcome = await runSession(forceLogin);
            forceLogin = false;

            if (outcome === "logout") {
                options.onLogout?.();
                // Straight back to the device-code screen, in the same process, with the
                // dashboard's SSE stream never having dropped.
                backoff = 30_000;
                continue;
            }
            if (outcome === "stale-hash" || outcome === "stopped") {
                return;
            }

            logger.warn(`Restarting the session in ${Math.round(backoff / 1000)}s.`);
            await new Promise((r) => setTimeout(r, backoff).unref());
            backoff = Math.min(backoff * 2, 600_000);
        }
    }

    return {
        bus,
        context,
        start(): void {
            // The loop is meant to be the thing that survives; if it ever throws its way
            // out, say so loudly rather than going quiet with the dashboard still up.
            void loop().catch((error) => {
                logger.error("Session loop stopped unexpectedly:", error);
                problem("fatal", "loop-failed", (error as Error).message);
            });
        },
        async stop(): Promise<void> {
            stopped = true;
            if (steamRetryTimer) {
                clearTimeout(steamRetryTimer);
                steamRetryTimer = null;
            }
            miner?.stop();
            unwire?.();
            await lock.release();
            // Persistence is written eagerly at every mutation, so there is nothing to
            // flush here beyond letting an in-flight write land.
            await new Promise((r) => setTimeout(r, 250).unref());
        },
        async runDryRun(): Promise<void> {
            // Set a session up and report on it without ever starting the watch loop.
            if (await prepareSession(options.forceLogin ?? false)) {
                await miner?.runDryRun();
            }
            unwire?.();
            unwire = null;
        },
    };
}

/** Where the flat files sat before accounts had their own directories. */
function legacyFallback(dataDir: string): LegacyPaths {
    return {
        config: join(dataDir, "config.json"),
        steam: join(dataDir, "steam.json"),
        state: join(dataDir, "state.json"),
        claims: join(dataDir, "claims.json"),
    };
}
