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
    const height = ref(typeof window === "undefined" ? 800 : window.innerHeight);
    const onResize = () => {
        width.value = window.innerWidth;
        height.value = window.innerHeight;
    };

    onMounted(() => window.addEventListener("resize", onResize, { passive: true }));
    onUnmounted(() => window.removeEventListener("resize", onResize));

    /**
     * The desktop app decides its own layout.
     *
     * In the browser, width is all there is to go on. In the desktop build the side panel
     * is a mode the user chose, so it stays a side panel however wide the window is - which
     * is what lets it fill a portrait monitor instead of springing back to the wide layout
     * halfway across.
     */
    const thin = ref(false);
    const bridge = typeof window === "undefined" ? null : window.desktopBridge;

    onMounted(async () => {
        if (!bridge) return;
        thin.value = (await bridge.isThin?.()) ?? false;
        bridge.onThinChange?.((value) => (thin.value = value));
    });

    return {
        width,
        height,
        /** Narrow enough that a sidebar would eat the content, or explicitly in the panel. */
        isCompact: computed(() => (bridge ? thin.value : width.value < COMPACT_BREAKPOINT)),
    };
}
