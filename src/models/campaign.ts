import type { DropCampaign, TimeBasedDrop } from "../twitch/types.js";
import { SPECIAL_CATEGORY_IDS } from "../twitch/constants.js";

/**
 * One timed drop within a campaign, tracking our progress toward it.
 */
export class Drop {
    currentMinutes: number;
    isClaimed: boolean;
    /** Only populated once the drop is claimable. Required to actually claim it. */
    dropInstanceId: string | null;

    constructor(
        readonly data: TimeBasedDrop,
        readonly campaign: Campaign,
    ) {
        this.currentMinutes = data.self?.currentMinutesWatched ?? 0;
        this.isClaimed = data.self?.isClaimed ?? false;
        this.dropInstanceId = data.self?.dropInstanceID ?? null;
    }

    get id(): string {
        return this.data.id;
    }

    get requiredMinutes(): number {
        return this.data.requiredMinutesWatched;
    }

    get name(): string {
        return this.rewardNames || this.data.name;
    }

    get rewardNames(): string {
        return this.data.benefitEdges.map((edge) => edge.benefit.name).join(", ");
    }

    get startAt(): Date {
        return new Date(this.data.startAt);
    }

    get endAt(): Date {
        return new Date(this.data.endAt);
    }

    get remainingMinutes(): number {
        return Math.max(0, this.requiredMinutes - this.currentMinutes);
    }

    get progress(): number {
        return this.requiredMinutes === 0 ? 1 : this.currentMinutes / this.requiredMinutes;
    }

    /**
     * Ready to claim: watched long enough and not yet claimed.
     *
     * Deliberately does not require `dropInstanceId`. Twitch sometimes never sends one, but
     * the ID is derivable from IDs we already hold, so a missing instance ID is not a reason
     * to leave a finished drop uncollected.
     */
    get isClaimable(): boolean {
        // requiredMinutes of 0 means this is not a watch-time drop at all - an event or
        // gift drop that Twitch grants by other means. Without this guard `0 >= 0` makes
        // every such drop look permanently ready, and each refresh retries a claim that
        // Twitch will never accept.
        return this.requiredMinutes > 0 && !this.isClaimed && this.currentMinutes >= this.requiredMinutes;
    }

    get isActive(): boolean {
        const now = Date.now();
        return now >= this.startAt.getTime() && now < this.endAt.getTime();
    }

    /**
     * Whether there is still enough time left to finish this drop.
     * Campaigns occasionally get extended, so callers may choose to try anyway.
     */
    get isFinishable(): boolean {
        const minutesLeft = (this.endAt.getTime() - Date.now()) / 60_000;
        return minutesLeft >= this.remainingMinutes;
    }

    /**
     * Time slack: minutes left before this drop expires, divided by minutes still needed.
     * 1.0 means exactly enough time; below 1.0 it cannot be finished. Infinite when there is
     * nothing left to earn.
     */
    get slack(): number {
        const minutesLeft = (this.endAt.getTime() - Date.now()) / 60_000;
        if (this.remainingMinutes <= 0 || minutesLeft <= 0) {
            return Number.POSITIVE_INFINITY;
        }
        return minutesLeft / this.remainingMinutes;
    }

    /** IDs of drops that must be claimed before this one earns progress (tiered campaigns). */
    get preconditionIds(): string[] {
        return (this.data.preconditionDrops ?? []).map((drop) => drop.id);
    }

    update(self: Partial<{ currentMinutesWatched: number; isClaimed: boolean; dropInstanceID: string | null }>): void {
        if (self.currentMinutesWatched !== undefined) {
            this.currentMinutes = self.currentMinutesWatched;
        }
        if (self.isClaimed !== undefined) {
            this.isClaimed = self.isClaimed;
        }
        if (self.dropInstanceID !== undefined) {
            this.dropInstanceId = self.dropInstanceID;
        }
    }
}

export class Campaign {
    readonly drops: Drop[];

    constructor(readonly data: DropCampaign) {
        this.drops = (data.timeBasedDrops ?? []).map((drop) => new Drop(drop, this));
    }

    get id(): string {
        return this.data.id;
    }

    get name(): string {
        return this.data.name;
    }

    get gameId(): string {
        return this.data.game.id;
    }

    get gameName(): string {
        return this.data.game.displayName ?? this.data.game.name ?? "Unknown";
    }

