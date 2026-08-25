import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { ApiServer } from "../packages/server/src/server.js";
import { DEFAULT_CONFIG } from "../packages/core/src/config.js";

/**
 * The setup buttons in the dashboard are only as good as their wiring, and a mistyped path
 * or a missed masked-token case fails at runtime rather than at build. These drive a real
 * server over a real socket.
 *
 * Telegram itself is never called with a usable token here - the tokens are junk. The
 * assertions deliberately avoid anything that depends on Telegram actually answering, so
 * these still mean the same thing on a machine with no network: what is being proved is
 * that the route resolves, reads its body and picks the right token.
 */
function serverWith(botToken: string) {
    const config = {
        ...DEFAULT_CONFIG,
        notifications: { ...DEFAULT_CONFIG.notifications, telegram: { botToken, chatId: "" } },
    };
    return new ApiServer(
        {
            auth: {} as never,
            version: "test",
            startedAt: Date.now(),
            bus: new EventEmitter(),
            getAuthStatus: () => "ok" as const,
            getDeviceCode: () => null,
            getMiner: () => null,
            getConfig: () => config,
            setConfig: async () => {},
            getNotifier: () => ({ send: async () => {} }) as never,
            getSteamLibrary: () => null,
            searchGames: async () => [],
            connectSteam: async () => 0,
            logout: async () => ({ revoked: true }),
            refreshSteam: async () => 0,
            disconnectSteam: async () => {},
        } as never,
        "/nonexistent",
    );
}

async function post(port: number, path: string, body: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("telegram setup routes", () => {
    it("refuses to guess when there is no token anywhere", async () => {
        const server = serverWith("");
        const port = await server.listen("127.0.0.1", 0);
        try {
            for (const path of ["/api/notify/telegram/check", "/api/notify/telegram/detect-chat"]) {
                const { status, body } = await post(port, path, {});
                expect(status).toBe(400);
                expect(body.error).toMatch(/token/i);
            }
        } finally {
            server.close();
        }
    });

    it("falls back to the stored token when the form only has the mask", async () => {
        // The dashboard never receives a real secret, so without this the setup buttons
        // would stop working the moment the page was reloaded.
        const server = serverWith("111111:storedtokenstoredtokenstoredtoken");
        const port = await server.listen("127.0.0.1", 0);
        try {
            const { status, body } = await post(port, "/api/notify/telegram/check", {
                botToken: "********",
            });
            // 200 rather than 400 is the whole point: it found a token to try. What
            // Telegram then said about it does not matter here.
            expect(status).toBe(200);
            expect(body.ok).toBe(false);
        } finally {
            server.close();
        }
    });

    it("never claims nobody has messaged the bot when the call itself failed", async () => {
        // Those two failures look identical to someone staring at the button, and telling
        // them to go and message the bot when the real problem is the token would send
        // them round a loop that cannot end. Only a genuine empty update list may say
        // "waiting" - the wording itself is covered in telegram-setup.test.ts.
        const server = serverWith("");
        const port = await server.listen("127.0.0.1", 0);
        try {
            const { body } = await post(port, "/api/notify/telegram/detect-chat", {
                botToken: "222222:definitelynotarealtokenatallnope",
            });
            expect(body.ok).toBe(false);
            expect(body.waiting).toBeUndefined();
            expect(String(body.error ?? "")).not.toBe("");
        } finally {
            server.close();
        }
    });
});
