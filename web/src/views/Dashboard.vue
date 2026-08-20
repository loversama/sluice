<script setup>
import { computed } from "vue";

import { useMinerStore } from "@/stores/miner.js";
import { formatDuration, formatRelative, formatUntil, totalRemainingMinutes } from "@/lib/format.js";
import NowMining from "@/components/NowMining.vue";
import EventFeed from "@/components/EventFeed.vue";
import StatusChip from "@/components/StatusChip.vue";

const store = useMinerStore();

/** Max five, since this is a preview of the queue rather than the full list. */
const queue = computed(() => store.upNext.slice(0, 5));
const claims = computed(() => store.claims.slice(0, 8));
</script>

<template>
    <div class="space-y-4">
        <NowMining />

        <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <!-- Showing the real queue is the strongest trust signal a bot UI has: the user
                 can see exactly why the miner will do what it does next. -->
            <section class="card p-3 lg:col-span-7">
                <header class="flex items-center justify-between mb-3">
                    <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                        Up next
                    </h2>
                    <RouterLink to="/campaigns" class="text-[11px] hover:underline" :style="{ color: 'var(--text-2)' }">
                        View all &rarr;
                    </RouterLink>
                </header>

                <p v-if="!queue.length" class="text-[12px] py-4 text-center" :style="{ color: 'var(--muted)' }">
                    Nothing queued behind the current campaign.
                </p>

                <ul v-else class="space-y-1">
                    <li
                        v-for="(campaign, index) in queue"
                        :key="campaign.id"
                        class="flex items-center gap-3 py-2 px-2 rounded-lg"
                        :style="{ background: 'var(--surface-2)' }"
                    >
                        <span
                            class="w-5 h-5 rounded-full grid place-items-center text-[10px] font-semibold shrink-0"
                            :style="
                                campaign.inPriorities
                                    ? { background: 'var(--accent)', color: 'white' }
                                    : { border: '1px solid var(--border)', color: 'var(--text-2)' }
                            "
                            :title="campaign.inPriorities ? `Priority #${campaign.priorityRank + 1}` : 'Not in your priority list'"
                        >
                            {{ index + 1 }}
                        </span>

                        <img
                            v-if="campaign.game.boxArtURL"
                            :src="campaign.game.boxArtURL"
                            :alt="campaign.game.name"
                            class="w-8 h-10 rounded object-cover shrink-0"
                        />

                        <div class="min-w-0 flex-1">
                            <p class="text-[13px] font-medium truncate">{{ campaign.game.name }}</p>
                            <p class="text-[11px] truncate" :style="{ color: 'var(--text-2)' }">
                                {{ campaign.name }}
                            </p>
                        </div>

                        <div class="text-right shrink-0">
                            <p class="text-[12px] tabular">
                                {{ formatDuration(totalRemainingMinutes(campaign)) }} left
                            </p>
                            <p class="text-[11px] tabular" :style="{ color: 'var(--muted)' }">
                                ends {{ formatUntil(campaign.endAt) }}
                            </p>
                        </div>

                        <StatusChip v-if="!campaign.isAccountLinked" status="unlinked" small />
                    </li>
                </ul>
            </section>

            <section class="card p-3 lg:col-span-5">
                <h2 class="text-[11px] uppercase tracking-wider mb-3" :style="{ color: 'var(--text-2)' }">
                    Recently claimed
                </h2>

                <div v-if="!claims.length" class="text-center py-6">
                    <p class="text-[22px] mb-1" :style="{ color: 'var(--muted)' }">◆</p>
                    <p class="text-[12px]" :style="{ color: 'var(--muted)' }">
                        Claimed drops will appear here.
                    </p>
                </div>

                <ul v-else class="space-y-1">
                    <li
                        v-for="(claim, index) in claims"
                        :key="`${claim.dropId}-${claim.at}`"
                        class="flex items-center gap-3 py-1.5 px-2 rounded-lg"
                        :class="index === 0 ? 'claim-enter' : ''"
                    >
                        <img
                            v-if="claim.rewardImageURL"
                            :src="claim.rewardImageURL"
                            :alt="claim.dropName"
                            class="w-10 h-10 rounded-lg object-cover shrink-0"
                            :style="{ background: 'var(--surface-2)' }"
                        />
                        <div class="min-w-0 flex-1">
                            <p class="text-[12px] font-medium truncate">{{ claim.dropName }}</p>
                            <p class="text-[11px] truncate" :style="{ color: 'var(--text-2)' }">
                                {{ claim.gameName }}
                            </p>
                        </div>
                        <span class="text-[11px] shrink-0" :style="{ color: 'var(--muted)' }">
                            {{ formatRelative(claim.at) }}
                        </span>
                    </li>
                </ul>
            </section>
        </div>

        <EventFeed :entries="store.feed" />
    </div>
</template>
