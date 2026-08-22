<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import { useMinerStore } from "@/stores/miner.js";
import { boxArt, formatDuration } from "@/lib/format.js";

const store = useMinerStore();
const steam = ref(null);

/**
 * Unlinked campaigns are the quietest way to lose rewards: progress accrues normally and
 * appears in the Twitch inventory, but nothing ever reaches the game. This page turns that
 * into a ranked to-do list, with the games the user actually owns at the top.
 */
const suggestions = ref([]);
const loading = ref(true);
const error = ref(null);

const owned = computed(() => suggestions.value.filter((entry) => entry.ownedOnSteam));
const rest = computed(() => suggestions.value.filter((entry) => !entry.ownedOnSteam));

const totalWasted = computed(() =>
    suggestions.value.reduce((sum, entry) => sum + entry.wastedMinutes, 0),
);

async function load() {
    try {
        const response = await fetch("/api/links");
        if (!response.ok) throw new Error(`Daemon returned ${response.status}`);
        suggestions.value = (await response.json()).suggestions ?? [];
        error.value = null;
    } catch (caught) {
        error.value = caught.message;
    } finally {
        loading.value = false;
    }
}

onMounted(async () => {
    await load();
    steam.value = await fetch("/api/steam").then((r) => r.json()).catch(() => null);
});

// Suggestions are derived from campaign state, so they go stale the moment it refreshes.
watch(() => store.campaigns, load);

function playtime(entry) {
    if (entry.playtimeMinutes === null) return null;
    return entry.playtimeMinutes > 0 ? formatDuration(entry.playtimeMinutes) : "never played";
}
</script>

