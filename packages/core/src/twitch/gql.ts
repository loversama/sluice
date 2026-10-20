import { request } from "undici";

import logger from "../logger.js";
import type { AuthState } from "./auth.js";
import { GQL_URL, QUERIES, type PersistedQuery, type QueryName } from "./constants.js";

/**
 * Channels fetched per directory query. The request cost is the same at any size, so this is
 * set well above the number we will actually check - a wider pool gives the drops-title
 * filter more to find.
 */
const DIRECTORY_PAGE_SIZE = 50;
import type {
    DropCampaign,
    Inventory,
    StreamNode,
    TimeBasedDrop,
} from "./types.js";

export class GqlError extends Error {
    constructor(message: string, readonly errors?: unknown) {
        super(message);
    }
}

/**
 * Raised when Twitch does not recognise a persisted query hash.
 *
 * This is the single most likely reason this bot stops working: Twitch rotated the query and
 * our stored SHA256 is stale. It is called out as its own error type so the failure is
 * obvious rather than surfacing as a confusing null dereference.
 */
/** Raised when Twitch no longer accepts the token and a refresh could not rescue it. */
export class AuthExpiredError extends GqlError {
    constructor() {
        super("Twitch rejected the access token. Re-authorize with --logout, or in the dashboard.");
    }
}

export class StaleQueryHashError extends GqlError {
    constructor(readonly operationName: string) {
        super(
            `Twitch no longer recognises the persisted query hash for "${operationName}". ` +
                "The hash has rotated and must be re-captured from twitch.tv network traffic " +
                "(see README: Updating GQL hashes).",
        );
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface GqlResponse<T> {
    data?: T;
    errors?: { message: string; [key: string]: unknown }[];
}

function buildPayload(query: PersistedQuery, variables?: Record<string, unknown>) {
    const merged = { ...(query.variables ?? {}), ...(variables ?? {}) };
    const payload: Record<string, unknown> = {
        operationName: query.operationName,
        extensions: { persistedQuery: { version: 1, sha256Hash: query.sha256 } },
    };
    if (Object.keys(merged).length > 0) {
        payload["variables"] = merged;
    }
    return payload;
}

export class TwitchGql {
    constructor(private readonly auth: AuthState) {}

    /**
     * Send one persisted query and return its `data`.
     *
     * Twitch answers with HTTP 200 even for failures, putting the problem in an `errors`
     * array, so success must be determined from the body rather than the status code.
     */
    async query<T>(
        name: QueryName,
        variables?: Record<string, unknown>,
        options: { retries?: number } = {},
    ): Promise<T> {
        const query = QUERIES[name];
        const payload = buildPayload(query, variables);
        const retries = options.retries ?? 3;

        let lastError: unknown;
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (attempt > 0) {
                // Exponential backoff, capped - Twitch rate-limits aggressive clients.
                // The +/-10% variance stops repeated failures from re-syncing into a
                // regular pattern of retries.
                const backoff = Math.min(1000 * 2 ** attempt, 15_000);
                await sleep(backoff * (0.9 + Math.random() * 0.2));
            }
            try {
                const response = await request(GQL_URL, {
                    method: "POST",
                    headers: {
                        ...this.auth.headers({ gql: true }),
                        "Content-Type": "text/plain;charset=UTF-8",
                    },
                    body: JSON.stringify(payload),
                });

                if (response.statusCode === 401) {
                    await response.body.dump();
                    // One refresh attempt per request; if it works the retry below succeeds,
                    // and if it does not the error names the actual problem.
                    if (attempt === 0 && (await this.auth.refresh())) {
                        continue;
                    }
                    throw new AuthExpiredError();
                }
                if (response.statusCode >= 500) {
                    await response.body.dump();
                    lastError = new GqlError(`Twitch returned ${response.statusCode}`);
                    continue;
                }
                if (response.statusCode !== 200) {
                    const text = await response.body.text();
                    throw new GqlError(`${query.operationName} failed (${response.statusCode}): ${text}`);
                }

                const body = (await response.body.json()) as GqlResponse<T>;

                if (body.errors?.length) {
                    const messages = body.errors.map((error) => String(error.message));
                    if (messages.some((message) => /PersistedQueryNotFound/i.test(message))) {
                        throw new StaleQueryHashError(query.operationName);
                    }
                    // These are transient server-side hiccups; retrying usually clears them.
                    if (messages.some((message) => /service (timeout|error|unavailable)/i.test(message))) {
                        lastError = new GqlError(`${query.operationName}: ${messages.join("; ")}`);
                        continue;
                    }
                    throw new GqlError(
                        `${query.operationName}: ${messages.join("; ")}`,
                        body.errors,
                    );
                }

                if (body.data === undefined) {
                    throw new GqlError(`${query.operationName} returned no data`);
                }
                return body.data;
            } catch (error) {
                // A stale hash will never fix itself; fail fast instead of burning retries.
                if (error instanceof StaleQueryHashError || error instanceof GqlError) {
                    throw error;
                }
                lastError = error;
                logger.debug(`${query.operationName} attempt ${attempt + 1} failed:`, error);
            }
        }
        throw new GqlError(`${query.operationName} failed after ${retries + 1} attempts`, lastError);
    }

    /**
     * Send a raw GraphQL query rather than a persisted one.
     *
     * Twitch accepts both. Raw queries cannot go stale the way persisted hashes do, so they
     * are preferable where the shape is simple and stable.
     */
    async rawQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        const response = await request(GQL_URL, {
            method: "POST",
            headers: {
                ...this.auth.headers({ gql: true }),
                "Content-Type": "text/plain;charset=UTF-8",
            },
            body: JSON.stringify({ query, variables }),
        });
        if (response.statusCode !== 200) {
            const text = await response.body.text();
            throw new GqlError(`Raw query failed (${response.statusCode}): ${text}`);
        }
        const body = (await response.body.json()) as GqlResponse<T>;
        if (body.errors?.length) {
            throw new GqlError(body.errors.map((error) => String(error.message)).join("; "));
        }
        if (body.data === undefined) {
            throw new GqlError("Raw query returned no data");
        }
        return body.data;
    }

