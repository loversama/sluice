<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import draggable from "vuedraggable";

import { useMinerStore } from "@/stores/miner.js";

const store = useMinerStore();

const priorities = ref([]);
const excluded = ref([]);
const priorityMode = ref("ending_soonest");

/** Wording is deliberately about outcomes, not algorithm names. */
const PRIORITY_MODES = [
    { value: "ending_soonest", label: "Whatever ends soonest", hint: "Finish what expires first." },
    {
        value: "tightest_deadline",
        label: "Most at risk of being missed",
        hint: "Weighs time left against the minutes still needed, so near-misses come first.",
    },
    { value: "one_game_at_a_time", label: "One game at a time", hint: "Finish a game's campaigns before starting another." },
    {
        value: "steam_playtime",
        label: "My Steam games, most played",
        hint: "Games you own on Steam first, ordered by total playtime. Needs Steam connected.",
        steam: true,
    },
    {
        value: "steam_recent",
        label: "My Steam games, recently played",
        hint: "Games you own on Steam first, most recently played first. Needs Steam connected.",
        steam: true,
    },
    { value: "random", label: "Random order", hint: "Reshuffled on every refresh." },
    { value: "priority_only", label: "Nothing else", hint: "Mine only the games listed above." },
];
const newPriority = ref("");
const steamStatus = ref(null);
const searchResults = ref([]);
const searching = ref(false);
let searchTimer = null;

/**
 * Search every category on Twitch, not just games with a campaign right now. A priority
 * list is a standing preference, so it has to be able to name a game before its campaign
 * is announced.
 */
function onSearchInput() {
    clearTimeout(searchTimer);
    const term = newPriority.value.trim();
    if (term.length < 2) {
        searchResults.value = [];
        return;
    }
    searchTimer = setTimeout(async () => {
        searching.value = true;
        try {
            const response = await fetch(`/api/games/search?q=${encodeURIComponent(term)}`);
            searchResults.value = (await response.json()).games ?? [];
        } catch {
            searchResults.value = [];
        } finally {
            searching.value = false;
        }
    }, 300);
}

function addGame(name) {
    if (!priorities.value.some((entry) => entry.toLowerCase() === name.toLowerCase())) {
        excluded.value = excluded.value.filter(
            (entry) => entry.toLowerCase() !== name.toLowerCase(),
        );
        priorities.value.push(name);
        scheduleSave();
    }
    newPriority.value = "";
    searchResults.value = [];
}

/** A Steam-driven mode is meaningless until a library has actually been fetched. */
const needsSteam = computed(
    () =>
        PRIORITY_MODES.find((mode) => mode.value === priorityMode.value)?.steam &&
        !steamStatus.value?.connected,
);
const newExcluded = ref("");
const saving = ref(false);

let saveTimer = null;

onMounted(async () => {
    if (!store.config) {
        await store.loadConfig();
    }
    steamStatus.value = await fetch("/api/steam")
        .then((response) => response.json())
        .catch(() => null);
});

watch(
    () => store.config,
    (config) => {
        if (!config) return;
        priorities.value = [...config.priorityGames];
        excluded.value = [...config.excludedGames];
        priorityMode.value = config.priorityMode ?? "ending_soonest";
    },
    { immediate: true },
);

/** Games we know about, for the autocomplete - active and upcoming campaigns alike. */
const knownGames = computed(() => {
    const seen = new Map();
    for (const campaign of store.campaigns) {
        if (!seen.has(campaign.game.name)) {
            seen.set(campaign.game.name, {
                name: campaign.game.name,
                boxArtURL: campaign.game.boxArtURL,
                status: campaign.status,
            });
        }
    }
    return [...seen.values()];
});

function campaignCount(game) {
    const matches = store.campaigns.filter(
        (campaign) => campaign.game.name.toLowerCase() === game.toLowerCase(),
    );
    const active = matches.filter((c) => c.status === "active").length;
    const upcoming = matches.filter((c) => c.status === "upcoming").length;
    if (active) return `${active} active campaign${active > 1 ? "s" : ""}`;
    if (upcoming) return `${upcoming} upcoming`;
    return "no campaigns right now";
}

function boxArt(game) {
    return knownGames.value.find((entry) => entry.name.toLowerCase() === game.toLowerCase())
        ?.boxArtURL;
}

/** Debounced so a fumbled drag does not fire three writes. */
function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 500);
}

