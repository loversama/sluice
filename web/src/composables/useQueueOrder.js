import { onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";

import { useMinerStore } from "@/stores/miner.js";
import { nextPriorityGames } from "@/lib/ranking.js";

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

    watch(
        () => store.upNext,
        (next) => {
            if (!pending.value) order.value = [...next];
        },
        { immediate: true },
    );

    onMounted(() => {
        // The reorder rule reads the existing priority list, so it has to be loaded.
        if (!store.config) store.loadConfig().catch(() => {});
    });

    onUnmounted(() => clearTimeout(settleTimer));

    /** Persist a drag by rewriting the priority list - see nextPriorityGames for the rule. */
    async function onReorder() {
        pending.value = true;
        saving.value = true;

        const next = nextPriorityGames(
            order.value,
            store.config?.priorityGames ?? [],
            store.currentCampaign?.game?.name ?? store.mining?.channel?.game ?? null,
        );

        try {
            await store.saveConfig({ priorityGames: next });
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
        onReorder();
    }

    return { order, saving, onReorder, move };
}
