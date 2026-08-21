import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { request } from "undici";

import logger from "../logger.js";
import {
    DEFAULT_CLIENT,
    OAUTH_DEVICE_URL,
    OAUTH_TOKEN_URL,
    OAUTH_VALIDATE_URL,
    randomAndroidUserAgent,
    type ClientInfo,
} from "./constants.js";
import type { DeviceCodeResponse, TokenResponse, ValidateResponse } from "./types.js";

export class AuthError extends Error {}

export interface StoredAuth {
    accessToken: string;
    refreshToken?: string;
    userId: string;
    login: string;
    deviceId: string;
    /** Which client issued this token. A token is only usable by its issuing client. */
    clientId?: string;
    /** Pinned alongside the device ID: a real phone does not change model between runs. */
    userAgent?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Twitch's own IDs are lowercase hex of this length; matching the format avoids standing out. */
function randomHex(length: number): string {
    return randomBytes(Math.ceil(length / 2))
        .toString("hex")
        .slice(0, length);
}

/**
 * Holds the OAuth credentials and the per-install identifiers that every request carries.
 *
 * Authentication uses the OAuth *device code* flow: we ask Twitch for a short code, the user
 * types it at twitch.tv/activate, and we poll until they do. No password ever reaches this
 * process, and there is nothing to scrape - which is why this survives login page redesigns
 * and 2FA changes that break browser-driven bots.
 */
export class AuthState {
    client: ClientInfo;
    /** Stable per-install ID. Twitch treats a changing device ID as suspicious. */
    deviceId: string;
    /** Rotates per process run, mirroring a fresh browser tab. */
    readonly sessionId: string;

    accessToken = "";
    refreshToken: string | undefined;
    userId = "";
    login = "";

    constructor(client: ClientInfo = DEFAULT_CLIENT) {
        // A fresh install picks one device string; load() replaces it with the stored one.
        this.client = { ...client, userAgent: randomAndroidUserAgent() };
        this.deviceId = randomHex(32);
        this.sessionId = randomHex(16);
    }

    get isAuthenticated(): boolean {
        return this.accessToken !== "" && this.userId !== "";
    }

    /**
     * Headers for a GQL request. Twitch cross-checks Client-Id against Origin/Referer, so
     * these must stay consistent with each other.
     */
    headers(options: { gql?: boolean } = {}): Record<string, string> {
        const headers: Record<string, string> = {
            Accept: "*/*",
            "Accept-Language": "en-US",
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
            "Client-Id": this.client.clientId,
            "User-Agent": this.client.userAgent,
            "X-Device-Id": this.deviceId,
            "Client-Session-Id": this.sessionId,
        };
        if (options.gql) {
            headers["Origin"] = this.client.clientUrl;
            headers["Referer"] = `${this.client.clientUrl}/`;
            if (this.accessToken) {
                headers["Authorization"] = `OAuth ${this.accessToken}`;
            }
        }
        return headers;
    }

    toJSON(): StoredAuth {
        return {
            accessToken: this.accessToken,
            refreshToken: this.refreshToken,
            userId: this.userId,
            login: this.login,
            deviceId: this.deviceId,
            clientId: this.client.clientId,
            userAgent: this.client.userAgent,
        };
    }

    async save(path: string): Promise<void> {
        await mkdir(dirname(path), { recursive: true });
        // Mode 0600: this file grants full access to the Twitch account.
        await writeFile(path, JSON.stringify(this.toJSON(), null, 2), { mode: 0o600 });
        logger.debug(`Saved credentials to ${path}`);
    }

