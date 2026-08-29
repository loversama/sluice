<script setup>
import { computed, ref } from "vue";
import { ElMessage } from "element-plus";

import { useMinerStore } from "@/stores/miner.js";
import { idleCopy } from "@/lib/idleCopy.js";
import StartupProgress from "@/components/StartupProgress.vue";
import { formatClock, formatDuration } from "@/lib/format.js";
import StatusChip from "./StatusChip.vue";

const store = useMinerStore();
const busy = ref(false);

/**
 * The header carries its state as a colour as well as a word, as the narrow layout does.
 * Mixed into the surface rather than used neat: it sits behind body text for hours.
 */
/** Mining proper, as opposed to starting up or having nothing to do. */
const active = computed(() => Boolean(store.mining && drop.value));

/**
 * The drop on screen has been claimed and the miner has not yet moved on.
 *
 * Twitch announces the reward, which triggers a campaign sweep, and only after that is the
 * next drop picked - some seconds later. Showing the finished drop as though it were still
 * counting up for all of that is the part that reads as stuck.
 */
/**
 * Idle because of the clock rather than because there is nothing to do. Worth separating:
 * one of them is a setting working, the other is a problem.
 */
const outsideSchedule = computed(() => store.outsideSchedule === true);

const claimedAndWaiting = computed(() => Boolean(active.value && drop.value?.isClaimed));

const accent = computed(() => (store.isStalled ? "var(--warn)" : "var(--accent)"));

const heroStyle = computed(() => ({
    background: `color-mix(in srgb, ${accent.value} 14%, var(--surface))`,
    transition: "background 400ms ease",
}));

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

/**
 * Why there is nothing to do, as the daemon reported it.
 *
 * This used to be guessed here from whatever campaign list the page happened to hold, which
 * could disagree with the decision the miner had actually made. The daemon now says, and
 * the wording lives in one module the narrow layout and the tray share.
 */
