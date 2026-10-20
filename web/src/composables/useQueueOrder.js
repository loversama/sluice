import { onUnmounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";

import { useMinerStore } from "@/stores/miner.js";
import { useGameLists } from "@/composables/useGameLists.js";
import {
    dragRefusal,
    orderDraggedGame,
    priorityGameBelow,
    reorderPriorityGames,
} from "@/lib/ranking.js";

/** What to say when a drag cannot hold - see dragRefusal. */
const REFUSALS = {
    dimmed: (item) =>
        `${item.game.name} won't be mined - ${
            item.isExcluded ? "it's on your excluded list" : "it's outside your library policy"
        } - so it stays at the bottom.`,
    deferred: (item) =>
        `${item.game.name} was skipped with Next, so it waits at the back. ` +
        "Put it back from the Priorities page.",
    below: () =>
        "Everything below that point is skipped or won't be mined, so nothing can be ranked under it.",
};

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
    const lists = useGameLists();

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

    onUnmounted(() => clearTimeout(settleTimer));

    /**
     * Persist a drag - see orderDraggedGame and reorderPriorityGames for the rules.
     *
     * A game already on the priority list moves within that list, because the list outranks
     * everything a drag can write elsewhere. Any other game goes to queueOrder, unless it
     * was dropped above a priority game: that can never hold, so it is put back with a note
     * saying how to rank it there instead. The priority list never gains an entry here.
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

        const refusal = dragRefusal(order.value, movedIndex);
        if (refusal) {
            ElMessage.info(REFUSALS[refusal](order.value[movedIndex]));
            order.value = [...store.upNext];
            return;
        }

        const priorityGames = store.config?.priorityGames ?? [];
        const reordered = reorderPriorityGames(order.value, priorityGames, movedIndex);
        if (!reordered && priorityGameBelow(order.value, priorityGames, movedIndex)) {
            const game = order.value[movedIndex]?.game?.name ?? "That game";
            ElMessage.info(
                `${game} isn't on your priority list, so it can't go above games that are. ` +
                    "Add it on the Priorities page to rank it among them.",
            );
            order.value = [...store.upNext];
            return;
        }

        pending.value = true;
        saving.value = true;

        const patch = reordered
            ? { priorityGames: reordered }
            : { queueOrder: orderDraggedGame(order.value, existing, movedIndex) };

        try {
            if (!(await lists.save(patch))) order.value = [...store.upNext];
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