    /**
     * Box art for the game, built from its id when Twitch omits the field - which it does on
     * the campaign list, so relying on the raw value meant notifications went out with no
     * image at all. The plain `<id>-WxH` form resolves to a grey 404 placeholder; the _IGDB
     * variant is the one carrying real art.
     */
    boxArtUrl(size = "144x192"): string | null {
        const provided = this.data.game.boxArtURL;
        if (provided) {
            return provided.replace("{width}x{height}", size);
        }
        return this.gameId
            ? `https://static-cdn.jtvnw.net/ttv-boxart/${this.gameId}_IGDB-${size}.jpg`
            : null;
    }

    get gameSlug(): string | null {
        return this.data.game.slug ?? null;
    }

    get startAt(): Date {
        return new Date(this.data.startAt);
    }

    get endAt(): Date {
        return new Date(this.data.endAt);
    }

    get isActive(): boolean {
        const now = Date.now();
        return now >= this.startAt.getTime() && now < this.endAt.getTime();
    }

    get isUpcoming(): boolean {
        return Date.now() < this.startAt.getTime();
    }

    /**
     * Ended, but still inside the window where Twitch lets a finished drop be claimed from
     * the inventory. Such a campaign cannot be mined, but its drops must still be known.
     */
    isInClaimGrace(graceMs: number): boolean {
        const ended = Date.now() - this.endAt.getTime();
        return ended > 0 && ended <= graceMs;
    }

    /**
     * Whether the Twitch account is linked to the publisher's account. Unlinked campaigns
     * still accrue progress and appear in the Twitch inventory, but the reward will not
     * arrive in-game until the accounts are linked.
     */
    get isAccountLinked(): boolean {
        return this.data.self?.isAccountConnected ?? true;
    }

    /**
     * True when every reward here is a Twitch badge or emote. Those are granted on Twitch
     * itself, so they arrive with or without a game account link - warning about linking
     * would be wrong, and skipping them as "unlinked" would discard a reward that works.
     */
    /**
     * True when this campaign's category is one Twitch earns anywhere.
     *
     * Its channels are then not required to be streaming the campaign's own category - see
     * SPECIAL_CATEGORY_IDS.
     */
    get isSpecialCategory(): boolean {
        return SPECIAL_CATEGORY_IDS.has(this.gameId);
    }

    get isTwitchNativeReward(): boolean {
        const benefits = this.drops.flatMap((drop) => drop.data.benefitEdges);
        if (benefits.length === 0) {
            return false;
        }
        return benefits.every(
            (edge) =>
                edge.benefit.distributionType === "BADGE" ||
                edge.benefit.distributionType === "EMOTE",
        );
    }

    /**
     * Whether a reward from this campaign can actually reach the user. Unlinked campaigns
     * still accrue progress that may never be delivered, so this is what ranking and any
     * skip policy should consult rather than `isAccountLinked` alone.
     */
    get isDeliverable(): boolean {
        return this.isAccountLinked || this.isTwitchNativeReward;
    }

    /**
     * Where to go to link this campaign's account. Twitch returns the publisher's own page,
     * which lands the user exactly where the link is made rather than on a directory of
     * every campaign they have.
     */
    get accountLinkUrl(): string {
        return this.data.accountLinkURL || "https://www.twitch.tv/drops/campaigns";
    }

    /** Campaigns may restrict progress to a specific set of channels. */
    get allowedChannelIds(): Set<string> | null {
        const allow = this.data.allow;
        if (!allow?.isEnabled || !allow.channels?.length) {
            return null;
        }
        return new Set(allow.channels.map((channel) => channel.id));
    }

    get allowedChannelLogins(): string[] {
        return (this.data.allow?.channels ?? [])
            .map((channel) => channel.name ?? channel.displayName ?? "")
            .filter((name) => name !== "")
            .map((name) => name.toLowerCase());
    }

    get isCompleted(): boolean {
        // Drops that need no watch time are not ours to finish, so they must not hold a
        // campaign open indefinitely either.
        return this.drops.every(
            (drop) => drop.isClaimed || !drop.isActive || drop.requiredMinutes <= 0,
        );
    }

    /** The tightest slack across this campaign's unfinished drops. */
    get slack(): number {
        const pending = this.drops.filter((drop) => !drop.isClaimed && drop.isActive);
        if (pending.length === 0) {
            return Number.POSITIVE_INFINITY;
        }
        return Math.min(...pending.map((drop) => drop.slack));
    }

    get claimableDrops(): Drop[] {
        return this.drops.filter((drop) => drop.isClaimable);
    }