const idle = computed(() => idleCopy(store.idle));
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
        One band, whatever the state. Starting up, idling and mining are the same thing at
        different moments - the panel that reports what the bot is doing - and giving each a
        card of its own made the page rearrange itself as they changed.
    -->
    <section v-else class="-mx-4 -mt-4 overflow-hidden" :style="heroStyle">
        <!-- Background to the window edges, contents on the same column as the panels
             below. Without the second half the text drifted out to the far edges while
             everything under it stayed centred. -->
        <div class="px-4 pt-3 pb-3 max-w-[1800px] mx-auto">
            <header class="flex items-center justify-between gap-3 mb-2">
                <div class="flex items-center gap-2 min-w-0">
                    <StatusChip
                        v-if="active"
                        :status="claimedAndWaiting ? 'claimed' : store.isStalled ? 'stalled' : 'mining'"
                    />
                    <span
                        v-else
                        class="text-[10px] uppercase tracking-wider"
                        :style="{ color: 'var(--text-2)' }"
                    >
                        {{ store.loading ? "Starting up" : paused ? "Paused" : "Idle" }}
                    </span>
                    <span v-if="active" class="text-[12px] truncate" :style="{ color: 'var(--text-2)' }">
                        <strong :style="{ color: 'var(--text)' }">{{ campaign?.game?.name }}</strong>
                        &mdash; {{ campaign?.name }}
                    </span>
                </div>

                <div class="flex items-center gap-2 shrink-0">
                    <StatusChip
                        v-if="active && campaign && !campaign.isAccountLinked"
                        status="unlinked"
                        :href="campaign.accountLinkUrl"
                    />
                    <button
                        v-if="active"
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
                            :disabled="busy || paused || !active"
                            title="Move on to the next campaign, sending this one to the back of the queue"
                            aria-label="Next campaign"
                            @click="run('next')"
                        >
                            {{ "\u23ED" }}
                        </button>
                    </div>
                </div>
            </header>

            <!-- Mining: the reward is the headline. Users care about the item, not the
                 streamer. -->
            <div v-if="active" class="flex items-start gap-4">
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

                    <!--
                        Directly under the name it belongs to. At the foot of the band it
                        was a 2000px line an inch away from the drop it measured, which
                        reads as a divider between sections rather than as progress.
                    -->
                    <!-- Spans the whole content column: it measures a wait of hours, and a
                         bar that stops short of the panel reads as a bar that is stuck. -->
                    <div class="flex items-center gap-3 mt-2">
                        <div
                            class="flex-1 h-[8px] rounded-full overflow-hidden"
                            :style="{ background: 'color-mix(in srgb, var(--bg) 55%, transparent)' }"
                        >
                            <div
                                class="h-full rounded-full transition-[width] duration-700"
                                :style="{
                                    width: `${progress * 100}%`,
                                    background: accent,
                                    boxShadow: `0 0 10px color-mix(in srgb, ${accent} 70%, transparent)`,
                                }"
                            />
                        </div>
                        <span class="tabular font-mono text-[12px] shrink-0" :style="{ color: 'var(--text-2)' }">
                            {{ drop.currentMinutes }} / {{ drop.requiredMinutes }} min
                            &middot; {{ Math.round(progress * 100) }}%
                        </span>
                    </div>

                    <!-- Once claimed the countdown has stopped meaning anything; say what is
                         actually happening rather than leave a finished drop ticking. -->
                    <p
                        v-if="claimedAndWaiting"
                        class="text-[12px] mt-1.5"
                        :style="{ color: 'var(--success)' }"
                    >
                        Claimed &mdash; choosing what to mine next&hellip;
                    </p>
                    <p
                        v-else
                        class="text-[12px] tabular mt-1.5"
                        :style="{ color: etaBeyondCampaign ? 'var(--warn)' : 'var(--text-2)' }"
                    >
                        {{ formatDuration(remainingMinutes) }} left
                        <template v-if="eta"> &middot; done ~{{ formatClock(eta) }}</template>
                        <template v-if="etaBeyondCampaign">
                            &middot; campaign ends first, may not finish
                        </template>
                    </p>

                    <div class="flex items-center justify-between gap-3 mt-2 flex-wrap">
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
                                    :class="entry.id === drop.id && !entry.isClaimed ? 'pulse' : ''"
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
                            <span class="flex items-end gap-[2px] h-3">
                                <span class="w-[3px] h-[5px] rounded-sm" :style="{ background: store.beatHealthy ? 'var(--accent)' : 'var(--muted)' }" />
                                <span class="w-[3px] h-[9px] rounded-sm" :style="{ background: store.beatHealthy ? 'var(--accent)' : 'var(--muted)' }" />
                                <span class="w-[3px] h-[12px] rounded-sm" :style="{ background: store.beatHealthy ? 'var(--accent)' : 'var(--muted)' }" />
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Starting up: what it is doing, and how far through. -->
            <div v-else-if="store.loading" class="max-w-[520px]">
                <StartupProgress />
            </div>

            <!-- Idle: never a blank band; always say why, and where to look next. -->
            <div v-else class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                    <h1 class="text-[20px] font-semibold leading-tight">
                        {{ paused ? "Paused" : store.atDailyLimit ? "Daily limit reached" : outsideSchedule ? "Outside your hours" : idle.title || "Nothing to mine right now" }}
                    </h1>
                    <p class="text-[12px] mt-1" :style="{ color: 'var(--text-2)' }">
                        <template v-if="paused">Nothing is being watched or claimed until you resume.</template>
                        <template v-else-if="store.atDailyLimit">
                            Today's allowance is used up. Mining resumes tomorrow.
                        </template>
                        <template v-else-if="outsideSchedule">
                            Mining is set to certain hours, and now is not one of them.
                        </template>
                        <template v-else>{{ idle.body || "Nothing available to mine right now." }}</template>
                    </p>
                </div>
                <RouterLink
                    v-if="store.upcomingCampaigns.length"
                    to="/campaigns"
                    class="text-[12px] hover:underline shrink-0"
                    :style="{ color: 'var(--accent)' }"
                >
                    See what is coming &rarr;
                </RouterLink>
            </div>
        </div>

    </section>
</template>
