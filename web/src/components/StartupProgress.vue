<script setup>
import { computed } from "vue";

import { useMinerStore } from "@/stores/miner.js";

/**
 * What the daemon is doing before there is anything to show.
 *
 * Opening the app and waiting half a minute at a blank panel reads as broken. Most of that
 * wait is fetching campaign details, which is one request per campaign and genuinely slow
 * on a busy account - so the honest fix is to say so and show it moving, rather than to
 * imply something is wrong or pretend it is nearly done.
 */
const store = useMinerStore();

const loading = computed(() => store.loading);

const label = computed(() => {
    const phase = loading.value?.phase;
    if (phase === "campaigns") return "Asking Twitch what is running";
    if (phase === "details") return "Reading campaign details";
    if (phase === "choosing") return "Choosing what to mine";
    return "Connecting to Twitch";
});

/** Only the details phase knows how much is left; the others are genuinely unbounded. */
const percent = computed(() => {
    const { done, total } = loading.value ?? {};
    if (!total) return null;
    return Math.min(100, Math.round((done / total) * 100));
});

const counted = computed(() => {
    const { done, total } = loading.value ?? {};
    return total ? `${done} of ${total}` : null;
});
</script>

<template>
    <div class="flex flex-col gap-1.5">
        <div class="flex items-baseline gap-2">
            <span class="text-[12px]">{{ label }}&hellip;</span>
            <span v-if="counted" class="text-[11px] tabular ml-auto" :style="{ color: 'var(--text-2)' }">
                {{ counted }}
            </span>
        </div>

        <div class="h-1 rounded-full overflow-hidden" :style="{ background: 'var(--surface-2)' }">
            <!--
                A real bar where the count is known, and a travelling one where it is not.
                A fake bar that crawls to 90% and stops is worse than admitting the wait is
                unbounded.
            -->
            <div
                v-if="percent !== null"
                class="h-full rounded-full transition-[width] duration-500"
                :style="{ width: `${percent}%`, background: 'var(--accent)' }"
            />
            <div v-else class="h-full w-1/3 rounded-full startup-sweep" :style="{ background: 'var(--accent)' }" />
        </div>

        <p v-if="loading?.phase === 'details'" class="text-[10px]" :style="{ color: 'var(--muted)' }">
            Twitch answers one campaign at a time, so this is the slow part.
        </p>
    </div>
</template>

<style scoped>
@keyframes startup-sweep {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(300%); }
}

.startup-sweep {
    animation: startup-sweep 1.4s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
    .startup-sweep {
        animation: none;
        width: 100%;
        opacity: 0.35;
    }
}
</style>