<template>
    <div class="space-y-4">
        <header>
            <h1 class="text-[15px] font-semibold">Accounts worth linking</h1>
            <p class="text-[12px] mt-1" :style="{ color: 'var(--text-2)' }">
                These campaigns are earning progress that will never reach the game, because your
                Twitch account is not linked to the publisher. Linking is done on Twitch &mdash;
                this bot cannot do it for you.
            </p>
        </header>

        <p v-if="loading" class="card p-8 text-center text-[12px]" :style="{ color: 'var(--muted)' }">
            Loading&hellip;
        </p>
        <p v-else-if="error" class="card p-8 text-center text-[12px]" :style="{ color: 'var(--danger)' }">
            {{ error }}
        </p>
        <p
            v-if="!loading && !error && !suggestions.length"
            class="card p-8 text-center text-[12px]"
            :style="{ color: 'var(--muted)' }"
        >
            Nothing to link &mdash; every active campaign is already connected to your account.
        </p>

        <!-- Half the ranking is Steam ownership; without it the page silently sorts on
             one signal and never says so. -->
        <p
            v-if="!loading && steam && !steam.connected"
            class="card p-3 text-[12px]"
            :style="{ color: 'var(--text-2)' }"
        >
            Connect Steam to rank these by the games you actually own and play.
            <RouterLink to="/settings" class="underline" :style="{ color: 'var(--accent)' }">
                Connect Steam
            </RouterLink>
        </p>

        <template v-else-if="false" />
        <template v-if="!loading && !error && suggestions.length">
            <div
                v-if="totalWasted > 0"
                class="card p-3 flex items-center gap-3"
                :style="{ borderColor: 'color-mix(in srgb, var(--warn) 40%, var(--border))' }"
            >
                <span class="text-[18px]" :style="{ color: 'var(--warn)' }">⚠</span>
                <p class="text-[12px]">
                    <strong>{{ formatDuration(totalWasted) }}</strong> of watch time has already
                    been earned toward campaigns that cannot pay out.
                </p>
                <a
                    href="https://www.twitch.tv/drops/campaigns"
                    target="_blank"
                    rel="noreferrer"
                    class="ml-auto px-3 py-1.5 rounded-lg text-[12px] text-white shrink-0"
                    :style="{ background: 'var(--accent)' }"
                >
                    Open Twitch drops page
                </a>
            </div>

            <section v-if="owned.length" class="space-y-1">
                <h2 class="text-[11px] uppercase tracking-wider px-1" :style="{ color: 'var(--text-2)' }">
                    You own these on Steam ({{ owned.length }})
                </h2>
                <div
                    v-for="entry in owned"
                    :key="entry.gameId"
                    class="card p-3 flex items-center gap-4"
                    :style="{ borderLeft: '3px solid var(--warn)' }"
                >
                    <img
                        v-if="boxArt(entry.gameId)"
                        :src="boxArt(entry.gameId)"
                        :alt="entry.gameName"
                        class="w-9 h-12 rounded object-cover shrink-0"
                        :style="{ background: 'var(--surface-2)' }"
                    />
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2 flex-wrap">
                            <a
                                v-if="entry.linkUrl"
                                :href="entry.linkUrl"
                                target="_blank"
                                rel="noreferrer"
                                class="text-[13px] font-medium hover:underline"
                                :style="{ color: 'var(--accent)' }"
                            >{{ entry.gameName }} &rarr;</a>
                            <p v-else class="text-[13px] font-medium">{{ entry.gameName }}</p>
                            <span
                                class="text-[10px] px-1.5 py-0.5 rounded-full"
                                :style="{
                                    background: 'color-mix(in srgb, var(--success) 15%, transparent)',
                                    color: 'var(--success)',
                                }"
                            >
                                owned &middot; {{ playtime(entry) }}
                            </span>
                        </div>
                        <p class="text-[11px] mt-0.5 truncate" :style="{ color: 'var(--text-2)' }">
                            {{ entry.rewards.join(", ") || "no rewards listed" }}
                        </p>
                    </div>
                    <div class="text-right shrink-0">
                        <p class="text-[12px] tabular">
                            {{ entry.campaignCount }}
                            campaign{{ entry.campaignCount === 1 ? "" : "s" }}
                        </p>
                        <p
                            v-if="entry.wastedMinutes"
                            class="text-[11px] tabular"
                            :style="{ color: 'var(--warn)' }"
                        >
                            {{ formatDuration(entry.wastedMinutes) }} at risk
                        </p>
                    </div>
                </div>
            </section>

            <section v-if="rest.length" class="space-y-1">
                <h2 class="text-[11px] uppercase tracking-wider px-1" :style="{ color: 'var(--text-2)' }">
                    Not in your Steam library ({{ rest.length }})
                </h2>
                <div
                    v-for="entry in rest"
                    :key="entry.gameId"
                    class="card p-3 flex items-center gap-4 opacity-80"
                >
                    <img
                        v-if="boxArt(entry.gameId)"
                        :src="boxArt(entry.gameId)"
                        :alt="entry.gameName"
                        class="w-9 h-12 rounded object-cover shrink-0 opacity-70"
                        :style="{ background: 'var(--surface-2)' }"
                    />
                    <div class="min-w-0 flex-1">
                        <a
                            v-if="entry.linkUrl"
                            :href="entry.linkUrl"
                            target="_blank"
                            rel="noreferrer"
                            class="text-[13px] hover:underline"
                            :style="{ color: 'var(--accent)' }"
                        >{{ entry.gameName }} &rarr;</a>
                        <p v-else class="text-[13px]">{{ entry.gameName }}</p>
                        <p class="text-[11px] mt-0.5 truncate" :style="{ color: 'var(--text-2)' }">
                            {{ entry.rewards.join(", ") || "no rewards listed" }}
                        </p>
                    </div>
                    <div class="text-right shrink-0">
                        <p class="text-[12px] tabular">
                            {{ entry.campaignCount }}
                            campaign{{ entry.campaignCount === 1 ? "" : "s" }}
                        </p>
                        <p
                            v-if="entry.wastedMinutes"
                            class="text-[11px] tabular"
                            :style="{ color: 'var(--muted)' }"
                        >
                            {{ formatDuration(entry.wastedMinutes) }} at risk
                        </p>
                    </div>
                </div>
            </section>
        </template>
    </div>
</template>
