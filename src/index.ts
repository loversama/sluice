import { EventEmitter } from "node:events";
import { basename, dirname, join, resolve } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadConfig, saveConfig, type Config } from "./config.js";
import logger, { setLogLevel, type LogLevel } from "./logger.js";
import { Miner } from "./miner.js";
import type { Campaign } from "./models/campaign.js";
import { NotifierGroup } from "./notifiers/index.js";
import { AuthState } from "./twitch/auth.js";
import { AuthExpiredError, StaleQueryHashError, TwitchGql } from "./twitch/gql.js";
import { ApiServer, type DeviceCodeInfo, type ServerContext } from "./api/server.js";
import { serializeCampaign } from "./api/serialize.js";
import { SteamClient, resolveSteamId } from "./steam/client.js";
import { VERSION } from "./version.js";
import {
    DirectSteamProvider,
    SinfulShadowsProvider,
    LibraryError,
    type LibraryProvider,
} from "./steam/provider.js";
import { SteamLibrary } from "./steam/library.js";


const HELP = `
Twitch Drops Bot - browserless Twitch drop miner

Usage: twitch-drops-bot [options]

Options:
  -c, --config <path>   Config file (default: ./config.json)
  -a, --auth <path>     Credential store (default: ./auth.json)
      --steam <path>    Steam library cache (default: ./steam.json)
      --state <path>    Notification bookkeeping (default: ./state.json)
  -l, --log <level>     error | warn | info | debug
      --web             Serve the dashboard and HTTP API
      --web-addr <addr> Address for the dashboard (default: 127.0.0.1:4400)
      --dry-run         Report what would be mined, then exit. Sends nothing.
      --logout          Discard stored credentials and log in again
  -h, --help            Show this message
`.trim();

