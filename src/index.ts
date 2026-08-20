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
import { StaleQueryHashError, TwitchGql } from "./twitch/gql.js";
import { ApiServer, type DeviceCodeInfo, type ServerContext } from "./api/server.js";
import { serializeCampaign } from "./api/serialize.js";

const VERSION = "0.3.0";

const HELP = `
Twitch Drops Bot - browserless Twitch drop miner

Usage: twitch-drops-bot [options]

Options:
  -c, --config <path>   Config file (default: ./config.json)
  -a, --auth <path>     Credential store (default: ./auth.json)
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
    const notifier = new NotifierGroup(config);
    // Decouples the miner's lifetime from the server's: the server starts first, before a
    // miner exists, and simply relays whatever arrives on this bus.
    const bus = new EventEmitter();

    let miner: Miner | null = null;
    let authStatus: "pending" | "ok" = "pending";
    let deviceCode: DeviceCodeInfo | null = null;

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
        void notifier.send(`Claimed <b>${drop.rewardNames}</b> from ${campaign.gameName}`);
    });
    miner.on("campaign-completed", (campaign) => {
        bus.emit("campaign-completed", {
            campaignId: campaign.id,
            name: campaign.name,
            gameName: campaign.gameName,
        });
        void notifier.send(`Finished <b>${campaign.gameName}</b> - ${campaign.name}`);
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
    miner.on("beat", (payload) => bus.emit("beat", payload));
    miner.on("feed", (entry) => bus.emit("feed", entry));
    miner.on("error", (error) => {
        bus.emit("problem", {
            level: error instanceof StaleQueryHashError ? "fatal" : "warn",
            code: error instanceof StaleQueryHashError ? "stale-hash" : "generic",
            message: error.message,
        });
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

    await miner.start();
}

main().catch((error) => {
    if (error instanceof StaleQueryHashError) {
        logger.error(error.message);
        process.exit(2);
    }
    logger.error("Fatal error:", error);
    process.exit(1);
});
