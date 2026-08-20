<script setup>
import { computed, ref } from "vue";

/**
 * A human-readable activity strip, deliberately not a log viewer - real logs belong in the
 * terminal. Collapsed to a few rows so it informs without dominating.
 */
const props = defineProps({
    entries: { type: Array, default: () => [] },
});

const expanded = ref(false);
const visible = computed(() => (expanded.value ? props.entries.slice(0, 50) : props.entries.slice(0, 3)));

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
                v-if="entries.length > 3"
                class="text-[11px] hover:underline"
                :style="{ color: 'var(--text-2)' }"
                @click="expanded = !expanded"
            >
                {{ expanded ? "Show less" : `Show all (${entries.length})` }}
            </button>
        </header>

        <p v-if="!entries.length" class="text-[12px]" :style="{ color: 'var(--muted)' }">
            Nothing has happened yet.
        </p>

        <ul v-else class="space-y-1">
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
