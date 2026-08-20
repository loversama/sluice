/**
 * Shapes returned by Twitch's private GQL API.
 *
 * Twitch omits fields depending on which query asked for them, so anything that is not
 * present in every response is marked optional. Trust the query, not the type.
 */

export interface Game {
    id: string;
    slug?: string;
    name?: string;
    displayName?: string;
    boxArtURL?: string;
}

export interface DropBenefit {
    id: string;
    name: string;
    imageAssetURL?: string;
    game?: Game;
}

export interface BenefitEdge {
    benefit: DropBenefit;
    entitlementLimit?: number;
}

export interface DropSelfState {
    currentMinutesWatched: number;
    /** Present only once the drop is claimable; required by the claim mutation. */
    dropInstanceID: string | null;
    isClaimed: boolean;
    hasPreconditionsMet?: boolean;
}

export interface TimeBasedDrop {
    id: string;
    name: string;
    startAt: string;
    endAt: string;
    requiredMinutesWatched: number;
    benefitEdges: BenefitEdge[];
    /** Drops in a tiered campaign that must be claimed before this one can progress. */
    preconditionDrops?: { id: string }[] | null;
    self?: DropSelfState | null;
}

export interface AllowList {
    isEnabled: boolean;
    channels: { id: string; name?: string; displayName?: string }[] | null;
}

export type CampaignStatus = "ACTIVE" | "UPCOMING" | "EXPIRED";

export interface DropCampaign {
    id: string;
    name: string;
    status: CampaignStatus;
    startAt: string;
    endAt: string;
    game: Game;
    /** False when the Twitch account is not linked to the publisher's account. */
    self?: { isAccountConnected: boolean } | null;
    timeBasedDrops?: TimeBasedDrop[] | null;
    allow?: AllowList | null;
}

export interface Inventory {
    dropCampaignsInProgress: DropCampaign[] | null;
    gameEventDrops: { id: string; name: string; lastAwardedAt: string; totalCount: number }[] | null;
}

export interface StreamNode {
    id: string;
    title?: string;
    viewersCount: number;
    game?: Game | null;
    broadcaster?: { id: string; login: string; displayName?: string } | null;
}

export interface DeviceCodeResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
}

export interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    token_type: string;
}

/** Response from id.twitch.tv/oauth2/validate - also how we learn our own user_id. */
export interface ValidateResponse {
    client_id: string;
    login: string;
    user_id: string;
    expires_in: number;
}
