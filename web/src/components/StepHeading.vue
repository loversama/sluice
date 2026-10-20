<script setup>
/**
 * A section heading on the Priorities page, numbered by the order the daemon applies it.
 *
 * In the narrow window it becomes the same full-bleed band Settings and the compact
 * dashboard use, so stacked sections read as one page rather than as loose cards.
 */
defineProps({
    title: { type: String, required: true },
    /** The layer's place in the ranking; omitted for anything that is not a layer. */
    step: { type: [Number, String], default: null },
    band: { type: Boolean, default: false },
});
</script>

<template>
    <div
        class="flex items-center gap-2 min-h-[22px]"
        :class="band ? '-mx-4 px-4 py-1.5' : ''"
        :style="band ? { background: 'var(--surface-2)' } : {}"
    >
        <span
            v-if="step !== null"
            class="w-4 h-4 rounded-full grid place-items-center text-[10px] font-semibold shrink-0"
            :style="{ border: '1px solid var(--border)', color: 'var(--text-2)' }"
            aria-hidden="true"
        >{{ step }}</span>
        <h2
            :class="band ? 'text-[10px]' : 'text-[11px]'"
            class="uppercase tracking-wider"
            :style="{ color: 'var(--text-2)' }"
        >
            {{ title }}
        </h2>
        <div class="ml-auto flex items-center gap-2">
            <slot />
        </div>
    </div>
</template>
