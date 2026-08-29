import { request } from "undici";

import logger from "../logger.js";

const STEAM_OPENID = "https://steamcommunity.com/openid/login";
const CLAIMED_ID_PATTERN = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

/**
 * Steam sign-in, via OpenID 2.0 - the only sign-in Steam offers.
 *
 * This establishes *who* the user is without them copying an ID by hand, and that is all
 * it is for - the library itself is read through the broker, from the Steam ID this hands
 * back.
 */
export function buildLoginUrl(returnTo: string, realm: string): string {
    const params = new URLSearchParams({
        "openid.ns": "http://specs.openid.net/auth/2.0",
        "openid.mode": "checkid_setup",
        "openid.return_to": returnTo,
        "openid.realm": realm,
        // Steam decides which account; we do not name one up front.
        "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
        "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
    });
    return `${STEAM_OPENID}?${params}`;
}

/**
 * Validate the assertion Steam sent back and extract the Steam ID.
 *
 * The signature must be checked with Steam directly - the query string alone is attacker
 * controlled, so trusting `claimed_id` without verification would let anyone claim any
 * account. Returns null if the assertion does not verify.
 */
export async function verifyCallback(query: URLSearchParams): Promise<string | null> {
    const claimedId = query.get("openid.claimed_id");
    if (!claimedId) {
        return null;
    }
    const match = CLAIMED_ID_PATTERN.exec(claimedId);
    if (!match?.[1]) {
        logger.debug(`Unexpected OpenID claimed_id: ${claimedId}`);
        return null;
    }

    // Echo every parameter back, with mode swapped, and let Steam confirm the signature.
    const verification = new URLSearchParams(query);
    verification.set("openid.mode", "check_authentication");

    const response = await request(STEAM_OPENID, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: verification.toString(),
    });
    const body = await response.body.text();

    if (!/is_valid\s*:\s*true/i.test(body)) {
        logger.warn("Steam rejected the sign-in assertion.");
        return null;
    }
    return match[1];
}