async function persist() {
    saving.value = true;
    try {
        await store.saveConfig({
            priorityGames: priorities.value,
            excludedGames: excluded.value,
            priorityMode: priorityMode.value,
        });
    } catch (error) {
        ElMessage.error(error.message);
        // Revert to whatever the daemon actually holds.
        priorities.value = [...(store.config?.priorityGames ?? [])];
        excluded.value = [...(store.config?.excludedGames ?? [])];
    } finally {
        saving.value = false;
    }
}

function addPriority() {
    // Enter takes the top search result when there is one, so the common case is two keys.
    const first = searchResults.value[0];
    const game = first ? first.name : newPriority.value.trim();
    if (game) {
        addGame(game);
    }
}

function addExcluded() {
    const game = newExcluded.value.trim();
    if (!game || excluded.value.some((entry) => entry.toLowerCase() === game.toLowerCase())) {
        newExcluded.value = "";
        return;
    }
    priorities.value = priorities.value.filter((entry) => entry.toLowerCase() !== game.toLowerCase());
    excluded.value.push(game);
    newExcluded.value = "";
    scheduleSave();
}

function remove(list, index) {
    list.splice(index, 1);
    scheduleSave();
}

function toExcluded(index) {
    const [game] = priorities.value.splice(index, 1);
    if (game) excluded.value.push(game);
    scheduleSave();
}

/** Keyboard reordering - drag-only would be an accessibility failure. */
function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= priorities.value.length) return;
    const [game] = priorities.value.splice(index, 1);
    priorities.value.splice(target, 0, game);
    scheduleSave();
}
</script>

