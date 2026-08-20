/**
 * Twitch client identities and GraphQL persisted-query definitions.
 *
 * Twitch's private GQL endpoint accepts "persisted queries": instead of sending the query
 * text, you send an operation name plus the SHA256 hash of the query the official web client
 * would have sent. Twitch rotates these hashes whenever they change a query, at which point
 * requests start failing with a PersistedQueryNotFound error. `npm run check-hashes` reports
 * which of these have gone stale.
 */

export interface ClientInfo {
    /** Origin/Referer to present. Must match the client ID or Twitch rejects the request. */
    readonly clientUrl: string;
    readonly clientId: string;
    readonly userAgent: string;
}

/**
 * The public web client ID. This is not a secret - it is embedded in twitch.tv and is the
 * same for every visitor.
 */
export const WEB_CLIENT: ClientInfo = {
    clientUrl: "https://www.twitch.tv",
    clientId: "kimne78kx3ncx6brgo4mv6wki5h1ko",
    userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
};

export const GQL_URL = "https://gql.twitch.tv/gql";
export const PUBSUB_URL = "wss://pubsub-edge.twitch.tv/v1";
export const OAUTH_DEVICE_URL = "https://id.twitch.tv/oauth2/device";
export const OAUTH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
export const OAUTH_VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
export const USHER_URL = "https://usher.ttvnw.net/api/channel/hls";

/** How often to send a watch payload. Twitch credits one "minute watched" per beat. */
export const WATCH_INTERVAL_MS = 59_000;
/** PubSub requires a PING at least every 5 minutes; we use 3 for headroom. */
export const PING_INTERVAL_MS = 3 * 60_000;
export const PING_TIMEOUT_MS = 10_000;
/**
 * A channel that just came online is not immediately creditable - Twitch needs a moment to
 * register the broadcast. Wait this long after a stream-up event before trusting it.
 */
export const ONLINE_DELAY_MS = 120_000;
/** PubSub caps topics per connection; we shard across sockets to stay under it. */
export const TOPICS_PER_SOCKET = 50;
export const MAX_SOCKETS = 8;

export interface PersistedQuery {
    readonly operationName: string;
    readonly sha256: string;
    readonly variables?: Record<string, unknown>;
}

/**
 * Verified against DevilXD/TwitchDropsMiner as of 2026-08. If a query starts returning
 * PersistedQueryNotFound, the hash has rotated and needs re-capturing from twitch.tv traffic.
 */
export const QUERIES = {
    /** All drop campaigns visible to the account, active and upcoming. */
    campaigns: {
        operationName: "ViewerDropsDashboard",
        sha256: "d9cae7761dafab85908c85e6683cb4201b449e66ac3bb5e894f15ff12aeafaa7",
        variables: { fetchRewardCampaigns: false },
    },
    /** Full detail for one campaign, including its drops and channel allow-list. */
    campaignDetails: {
        operationName: "DropCampaignDetails",
        sha256: "039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1",
    },
    /** Campaigns already in progress, with per-drop minutes watched and claim state. */
    inventory: {
        operationName: "Inventory",
        sha256: "8337eb8541b314040b0edde0c09c5c7a2783ba1960aa9edfbf3bac16d0fec404",
        variables: { fetchRewardCampaigns: false },
    },
    /** Live progress for the channel currently being watched. */
    currentDrop: {
        operationName: "DropCurrentSessionContext",
        sha256: "4d06b702d25d652afb9ef835d2a550031f1cf762b193523a92166f40ea3d142b",
    },
    /** Which campaigns a given channel actually grants right now. */
    availableDrops: {
        operationName: "DropsHighlightService_AvailableDrops",
        sha256: "782dad0f032942260171d2d80a654f88bdd0c5a9dddc392e9bc92218a0f42d20",
    },
    claimDrop: {
        operationName: "DropsPage_ClaimDropRewards",
        sha256: "a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930",
    },
    /** Live channels for a game. Requires the game *slug*, not its display name. */
    gameDirectory: {
        operationName: "DirectoryPage_Game",
        sha256: "86bcceb4e8b1a51256ff8eed8bd8aae4acacf80d737efe904f84f3aeadf8cafd",
    },
    /** Resolves a game's display name to its URL slug. */
    slugRedirect: {
        operationName: "DirectoryGameRedirect",
        sha256: "1f0300090caceec51f33c5e20647aceff9017f740f223c3c532ba6fa59f6b6cc",
    },
    streamInfo: {
        operationName: "VideoPlayerStreamInfoOverlayChannel",
        sha256: "198492e0857f6aedead9665c81c5a06d67b25b58034649687124083ff288597d",
    },
    playbackAccessToken: {
        operationName: "PlaybackAccessToken",
        sha256: "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9",
        variables: {
            isLive: true,
            isVod: false,
            platform: "web",
            playerType: "site",
            vodID: "",
        },
    },
    channelPoints: {
        operationName: "ChannelPointsContext",
        sha256: "374314de591e69925fce3ddc2bcf085796f56ebb8cad67a0daa3165c03adc345",
    },
    claimChannelPoints: {
        operationName: "ClaimCommunityPoints",
        sha256: "46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0",
    },
} as const satisfies Record<string, PersistedQuery>;

export type QueryName = keyof typeof QUERIES;
