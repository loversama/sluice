<script setup>
import { computed } from "vue";

import { useMinerStore } from "@/stores/miner.js";
import StatusChip from "./StatusChip.vue";
import Skeleton from "@/components/Skeleton.vue";
import { orderTiers, tierProgress } from "@/lib/tiers.js";

const store = useMinerStore();

const campaign = computed(() => store.currentCampaign);

/**
 * Every tier, not just the one being worked, so the whole ladder is visible at a glance.
 *
 * Sorted by the minutes each needs, because Twitch does not return them in any order and
 * an unsorted ladder is actively misleading: on a real campaign the drops arrived 90, 120,
 * 30, 60, which put the only unclaimed tier second and made the ladder look finished.
 *
 * A tier needing no watch time is not part of that progression at all - those are earned by
 * some other condition, playing the game or owning something - so they sort to the end and
 * are marked rather than mixed in.
 */
const tiers = computed(() =>
    orderTiers(campaign.value?.drops)
        .map((drop) => ({
            ...drop,
            current: drop.id === store.mining?.dropId,
            /** Not earned by watching, so no amount of watching will advance it. */
            special: !drop.requiredMinutes,
            fraction: drop.requiredMinutes
                ? Math.min(1, drop.currentMinutes / drop.requiredMinutes)
                : 0,
        }))
);

/**
 * Only the tiers watching can actually earn.
 *
 * Counting the others would make a finished ladder read as unfinished for ever, since
 * nothing the miner does will ever tick them over.
 */
const progress = computed(() => tierProgress(campaign.value?.drops));
</script>

<template>
    <section class="card p-3 flex flex-col min-h-0">
        <header class="flex items-baseline justify-between mb-2">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                {{ campaign ? `${campaign.game.name} tiers` : "Tiers" }}
            </h2>
            <span v-if="tiers.length" class="text-[11px] tabular" :style="{ color: 'var(--text-2)' }">
                {{ progress.claimed }}/{{ progress.total }} claimed
            </span>
        </header>

        <!-- Ladders run to six or more tiers, so this scrolls rather than pushing the
             column out of shape. -->
        <!-- Placeholders in the shape of the ladder, so the panel does not resize under the
             real thing when it lands. -->
        <div v-if="!tiers.length" class="space-y-2 flex-1">
            <div v-for="n in 3" :key="n" class="flex items-center gap-2">
                <Skeleton width="32px" height="32px" />
                <div class="flex-1 space-y-1.5">
                    <Skeleton :width="`${72 - n * 9}%`" height="10px" />
                    <Skeleton width="100%" height="4px" />
                </div>
            </div>
        </div>

        <ul v-else class="space-y-2 flex-1 min-h-0 overflow-y-auto pr-1 scroll-thin">
            <li
                v-for="tier in tiers"
                :key="tier.id"
                class="flex items-center gap-2"
                :class="tier.isClaimed || tier.special ? 'opacity-60' : ''"
            >
                <img
                    v-if="tier.rewards[0]?.imageURL"
                    :src="tier.rewards[0].imageURL"
                    :alt="tier.name"
                    class="w-8 h-8 rounded object-cover shrink-0"
                    :style="{ background: 'var(--surface-2)' }"
                />
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5">
                        <p class="text-[12px] truncate" :class="tier.current ? 'font-semibold' : ''">
                            {{ tier.rewards[0]?.name ?? tier.name }}
                        </p>
                        <StatusChip v-if="tier.isClaimed" status="claimed" small />
                    </div>
                    <div class="flex items-center gap-2 mt-1">
                        <!--
                            A special tier gets a pip rather than a bar. A bar stuck at zero
                            reads as "not started", when the truth is that watching is not
                            what earns it.
                        -->
                        <template v-if="tier.special">
                            <span
                                class="w-1.5 h-1.5 rounded-full shrink-0"
                                :style="{ background: 'var(--muted)' }"
                            />
                            <span class="text-[10px]" :style="{ color: 'var(--muted)' }">
                                Not earned by watching
                            </span>
                        </template>
                        <template v-else>
                            <div class="flex-1 h-1 rounded-full overflow-hidden" :style="{ background: 'var(--surface-2)' }">
                                <div
                                    class="h-full rounded-full"
                                    :style="{
                                        width: `${tier.fraction * 100}%`,
                                        background: tier.isClaimed ? 'var(--success)' : 'var(--accent)',
                                    }"
                                />
                            </div>
                            <span class="tabular font-mono text-[10px] shrink-0" :style="{ color: 'var(--text-2)' }">
                                {{ tier.currentMinutes }}/{{ tier.requiredMinutes }}
                            </span>
                        </template>
                    </div>
                </div>
            </li>
        </ul>
    </section>
</template>
