<script setup>
import { computed } from "vue";

import { useMinerStore } from "@/stores/miner.js";
import { formatRelative } from "@/lib/format.js";
import Skeleton from "@/components/Skeleton.vue";

/**
 * The dashboard for a window narrow enough to sit down the side of a screen.
 *
 * Three things, in the order you would want them while doing something else: what is being
 * mined right now, what is queued behind it, and what has recently landed. Everything that
 * needs width - the tier ladder, the live channel panel, the activity feed - is left to the
 * full dashboard rather than squeezed until it is unreadable.
 */
const store = useMinerStore();

const channel = computed(() => store.mining?.channel ?? null);
const drop = computed(() => store.currentDrop);
const campaign = computed(() => store.currentCampaign);

const progress = computed(() => {
    const d = drop.value;
    if (!d?.requiredMinutes) return 0;
    return Math.min(100, Math.round((d.currentMinutes / d.requiredMinutes) * 100));
});

const upNext = computed(() => store.upNext.slice(0, 6));
const claims = computed(() => store.claims);

/** Minutes left on the current drop, which is the number people actually watch. */
const remaining = computed(() => {
    const d = drop.value;
    if (!d?.requiredMinutes) return null;
    return Math.max(0, d.requiredMinutes - d.currentMinutes);
});

const stats = computed(() => store.stats ?? null);

/**
 * True while the first snapshot is still on its way. Signing in and fetching campaigns can
 * take ten seconds, and "nothing being mined" is a lie during that window - it is not that
 * there is nothing, it is that we do not know yet.
 */
const loading = computed(() => !store.loaded);
</script>

