import { onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";

import { useMinerStore } from "@/stores/miner.js";
import { orderDraggedGame } from "@/lib/ranking.js";

/**
 * Dragging the queue into a different order, from either layout.
 *
 * Shared rather than written twice because the tricky parts are not visual: the queue is
 * computed by the daemon and read-only, so an order can only be stored by rewriting the
 * priority list, and the local copy has to survive the snapshots arriving while that
 * happens. Two copies of that would drift, and the drift would be silent.
 */
export function useQueueOrder() {
    const store = useMinerStore();

    /** A local copy of the queue, so a drag has something to write to. */
    const order = ref([]);
    /** Set across a save, so an inbound snapshot cannot yank the list back mid-write. */
    const pending = ref(false);
    const saving = ref(false);
    let settleTimer = null;

    /** True while a row is actually held, so an inbound snapshot cannot re-render under it. */
    const dragging = ref(false);

    watch(
        () => store.upNext,
        (next) => {
            if (!pending.value && !dragging.value) order.value = [...next];
        },
        { immediate: true },
    );

    onMounted(() => {
        // The reorder rule reads the existing priority list, so it has to be loaded.
        if (!store.config) store.loadConfig().catch(() => {});
    });

    onUnmounted(() => clearTimeout(settleTimer));

    /**
     * Persist a drag - see orderDraggedGame for the rule.
     *
     * Writes queueOrder and nothing else. The priority list is the user's own and is never
     * touched from here.
     *
     * Refuses to write if settings were never loaded, since treating a failed fetch as an
     * empty list would delete an order the user had built up.
     */
    async function onReorder(event) {
        const existing = store.config?.queueOrder;
        if (!existing) {
            ElMessage.error("Settings have not loaded yet, so the order was not saved.");
            order.value = [...store.upNext];
            return;
        }

        const movedIndex = event?.newIndex ?? event?.newDraggableIndex;
        if (movedIndex === undefined || movedIndex === null) {
            order.value = [...store.upNext];
            return;
        }

        pending.value = true;
        saving.value = true;

        const next = orderDraggedGame(order.value, existing, movedIndex);

        try {
            await store.saveConfig({ queueOrder: next });
        } catch (error) {
            ElMessage.error(error.message);
            order.value = [...store.upNext];
        } finally {
            saving.value = false;
            // Let the daemon re-rank and push before trusting its order again.
            clearTimeout(settleTimer);
            settleTimer = setTimeout(() => {
                pending.value = false;
                order.value = [...store.upNext];
            }, 2500);
        }
    }

    /** Keyboard reordering - drag-only would be an accessibility failure. */
    function move(index, delta) {
        const target = index + delta;
        if (target < 0 || target >= order.value.length) return;
        const [item] = order.value.splice(index, 1);
        order.value.splice(target, 0, item);
        onReorder({ newIndex: target });
    }

    return { order, saving, dragging, onReorder, move };
}
