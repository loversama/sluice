import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AuthState } from "../packages/core/src/twitch/auth.js";
import { ANDROID_CLIENT, TV_CLIENT } from "../packages/core/src/twitch/constants.js";

async function storedAuth(fields: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "sluice-auth-"));
    const path = join(dir, "auth.json");
    await writeFile(path, JSON.stringify({ accessToken: "t", userId: "1", login: "u", deviceId: "d", ...fields }));
    return path;
}

/**
 * Twitch stopped issuing device codes to the Android client while its existing tokens kept
 * working. New sign-ins move to the TV client; a token Android already issued must not be
 * thrown away on upgrade, or every existing install is forced through a login it gains
 * nothing from.
 */
describe("auth client selection", () => {
    it("signs new installs in as the TV client", () => {
        const auth = new AuthState();
        expect(auth.client.clientId).toBe(TV_CLIENT.clientId);
        expect(auth.client.clientUrl).toBe(TV_CLIENT.clientUrl);
        expect(auth.client.userAgent).toBe(TV_CLIENT.userAgent);
    });

    it("keeps a stored Android token on the Android client", async () => {
        const ua = "Dalvik/2.1.0 (stored)";
        const auth = new AuthState();
        const loaded = await auth.load(await storedAuth({ clientId: ANDROID_CLIENT.clientId, userAgent: ua }));
        expect(loaded).toBe(true);
        expect(auth.client.clientId).toBe(ANDROID_CLIENT.clientId);
        expect(auth.client.clientUrl).toBe(ANDROID_CLIENT.clientUrl);
        expect(auth.client.userAgent).toBe(ua);
        expect(auth.isAuthenticated).toBe(true);
    });

    it("loads a stored TV token", async () => {
        const auth = new AuthState();
        expect(await auth.load(await storedAuth({ clientId: TV_CLIENT.clientId }))).toBe(true);
        expect(auth.client.clientId).toBe(TV_CLIENT.clientId);
    });

    it("re-authorises a token from an unknown or missing client", async () => {
        expect(await new AuthState().load(await storedAuth({ clientId: "somethingelse" }))).toBe(false);
        expect(await new AuthState().load(await storedAuth({}))).toBe(false);
    });
});
