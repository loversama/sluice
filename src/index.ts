import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createApp } from "./app.js";
import logger, { setLogLevel, type LogLevel } from "./logger.js";
import { ApiServer } from "./api/server.js";
import { loadConfig } from "./config.js";

const HELP = `
Twitch Drops Bot - browserless Twitch drop miner

Usage: twitch-drops-bot [options]

Options:
  -c, --config <path>   Config file (default: ./config.json)
  -a, --auth <path>     Credential store (default: ./auth.json)
      --steam <path>    Steam library cache (default: ./steam.json)
      --state <path>    Notification bookkeeping (default: ./state.json)
      --claims <path>   Claim history (default: ./claims.json)
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

    const authPath = resolve(values.auth!);
    // Everything but the credentials lives under a per-account directory beside them.
    const dataDir = dirname(authPath);

    // Read once up front purely to honour logLevel before anything logs. The app reloads
    // config properly for whichever account signs in.
    const startupConfig = await loadConfig(resolve(values.config!));
    setLogLevel((values.log as LogLevel) ?? startupConfig.logLevel);
    logger.info(`Data directory: ${dataDir}`);

    const app = createApp({
        dataDir,
        legacyPaths: {
            config: resolve(values.config!),
            steam: resolve(values.steam!),
            state: resolve(values.state!),
            claims: resolve(values.claims!),
        },
        forceLogin: values.logout,
        dryRun: values["dry-run"],
        getOwnPort: () => boundPort,
        onDeviceCode: ({ code, url }) => {
            console.log("\n" + "=".repeat(58));
            console.log("  Authorize this bot with your Twitch account:");
            console.log(`  1. Open ${url}`);
            console.log(`  2. Enter the code:  ${code}`);
            console.log("=".repeat(58) + "\n");
            if (values.web) {
                console.log("(You can also do this from the dashboard.)");
            }
            console.log("Waiting for you to approve...");
        },
        onLogout: () => {
            logger.info("Signed out. Waiting for a new login.");
        },
    });

    let boundPort: number | null = null;
    let server: ApiServer | null = null;
    if (values.web) {
        const staticDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");
        server = new ApiServer(app.context, staticDir);
        const { host, port } = parseAddress(values["web-addr"]!);
        boundPort = await server.listen(host, port);
    }

    if (values["dry-run"]) {
        await app.runDryRun();
        server?.close();
        return;
    }

    const shutdown = (signal: string) => {
        logger.info(`Received ${signal}, shutting down.`);
        void app.stop().then(() => {
            server?.close();
            process.exit(0);
        });
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // Node terminates on an unhandled rejection, and would do so having printed nothing
    // useful. Under Docker the restart policy turns that into a recovery; the point of
    // catching it is to leave a reason behind first. The desktop build registers its own
    // handlers instead, because there is no supervisor there to restart anything.
    process.on("unhandledRejection", (reason) => {
        logger.error("Unhandled promise rejection:", reason);
        logger.error("Exiting; the container will restart.");
        process.exit(1);
    });
    process.on("uncaughtException", (error) => {
        logger.error("Uncaught exception:", error);
        logger.error("Exiting; the container will restart.");
        process.exit(1);
    });

    // Returns immediately; the session loop runs in the background and survives a sign-out,
    // so the process stays up and the dashboard keeps its stream.
    app.start();
}

main().catch((error) => {
    logger.error("Fatal error:", error);
    process.exit(1);
});
