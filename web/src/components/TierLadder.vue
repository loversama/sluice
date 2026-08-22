<script setup>
import { computed } from "vue";

import { useMinerStore } from "@/stores/miner.js";
import StatusChip from "./StatusChip.vue";

const store = useMinerStore();

const campaign = computed(() => store.currentCampaign);

/** Every tier, not just the one being worked, so the whole ladder is visible at a glance. */
const tiers = computed(() =>
    (campaign.value?.drops ?? []).map((drop) => ({
        ...drop,
        current: drop.id === store.mining?.dropId,
        fraction: drop.requiredMinutes
            ? Math.min(1, drop.currentMinutes / drop.requiredMinutes)
            : 0,
    })),
);
</script>

<template>
    <section v-if="campaign && tiers.length" class="card p-3 flex flex-col min-h-0">
        <header class="flex items-baseline justify-between mb-2">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                {{ campaign.game.name }} tiers
            </h2>
            <span class="text-[11px] tabular" :style="{ color: 'var(--text-2)' }">
                {{ tiers.filter((t) => t.isClaimed).length }}/{{ tiers.length }} claimed
            </span>
        </header>

        <!-- Ladders run to six or more tiers, so this scrolls rather than pushing the
             column out of shape. -->
        <ul class="space-y-2 flex-1 min-h-0 overflow-y-auto pr-1 scroll-thin">
            <li
                v-for="tier in tiers"
                :key="tier.id"
                class="flex items-center gap-2"
                :class="tier.isClaimed ? 'opacity-60' : ''"
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
                    </div>
                </div>
            </li>
        </ul>
    </section>
</template>
