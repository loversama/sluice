import { onMounted, onUnmounted, ref, computed } from "vue";

/**
 * Below this the sidebar and the multi-column dashboard stop making sense, and the app
 * switches to a single stacked column. Chosen to sit above the 350px minimum the window
 * allows, so the narrow layout has a little room rather than being pinned to the edge.
 */
export const COMPACT_BREAKPOINT = 560;

/** Track the window width, so layout can respond to a resized desktop window, not just CSS. */
export function useViewport() {
    const width = ref(typeof window === "undefined" ? 1280 : window.innerWidth);
    const onResize = () => (width.value = window.innerWidth);

    onMounted(() => window.addEventListener("resize", onResize, { passive: true }));
    onUnmounted(() => window.removeEventListener("resize", onResize));

    return {
        width,
        /** Narrow enough that a sidebar would eat the content. */
        isCompact: computed(() => width.value < COMPACT_BREAKPOINT),
    };
}