    /** True once every precondition of `drop` has been claimed. */
    arePreconditionsMet(drop: Drop): boolean {
        return drop.preconditionIds.every((id) => {
            const precondition = this.drops.find((candidate) => candidate.id === id);
            // A precondition we cannot see was most likely already claimed.
            return precondition === undefined || precondition.isClaimed;
        });
    }

    /**
     * The next drop worth working on, or null if there is nothing to do.
     * Drops are returned in campaign order so tiered rewards unlock in sequence.
     */
    nextDrop(options: { attemptImpossible?: boolean } = {}): Drop | null {
        for (const drop of this.drops) {
            if (drop.isClaimed || !drop.isActive) {
                continue;
            }
            // A drop needing no watch time cannot be advanced by watching. Twitch grants
            // these by other means, and treating one as work parks the miner on a channel
            // forever: an EWC campaign offered a 0-minute reward ahead of a real 720-minute
            // tier, and the bot sat on the former while the latter went unearned.
            if (drop.requiredMinutes <= 0) {
                continue;
            }
            if (!this.arePreconditionsMet(drop)) {
                continue;
            }
            if (!options.attemptImpossible && !drop.isFinishable) {
                continue;
            }
            return drop;
        }
        return null;
    }

    /** Merge fresh detail (drops, allow-list) into this campaign in place. */
    merge(details: DropCampaign): Campaign {
        const merged = new Campaign({ ...this.data, ...details });
        // Preserve progress we already know about, in case the new payload omits `self`.
        for (const drop of merged.drops) {
            const existing = this.drops.find((candidate) => candidate.id === drop.id);
            if (existing && !drop.data.self) {
                drop.update({
                    currentMinutesWatched: existing.currentMinutes,
                    isClaimed: existing.isClaimed,
                    dropInstanceID: existing.dropInstanceId,
                });
            }
        }
        return merged;
    }
}

/**
 * How campaigns outside the explicit priority list are ordered against each other.
 * The priority list always wins; this only decides what happens below it.
 */
/**
 * Which campaigns are eligible to mine at all, once a Steam library is available.
 *
 * Separate from the unlinked-account policy: this is about owning the game, that is about
 * whether the reward can reach you. A campaign has to pass both.
 */
export type LibraryPolicy = "ownedOrListed" | "all";

export interface LibraryScopeOptions {
    policy: LibraryPolicy;
    priorityGames: string[];
    /**
     * Whether the user owns a game, or null when no library is loaded. Passed in so this
     * module stays free of Steam concerns, as with {@link RankingOptions.steamScore}.
     */
    owns: ((gameName: string) => boolean) | null;
}

/**
 * Whether a campaign is for a game the user actually has a claim on.
 *
 * Twitch runs campaigns for hundreds of games at once, and watching one you neither own nor
 * asked for buys a reward you cannot use. Owning it on Steam counts, and so does naming it
 * in the priority list - the escape hatch for everything Steam cannot see: an Epic or
 * console title, or a Twitch category like "Special Events" that is not a game at all.
 *
 * Inert with no library loaded. There would be nothing to test ownership against, and
 * applying the rule anyway would silently shrink mining to the priority list.
 */
export function isInLibraryScope(campaign: Campaign, options: LibraryScopeOptions): boolean {
    if (options.policy !== "ownedOrListed" || !options.owns) {
        return true;
    }
    const listed = options.priorityGames.some(
        (game) =>
            game === campaign.gameId || game.toLowerCase() === campaign.gameName.toLowerCase(),
    );
    return listed || options.owns(campaign.gameName);
}

/**
 * Reward names that do not identify a single benefit.
 *
 * Reconciling against the inventory matches each reward by benefit ID and falls back to
 * matching by name when the IDs do not line up. That fallback only holds while a name
 * belongs to one benefit, and Twitch reuses names freely - both within a campaign and
 * between concurrent ones. GTA ran "Team eCola" and "Team Sprunk" side by side: eCola
 * awarded an identically named GTA$250K at 120 and 360 minutes, and both campaigns awarded
 * a GTA$500K under different benefit IDs. Owning any one of them would otherwise prove the
 * others collected.
 *
 * Scoped across every campaign in the refresh rather than one at a time, because the
 * collisions cross campaign boundaries.
 */