function parseAddress(value: string): { host: string; port: number } {
    const separator = value.lastIndexOf(":");
    if (separator === -1) {
        return { host: "127.0.0.1", port: Number(value) };
    }
    return { host: value.slice(0, separator), port: Number(value.slice(separator + 1)) };
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            config: { type: "string", short: "c", default: "config.json" },
            auth: { type: "string", short: "a", default: "auth.json" },
            steam: { type: "string", default: "steam.json" },
            state: { type: "string", default: "state.json" },
            claims: { type: "string", default: "claims.json" },
            log: { type: "string", short: "l" },
            web: { type: "boolean", default: false },
            "web-addr": { type: "string", default: "127.0.0.1:4400" },
            "dry-run": { type: "boolean", default: false },
            logout: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
        },
    });

    if (values.help) {
        console.log(HELP);
        return;
    }

    let configPath = resolve(values.config!);
    const authPath = resolve(values.auth!);
    // Everything but the credentials themselves lives under a per-account directory beside
    // them, so signing out keeps a user's drop history and settings, and a second account
    // starts clean instead of inheriting the first one's.
    const dataDir = dirname(authPath);

    let config = await loadConfig(configPath);
    setLogLevel((values.log as LogLevel) ?? config.logLevel);
    logger.info(`Config: ${configPath}`);

    const auth = new AuthState();
    // The search endpoint is available as soon as the server is, before the miner exists.
    const gqlForSearch = new TwitchGql(auth);
    // Rebuilt whenever the config changes: the group snapshots its channels at
    // construction, so a token added at runtime would otherwise do nothing until restart.
    let notifier = new NotifierGroup(config);
    // Decouples the miner's lifetime from the server's: the server starts first, before a
    // miner exists, and simply relays whatever arrives on this bus.
    const bus = new EventEmitter();

    let miner: Miner | null = null;
    let authStatus: "pending" | "ok" = "pending";
    let deviceCode: DeviceCodeInfo | null = null;

    let steamPath = resolve(values.steam!);
    let statePath = resolve(values.state!);
    let claimsPath = resolve(values.claims!);
    const steamLibrary = new SteamLibrary();
    await steamLibrary.load(steamPath);

    /** Build the configured library provider, or explain what is still missing. */
    const buildSteamProvider = (): LibraryProvider => {
        if (config.steam.provider === "sinfulshadows") {
            const { apiKey, baseUrl } = config.steam.sinfulshadows;
            if (!apiKey) {
                throw new Error("No SinfulShadows API key configured.");
            }
            return new SinfulShadowsProvider(apiKey, baseUrl);
        }
        const { apiKey, steamId } = config.steam;
        if (!apiKey) {
            throw new Error("No Steam API key configured.");
        }
        if (!steamId) {
            throw new Error("No Steam account connected.");
        }
        return new DirectSteamProvider(new SteamClient(apiKey), steamId);
    };

    /**
     * A rejected SinfulShadows key is worth telling the user about once, not on every
     * refresh cycle - the library keeps working from cache in the meantime.
     */
    let warnedKeyRejected = false;

    /** Pull the library from the configured provider. */
    const refreshSteam = async (): Promise<number> => {
        const provider = buildSteamProvider();
        try {
            const count = await steamLibrary.refresh(provider);
            await steamLibrary.save(steamPath);
            warnedKeyRejected = false;
            return count;
        } catch (error) {
            if (error instanceof LibraryError && error.code === "key_invalid" && !warnedKeyRejected) {
                warnedKeyRejected = true;
                await notifier
                    .send({
                        title: "SinfulShadows key rejected",
                        lines: [
                            error.message,
                            `Mining continues on the cached library (${steamLibrary.size} games).`,
                        ],
                        url: error.actionUrl ?? null,
                        kind: "warning",
                    })
                    .catch(() => {});
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
            await saveConfig(configPath, next);
            notifier = new NotifierGroup(next);
            miner?.applyConfig(next);
            // Ranking may have changed, so push a fresh campaign view to the dashboard.
            if (miner) {
                bus.emit("campaigns", {
                    campaigns: miner.getCampaigns().map((c) => serializeCampaign(c, next)),
                    queue: miner.getMineableCampaigns().map((c) => c.id),
                });
            }
        },
        getNotifier: () => notifier,
        getSteamLibrary: () => (steamLibrary.isLoaded ? steamLibrary : null),
        searchGames: (term: string) => gqlForSearch.searchGames(term),
        connectSteam: async (input) => {
            // The SinfulShadows path needs one credential and nothing else: the Steam account
            // comes from whatever the key's owner linked on the site.
            if (input.provider === "sinfulshadows") {
                const apiKey = input.sinfulshadowsApiKey ?? config.steam.sinfulshadows.apiKey;
                if (!apiKey) {
                    throw new Error("No SinfulShadows API key given.");
                }
                const baseUrl = config.steam.sinfulshadows.baseUrl;
                // Verify before saving, so a typo is reported rather than stored.
                const identity = await new SinfulShadowsProvider(apiKey, baseUrl).verify();
                await context.setConfig({
                    ...config,
                    steam: {
                        ...config.steam,
                        provider: "sinfulshadows",
                        sinfulshadows: { ...config.steam.sinfulshadows, apiKey },
                    },
                });
                if (!identity.steamLinked) {
                    throw new Error(
                        "Key accepted, but no Steam account is linked to it. Link Steam at " +
                            `${baseUrl}/settings/connections, then refresh.`,
                    );
                }
                warnedKeyRejected = false;
                return refreshSteam();
            }

            const apiKey = input.apiKey ?? config.steam.apiKey;
            // Identity first: a profile URL resolves through Steam's community XML view,
            // which needs no key, so the account can be attached before one is supplied.
            const steamId = input.steamId
                ? await resolveSteamId(input.steamId, apiKey ? new SteamClient(apiKey) : undefined)
                : config.steam.steamId;
            if (!steamId) {
                throw new Error("No Steam account given.");
            }
            await context.setConfig({
                ...config,
                steam: { ...config.steam, provider: "direct", apiKey, steamId },
            });
            // Reading the library is the part that genuinely requires a key.
            if (!apiKey) {
                throw new Error(
                    "Account saved. Add a Web API key to read your library - the key is what " +
                        "grants access to it.",
                );
            }
            return refreshSteam();
        },
        logout: async () => {
            logger.info("Signing out by request.");
            // Revoke first: deleting the file alone leaves the token live on Twitch, still
            // listed among the account's authorised connections.
            const revoked = await auth.revoke();
            await rm(authPath, { force: true });
            // Only the credentials go. The account's directory - drop history, settings,
            // Steam library - is left untouched so signing back in restores it.
            logger.info(
                revoked
                    ? "Token revoked and credentials removed."
                    : "Credentials removed; Twitch did not confirm the revocation.",
            );
            miner?.stop();
            // The device-code flow runs once, at startup, so the way back to it is a
            // restart. Docker brings the container straight back to the login screen.
            setTimeout(() => process.exit(0), 250);
            return { revoked };
        },
        refreshSteam,
        disconnectSteam: async () => {
            await context.setConfig({
                ...config,
                steam: {
                    ...config.steam,
                    provider: "direct",
                    apiKey: undefined,
                    steamId: undefined,
                    sinfulshadows: { ...config.steam.sinfulshadows, apiKey: undefined },
                },
            });
        },
    };

    let server: ApiServer | null = null;
    if (values.web) {
        const staticDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");
        server = new ApiServer(context, staticDir);
        const { host, port } = parseAddress(values["web-addr"]!);
        await server.listen(host, port);
    }

    const restored = values.logout ? false : await auth.load(authPath);

    if (!restored || !(await auth.validate())) {
        if (restored) {
            logger.warn("Stored credentials are no longer valid; logging in again.");
        }
        await auth.authorize((verificationUri, userCode) => {
            deviceCode = {
                code: userCode,
                url: verificationUri,
                // Twitch device codes are valid for 30 minutes.
                expiresAt: Date.now() + 30 * 60_000,
            };
            bus.emit("auth", { status: "pending", device: deviceCode });
            console.log("\n" + "=".repeat(58));
            console.log("  Authorize this bot with your Twitch account:");
            console.log(`  1. Open ${verificationUri}`);
            console.log(`  2. Enter the code:  ${userCode}`);
            console.log("=".repeat(58) + "\n");
            if (values.web) {
                console.log(`(You can also do this from the dashboard.)`);
            }
            console.log("Waiting for you to approve...");
        });
        await auth.save(authPath);
    } else {
        logger.info(`Logged in as ${auth.login}`);
        // Re-save so an older credential file picks up newer fields (such as the pinned
        // device string), keeping the identity stable from here on.
        await auth.save(authPath);
    }

    // Now that we know who is signed in, move to that account's own directory. The flat
    // files from before this existed are adopted once, so an upgrade keeps its history.
    {
        const userDir = join(dataDir, "users", auth.userId);
        await mkdir(userDir, { recursive: true });
        const adopt = async (legacy: string, owned: string): Promise<string> => {
            const hasOwn = await readFile(owned).then(
                () => true,
                () => false,
            );
            if (!hasOwn) {
                const legacyContents = await readFile(legacy, "utf8").catch(() => null);
                if (legacyContents !== null) {
                    await writeFile(owned, legacyContents);
                    logger.info(`Adopted ${basename(legacy)} for ${auth.login}.`);
                }
            }
            return owned;
        };
        configPath = await adopt(configPath, join(userDir, "config.json"));
        steamPath = await adopt(steamPath, join(userDir, "steam.json"));
        statePath = await adopt(statePath, join(userDir, "state.json"));
        claimsPath = await adopt(claimsPath, join(userDir, "claims.json"));

        // Re-read through the account's own copies: a returning user has settings and a
        // library of their own, and the pre-login load only ever saw the defaults.
        config = await loadConfig(configPath);
        notifier = new NotifierGroup(config);
        await steamLibrary.load(steamPath);
        logger.info(`Data for ${auth.login}: ${userDir}`);
    }

    authStatus = "ok";
    deviceCode = null;
    bus.emit("auth", { status: "ok", user: { id: auth.userId, displayName: auth.login } });

    const gql = new TwitchGql(auth);
    miner = new Miner(auth, gql, config);
    // Restored before mining starts, so a restart does not re-send alerts already sent.
    await miner.loadPersistedState(statePath);
    await miner.loadClaimHistory(claimsPath);
    miner.setSteamLibrary(steamLibrary.isLoaded ? steamLibrary : null);

    // Refresh the Steam library if it is configured and the cache has gone stale.
    const steamConfigured =
        config.steam.provider === "sinfulshadows"
            ? Boolean(config.steam.sinfulshadows.apiKey)
            : Boolean(config.steam.apiKey && config.steam.steamId);
    if (steamConfigured) {
        const ageHours = (Date.now() - steamLibrary.fetchedAt) / 3_600_000;
        if (!steamLibrary.isLoaded || ageHours >= config.steam.refreshHours) {
            try {
                await refreshSteam();
                miner.setSteamLibrary(steamLibrary);
            } catch (error) {
                // A stale library still ranks better than none, so keep going.
                logger.warn(`Could not refresh the Steam library: ${(error as Error).message}`);
            }
        }
    }

    // Translate miner events into the JSON shapes the dashboard consumes.
    miner.on("watching", ({ channel, campaign, drop }) => {
        bus.emit("watching", {
            channel: {
                login: channel.login,
                displayName: channel.displayName,
                url: channel.url,
                title: channel.stream?.title ?? "",
                viewers: channel.stream?.viewers ?? 0,
                game: channel.stream?.gameName ?? null,
            },
            campaignId: campaign.id,
            dropId: drop.id,
        });
    });
    miner.on("progress", ({ drop, minutes, required }) => {
        bus.emit("progress", {
            dropId: drop.id,
            campaignId: drop.campaign.id,
            minutes,
            required,
        });
    });
    miner.on("drop-claimed", ({ drop, campaign }) => {
        bus.emit("drop-claimed", {
            dropId: drop.id,
            campaignId: campaign.id,
            dropName: drop.rewardNames || drop.name,
            gameName: campaign.gameName,
            rewardImageURL: drop.data.benefitEdges[0]?.benefit.imageAssetURL ?? null,
            at: Date.now(),
        });
        // An unlinked claim used to send two messages at once - a claim and a separate
        // warning about the same drop. The warning is folded in here instead.
        const deliverable = campaign.isDeliverable;
        void notifier.send({
            kind: deliverable ? "claim" : "warning",
            title: deliverable ? "Drop claimed" : campaign.gameName,
            lines: [
                deliverable ? "" : "Drop claimed, but your account is not linked",
                drop.rewardNames || drop.name,
                `${campaign.gameName} - ${campaign.name}`,
                deliverable
                    ? ""
                    : "Link now - some publishers only honour a link made before claiming.",
            ].filter(Boolean),
            imageUrl: drop.data.benefitEdges[0]?.benefit.imageAssetURL ?? null,
            url: deliverable ? null : campaign.accountLinkUrl,
        });
    });
    miner.on("campaign-completed", (campaign) => {
        bus.emit("campaign-completed", {
            campaignId: campaign.id,
            name: campaign.name,
            gameName: campaign.gameName,
        });
        void notifier.send({
            kind: "complete",
            title: "Campaign complete",
            lines: [
                `${campaign.gameName} - ${campaign.name}`,
                `${campaign.drops.length} drop${campaign.drops.length === 1 ? "" : "s"} claimed`,
            ],
            imageUrl: campaign.boxArtUrl(),
        });
    });
    miner.on("campaigns-updated", (campaigns: Campaign[]) => {
        bus.emit("campaigns", {
            campaigns: campaigns.map((campaign) => serializeCampaign(campaign, config)),
            queue: miner?.getMineableCampaigns().map((campaign) => campaign.id) ?? [],
            nextRefreshAt: miner?.getNextRefreshAt()
                ? new Date(miner.getNextRefreshAt()!).toISOString()
                : null,
        });
    });
    miner.on("unlinked-expiring", ({ campaign, earnedMinutes, rewards, hoursLeft }) => {
        const hours = hoursLeft < 1 ? "under an hour" : `${Math.round(hoursLeft)} hours`;
        void notifier.send({
            kind: "warning",
            // Game name leads: it is what the reader recognises at a glance in a
            // notification list, with the reason for the alert on the line beneath.
            title: campaign.gameName,
            lines: [
                "Link your account to keep this drop",
                campaign.name,
                `${earnedMinutes} minutes earned, expires in ${hours}.`,
                rewards.length ? `At risk: ${rewards.join(", ")}` : "",
                "Your Twitch account is not linked, so this will not reach the game.",
            ].filter(Boolean),
            imageUrl: campaign.boxArtUrl(),
            url: campaign.accountLinkUrl,
        });
    });

    miner.on("unlinked-claim", ({ campaign, drop, held }) => {
        // Only a held drop needs its own message: nothing was claimed, so no claim
        // notification follows. When the drop is claimed the warning travels with it.
        if (!held) {
            return;
        }
        void notifier.send({
            kind: "warning",
            title: campaign.gameName,
            lines: [
                "Drop ready but held - account not linked",
                drop.rewardNames || drop.name,
                "Link your account, then claim it from the Twitch inventory.",
            ],
            imageUrl: drop.data.benefitEdges[0]?.benefit.imageAssetURL ?? null,
            url: campaign.accountLinkUrl,
        });
    });

    miner.on("beat", (payload) => bus.emit("beat", payload));
    miner.on("feed", (entry) => bus.emit("feed", entry));
    miner.on("error", (error) => {
        const fatal = error instanceof StaleQueryHashError || error instanceof AuthExpiredError;
        bus.emit("problem", {
            level: fatal ? "fatal" : "warn",
            code:
                error instanceof StaleQueryHashError
                    ? "stale-hash"
                    : error instanceof AuthExpiredError
                      ? "auth"
                      : "generic",
            message: error.message,
        });
        if (fatal) {
            void notifier.send({
                kind: "warning",
                title: "Mining stopped",
                lines: [error.message],
            });
        }
    });

    if (values["dry-run"]) {
        await miner.runDryRun();
        server?.close();
        return;
    }

    const shutdown = (signal: string) => {
        logger.info(`Received ${signal}, shutting down.`);
        miner?.stop();
        server?.close();
        // Give in-flight requests a moment to settle before exiting.
        setTimeout(() => process.exit(0), 500);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    try {
        await miner.start();
    } catch (error) {
        if (error instanceof StaleQueryHashError && server) {
            // Exiting here would be a crash loop under `restart: unless-stopped`, and the
            // dashboard's "Mining paused" banner could never be seen because the process
            // serving it dies. A rotated hash needs a code change, so there is nothing to
            // retry - stay up, keep the API and dashboard alive, and say what is wrong.
            logger.error(error.message);
            logger.error("Mining is paused. The dashboard remains available.");
            bus.emit("problem", { level: "fatal", code: "stale-hash", message: error.message });
            void notifier.send({
                kind: "warning",
                title: "Mining paused",
                lines: [error.message, "Run npm run check-hashes to see which queries rotated."],
            });
            // Hold the process open for the HTTP server.
            await new Promise(() => {});
        }
        throw error;
    }
}

main().catch((error) => {
    if (error instanceof StaleQueryHashError) {
        logger.error(error.message);
        process.exit(2);
    }
    logger.error("Fatal error:", error);
    process.exit(1);
});
