import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import logger from "./logger.js";

/**
 * Notification bookkeeping that has to outlive the process.
 *
 * "Once per campaign" is meaningless if the record is in memory: a restart re-sends every
 * alert, and a few restarts in an afternoon turn a useful warning into noise the user learns
 * to ignore. Persisting it is what makes the guarantee real.
 */
export interface PersistedState {
    /** Campaigns already warned about for unlinked progress nearing expiry. */
    warnedExpiring: string[];
    /** Drops already flagged as claimed-while-unlinked. */
    notifiedUnlinkedClaims: string[];
    /** Drops Twitch refused, so a doomed claim is not retried after a restart either. */
    failedClaims: string[];
}

const EMPTY: PersistedState = {
    warnedExpiring: [],
    notifiedUnlinkedClaims: [],
    failedClaims: [],
};

/** Keep the file bounded; these are campaign and drop IDs that eventually stop mattering. */
const MAX_ENTRIES = 500;

export async function loadState(path: string): Promise<PersistedState> {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PersistedState>;
        return {
            warnedExpiring: parsed.warnedExpiring ?? [],
            notifiedUnlinkedClaims: parsed.notifiedUnlinkedClaims ?? [],
            failedClaims: parsed.failedClaims ?? [],
        };
    } catch {
        return { ...EMPTY };
    }
}

export async function saveState(path: string, state: PersistedState): Promise<void> {
    const trim = (values: string[]) => values.slice(-MAX_ENTRIES);
    try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(
            path,
            JSON.stringify(
                {
                    warnedExpiring: trim(state.warnedExpiring),
                    notifiedUnlinkedClaims: trim(state.notifiedUnlinkedClaims),
                    failedClaims: trim(state.failedClaims),
                },
                null,
                2,
            ),
        );
    } catch (error) {
        // Losing this only costs a duplicate notification, so never let it stop mining.
        logger.debug("Could not persist notification state:", error);
    }
}