export function ambiguousBenefitNames(campaigns: Iterable<Campaign>): Set<string> {
    const idsByName = new Map<string, Set<string>>();
    for (const campaign of campaigns) {
        for (const drop of campaign.drops) {
            for (const edge of drop.data.benefitEdges) {
                const name = edge.benefit.name?.toLowerCase();
                if (!name) continue;
                const ids = idsByName.get(name) ?? new Set<string>();
                ids.add(edge.benefit.id);
                idsByName.set(name, ids);
            }
        }
    }
    const ambiguous = new Set<string>();
    for (const [name, ids] of idsByName) {
        if (ids.size > 1) {
            ambiguous.add(name);
        }
    }
    return ambiguous;
}

export type PriorityMode =
    /** Mine nothing outside the priority list. */
    | "priority_only"
    /** Whatever expires first. */
    | "ending_soonest"
    /** Whatever is closest to running out of time for the work still needed. */
    | "tightest_deadline"
    /** Shuffled, so the same campaigns are not always favoured. */
    | "random"
    /** Stay on the current game until its campaigns are done, then move on. */
    | "one_game_at_a_time"
    /** Games owned on Steam first, most-played first. */
    | "steam_playtime"
    /** Games owned on Steam first, most recently played first. */
    | "steam_recent";

export interface RankingOptions {
    priorityGames: string[];
    mode?: PriorityMode;
    /**
     * Stable random keys by campaign ID, for "random" mode. Regenerated each refresh so the
     * order varies between cycles but stays consistent within one - a comparator that called
     * Math.random() directly would violate sort's ordering contract.
     */
    randomKeys?: Map<string, number>;
    /** Game currently being mined, used by "one_game_at_a_time". */
    focusGameId?: string | null;
    /**
     * Ranking weight from the user's Steam library, higher being more wanted and 0 meaning
     * not owned. Supplied by the caller so this module stays free of Steam concerns.
     */
    steamScore?: (campaign: Campaign) => number;
}

function priorityRank(campaign: Campaign, priorityGames: string[]): number {
    const index = priorityGames.findIndex(
        (game) =>
            game.toLowerCase() === campaign.gameName.toLowerCase() || game === campaign.gameId,
    );
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * Order campaigns by how much we want them. The explicit priority list is always the first
 * criterion; {@link RankingOptions.mode} decides how everything below it is ordered.
 */
export function compareCampaigns(a: Campaign, b: Campaign, options: RankingOptions): number {
    const { priorityGames, mode = "ending_soonest" } = options;

    const rankDelta = priorityRank(a, priorityGames) - priorityRank(b, priorityGames);
    if (rankDelta !== 0) {
        return rankDelta;
    }

    // A campaign whose reward cannot be delivered is worth less than one that can, whatever
    // else is equal: watch time spent on it may produce nothing at all. Applied below the
    // explicit priority list, so a game the user named still wins.
    if (a.isDeliverable !== b.isDeliverable) {
        return a.isDeliverable ? -1 : 1;
    }

    // Keep working the game already in progress before starting another one.
    if (mode === "one_game_at_a_time" && options.focusGameId) {
        const focus = (campaign: Campaign) => (campaign.gameId === options.focusGameId ? 0 : 1);
        const focusDelta = focus(a) - focus(b);
        if (focusDelta !== 0) {
            return focusDelta;
        }
    }

    if (mode === "steam_playtime" || mode === "steam_recent") {
        const scoreA = options.steamScore?.(a) ?? 0;
        const scoreB = options.steamScore?.(b) ?? 0;
        if (scoreA !== scoreB) {
            // Descending: more playtime, or more recently played, comes first.
            return scoreB - scoreA;
        }
    } else if (mode === "random") {
        const keyA = options.randomKeys?.get(a.id) ?? 0;
        const keyB = options.randomKeys?.get(b.id) ?? 0;
        if (keyA !== keyB) {
            return keyA - keyB;
        }
    } else if (mode === "tightest_deadline") {
        const slackDelta = a.slack - b.slack;
        if (Number.isFinite(slackDelta) && slackDelta !== 0) {
            return slackDelta;
        }
    }

    // Every mode falls back to expiry, then to the quickest win.
    const endDelta = a.endAt.getTime() - b.endAt.getTime();
    if (endDelta !== 0) {
        return endDelta;
    }

    const remaining = (campaign: Campaign): number =>
        campaign.nextDrop({ attemptImpossible: true })?.remainingMinutes ?? Number.MAX_SAFE_INTEGER;
    return remaining(a) - remaining(b);
}
