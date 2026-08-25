<script setup>
/**
 * A placeholder in the shape of the thing that is coming.
 *
 * Used while the daemon signs in and fetches campaigns, which takes long enough that an
 * empty panel looks like a failure. The point is to keep the layout still: the panel is
 * already the right size, so nothing jumps when the real content lands.
 */
defineProps({
    width: { type: String, default: "100%" },
    height: { type: String, default: "12px" },
});
</script>

<template>
    <div class="skeleton" :style="{ width, height }" aria-hidden="true" />
</template>
