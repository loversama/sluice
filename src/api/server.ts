import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { EventEmitter } from "node:events";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

import logger from "../logger.js";
import type { Config } from "../config.js";
import type { Miner } from "../miner.js";
import type { AuthState } from "../twitch/auth.js";
import type { NotifierGroup } from "../notifiers/index.js";
import type { SteamLibrary } from "../steam/library.js";
import { buildLoginUrl, verifyCallback } from "../steam/openid.js";
import { isMasked, maskConfig, serializeCampaign } from "./serialize.js";

export interface DeviceCodeInfo {
    code: string;
    url: string;
    expiresAt: number;
}

/**
 * Everything the API needs from the running application. Passed as accessors rather than
 * values because the server starts before login finishes and before the miner exists.
 */
export interface ServerContext {
    auth: AuthState;
    version: string;
    startedAt: number;
    /** Event bus carrying miner events; the server relays these to SSE clients. */
    bus: EventEmitter;
    getAuthStatus(): "pending" | "ok";
    getDeviceCode(): DeviceCodeInfo | null;
    getMiner(): Miner | null;
    getConfig(): Config;
    setConfig(config: Config): Promise<void>;
    getNotifier(): NotifierGroup;
    getSteamLibrary(): SteamLibrary | null;
    searchGames(term: string): Promise<{ id: string; name: string; boxArtURL: string | null }[]>;
    /** Store credentials and pull the library. Returns the number of games found. */
    connectSteam(input: { apiKey?: string; steamId?: string }): Promise<number>;
    refreshSteam(): Promise<number>;
    disconnectSteam(): Promise<void>;
}

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
};

