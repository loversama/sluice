<script setup>
/**
 * The Sluice mark: a drop above a funnel.
 *
 * Drawn rather than loaded so it takes the surrounding colour - the header tints it with
 * the accent, which differs between the light and dark themes, and a PNG of the purple
 * artwork would sit wrong against both. The geometry is measured from sluice.jpeg, the same
 * drawing every shipped icon is generated from, so this and the taskbar agree.
 */
defineProps({
    /** Rendered size in pixels, square. */
    size: { type: Number, default: 16 },
});
</script>

<template>
    <svg
        :width="size"
        :height="size"
        viewBox="205 205 613 613"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
    >
        <!-- The drop: a point above a circle, joined by its tangents. -->
        <path d="M511.5 205 C511.5 205 568 268 568 311.5 A56.5 56.5 0 1 1 455 311.5 C455 268 511.5 205 511.5 205 Z" />
        <!-- The funnel: a wide mouth narrowing into a stem cut off at an angle. -->
        <path d="M283 389 H740 L563 625 V760 L460 818 V625 Z" />
    </svg>
</template>