    /**
     * Search every game category on Twitch, not just those with a campaign right now.
     *
     * The priority list is a standing preference - a user wants to queue a game before its
     * campaign is announced - so it must be able to name games the campaign list has never
     * mentioned.
     */
    async searchGames(
        term: string,
        limit = 8,
    ): Promise<{ id: string; name: string; slug: string; boxArtURL: string | null }[]> {
        if (!term.trim()) {
            return [];
        }
        const data = await this.rawQuery<{
            searchCategories: {
                edges: { node: { id: string; name: string; slug: string; boxArtURL: string | null } }[];
            } | null;
        }>(
            "query($q:String!,$n:Int!){searchCategories(query:$q first:$n)" +
                "{edges{node{id name slug boxArtURL}}}}",
            { q: term, n: limit },
        );
        return (data.searchCategories?.edges ?? []).map((edge) => ({
            ...edge.node,
            // Twitch returns a template with {width}x{height} placeholders.
            boxArtURL: edge.node.boxArtURL?.replace("{width}x{height}", "72x96") ?? null,
        }));
    }

    /** Every campaign visible to this account, without per-drop detail. */
    async getCampaigns(): Promise<DropCampaign[]> {
        const data = await this.query<{ currentUser: { dropCampaigns: DropCampaign[] | null } }>(
            "campaigns",
        );
        return data.currentUser?.dropCampaigns ?? [];
    }

    /** Full detail for one campaign: its drops, and any channel allow-list. */
    async getCampaignDetails(campaignId: string): Promise<DropCampaign | null> {
        const data = await this.query<{ user: { dropCampaign: DropCampaign | null } | null }>(
            "campaignDetails",
            // Despite its name, channelLogin takes the numeric user ID. Twitch once accepted
            // the login too; since October 2026 a login gets `dropCampaign: null` back with
            // no error, which left every campaign looking drop-less and therefore "done".
            { dropID: campaignId, channelLogin: this.auth.userId },
        );
        return data.user?.dropCampaign ?? null;
    }

