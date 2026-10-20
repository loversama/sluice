import { computed, onMounted } from "vue";
import { ElMessage } from "element-plus";

import { useMinerStore } from "@/stores/miner.js";
import * as lists from "@/lib/gameLists.js";

/**
 * Every write to the priority list, the excluded list and the queue order goes through here.
 *
 * Priorities, Campaigns and the queue drag each used to build and save these lists their own
 * way, and the guards drifted apart: the queue refused to write before settings had loaded,
 * but the Campaigns buttons did not - so a click before the fetch finished wrote the game
 * into an empty list over the real one. One place now owns that guard, the matching rules
 * (lib/gameLists.js) and the error toast.
 */
export function useGameLists() {
    const store = useMinerStore();

    onMounted(() => {
        // The guard below needs these loaded, and every page using this edits them.
        if (!store.config) store.loadConfig().catch(() => {});
    });

    const priorityGames = computed(() => store.config?.priorityGames ?? []);
    const excludedGames = computed(() => store.config?.excludedGames ?? []);
    const queueOrder = computed(() => store.config?.queueOrder ?? []);

    /** Zero-based place on the priority list, or -1. */
    const rankOf = (game) => lists.indexIn(priorityGames.value, game);
    const isPriority = (game) => rankOf(game) !== -1;
    const isExcluded = (game) => lists.isOn(excludedGames.value, game);

    /**
     * Save a patch to the lists. Resolves false, having said why, if nothing was written.
     *
     * Refuses outright while settings are unloaded: building the patch from a list that is
     * not there yet would save an empty one over the real thing.
     */
    async function save(patch, success) {
        if (!store.config) {
            ElMessage.error("Settings have not loaded yet, so nothing was changed.");
            return false;
        }
        try {
            await store.saveConfig(patch);
            if (success) ElMessage.success(success);
            return true;
        } catch (error) {
            ElMessage.error(error.message);
            return false;
        }
    }

    /** Apply one of the lib/gameLists edits to the lists as they stand, then save it. */
    function edit(change, game, success, options) {
        if (!store.config) return save(null);
        return save(change(store.config, game, options), success);
    }

    const nameOf = (game) => (typeof game === "string" ? game : game.name);

    return {
        loaded: computed(() => Boolean(store.config)),
        priorityGames,
        excludedGames,
        queueOrder,
        rankOf,
        isPriority,
        isExcluded,
        save,
        prioritise: (game) => edit(lists.prioritise, game, `${nameOf(game)} added to priorities.`),
        moveToTop: (game) =>
            edit(lists.prioritise, game, `${nameOf(game)} is now first.`, { top: true }),
        removePriority: (game) =>
            edit(lists.removePriority, game, `${nameOf(game)} removed from priorities.`),
        exclude: (game) => edit(lists.exclude, game, `${nameOf(game)} excluded.`),
        unexclude: (game) => edit(lists.unexclude, game, `${nameOf(game)} can be mined again.`),
        unorder: (game) => edit(lists.unorder, game),
        resetQueueOrder: () => save({ queueOrder: [] }, "Dragged order cleared."),
    };
}
