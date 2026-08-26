<script setup>
import { computed, ref } from "vue";
import { ElMessage } from "element-plus";

import { useMinerStore } from "@/stores/miner.js";
import StartupProgress from "@/components/StartupProgress.vue";
import { formatClock, formatDuration } from "@/lib/format.js";
import StatusChip from "./StatusChip.vue";

const store = useMinerStore();
const busy = ref(false);

const paused = computed(() => store.daemon?.paused === true);

/** Always shown, not just when idle: it answers "when will it notice the new campaign". */
const refreshIn = computed(() => {
    const seconds = store.secondsToRefresh;
    if (seconds === null) return null;
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
});

async function run(name) {
    busy.value = true;
    try {
        await store.action(name);
    } catch (error) {
        ElMessage.error(error.message);
    } finally {
        busy.value = false;
    }
}

const campaign = computed(() => store.currentCampaign);
const drop = computed(() => store.currentDrop);

const reward = computed(() => drop.value?.rewards?.[0] ?? null);

const progress = computed(() => {
    if (!drop.value?.requiredMinutes) {
        return 0;
    }
    return Math.min(1, drop.value.currentMinutes / drop.value.requiredMinutes);
});

const remainingMinutes = computed(() =>
    drop.value ? Math.max(0, drop.value.requiredMinutes - drop.value.currentMinutes) : 0,
);

/** Wall-clock finish estimate: answers "will it be done tonight", which a duration cannot. */
const eta = computed(() => {
    if (!drop.value) {
        return null;
    }
    return new Date(store.now + remainingMinutes.value * 60_000);
});

/** The campaign may expire before we can finish - worth flagging rather than hiding. */
const etaBeyondCampaign = computed(() => {
    if (!eta.value || !campaign.value) {
        return false;
    }
    return eta.value > new Date(campaign.value.endAt);
});

const beatLabel = computed(() => {
    if (store.beatAge === null) {
        return "waiting for first beat";
    }
    const seconds = Math.floor(store.beatAge / 1000);
    return `last beat ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} ago`;
});

const claimedCount = computed(
    () => campaign.value?.drops.filter((entry) => entry.isClaimed).length ?? 0,
);

/** Why there is nothing to do, stated concretely rather than as a blank card. */
const idleReason = computed(() => {
    if (store.upcomingCampaigns.length > 0) {
        return `No active campaigns match your priorities - ${store.upcomingCampaigns.length} upcoming.`;
    }
    if (store.campaigns.length === 0) {
        return "No campaigns found yet. Waiting for the first refresh.";
    }
    return "Nothing available to mine right now.";
});
</script>

