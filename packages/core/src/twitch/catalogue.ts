import { request } from "undici";

import logger from "../logger.js";
import { VERSION } from "../version.js";
import type { DropCampaign } from "./types.js";

/**
 * A public, community-run list of every live Twitch drop campaign, with full details.
 *
 * Why it exists: since September 2026 Twitch no longer issues sign-in codes to the Android
 * client, and the TV client that still does is shown an empty campaign dashboard. A fresh
 * login therefore knows of no campaigns at all. This catalogue fills that one gap - the
 * campaign list and each campaign's drops and channel allow-list - and nothing else. The
 * account's own inventory, progress, watching and claiming all still come from Twitch.
 *
 * Nothing about the account is sent: no token, no cookies, no user ID. It is the same
 * fallback DevilXD/TwitchDropsMiner PR #1180 uses.
 */
export const CATALOGUE_URL = "https://twitch-drops-api.sunkwi.com/v2/drops";

/** How stale the catalogue may be before it is ignored rather than trusted. */
const MAX_AGE_MS = 6 * 60 * 60_000;

interface CatalogueGame {
    gameId: string;
    gameDisplayName: string;
    gameBoxArtURL?: string;
    rewards: DropCampaign[];
}

interface CatalogueResponse {
    lastUpdatedAt: string;
    refreshIntervalSeconds: number;
    data: CatalogueGame[];
}

/**
 * Turn the catalogue's per-game grouping into the flat campaign list Twitch would return.
 *
 * Exported for tests. A campaign whose end has passed is marked expired whatever the
 * catalogue says, so a lagging snapshot cannot bring back something that has ended.
 */
export function campaignsFromCatalogue(body: CatalogueResponse, now = Date.now()): DropCampaign[] {
    const campaigns: DropCampaign[] = [];
    for (const game of body.data ?? []) {
        for (const campaign of game.rewards ?? []) {
            if (!campaign?.id || !campaign.game?.id) {
                continue;
            }
            const ended = new Date(campaign.endAt).getTime() <= now;
            campaigns.push({
                ...campaign,
                status: ended ? "EXPIRED" : campaign.status,
                // Account-specific: the catalogue cannot know it, and claiming the account
                // is linked when it is not would be worse than not knowing.
                self: null,
                game: {
                    ...campaign.game,
                    displayName: campaign.game.displayName ?? game.gameDisplayName,
                    boxArtURL: campaign.game.boxArtURL ?? game.gameBoxArtURL,
                },
            });
        }
    }
    return campaigns;
}

/** Fetch the catalogue. Returns an empty list, never throws, if it is unusable. */
export async function fetchCatalogue(): Promise<DropCampaign[]> {
    try {
        const response = await request(CATALOGUE_URL, {
            method: "GET",
            headers: { accept: "application/json", "user-agent": `sluice/${VERSION}` },
            headersTimeout: 15_000,
            bodyTimeout: 30_000,
        });
        if (response.statusCode !== 200) {
            await response.body.dump();
            logger.warn(`The public drops catalogue returned ${response.statusCode}.`);
            return [];
        }
        const body = (await response.body.json()) as CatalogueResponse;
        const age = Date.now() - new Date(body.lastUpdatedAt).getTime();
        if (!(age < MAX_AGE_MS)) {
            logger.warn("The public drops catalogue has not updated in hours; ignoring it.");
            return [];
        }
        return campaignsFromCatalogue(body);
    } catch (error) {
        logger.warn(`Could not reach the public drops catalogue: ${(error as Error).message}`);
        return [];
    }
}
