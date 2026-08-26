<script setup>
/**
 * The grey camera that stands in for a stream there is nothing to show for yet.
 *
 * Drawn rather than fetched. Twitch serves a placeholder of its own at the preview URL, but
 * relying on it means a network round trip to say "nothing here", and a broken-image glyph
 * when that fails - which is precisely the moment it is most likely to.
 */
defineProps({ label: { type: String, default: "" } });
</script>

<template>
    <div
        class="w-full h-full grid place-items-center gap-3"
        :style="{ background: 'var(--surface-2)' }"
    >
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true">
            <rect
                x="6" y="18" width="34" height="28" rx="4"
                :fill="'var(--muted)'" opacity="0.55"
            />
            <path d="M44 30 L58 21 v22 l-14 -9 z" :fill="'var(--muted)'" opacity="0.55" />
        </svg>
        <p v-if="label" class="text-[11px] -mt-2" :style="{ color: 'var(--muted)' }">{{ label }}</p>
    </div>
</template>