<template>
    <!-- Fatal daemon problem: the one place raw ops guidance belongs in the UI. -->
    <section
        v-if="store.fatal"
        class="card p-4"
        :style="{ borderColor: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))' }"
    >
        <h2 class="text-[15px] font-semibold mb-1" :style="{ color: 'var(--danger)' }">
            Mining paused
        </h2>
        <p class="text-[12px] mb-2">{{ store.fatal.message }}</p>
        <p v-if="store.fatal.code === 'stale-hash'" class="text-[12px]" :style="{ color: 'var(--text-2)' }">
            Twitch rotated its API query hashes. Run
            <code class="font-mono" :style="{ color: 'var(--text)' }">npm run check-hashes</code>
            to see which are stale.
        </p>
    </section>

    <!--
        Starting up is not the same as having nothing to mine, and saying the latter during
        the former is simply wrong - on a busy account the wait is half a minute.
    -->
    <section v-else-if="store.loading && !store.mining" class="card p-4">
        <h2 class="text-[15px] font-semibold mb-2">Starting up</h2>
        <StartupProgress />
    </section>

    <!-- Idle: never a blank card; always say why, and where to look next. -->
    <section v-else-if="!store.mining || !drop" class="card p-4">
        <div class="flex items-center justify-between">
            <div>
                <h2 class="text-[15px] font-semibold">
                    {{ paused ? "Paused" : "Nothing to mine right now" }}
                </h2>
                <p class="text-[12px] mt-1" :style="{ color: 'var(--text-2)' }">
                    {{ paused ? "Nothing is being watched or claimed until you resume." : idleReason }}
                </p>
            </div>
            <RouterLink
                v-if="store.upcomingCampaigns.length"
                to="/campaigns"
                class="text-[12px] hover:underline"
                :style="{ color: 'var(--accent)' }"
            >
                See upcoming &rarr;
            </RouterLink>
        </div>
        <div class="flex items-center gap-2 mt-3">
            <button
                v-if="paused"
                class="px-3 py-1.5 rounded-lg text-[12px] text-white"
                :style="{ background: 'var(--accent)' }"
                :disabled="busy"
                @click="run('resume')"
            >
                Resume
            </button>
            <button
                class="px-3 py-1.5 rounded-lg text-[12px]"
                :style="{ background: 'var(--surface-2)', color: 'var(--text)' }"
                :disabled="busy"
                @click="run('refresh')"
            >
                Refresh campaigns now
            </button>
            <span v-if="refreshIn" class="text-[11px] tabular ml-auto" :style="{ color: 'var(--muted)' }">
                next refresh in {{ refreshIn }}
            </span>
        </div>
    </section>

    <!-- Active mining. -->
    <section
        v-else
        class="card p-4"
        :style="{ borderLeft: `3px solid ${store.isStalled ? 'var(--warn)' : 'var(--accent)'}` }"
    >
        <header class="flex items-center justify-between gap-3 mb-4">
            <div class="flex items-center gap-2 min-w-0">
                <StatusChip :status="store.isStalled ? 'stalled' : 'mining'" />
                <span class="text-[12px] truncate" :style="{ color: 'var(--text-2)' }">
                    <strong :style="{ color: 'var(--text)' }">{{ campaign?.game?.name }}</strong>
                    &mdash; {{ campaign?.name }}
                </span>
            </div>
            <div class="flex items-center gap-2 shrink-0">
                <StatusChip
                    v-if="campaign && !campaign.isAccountLinked"
                    status="unlinked"
                    :href="campaign.accountLinkUrl"
                />
                <button
                    class="px-2 py-1 rounded text-[11px]"
                    :style="{ background: 'var(--surface-2)', color: 'var(--text-2)' }"
                    :disabled="busy"
                    title="Leave this channel and pick another"
                    @click="run('skip')"
                >
                    Skip channel
                </button>
                <!--
                    Transport controls, because that is the mental model people already
                    have for "this is playing and I want the next one". Pause toggles
                    rather than always reading Pause, which said the wrong thing outright
                    once the miner was already stopped.
                -->
                <div class="flex items-center gap-1 ml-1">
                    <button
                        class="w-7 h-7 rounded-full grid place-items-center text-[12px] transition-colors"
                        :style="{ background: 'var(--surface-2)', color: 'var(--text)' }"
                        :disabled="busy"
                        :title="paused ? 'Resume mining' : 'Pause mining'"
                        :aria-label="paused ? 'Resume mining' : 'Pause mining'"
                        @click="run(paused ? 'resume' : 'pause')"
                    >
                        {{ paused ? "\u25B6" : "\u23F8" }}
                    </button>
                    <button
                        class="w-7 h-7 rounded-full grid place-items-center text-[12px] transition-colors"
                        :style="{ background: 'var(--surface-2)', color: 'var(--text)' }"
                        :disabled="busy || paused"
                        title="Move on to the next campaign, sending this one to the back of the queue"
                        aria-label="Next campaign"
                        @click="run('next')"
                    >
                        {{ "\u23ED" }}
                    </button>
                </div>
            </div>
        </header>

        <!-- The reward is the headline. Users care about the item, not the streamer. -->
        <div class="flex items-start gap-4">
            <img
                v-if="reward?.imageURL"
                :src="reward.imageURL"
                :alt="reward.name"
                class="w-16 h-16 rounded-lg object-cover shrink-0"
                :style="{ background: 'var(--surface-2)' }"
            />
            <div class="min-w-0 flex-1">
                <h1 class="text-[20px] font-semibold leading-tight truncate">
                    {{ reward?.name ?? drop.name }}
                </h1>

                <div class="flex items-center gap-3 mt-2">
                    <div class="flex-1 h-[10px] rounded-full overflow-hidden" :style="{ background: 'var(--surface-2)' }">
                        <div
                            class="h-full rounded-full transition-[width] duration-500 ease-out"
                            :style="{
                                width: `${progress * 100}%`,
                                background: 'linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 60%, white))',
                            }"
                        />
                    </div>
                    <span class="tabular font-mono text-[12px] shrink-0">
                        {{ drop.currentMinutes }} / {{ drop.requiredMinutes }} min
                    </span>
                    <span class="tabular text-[12px] shrink-0" :style="{ color: 'var(--text-2)' }">
                        {{ Math.round(progress * 100) }}%
                    </span>
                </div>

                <p
                    class="text-[12px] mt-2 tabular"
                    :style="{ color: etaBeyondCampaign ? 'var(--warn)' : 'var(--text-2)' }"
                >
                    {{ formatDuration(remainingMinutes) }} left
                    <template v-if="eta"> &middot; done ~{{ formatClock(eta) }}</template>
                    <template v-if="etaBeyondCampaign">
                        &middot; campaign ends first, may not finish
                    </template>
                </p>
            </div>
        </div>

        <footer
            class="flex items-center justify-between gap-3 mt-4 pt-3 flex-wrap"
            :style="{ borderTop: '1px solid var(--border)' }"
        >
            <div class="flex items-center gap-2 min-w-0">
                <span class="text-[12px]" :style="{ color: 'var(--text-2)' }">watching</span>
                <a
                    :href="store.mining.channel.url"
                    target="_blank"
                    rel="noreferrer"
                    class="text-[12px] font-medium hover:underline truncate"
                    :style="{ color: 'var(--accent)' }"
                >
                    {{ store.mining.channel.displayName }}
                </a>
                <span
                    class="text-[10px] px-1.5 py-0.5 rounded font-semibold"
                    :style="{ background: 'color-mix(in srgb, var(--danger) 18%, transparent)', color: 'var(--danger)' }"
                >
                    LIVE
                </span>
            </div>

            <div class="flex items-center gap-3">
                <!-- Drop dots show where this drop sits in the tier chain. -->
                <span class="text-[11px]" :style="{ color: 'var(--text-2)' }">
                    {{ claimedCount }}/{{ campaign?.drops.length ?? 0 }} claimed
                </span>
                <span class="flex gap-1">
                    <span
                        v-for="entry in campaign?.drops ?? []"
                        :key="entry.id"
                        class="w-2 h-2 rounded-full"
                        :title="entry.name"
                        :style="{
                            background: entry.isClaimed
                                ? 'var(--success)'
                                : entry.id === drop.id
                                  ? 'var(--accent)'
                                  : 'var(--surface-2)',
                        }"
                    />
                </span>

                <span
                    class="tabular font-mono text-[11px]"
                    :style="{ color: store.beatHealthy ? 'var(--text-2)' : 'var(--warn)' }"
                >
                    {{ beatLabel }}
                </span>
                <span class="flex items-end gap-[2px] h-3" :class="store.beatHealthy ? 'pulse' : ''">
                    <span class="w-[3px] h-[5px] rounded-sm" :style="{ background: store.beatHealthy ? 'var(--accent)' : 'var(--muted)' }" />
                    <span class="w-[3px] h-[9px] rounded-sm" :style="{ background: store.beatHealthy ? 'var(--accent)' : 'var(--muted)' }" />
                    <span class="w-[3px] h-[12px] rounded-sm" :style="{ background: store.beatHealthy ? 'var(--accent)' : 'var(--muted)' }" />
                </span>
            </div>
        </footer>
    </section>
</template>