<template>
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <section class="lg:col-span-7 space-y-3">
            <header class="flex items-center justify-between">
                <div>
                    <h1 class="text-[15px] font-semibold">Priority games</h1>
                    <p class="text-[12px]" :style="{ color: 'var(--text-2)' }">
                        Mined top to bottom. Within a game, campaigns ending soonest go first.
                    </p>
                </div>
                <span v-if="saving" class="text-[11px]" :style="{ color: 'var(--text-2)' }">Saving&hellip;</span>
            </header>

            <div class="flex gap-2">
                <div class="relative flex-1">
                    <input
                        v-model="newPriority"
                        placeholder="Search any game on Twitch"
                        class="w-full px-3 py-2 rounded-lg text-[12px] outline-none"
                        :style="{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }"
                        @input="onSearchInput"
                        @keyup.enter="addPriority"
                    />

                    <ul
                        v-if="searchResults.length"
                        class="absolute z-20 left-0 right-0 mt-1 rounded-lg overflow-hidden shadow-xl"
                        :style="{ background: 'var(--surface)', border: '1px solid var(--border)' }"
                    >
                        <li
                            v-for="game in searchResults"
                            :key="game.id"
                            class="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:brightness-125"
                            :style="{ background: 'var(--surface)' }"
                            @click="addGame(game.name)"
                        >
                            <img
                                v-if="game.boxArtURL"
                                :src="game.boxArtURL"
                                :alt="game.name"
                                class="w-6 h-8 rounded object-cover"
                            />
                            <span class="text-[12px] truncate">{{ game.name }}</span>
                        </li>
                    </ul>
                    <p
                        v-else-if="searching"
                        class="absolute left-0 right-0 mt-1 px-3 py-2 rounded-lg text-[11px]"
                        :style="{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)' }"
                    >
                        Searching Twitch&hellip;
                    </p>
                </div>
                <button
                    class="px-3 py-2 rounded-lg text-[12px] font-medium text-white shrink-0"
                    :style="{ background: 'var(--accent)' }"
                    @click="addPriority"
                >
                    Add
                </button>
            </div>

            <p v-if="!priorities.length" class="card p-6 text-center text-[12px]" :style="{ color: 'var(--muted)' }">
                No priorities yet &mdash; the miner picks whatever ends soonest.
                Add games to control the order.
            </p>

            <draggable
                v-model="priorities"
                item-key="self"
                handle=".drag-handle"
                :animation="150"
                class="space-y-1"
                @end="scheduleSave"
            >
                <template #item="{ element: game, index }">
                    <div
                        class="card flex items-center gap-3 p-2.5"
                        tabindex="0"
                        @keydown.ctrl.up.prevent="move(index, -1)"
                        @keydown.ctrl.down.prevent="move(index, 1)"
                    >
                        <span class="drag-handle cursor-grab select-none" :style="{ color: 'var(--muted)' }">⠿</span>
                        <span
                            class="w-5 h-5 rounded-full grid place-items-center text-[10px] font-semibold shrink-0 text-white"
                            :style="{ background: 'var(--accent)' }"
                        >
                            {{ index + 1 }}
                        </span>
                        <img v-if="boxArt(game)" :src="boxArt(game)" :alt="game" class="w-6 h-8 rounded object-cover" />
                        <span class="text-[13px] flex-1 truncate">{{ game }}</span>
                        <span class="text-[11px] shrink-0" :style="{ color: 'var(--muted)' }">
                            {{ campaignCount(game) }}
                        </span>
                        <div class="flex gap-1 shrink-0">
                            <button class="px-1.5 text-[12px]" :style="{ color: 'var(--text-2)' }" title="Move up" @click="move(index, -1)">↑</button>
                            <button class="px-1.5 text-[12px]" :style="{ color: 'var(--text-2)' }" title="Move down" @click="move(index, 1)">↓</button>
                            <button class="px-1.5 text-[12px]" :style="{ color: 'var(--text-2)' }" title="Exclude" @click="toExcluded(index)">⊘</button>
                            <button class="px-1.5 text-[12px]" :style="{ color: 'var(--danger)' }" title="Remove" @click="remove(priorities, index)">×</button>
                        </div>
                    </div>
                </template>
            </draggable>

            <!--
                Rendering the catch-all as a permanent bottom row turns an abstract boolean
                into a spatial fact: everything above the line is ranked, this is the rest.
            -->
            <div
                class="rounded-[10px] p-2.5"
                :style="{
                    border: '1px dashed var(--border)',
                    opacity: priorityMode === 'priority_only' ? 0.55 : 1,
                }"
            >
                <div class="flex items-center gap-3">
                    <span class="w-5" />
                    <span
                        class="w-5 h-5 rounded-full grid place-items-center text-[11px] shrink-0"
                        :style="{ border: '1px solid var(--border)', color: 'var(--text-2)' }"
                    >
                        ∞
                    </span>
                    <span class="text-[13px] flex-1">Everything else, ordered by</span>
                    <select
                        v-model="priorityMode"
                        class="px-2 py-1.5 rounded-lg text-[12px] outline-none max-w-[220px]"
                        :style="{
                            background: 'var(--surface-2)',
                            border: '1px solid var(--border)',
                            color: 'var(--text)',
                        }"
                        @change="scheduleSave"
                    >
                        <option v-for="mode in PRIORITY_MODES" :key="mode.value" :value="mode.value">
                            {{ mode.label }}
                        </option>
                    </select>
                </div>
                <p class="text-[11px] mt-1.5 pl-[52px]" :style="{ color: 'var(--text-2)' }">
                    {{ PRIORITY_MODES.find((mode) => mode.value === priorityMode)?.hint }}
                </p>
                <p
                    v-if="needsSteam"
                    class="text-[11px] mt-1 pl-[52px]"
                    :style="{ color: 'var(--warn)' }"
                >
                    Steam is not connected, so this falls back to whatever ends soonest.
                    <RouterLink to="/settings" class="underline">Connect Steam</RouterLink>
                </p>
            </div>
        </section>

        <section class="lg:col-span-5 space-y-3">
            <div>
                <h2 class="text-[15px] font-semibold">Excluded games</h2>
                <p class="text-[12px]" :style="{ color: 'var(--text-2)' }">
                    Never mined, whatever the ordering above says.
                </p>
            </div>

            <div class="flex gap-2">
                <input
                    v-model="newExcluded"
                    placeholder="Add a game to exclude"
                    class="flex-1 px-3 py-2 rounded-lg text-[12px] outline-none"
                    :style="{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }"
                    @keyup.enter="addExcluded"
                />
                <button
                    class="px-3 py-2 rounded-lg text-[12px]"
                    :style="{ background: 'var(--surface-2)', color: 'var(--text)' }"
                    @click="addExcluded"
                >
                    Add
                </button>
            </div>

            <p v-if="!excluded.length" class="card p-6 text-center text-[12px]" :style="{ color: 'var(--muted)' }">
                Nothing excluded.
            </p>

            <div v-else class="flex flex-wrap gap-1.5">
                <span
                    v-for="(game, index) in excluded"
                    :key="game"
                    class="flex items-center gap-1.5 px-2 py-1 rounded-full text-[12px]"
                    :style="{ background: 'var(--surface-2)', color: 'var(--text-2)' }"
                >
                    {{ game }}
                    <button :style="{ color: 'var(--danger)' }" @click="remove(excluded, index)">×</button>
                </span>
            </div>
        </section>
    </div>
</template>