    async load(path: string): Promise<boolean> {
        try {
            const stored = JSON.parse(await readFile(path, "utf8")) as StoredAuth;
            // A token issued by a different client will fail the integrity check rather than
            // erroring cleanly, so discard it and force a fresh login instead.
            // Missing clientId means it predates this field, so it cannot be trusted either.
            if (stored.clientId !== this.client.clientId) {
                logger.info("Stored credentials were issued by a different client; re-authorizing.");
                return false;
            }
            this.accessToken = stored.accessToken;
            this.refreshToken = stored.refreshToken;
            this.userId = stored.userId;
            this.login = stored.login;
            if (stored.deviceId) {
                this.deviceId = stored.deviceId;
            }
            if (stored.userAgent) {
                this.client = { ...this.client, userAgent: stored.userAgent };
            }
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Confirm the stored token still works, and pick up our user ID and login from Twitch.
     * Returns false if the token has been revoked or expired.
     */
    async validate(): Promise<boolean> {
        if (!this.accessToken) {
            return false;
        }
        const response = await request(OAUTH_VALIDATE_URL, {
            method: "GET",
            headers: { Authorization: `OAuth ${this.accessToken}` },
        });
        if (response.statusCode !== 200) {
            await response.body.dump();
            logger.debug(`Token validation failed with status ${response.statusCode}`);
            return false;
        }
        const data = (await response.body.json()) as ValidateResponse;
        this.userId = data.user_id;
        this.login = data.login;
        return true;
    }

    /**
     * Exchange the stored refresh token for a new access token.
     *
     * Twitch access tokens expire, and until now the refresh token was saved and never used:
     * once the access token lapsed mid-run every call failed generically and the miner
     * logged the same error forever with nothing actionable surfaced.
     *
     * Returns false when there is no usable refresh token, in which case the caller has to
     * fall back to a fresh device-code login.
     */
    async refresh(): Promise<boolean> {
        if (!this.refreshToken) {
            return false;
        }
        const response = await request(OAUTH_TOKEN_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Client-Id": this.client.clientId,
                "User-Agent": this.client.userAgent,
            },
            body: new URLSearchParams({
                client_id: this.client.clientId,
                grant_type: "refresh_token",
                refresh_token: this.refreshToken,
            }).toString(),
        });

        if (response.statusCode !== 200) {
            await response.body.dump();
            logger.debug(`Token refresh rejected with ${response.statusCode}`);
            return false;
        }
        const token = (await response.body.json()) as TokenResponse;
        this.accessToken = token.access_token;
        // Twitch issues a new refresh token each time; keeping the old one would break the
        // next refresh.
        if (token.refresh_token) {
            this.refreshToken = token.refresh_token;
        }
        const valid = await this.validate();
        if (valid) {
            logger.info("Refreshed the Twitch access token.");
        }
        return valid;
    }

    /**
     * Run the device code flow, calling `onCode` once the user needs to enter the code.
     * Resolves when the user has approved, or throws if they never do.
     */
    async authorize(onCode: (verificationUri: string, userCode: string) => void): Promise<void> {
        const headers = {
            Accept: "application/json",
            "Accept-Language": "en-US",
            "Client-Id": this.client.clientId,
            Origin: this.client.clientUrl,
            Referer: `${this.client.clientUrl}/`,
            "User-Agent": this.client.userAgent,
            "X-Device-Id": this.deviceId,
            "Content-Type": "application/x-www-form-urlencoded",
        };

        const deviceResponse = await request(OAUTH_DEVICE_URL, {
            method: "POST",
            headers,
            // An empty scope set is deliberate: drop mining needs no granted scopes.
            body: new URLSearchParams({ client_id: this.client.clientId, scopes: "" }).toString(),
        });
        if (deviceResponse.statusCode !== 200) {
            const text = await deviceResponse.body.text();
            throw new AuthError(`Device code request failed (${deviceResponse.statusCode}): ${text}`);
        }
        const device = (await deviceResponse.body.json()) as DeviceCodeResponse;

        onCode(device.verification_uri, device.user_code);

        const deadline = Date.now() + device.expires_in * 1000;
        const pollBody = new URLSearchParams({
            client_id: this.client.clientId,
            device_code: device.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString();

        while (Date.now() < deadline) {
            // Sleep first - the user cannot possibly have entered the code yet.
            await sleep(device.interval * 1000);

            const tokenResponse = await request(OAUTH_TOKEN_URL, {
                method: "POST",
                headers,
                body: pollBody,
            });
            if (tokenResponse.statusCode !== 200) {
                // 400 simply means "not authorized yet"; keep polling.
                await tokenResponse.body.dump();
                continue;
            }
            const token = (await tokenResponse.body.json()) as TokenResponse;
            this.accessToken = token.access_token;
            this.refreshToken = token.refresh_token;
            if (!(await this.validate())) {
                throw new AuthError("Received a token but Twitch rejected it during validation.");
            }
            logger.info(`Logged in as ${this.login}`);
            return;
        }

        throw new AuthError("Device code expired before it was entered.");
    }
}