<template>
    <div class="flex flex-col gap-3 p-3">
        <!-- Now mining. Pinned, because in a window this size it is the reason the window
             is open, and it should not scroll away behind a long claim list. -->
        <section class="card p-3 sticky top-0 z-10" :style="{ background: 'var(--surface)' }">
            <div class="flex items-center justify-between gap-2 mb-2">
                <span class="text-[10px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                    Now mining
                </span>
                <span
                    v-if="store.daemon?.paused"
                    class="text-[10px] px-1.5 py-0.5 rounded"
                    :style="{ background: 'var(--surface-2)', color: 'var(--warn)' }"
                >
                    Paused
                </span>
                <span
                    v-else-if="store.isStalled"
                    class="text-[10px] px-1.5 py-0.5 rounded"
                    :style="{ background: 'var(--surface-2)', color: 'var(--warn)' }"
                    title="Progress has gone quiet. The miner recovers on its own."
                >
                    Quiet
                </span>
            </div>

            <template v-if="channel">
                <p class="text-[14px] font-medium leading-tight truncate">{{ channel.game }}</p>
                <p class="text-[11px] truncate mb-2" :style="{ color: 'var(--text-2)' }">
                    {{ channel.displayName }}
                </p>

                <template v-if="drop">
                    <div class="flex items-baseline justify-between gap-2 mb-1">
                        <span class="text-[11px] truncate" :style="{ color: 'var(--text-2)' }">
                            {{ drop.name }}
                        </span>
                        <span class="text-[11px] tabular shrink-0">
                            {{ drop.currentMinutes }}/{{ drop.requiredMinutes }}m
                        </span>
                    </div>
                    <div class="h-1.5 rounded-full overflow-hidden" :style="{ background: 'var(--surface-2)' }">
                        <div
                            class="h-full rounded-full transition-[width] duration-700"
                            :style="{ width: `${progress}%`, background: 'var(--accent)' }"
                        />
                    </div>
                    <p v-if="remaining !== null" class="text-[10px] mt-1" :style="{ color: 'var(--muted)' }">
                        {{ remaining === 0 ? "Ready to claim" : `${remaining} min remaining` }}
                    </p>
                </template>
                <p v-if="campaign && !campaign.isDeliverable" class="text-[10px] mt-2" :style="{ color: 'var(--warn)' }">
                    Not linked — the reward will not reach the game.
                </p>
            </template>

            <template v-else-if="loading">
                <Skeleton width="60%" height="14px" />
                <Skeleton width="40%" height="10px" class="mt-1.5" />
                <Skeleton width="100%" height="6px" class="mt-3" />
                <p class="text-[10px] mt-2" :style="{ color: 'var(--muted)' }">
                    Connecting to Twitch&hellip;
                </p>
            </template>

            <p v-else class="text-[12px] py-2" :style="{ color: 'var(--text-2)' }">
                Nothing being mined right now.
            </p>
        </section>

        <!-- Up next. Just enough to know whether it is about to do something sensible. -->
        <section class="card p-3">
            <span class="text-[10px] uppercase tracking-wider block mb-2" :style="{ color: 'var(--text-2)' }">
                Up next
            </span>
            <ul v-if="upNext.length" class="flex flex-col gap-1.5">
                <li
                    v-for="(item, index) in upNext"
                    :key="item.id"
                    class="flex items-center gap-2 min-w-0"
                >
                    <span class="text-[10px] tabular w-3 shrink-0" :style="{ color: 'var(--muted)' }">
                        {{ index + 1 }}
                    </span>
                    <span class="text-[12px] truncate flex-1">{{ item.game?.name ?? item.gameName }}</span>
                    <span
                        v-if="!item.isDeliverable"
                        class="text-[9px] shrink-0"
                        :style="{ color: 'var(--warn)' }"
                        title="Account not linked"
                    >○</span>
                </li>
            </ul>
            <div v-else-if="loading" class="flex flex-col gap-2">
                <Skeleton v-for="n in 3" :key="n" :width="`${88 - n * 12}%`" height="11px" />
            </div>
            <p v-else class="text-[12px]" :style="{ color: 'var(--text-2)' }">Nothing queued.</p>
        </section>

        <!-- Totals. One line, because at this width a stat grid is just noise. -->
        <div
            v-if="loading"
            class="flex items-center justify-between px-1"
        >
            <Skeleton v-for="n in 3" :key="n" width="52px" height="9px" />
        </div>
        <div
            v-else-if="stats"
            class="flex items-center justify-between px-1 text-[10px]"
            :style="{ color: 'var(--text-2)' }"
        >
            <span>{{ stats.dropsAllTime }} drops</span>
            <span>{{ stats.campaignsCompleted }} campaigns</span>
            <span>{{ Math.round(stats.minutesEarned / 60) }}h mined</span>
        </div>

        <!-- Recently claimed. The reason any of this is running. -->
        <section class="card p-3">
            <span class="text-[10px] uppercase tracking-wider block mb-2" :style="{ color: 'var(--text-2)' }">
                Recently claimed
            </span>
            <ul v-if="claims.length" class="flex flex-col gap-2 max-h-[40vh] overflow-y-auto -mr-1 pr-1">
                <li v-for="claim in claims" :key="`${claim.dropId}-${claim.at}`" class="flex items-center gap-2 min-w-0">
                    <img
                        v-if="claim.rewardImageURL"
                        :src="claim.rewardImageURL"
                        alt=""
                        class="w-6 h-6 rounded object-cover shrink-0"
                        loading="lazy"
                    />
                    <div class="min-w-0 flex-1">
                        <p class="text-[12px] truncate leading-tight">{{ claim.dropName }}</p>
                        <p class="text-[10px] truncate" :style="{ color: 'var(--text-2)' }">
                            {{ claim.gameName }}
                        </p>
                    </div>
                    <span class="text-[10px] shrink-0 tabular" :style="{ color: 'var(--muted)' }">
                        {{ formatRelative(claim.at) }}
                    </span>
                </li>
            </ul>
            <div v-else-if="loading" class="flex flex-col gap-2.5">
                <div v-for="n in 3" :key="n" class="flex items-center gap-2">
                    <Skeleton width="24px" height="24px" />
                    <div class="flex-1 flex flex-col gap-1">
                        <Skeleton :width="`${75 - n * 8}%`" height="10px" />
                        <Skeleton :width="`${50 - n * 6}%`" height="8px" />
                    </div>
                </div>
            </div>
            <p v-else class="text-[12px]" :style="{ color: 'var(--text-2)' }">No drops claimed yet.</p>
        </section>
    </div>
</template>
