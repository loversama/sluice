import type { DropCampaign, TimeBasedDrop } from "../packages/core/src/twitch/types.js";

/** Minutes as milliseconds, for readable relative timestamps. */
const MIN = 60_000;

export function iso(offsetMinutes: number): string {
    return new Date(Date.now() + offsetMinutes * MIN).toISOString();
}

export function makeDrop(overrides: Partial<TimeBasedDrop> & { id: string }): TimeBasedDrop {
    return {
        name: overrides.id,
        startAt: iso(-60),
        // Comfortably longer than requiredMinutesWatched: a fixture sitting exactly on the
        // finishable boundary makes every test that touches nextDrop() a coin flip.
        endAt: iso(600),
        requiredMinutesWatched: 60,
        benefitEdges: [
            { benefit: { id: `${overrides.id}-b`, name: `${overrides.id} reward` } },
        ],
        preconditionDrops: null,
        self: { currentMinutesWatched: 0, dropInstanceID: null, isClaimed: false },
        ...overrides,
    } as TimeBasedDrop;
}

export function makeCampaign(
    overrides: Partial<DropCampaign> & { id: string } & { drops?: TimeBasedDrop[] },
): DropCampaign {
    const { drops, ...rest } = overrides;
    return {
        name: `${overrides.id} campaign`,
        status: "ACTIVE",
        startAt: iso(-120),
        endAt: iso(120),
        game: { id: `game-${overrides.id}`, displayName: `Game ${overrides.id}` },
        self: { isAccountConnected: true },
        timeBasedDrops: drops ?? [makeDrop({ id: `${overrides.id}-d1` })],
        allow: null,
        ...rest,
    } as DropCampaign;
}
