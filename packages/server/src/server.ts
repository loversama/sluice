import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { EventEmitter } from "node:events";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

import {
    logger,
    buildLoginUrl,
    verifyCallback,
    isMasked,
    maskConfig,
    botFromGetMe,
    chatFromUpdates,
    describeTelegramError,
    botFromUser,
    describeDiscordError,
    guildsFrom,
    textChannelsFrom,
    type DiscordChannel,
    type NotifierService,
    serializeCampaign,
    type Config,
    type DeviceCodeInfo,
    type ServerContext,
} from "@sluice/core";

export type { DeviceCodeInfo, ServerContext };

/** A bot in more servers than this lists the first few rather than stalling the button. */
const MAX_GUILDS_SCANNED = 10;

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
    "loading",
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

/** One call to Discord's REST API as a bot. */
async function callDiscord(
    token: string,
    path: string,
): Promise<{ status: number; payload: unknown }> {
    try {
        const response = await fetch(`https://discord.com/api/v10${path}`, {
            headers: { Authorization: `Bot ${token}` },
            signal: AbortSignal.timeout(10_000),
        });
        return { status: response.status, payload: await response.json().catch(() => null) };
    } catch {
        return { status: 0, payload: { message: "Could not reach Discord." } };
    }
}

/**
 * One call to Telegram's bot API, returning the status alongside the body so a caller can
 * tell "wrong token" from "nobody has messaged it yet".
 */
async function callTelegram(
    token: string,
    method: string,
): Promise<{ status: number; payload: unknown }> {
    try {
        const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
            signal: AbortSignal.timeout(10_000),
        });
        return { status: response.status, payload: await response.json().catch(() => null) };
    } catch {
        return { status: 0, payload: { description: "Could not reach Telegram." } };
    }
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

