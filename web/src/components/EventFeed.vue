<script setup>
import { computed, nextTick, ref, watch } from "vue";

/**
 * A human-readable activity strip, deliberately not a log viewer - real logs belong in the
 * terminal. Collapsed to a few rows so it informs without dominating.
 */
const props = defineProps({
    entries: { type: Array, default: () => [] },
});

const list = ref(null);
/** Set when the reader scrolls away from the bottom, so following does not fight them. */
const pinned = ref(true);

/**
 * Oldest first, like any log. The store keeps newest-first for the panels that show only
 * the last few, so it is reversed here rather than there.
 */
const visible = computed(() => [...props.entries].reverse());

function onScroll() {
    const element = list.value;
    if (!element) return;
    pinned.value = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
}

watch(
    () => props.entries.length,
    async () => {
        if (!pinned.value) return;
        await nextTick();
        const element = list.value;
        if (element) element.scrollTop = element.scrollHeight;
    },
    { immediate: true },
);

const COLORS = { info: "var(--text-2)", warn: "var(--warn)", error: "var(--danger)" };

function time(at) {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
    <section class="card p-3">
        <header class="flex items-center justify-between mb-2">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                Activity
            </h2>
            <button
                v-if="!pinned"
                class="text-[11px] hover:underline"
                :style="{ color: 'var(--accent)' }"
                @click="pinned = true; list && (list.scrollTop = list.scrollHeight)"
            >
                Jump to latest
            </button>
            <span v-else class="text-[11px]" :style="{ color: 'var(--muted)' }">
                {{ entries.length }} events
            </span>
        </header>

        <p v-if="!entries.length" class="text-[12px]" :style="{ color: 'var(--muted)' }">
            Nothing has happened yet.
        </p>

        <ul
            v-else
            ref="list"
            class="space-y-1 h-[220px] overflow-y-auto pr-1 scroll-thin"
            @scroll="onScroll"
        >
            <li v-for="(entry, index) in visible" :key="index" class="flex items-start gap-2">
                <span class="tabular font-mono text-[11px] shrink-0" :style="{ color: 'var(--muted)' }">
                    {{ time(entry.at) }}
                </span>
                <span class="mt-[5px] w-1.5 h-1.5 rounded-full shrink-0"
                      :style="{ background: COLORS[entry.level] ?? COLORS.info }" />
                <span class="text-[12px] leading-5">{{ entry.message }}</span>
            </li>
        </ul>
    </section>
</template>
