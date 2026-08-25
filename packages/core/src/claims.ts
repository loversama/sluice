import { readFile } from "node:fs/promises";

import { writeFileAtomic } from "./atomic-write.js";
import { dirname } from "node:path";

import logger from "./logger.js";
import type { ClaimRecord } from "./miner.js";

/**
 * A durable record of what the bot has actually earned.
 *
 * The in-memory ring buffer resets on every restart, so the dashboard forgot its own history
 * after each deploy. A miner is judged by what it produced; that record has to outlive the
 * process.
 */
export interface ClaimHistory {
    claims: ClaimRecord[];
    /** Campaign IDs seen completed, so the count is not inflated by repeats. */
    completedCampaignIds: string[];
}

/** Enough for a long history without the file becoming unwieldy. */
const MAX_CLAIMS = 1000;

export async function loadClaims(path: string): Promise<ClaimHistory> {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ClaimHistory>;
        return {
            claims: parsed.claims ?? [],
            completedCampaignIds: parsed.completedCampaignIds ?? [],
        };
    } catch {
        return { claims: [], completedCampaignIds: [] };
    }
}

export async function saveClaims(path: string, history: ClaimHistory): Promise<void> {
    try {
        await writeFileAtomic(
            path,
            JSON.stringify(
                {
                    claims: history.claims.slice(-MAX_CLAIMS),
                    completedCampaignIds: history.completedCampaignIds.slice(-MAX_CLAIMS),
                },
                null,
                2,
            ),
        );
    } catch (error) {
        // Losing history is not worth interrupting mining over.
        logger.debug("Could not persist claim history:", error);
    }
}

export interface ClaimStats {
    dropsLast7Days: number;
    dropsAllTime: number;
    campaignsCompleted: number;
    /** Total required watch time across everything claimed, as a rough "time invested". */
    minutesEarned: number;
    /** Of that, the minutes spent on campaigns whose reward could actually arrive. */
    deliverableMinutes: number;
    /** Minutes spent on campaigns that could not pay out. */
    wastedMinutes: number;
}

export function summarise(
    history: ClaimHistory,
    requiredMinutesByDrop: Map<string, number>,
    /** Whether each campaign's reward could reach the user; absent means we no longer know. */
    deliverableByCampaign: Map<string, boolean>,
): ClaimStats {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60_000;
    let earned = 0;
    let deliverable = 0;
    let wasted = 0;

    for (const claim of history.claims) {
        // The record's own figure first: the campaign store is empty for the first moments
        // after a restart and forgets campaigns as they rotate out, so relying on it made
        // this total flicker to zero and undercount thereafter.
        const minutes = claim.requiredMinutes ?? requiredMinutesByDrop.get(claim.dropId) ?? 0;
        earned += minutes;

        const known = claim.deliverable ?? deliverableByCampaign.get(claim.campaignId);
        if (known === true) {
            deliverable += minutes;
        } else if (known === false) {
            wasted += minutes;
        }
    }

    return {
        dropsLast7Days: history.claims.filter((claim) => claim.at >= weekAgo).length,
        dropsAllTime: history.claims.length,
        campaignsCompleted: history.completedCampaignIds.length,
        minutesEarned: earned,
        deliverableMinutes: deliverable,
        wastedMinutes: wasted,
    };
}
