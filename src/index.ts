import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig } from "./config.js";
import logger, { setLogLevel, type LogLevel } from "./logger.js";
import { Miner } from "./miner.js";
import { NotifierGroup } from "./notifiers/index.js";
import { AuthState } from "./twitch/auth.js";
import { StaleQueryHashError, TwitchGql } from "./twitch/gql.js";

const HELP = `
Twitch Drops Bot - browserless Twitch drop miner

Usage: twitch-drops-bot [options]

Options:
  -c, --config <path>   Config file (default: ./config.json)
  -a, --auth <path>     Credential store (default: ./auth.json)
  -l, --log <level>     error | warn | info | debug
      --dry-run         Log in and report what would be mined, then exit.
                        Sends no watch events and claims nothing.
      --logout          Discard stored credentials and log in again
  -h, --help            Show this message
`.trim();

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            config: { type: "string", short: "c", default: "config.json" },
            auth: { type: "string", short: "a", default: "auth.json" },
            log: { type: "string", short: "l" },
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

    const config = await loadConfig(configPath);
    setLogLevel((values.log as LogLevel) ?? config.logLevel);
    logger.info(`Config: ${configPath}`);

    const auth = new AuthState();
    const restored = values.logout ? false : await auth.load(authPath);

    if (!restored || !(await auth.validate())) {
        if (restored) {
            logger.warn("Stored credentials are no longer valid; logging in again.");
        }
        await auth.authorize((verificationUri, userCode) => {
            // Printed rather than logged so it stands out regardless of log level.
            console.log("\n" + "=".repeat(58));
            console.log("  Authorize this bot with your Twitch account:");
            console.log(`  1. Open ${verificationUri}`);
            console.log(`  2. Enter the code:  ${userCode}`);
            console.log("=".repeat(58) + "\n");
            console.log("Waiting for you to approve...");
        });
        await auth.save(authPath);
    } else {
        logger.info(`Logged in as ${auth.login}`);
    }

    const gql = new TwitchGql(auth);
    const notifier = new NotifierGroup(config);
    const miner = new Miner(auth, gql, config);

    miner.on("drop-claimed", ({ drop, campaign }) => {
        void notifier.send(`Claimed <b>${drop.rewardNames}</b> from ${campaign.gameName}`);
    });
    miner.on("campaign-completed", (campaign) => {
        void notifier.send(`Finished <b>${campaign.gameName}</b> - ${campaign.name}`);
    });

    if (values["dry-run"]) {
        await miner.runDryRun();
        return;
    }

    const shutdown = (signal: string) => {
        logger.info(`Received ${signal}, shutting down.`);
        miner.stop();
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