/** Events relayed from the miner to the browser, verbatim by name. */
const RELAYED_EVENTS = [
    "watching",
    "progress",
    "drop-claimed",
    "campaign-completed",
    "campaigns",
    "beat",
    "feed",
    "problem",
    "auth",
] as const;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    });
    response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        // The largest legitimate body is a config object; anything bigger is a mistake.
        if (size > 256 * 1024) {
            throw new Error("Request body too large");
        }
        chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) {
        return {};
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export class ApiServer {
    private readonly server = createServer((request, response) => {
        this.handle(request, response).catch((error) => {
            logger.debug("API request failed:", error);
            if (!response.headersSent) {
                sendJson(response, 500, { error: String((error as Error).message) });
            }
        });
    });

    /** Connected SSE clients. */
    private readonly clients = new Set<ServerResponse>();
    private eventId = 0;

    constructor(
        private readonly context: ServerContext,
        private readonly staticDir: string,
    ) {
        for (const event of RELAYED_EVENTS) {
            this.context.bus.on(event, (payload: unknown) => this.broadcast(event, payload));
        }
    }

    listen(host: string, port: number): Promise<void> {
        return new Promise((resolvePromise, rejectPromise) => {
            this.server.once("error", rejectPromise);
            this.server.listen(port, host, () => {
                logger.info(`Dashboard listening on http://${host}:${port}`);
                if (host !== "127.0.0.1" && host !== "localhost") {
                    // In a container, binding wide is required for the port to work at all -
                    // exposure is decided by the port mapping, so the blunt warning would be
                    // misleading. Outside one, it means what it says.
                    if (existsSync("/.dockerenv")) {
                        logger.info(
                            "Bound to all interfaces inside the container. What is actually " +
                                "reachable is set by the port mapping in docker-compose.yml.",
                        );
                    } else {
                        logger.warn(
                            "The dashboard is bound to a non-local address. Anyone who can " +
                                "reach it can read your Twitch campaign data and change settings.",
                        );
                    }
                }
                resolvePromise();
            });
        });
    }

    close(): void {
        for (const client of this.clients) {
            client.end();
        }
        this.clients.clear();
        this.server.close();
    }

    private broadcast(event: string, payload: unknown): void {
        if (this.clients.size === 0) {
            return;
        }
        const id = ++this.eventId;
        const frame = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
        for (const client of this.clients) {
            client.write(frame);
        }
    }

    private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const url = new URL(request.url ?? "/", "http://localhost");
        const path = url.pathname;

        if (path === "/api/stream") {
            return this.handleStream(request, response);
        }
        if (path.startsWith("/api/")) {
            return this.handleApi(request, response, path, url);
        }
        return this.handleStatic(path, response);
    }

    private handleStream(request: IncomingMessage, response: ServerResponse): void {
        response.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            // Without this, nginx and friends buffer the stream into uselessness.
            "X-Accel-Buffering": "no",
        });
        response.write(`retry: 3000\n\n`);
        this.clients.add(response);

        // Comment frames keep intermediaries from timing the connection out.
        const keepAlive = setInterval(() => response.write(": ping\n\n"), 25_000);
        const cleanup = () => {
            clearInterval(keepAlive);
            this.clients.delete(response);
        };
        request.on("close", cleanup);
        response.on("error", cleanup);
    }

    private async handleApi(
        request: IncomingMessage,
        response: ServerResponse,
        path: string,
        url: URL,
    ): Promise<void> {
        const method = request.method ?? "GET";

        if (path === "/api/state" && method === "GET") {
            return sendJson(response, 200, this.buildSnapshot());
        }

        if (path === "/api/config") {
            if (method === "GET") {
                return sendJson(response, 200, maskConfig(this.context.getConfig()));
            }
            if (method === "PUT") {
                const patch = (await readBody(request)) as Partial<Config>;
                const merged = this.mergeConfig(patch);
                await this.context.setConfig(merged);
                return sendJson(response, 200, maskConfig(merged));
            }
        }

        if (path === "/api/events" && method === "GET") {
            const limit = Number(url.searchParams.get("limit") ?? 50);
            const miner = this.context.getMiner();
            return sendJson(response, 200, {
                events: miner?.getFeed(Number.isFinite(limit) ? limit : 50) ?? [],
                claims: miner?.getRecentClaims() ?? [],
            });
        }

        // Manual overrides. The bot is deliberately autonomous, but with no lever at all
        // a user who dislikes the current channel can only edit config or restart.
        if (path.startsWith("/api/actions/") && method === "POST") {
            const miner = this.context.getMiner();
            if (!miner) {
                return sendJson(response, 409, { error: "The miner is not running yet." });
            }
            switch (path.slice("/api/actions/".length)) {
                case "pause":
                    miner.pause();
                    return sendJson(response, 200, { paused: true });
                case "resume":
                    miner.resume();
                    return sendJson(response, 200, { paused: false });
                case "skip":
                    return sendJson(response, 200, { skipped: miner.skipChannel() });
                case "refresh":
                    await miner.refreshNow();
                    return sendJson(response, 200, { ok: true });
                default:
                    return sendJson(response, 404, { error: "Unknown action" });
            }
        }

        if (path === "/api/games/search" && method === "GET") {
            const term = url.searchParams.get("q") ?? "";
            const games = await this.context.searchGames(term).catch(() => []);
            return sendJson(response, 200, { games });
        }

        if (path === "/api/steam" && method === "GET") {
            const library = this.context.getSteamLibrary();
            const config = this.context.getConfig();
            return sendJson(response, 200, {
                connected: Boolean(config.steam.steamId && config.steam.apiKey),
                hasApiKey: Boolean(config.steam.apiKey),
                steamId: config.steam.steamId ?? null,
                personaName: library?.personaName ?? null,
                gameCount: library?.size ?? 0,
                fetchedAt: library?.fetchedAt ? new Date(library.fetchedAt).toISOString() : null,
            });
        }

        if (path === "/api/steam/connect" && method === "POST") {
            const body = (await readBody(request)) as { apiKey?: string; steamId?: string };
            // A masked key means "keep the stored one".
            const apiKey = isMasked(body.apiKey) ? undefined : body.apiKey;
            const count = await this.context.connectSteam({ apiKey, steamId: body.steamId });
            return sendJson(response, 200, { ok: true, gameCount: count });
        }

        if (path === "/api/steam/refresh" && method === "POST") {
            const count = await this.context.refreshSteam();
            return sendJson(response, 200, { ok: true, gameCount: count });
        }

        if (path === "/api/steam/disconnect" && method === "POST") {
            await this.context.disconnectSteam();
            return sendJson(response, 200, { ok: true });
        }

        // Steam sign-in, so the user does not have to find their 64-bit ID by hand.
        if (path === "/api/steam/login" && method === "GET") {
            const origin = this.originFor(request);
            const target = buildLoginUrl(`${origin}/api/steam/callback`, `${origin}/`);
            response.writeHead(302, { Location: target });
            response.end();
            return;
        }

        if (path === "/api/steam/callback" && method === "GET") {
            const steamId = await verifyCallback(url.searchParams);
            if (!steamId) {
                response.writeHead(302, { Location: "/#/settings?steam=failed" });
                response.end();
                return;
            }
            try {
                await this.context.connectSteam({ steamId });
                response.writeHead(302, { Location: "/#/settings?steam=connected" });
            } catch (error) {
                logger.warn(`Steam sign-in succeeded but the library could not be read: ${error}`);
                // Identity is established even if the library read failed - usually a
                // missing API key, which the settings page will prompt for.
                response.writeHead(302, { Location: "/#/settings?steam=needs-key" });
            }
            response.end();
            return;
        }

        if (path === "/api/links" && method === "GET") {
            const miner = this.context.getMiner();
            return sendJson(response, 200, { suggestions: miner?.getLinkSuggestions() ?? [] });
        }

        if (path === "/api/notify/test" && method === "POST") {
            const notifier = this.context.getNotifier();
            if (notifier.isEmpty) {
                return sendJson(response, 400, { error: "No notifiers are configured." });
            }
            await notifier.send({
                kind: "info",
                title: "Test notification",
                lines: ["Twitch Drops Bot is connected and can reach you here."],
            });
            return sendJson(response, 200, { ok: true });
        }

        return sendJson(response, 404, { error: "Not found" });
    }

    /** Best-effort origin for OpenID return URLs, from the Host header the browser used. */
    private originFor(request: IncomingMessage): string {
        const host = request.headers.host ?? "127.0.0.1:4400";
        const proto = (request.headers["x-forwarded-proto"] as string | undefined) ?? "http";
        return `${proto}://${host}`;
    }

    /** Merge an incoming config patch, preserving secrets the client sent back masked. */
    private mergeConfig(patch: Partial<Config>): Config {
        const current = this.context.getConfig();
        const merged: Config = {
            ...current,
            ...patch,
            notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
        };
        const telegram = merged.notifications.telegram;
        if (telegram && isMasked(telegram.botToken)) {
            telegram.botToken = current.notifications.telegram?.botToken ?? "";
        }
        const discord = merged.notifications.discord;
        if (discord && isMasked(discord.webhookUrl)) {
            discord.webhookUrl = current.notifications.discord?.webhookUrl ?? "";
        }
        if (merged.steam && isMasked(merged.steam.apiKey)) {
            merged.steam.apiKey = current.steam.apiKey;
        }
        if (merged.campaignRefreshMinutes < 5) {
            merged.campaignRefreshMinutes = 5;
        }
        return merged;
    }

    private buildSnapshot() {
        const miner = this.context.getMiner();
        const config = this.context.getConfig();
        const device = this.context.getDeviceCode();

        return {
            daemon: {
                version: this.context.version,
                startedAt: new Date(this.context.startedAt).toISOString(),
                dryRun: miner?.dryRun ?? false,
                paused: miner?.isPaused ?? false,
            },
            auth: {
                status: this.context.getAuthStatus(),
                user: this.context.auth.isAuthenticated
                    ? { id: this.context.auth.userId, displayName: this.context.auth.login }
                    : null,
                device: device
                    ? {
                          code: device.code,
                          url: device.url,
                          expiresAt: new Date(device.expiresAt).toISOString(),
                      }
                    : null,
            },
            mining: miner?.getMiningState() ?? null,
            allowStreamEmbed: config.allowStreamEmbed,
            queue: miner?.getMineableCampaigns().map((campaign) => campaign.id) ?? [],
            nextRefreshAt: miner?.getNextRefreshAt()
                ? new Date(miner.getNextRefreshAt()!).toISOString()
                : null,
            campaigns:
                miner?.getCampaigns().map((campaign) => serializeCampaign(campaign, config)) ?? [],
            claims: miner?.getRecentClaims() ?? [],
            stats: miner?.getClaimStats() ?? null,
            feed: miner?.getFeed() ?? [],
        };
    }

    /** Serve the built dashboard, falling back to index.html so client routing works. */
    private async handleStatic(path: string, response: ServerResponse): Promise<void> {
        const root = resolve(this.staticDir);
        // normalize() collapses "..", so a crafted path cannot escape the static root.
        const requested = normalize(path === "/" ? "/index.html" : path);
        let filePath = join(root, requested);
        if (!filePath.startsWith(root)) {
            return sendJson(response, 403, { error: "Forbidden" });
        }

        let info = await stat(filePath).catch(() => null);
        if (!info?.isFile()) {
            filePath = join(root, "index.html");
            info = await stat(filePath).catch(() => null);
        }
        if (!info?.isFile()) {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(
                "<!doctype html><meta charset=utf-8><title>Twitch Drops Bot</title>" +
                    "<body style=\"font-family:system-ui;padding:2rem;background:#0e0e12;color:#efeff4\">" +
                    "<h1>Dashboard not built</h1>" +
                    "<p>Run <code>npm run build:web</code> to build the dashboard. " +
                    "The API is available under <code>/api</code>.</p>",
            );
            return;
        }

        response.writeHead(200, {
            "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
            "Cache-Control": requested === "/index.html" ? "no-store" : "public, max-age=3600",
        });
        createReadStream(filePath).pipe(response);
    }
}