    async getInventory(): Promise<Inventory> {
        const data = await this.query<{ currentUser: { inventory: Inventory } }>("inventory");
        return data.currentUser.inventory;
    }

    /**
     * How many minutes the current watch session has been credited on this channel.
     *
     * One cheap call that answers "is this channel actually earning?" directly, instead of
     * waiting out fifteen unconfirmed beats and then reconciling the whole inventory.
     * Returns null when Twitch reports no session, which is itself the answer.
     */
    async getCurrentDropSession(
        channelId: string,
    ): Promise<{ dropId: string; currentMinutes: number } | null> {
        const data = await this.query<{
            currentUser: {
                dropCurrentSession: { dropID: string; currentMinutesWatched: number } | null;
            } | null;
        }>("currentDrop", { channelID: channelId, channelLogin: "" });
        const session = data.currentUser?.dropCurrentSession;
        if (!session) {
            return null;
        }
        return { dropId: session.dropID, currentMinutes: session.currentMinutesWatched };
    }

    /** Campaign IDs this channel currently grants progress toward. */
    async getAvailableDrops(channelId: string): Promise<TimeBasedDrop[]> {
        const data = await this.query<{
            channel: { viewerDropCampaigns: TimeBasedDrop[] | null } | null;
        }>("availableDrops", { channelID: channelId });
        return data.channel?.viewerDropCampaigns ?? [];
    }

    async claimDrop(dropInstanceId: string): Promise<boolean> {
        const data = await this.query<{
            claimDropRewards: { status?: string } | null;
        }>("claimDrop", { input: { dropInstanceID: dropInstanceId } });
        const status = data.claimDropRewards?.status;
        // Twitch reports an already-claimed drop as a success case, not an error.
        return status === "ELIGIBLE_FOR_ALL" || status === "DROP_INSTANCE_ALREADY_CLAIMED";
    }

    /** The directory query needs a URL slug, which is not always the display name lowercased. */
    async getGameSlug(gameName: string): Promise<string | null> {
        const data = await this.query<{ game: { slug: string } | null }>("slugRedirect", {
            name: gameName,
        });
        return data.game?.slug ?? null;
    }

    /**
     * Live channels for a game, viewer count descending.
     *
     * One request regardless of `limit`, so a larger page costs only bandwidth and gives
     * client-side filters a bigger pool to work with. Verified up to 100.
     */
    async getGameChannels(
        slug: string,
        options: {
            limit?: number;
            dropsOnly?: boolean;
            /** Two-letter codes, e.g. ["EN"]. Empty means any language. */
            languages?: string[];
        } = {},
    ): Promise<StreamNode[]> {
        const data = await this.query<{
            game: { streams: { edges: { node: StreamNode }[] } | null } | null;
        }>("gameDirectory", {
            slug,
            limit: options.limit ?? DIRECTORY_PAGE_SIZE,
            imageWidth: 50,
            includeCostreaming: false,
            sortTypeIsRecency: false,
            options: {
                broadcasterLanguages: options.languages ?? [],
                freeformTags: null,
                includeRestricted: ["SUB_ONLY_LIVE"],
                recommendationsContext: { platform: "web" },
                sort: "RELEVANCE",
                systemFilters: options.dropsOnly ? ["DROPS_ENABLED"] : [],
                tags: [],
                requestID: "JIRA-VXP-2397",
            },
        });
        return (data.game?.streams?.edges ?? []).map((edge) => edge.node);
    }

    /** Live stream state for one channel, or null when the channel is offline. */
    async getStreamInfo(login: string): Promise<{
        id: string;
        stream: { id: string; viewersCount: number } | null;
        broadcastSettings: { title: string; game: { id: string; name: string } | null } | null;
    } | null> {
        const data = await this.query<{
            user: {
                id: string;
                stream: { id: string; viewersCount: number } | null;
                broadcastSettings: {
                    title: string;
                    game: { id: string; name: string } | null;
                } | null;
            } | null;
        }>("streamInfo", { channel: login });
        return data.user ?? null;
    }

}
