<script setup>
import { computed } from "vue";

/**
 * One segment per drop, so a campaign's overall progress and its tiered structure are
 * legible in a single glance.
 */
const props = defineProps({
    drops: { type: Array, required: true },
    height: { type: Number, default: 7 },
});

const segments = computed(() =>
    props.drops.map((drop) => ({
        id: drop.id,
        claimed: drop.isClaimed,
        fraction: drop.requiredMinutes
            ? Math.min(1, drop.currentMinutes / drop.requiredMinutes)
            : 0,
        title: `${drop.name}: ${drop.currentMinutes}/${drop.requiredMinutes} min`,
    })),
);
</script>

<template>
    <div class="flex gap-[3px] w-full" :style="{ height: `${height}px` }">
        <div
            v-for="segment in segments"
            :key="segment.id"
            class="flex-1 rounded-full overflow-hidden"
            :style="{ background: 'color-mix(in srgb, var(--text-2) 22%, transparent)' }"
            :title="segment.title"
        >
            <div
                class="h-full rounded-full transition-[width] duration-500 ease-out"
                :style="{
                    width: `${segment.fraction * 100}%`,
                    background: segment.claimed ? 'var(--success)' : 'var(--accent)',
                }"
            />
        </div>
    </div>
</template>
