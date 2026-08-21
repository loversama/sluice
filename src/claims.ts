import { readFile, writeFile, mkdir } from "node:fs/promises";
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
        await mkdir(dirname(path), { recursive: true });
        await writeFile(
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
}

export function summarise(history: ClaimHistory, requiredMinutesByDrop: Map<string, number>): ClaimStats {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60_000;
    return {
        dropsLast7Days: history.claims.filter((claim) => claim.at >= weekAgo).length,
        dropsAllTime: history.claims.length,
        campaignsCompleted: history.completedCampaignIds.length,
        minutesEarned: history.claims.reduce(
            (sum, claim) => sum + (requiredMinutesByDrop.get(claim.dropId) ?? 0),
            0,
        ),
    };
}
