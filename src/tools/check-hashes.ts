/**
 * Health-check every persisted query hash against Twitch.
 *
 * Twitch rotates these hashes without warning, and a stale one makes the affected feature
 * fail with PersistedQueryNotFound. Run this first whenever the bot starts misbehaving.
 *
 * Runs unauthenticated, so operations that require a token report "needs auth" - that still
 * proves the hash itself is recognised, which is what we are checking.
 */
import { request } from "undici";

import {
    GQL_URL,
    QUERIES,
    WEB_CLIENT,
    type PersistedQuery,
    type QueryName,
} from "../twitch/constants.js";

/** Placeholder variables, just enough for Twitch to resolve each operation. */
const PROBES: Record<QueryName, Record<string, unknown>> = {
    campaigns: {},
    campaignDetails: { dropID: "0", channelLogin: "twitch" },
    inventory: {},
    currentDrop: { channelID: "1", channelLogin: "" },
    availableDrops: { channelID: "1" },
    claimDrop: { input: { dropInstanceID: "0" } },
    gameDirectory: {
        slug: "rust",
        limit: 1,
        imageWidth: 50,
        includeCostreaming: false,
        sortTypeIsRecency: false,
        options: {
            broadcasterLanguages: [],
            freeformTags: null,
            includeRestricted: ["SUB_ONLY_LIVE"],
            recommendationsContext: { platform: "web" },
            sort: "RELEVANCE",
            systemFilters: [],
            tags: [],
            requestID: "JIRA-VXP-2397",
        },
    },
    slugRedirect: { name: "Rust" },
    streamInfo: { channel: "twitch" },
    playbackAccessToken: { login: "twitch" },
    channelPoints: { channelLogin: "twitch" },
    claimChannelPoints: { input: { claimID: "0", channelID: "1" } },
};

async function main(): Promise<void> {
    let stale = 0;

    for (const name of Object.keys(QUERIES) as QueryName[]) {
        // Widen away from the literal const type so optional fields are visible.
        const query: PersistedQuery = QUERIES[name];
        const variables = { ...(query.variables ?? {}), ...PROBES[name] };
        const response = await request(GQL_URL, {
            method: "POST",
            headers: {
                "Client-Id": WEB_CLIENT.clientId,
                "User-Agent": WEB_CLIENT.userAgent,
                "Content-Type": "text/plain;charset=UTF-8",
            },
            body: JSON.stringify({
                operationName: query.operationName,
                variables,
                extensions: { persistedQuery: { version: 1, sha256Hash: query.sha256 } },
            }),
        });
        const body = await response.body.text();

        let status: string;
        if (/PersistedQueryNotFound/i.test(body)) {
            status = "STALE - hash rotated";
            stale++;
        } else if (/IntegrityCheckFailed/i.test(body)) {
            // Expected without a token: the operation exists but is gated behind auth.
            status = "ok (needs auth)";
        } else {
            status = "ok";
        }
        console.log(`${name.padEnd(22)} ${query.operationName.padEnd(38)} ${status}`);
    }

    if (stale > 0) {
        console.error(
            `\n${stale} hash(es) are stale. Capture fresh ones from twitch.tv network traffic ` +
                "and update src/twitch/constants.ts.",
        );
        process.exit(1);
    }
    console.log("\nAll persisted query hashes are current.");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
