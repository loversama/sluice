import type { DropCampaign, TimeBasedDrop } from "../twitch/types.js";

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

    /** Ready to claim: watched enough, not yet claimed, and Twitch issued an instance ID. */
    get isClaimable(): boolean {
        return !this.isClaimed && this.dropInstanceId !== null && this.currentMinutes >= this.requiredMinutes;
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
     * Whether the Twitch account is linked to the publisher's account. Unlinked campaigns
     * still accrue progress and appear in the Twitch inventory, but the reward will not
     * arrive in-game until the accounts are linked.
     */
    get isAccountLinked(): boolean {
        return this.data.self?.isAccountConnected ?? true;
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
        return this.drops.every((drop) => drop.isClaimed || !drop.isActive);
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
 * Order campaigns by how much we want them:
 *   1. position of the game in the user's priority list
 *   2. soonest to end (finish what is about to expire)
 *   3. fewest remaining minutes
 */
export function compareCampaigns(a: Campaign, b: Campaign, priorityGames: string[]): number {
    const rank = (campaign: Campaign): number => {
        const index = priorityGames.findIndex(
            (game) =>
                game.toLowerCase() === campaign.gameName.toLowerCase() || game === campaign.gameId,
        );
        return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };

    const rankDelta = rank(a) - rank(b);
    if (rankDelta !== 0) {
        return rankDelta;
    }

    const endDelta = a.endAt.getTime() - b.endAt.getTime();
    if (endDelta !== 0) {
        return endDelta;
    }

    const remaining = (campaign: Campaign): number =>
        campaign.nextDrop({ attemptImpossible: true })?.remainingMinutes ?? Number.MAX_SAFE_INTEGER;
    return remaining(a) - remaining(b);
}
