import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
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
import { SteamLibrary } from "./steam/library.js";

const VERSION = "0.3.0";

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

    const configPath = resolve(values.config!);
    const authPath = resolve(values.auth!);

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

    const steamPath = resolve(values.steam!);
    const steamLibrary = new SteamLibrary();
    await steamLibrary.load(steamPath);

    /** Pull the library from Steam, using whatever credentials the config holds. */
    const refreshSteam = async (): Promise<number> => {
        const { apiKey, steamId } = config.steam;
        if (!apiKey) {
            throw new Error("No Steam API key configured.");
        }
        if (!steamId) {
            throw new Error("No Steam account connected.");
        }
        const count = await steamLibrary.refresh(new SteamClient(apiKey), steamId);
        await steamLibrary.save(steamPath);
        return count;
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
            const apiKey = input.apiKey ?? config.steam.apiKey;
            if (!apiKey) {
                throw new Error("A Steam Web API key is required to read your library.");
            }
            const client = new SteamClient(apiKey);
            const steamId = input.steamId
                ? await resolveSteamId(input.steamId, client)
                : config.steam.steamId;
            if (!steamId) {
                throw new Error("No Steam account given.");
            }
            await context.setConfig({
                ...config,
                steam: { ...config.steam, apiKey, steamId },
            });
            return refreshSteam();
        },
        refreshSteam,
        disconnectSteam: async () => {
            await context.setConfig({
                ...config,
                steam: { ...config.steam, apiKey: undefined, steamId: undefined },
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

    authStatus = "ok";
    deviceCode = null;
    bus.emit("auth", { status: "ok", user: { id: auth.userId, displayName: auth.login } });

    const gql = new TwitchGql(auth);
    miner = new Miner(auth, gql, config);
    // Restored before mining starts, so a restart does not re-send alerts already sent.
    await miner.loadPersistedState(resolve(values.state!));
    await miner.loadClaimHistory(resolve(values.claims!));
    miner.setSteamLibrary(steamLibrary.isLoaded ? steamLibrary : null);

    // Refresh the Steam library if it is configured and the cache has gone stale.
    if (config.steam.apiKey && config.steam.steamId) {
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
            channel: { login: channel.login, displayName: channel.displayName, url: channel.url },
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
        void notifier.send({
            kind: "claim",
            title: "Drop claimed",
            lines: [
                drop.rewardNames || drop.name,
                `${campaign.gameName} - ${campaign.name}`,
            ],
            imageUrl: drop.data.benefitEdges[0]?.benefit.imageAssetURL ?? null,
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
            imageUrl: campaign.data.game.boxArtURL ?? null,
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
            imageUrl: campaign.data.game.boxArtURL ?? null,
            url: campaign.accountLinkUrl,
        });
    });

    miner.on("unlinked-claim", ({ campaign, drop, held }) => {
        void notifier.send({
            kind: "warning",
            title: campaign.gameName,
            lines: [
                held ? "Drop ready but held - account not linked" : "Drop claimed while unlinked",
                drop.rewardNames || drop.name,
                held
                    ? "Link your account, then claim it from the Twitch inventory."
                    : "Link your account now - some publishers only honour a link made before claiming.",
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
