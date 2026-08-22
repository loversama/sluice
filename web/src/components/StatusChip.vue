<script setup>
import { computed } from "vue";

/**
 * Status is triple-coded - colour, label and icon - because colour alone is invisible to
 * colour-blind users. The same chip is reused everywhere so the vocabulary is learned once.
 */
const props = defineProps({
    status: { type: String, required: true },
    small: { type: Boolean, default: false },
    /**
     * Makes the chip a link. Used by the "not linked" chip so the warning is also the fix -
     * clicking it opens the publisher's own linking page rather than leaving the user to go
     * and find it.
     */
    href: { type: String, default: null },
});

const STYLES = {
    mining: { label: "Mining", icon: "●", color: "var(--accent)", pulse: true },
    active: { label: "Active", icon: "○", color: "var(--success)" },
    upcoming: { label: "Upcoming", icon: "◷", color: "var(--info)" },
    completed: { label: "Completed", icon: "✓", color: "var(--muted)" },
    stalled: { label: "Stalled", icon: "⏸", color: "var(--warn)", pulse: true },
    unlinked: { label: "Not linked", icon: "⚠", color: "var(--warn)" },
    unfinishable: { label: "Can't finish", icon: "⏳", color: "var(--warn)" },
    excluded: { label: "Excluded", icon: "⊘", color: "var(--muted)" },
    claimed: { label: "Claimed", icon: "✓", color: "var(--success)" },
    claimable: { label: "Ready", icon: "★", color: "var(--success)" },
    locked: { label: "Locked", icon: "⚿", color: "var(--muted)" },
    missed: { label: "Missed", icon: "✗", color: "var(--muted)" },
    restricted: { label: "Allow-list", icon: "☷", color: "var(--text-2)" },
};

const style = computed(() => STYLES[props.status] ?? STYLES.active);
</script>

<template>
    <component
        :is="href ? 'a' : 'span'"
        :href="href || undefined"
        :target="href ? '_blank' : undefined"
        :rel="href ? 'noreferrer' : undefined"
        :title="href ? 'Open the publisher\'s account linking page' : undefined"
        class="inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap"
        :class="[
            small ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]',
            href ? 'cursor-pointer hover:brightness-125 underline-offset-2 hover:underline' : '',
        ]"
        :style="{
            color: style.color,
            borderColor: `color-mix(in srgb, ${style.color} 40%, transparent)`,
            background: `color-mix(in srgb, ${style.color} 12%, transparent)`,
        }"
        @click.stop
    >
        <span :class="style.pulse ? 'pulse' : ''">{{ style.icon }}</span>
        {{ style.label }}
    </component>
</template>