/** Loopback names a browser can legitimately reach this server by. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** The hostname a request claims it reached us by, without the port. */
export function hostnameOf(value: string): string {
    const trimmed = value.trim().toLowerCase();
    if (trimmed.startsWith("[")) {
        return trimmed.slice(0, trimmed.indexOf("]") + 1);
    }
    const colon = trimmed.lastIndexOf(":");
    return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/**
 * Whether a Host header names somewhere this server is actually served from.
 *
 * Binding to loopback is not on its own a defence. A hostile page can point a domain it
 * controls at 127.0.0.1, wait for the browser's DNS cache to turn over, and from then on its
 * scripts are same-origin with whatever is listening there - free to read replies, not merely
 * send requests. Pinning the Host closes that for the price of a string compare.
 */
export function isKnownHost(
    hostHeader: string | undefined,
    options: { boundHost: string; allowedHosts: readonly string[] },
): boolean {
    if (!hostHeader) {
        // HTTP/1.1 requires it; its absence is either broken or deliberate.
        return false;
    }
    const host = hostnameOf(hostHeader);
    if (LOOPBACK_HOSTS.has(host) || host === options.boundHost.toLowerCase()) {
        return true;
    }
    return options.allowedHosts.some((allowed) => allowed.trim().toLowerCase() === host);
}

/**
 * Whether a browser is sending this from a page on some other origin.
 *
 * A form post needs no preflight, so any site you happen to visit could otherwise reach a
 * POST here - signing you out and revoking your Twitch token without a line of script running
 * on your dashboard. Browsers attach Origin to these; a missing one means the request did not
 * come from a page, which is how curl and the CLI still work.
 */
export function isCrossOrigin(
    originHeader: string | undefined,
    hostHeader: string | undefined,
): boolean {
    if (!originHeader) {
        return false;
    }
    if (originHeader === "null") {
        // A sandboxed or file:// page. Opaque, so never same-origin with us.
        return true;
    }
    try {
        return new URL(originHeader).host.toLowerCase() !== (hostHeader ?? "").toLowerCase();
    } catch {
        return true;
    }
}

export class ApiServer {
    /** Address we were told to bind, accepted as a Host alongside the loopback names. */
    private boundHost = "127.0.0.1";

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

    /**
     * Start listening, resolving with the port actually bound.
     *
     * The port matters to the caller now: passing 0 asks the OS for a free one, which is
     * how the desktop build avoids colliding with a running container - and it then has to
     * know which port to point a window at.
     */
    listen(host: string, port: number): Promise<number> {
        this.boundHost = host.toLowerCase();
        return new Promise((resolvePromise, rejectPromise) => {
            this.server.once("error", rejectPromise);
            this.server.listen(port, host, () => {
                const address = this.server.address();
                const actual = typeof address === "object" && address ? address.port : port;
                logger.info(`Dashboard listening on http://${host}:${actual}`);
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
                resolvePromise(actual);
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

        if (!isKnownHost(request.headers.host, {
            boundHost: this.boundHost,
            allowedHosts: this.context.getConfig().allowedHosts,
        })) {
            const claimed = request.headers.host ?? "";
            logger.warn(
                `Refused a request addressed to "${claimed}". If you reach the dashboard ` +
                    'by that name on purpose, add it to "allowedHosts" in your config; ' +
                    "otherwise something is pointing that name at this machine.",
            );
            return sendJson(response, 421, {
                error: `This dashboard does not answer to "${claimed}".`,
                hint: 'Add it to "allowedHosts" in your config if this was deliberate.',
            });
        }

        const method = (request.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD" && isCrossOrigin(request.headers.origin, request.headers.host)) {
            logger.warn(`Refused a cross-origin ${method} from "${request.headers.origin}".`);
            return sendJson(response, 403, {
                error: "Cross-origin requests are not accepted.",
            });
        }

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
                case "next":
                    return sendJson(response, 200, { skipped: miner.skipCampaign() });
                case "restore":
                    return sendJson(response, 200, { restored: miner.clearDeferrals() });
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
            const provider = config.steam.provider;
            const connected =
                provider === "sinfulshadows"
                    ? Boolean(config.steam.sinfulshadows.apiKey)
                    : Boolean(config.steam.steamId && config.steam.apiKey);
            return sendJson(response, 200, {
                provider,
                connected,
                hasApiKey: Boolean(config.steam.apiKey),
                hasSinfulShadowsKey: Boolean(config.steam.sinfulshadows.apiKey),
                sinfulshadowsBaseUrl: config.steam.sinfulshadows.baseUrl,
                steamId: config.steam.steamId ?? null,
                personaName: library?.personaName ?? null,
                gameCount: library?.size ?? 0,
                // Which signal the "recently played" ranking can use - a library read through
                // a shared key carries no last-played timestamps.
                recencySignal: library?.recencySignal ?? null,
                stale: library?.stale ?? false,
                fetchedAt: library?.fetchedAt ? new Date(library.fetchedAt).toISOString() : null,
            });
        }

        if (path === "/api/auth/logout" && method === "POST") {
            const result = await this.context.logout();
            return sendJson(response, 200, { ok: true, ...result });
        }

        if (path === "/api/steam/connect" && method === "POST") {
            const body = (await readBody(request)) as {
                provider?: "direct" | "sinfulshadows";
                apiKey?: string;
                steamId?: string;
                sinfulshadowsApiKey?: string;
            };
            // A masked key means "keep the stored one".
            const apiKey = isMasked(body.apiKey) ? undefined : body.apiKey;
            const sinfulshadowsApiKey = isMasked(body.sinfulshadowsApiKey)
                ? undefined
                : body.sinfulshadowsApiKey;
            const count = await this.context.connectSteam({
                provider: body.provider,
                apiKey,
                steamId: body.steamId,
                sinfulshadowsApiKey,
            });
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

        if (path === "/api/notify/telegram/check" && method === "POST") {
            const token = this.telegramToken(await readBody(request));
            if (!token) {
                return sendJson(response, 400, { error: "Paste a bot token first." });
            }
            const { status, payload } = await callTelegram(token, "getMe");
            const bot = botFromGetMe(payload);
            return bot
                ? sendJson(response, 200, { ok: true, ...bot })
                : sendJson(response, 200, { ok: false, error: describeTelegramError(status, payload) });
        }

        if (path === "/api/notify/telegram/detect-chat" && method === "POST") {
            const token = this.telegramToken(await readBody(request));
            if (!token) {
                return sendJson(response, 400, { error: "Paste a bot token first." });
            }
            // A short timeout, not a long poll: the user is watching a button, and a
            // request that hangs for 30s reads as broken however correct it is.
            const { status, payload } = await callTelegram(token, "getUpdates?limit=20&timeout=0");
            const chat = chatFromUpdates(payload);
            if (chat) {
                return sendJson(response, 200, { ok: true, ...chat });
            }
            const body = payload as { ok?: boolean } | null;
            return body?.ok === true
                ? sendJson(response, 200, { ok: false, waiting: true })
                : sendJson(response, 200, { ok: false, error: describeTelegramError(status, payload) });
        }

        if (path === "/api/notify/discord/check" && method === "POST") {
            const token = this.discordToken(await readBody(request));
            if (!token) {
                return sendJson(response, 400, { error: "Paste a bot token first." });
            }
            const { status, payload } = await callDiscord(token, "/users/@me");
            const bot = botFromUser(payload);
            return bot
                ? sendJson(response, 200, { ok: true, ...bot })
                : sendJson(response, 200, { ok: false, error: describeDiscordError(status, payload) });
        }

        if (path === "/api/notify/discord/channels" && method === "POST") {
            const token = this.discordToken(await readBody(request));
            if (!token) {
                return sendJson(response, 400, { error: "Paste a bot token first." });
            }

            const guilds = await callDiscord(token, "/users/@me/guilds");
            const list = guildsFrom(guilds.payload);
            if (!list.length) {
                return sendJson(response, 200, {
                    ok: false,
                    error:
                        guilds.status === 200
                            ? "That bot is not in any server yet. Invite it to one, then try again."
                            : describeDiscordError(guilds.status, guilds.payload),
                });
            }

            // One request per guild, so a bot sitting in a hundred servers cannot turn a
            // button press into a hundred round trips.
            const shown = list.slice(0, MAX_GUILDS_SCANNED);
            const channels: DiscordChannel[] = [];
            for (const guild of shown) {
                const result = await callDiscord(token, `/guilds/${guild.id}/channels`);
                channels.push(...textChannelsFrom(result.payload, guild.name));
            }

            return sendJson(response, 200, {
                ok: true,
                channels,
                truncated: list.length > shown.length,
            });
        }

        if (path === "/api/notify/test" && method === "POST") {
            const body = (await readBody(request)) as { service?: NotifierService } | null;
            const service = body?.service;
            const notifier = this.context.getNotifier();

            if (service ? !notifier.has(service) : notifier.isEmpty) {
                return sendJson(response, 400, {
                    error: service
                        ? `Nothing is configured for ${service} yet.`
                        : "No notifiers are configured.",
                });
            }

            // Report what each one did rather than a bare ok. "Sent" while nothing arrives
            // is precisely the failure a test button exists to catch.
            const results = await notifier.deliver(
                {
                    kind: "info",
                    title: "Test notification",
                    lines: ["Sluice is connected and can reach you here."],
                },
                service,
            );
            return sendJson(response, 200, { ok: results.every((r) => r.ok), results });
        }

        return sendJson(response, 404, { error: "Not found" });
    }

    /**
     * The token to talk to Telegram with.
     *
     * The dashboard only ever sees secrets masked, so a token already saved is not in the
     * form the user is looking at. Taking the stored one when the client has nothing real
     * to offer is what lets the setup buttons keep working after a reload.
     */
    private telegramToken(body: unknown): string {
        const supplied = (body as { botToken?: unknown } | null)?.botToken;
        if (typeof supplied === "string" && supplied.trim() && !isMasked(supplied)) {
            return supplied.trim();
        }
        return this.context.getConfig().notifications.telegram?.botToken ?? "";
    }

    /** As telegramToken, for Discord's bot token. */
    private discordToken(body: unknown): string {
        const supplied = (body as { botToken?: unknown } | null)?.botToken;
        if (typeof supplied === "string" && supplied.trim() && !isMasked(supplied)) {
            return supplied.trim();
        }
        return this.context.getConfig().notifications.discord?.botToken ?? "";
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
        if (discord && isMasked(discord.botToken)) {
            discord.botToken = current.notifications.discord?.botToken ?? "";
        }
        if (merged.steam && isMasked(merged.steam.apiKey)) {
            merged.steam.apiKey = current.steam.apiKey;
        }
        if (merged.steam?.sinfulshadows && isMasked(merged.steam.sinfulshadows.apiKey)) {
            merged.steam.sinfulshadows.apiKey = current.steam.sinfulshadows?.apiKey;
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
            sounds: config.sounds,
            sidebarMode: config.sidebarMode,
            autoUpdate: config.autoUpdate,
            desktopNotifications: config.desktopNotifications,
            desktopNotificationStyle: config.desktopNotificationStyle,
            queue: miner?.getMineableCampaigns().map((campaign) => campaign.id) ?? [],
            nextRefreshAt: miner?.getNextRefreshAt()
                ? new Date(miner.getNextRefreshAt()!).toISOString()
                : null,
            campaigns:
                miner?.getCampaigns().map((campaign) => serializeCampaign(campaign, config, miner?.ownsPredicate ?? null)) ?? [],
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
                "<!doctype html><meta charset=utf-8><title>Sluice</title>" +
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
