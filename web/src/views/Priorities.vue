<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ElMessage } from "element-plus";
import draggable from "vuedraggable";

import { useMinerStore } from "@/stores/miner.js";
import { useGameLists } from "@/composables/useGameLists.js";
import { useViewport } from "@/lib/viewport.js";
import { boxArt } from "@/lib/format.js";
import * as edits from "@/lib/gameLists.js";
import { isDimmed, matchesGame } from "@/lib/ranking.js";
import StatusChip from "@/components/StatusChip.vue";
import StepHeading from "@/components/StepHeading.vue";

/**
 * Everything that decides what is mined next, in the order the daemon applies it.
 *
 * The rules were spread over three pages - the priority list here, dragged order only
 * visible as a side effect on the dashboard, Next deferrals nowhere at all - so the queue
 * could do something no page explained. Each layer now has a numbered section, top to
 * bottom as the miner reads them, with a live look at the queue they add up to.
 */
const store = useMinerStore();
const route = useRoute();
const lists = useGameLists();
const { isCompact } = useViewport();

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
        // "Recently played" is approximate and the label should not pretend otherwise:
        // Steam gives an exact last-played date only to a key that owns the account, so
        // the ranking runs on its two-week playtime figure instead. A game played hard
        // last Tuesday outranks one touched briefly yesterday.
        value: "steam_recent",
        label: "My Steam games, recently played",
        hint:
            "Games you own on Steam first, ranked by Steam's two-week playtime rather than " +
            "an exact last-played date. Needs Steam connected.",
        steam: true,
    },
    { value: "random", label: "Random order", hint: "Reshuffled on every refresh." },
    { value: "priority_only", label: "Nothing else", hint: "Mine only the games listed above." },
];

const currentMode = computed(() => PRIORITY_MODES.find((mode) => mode.value === priorityMode.value));

/* -------------------------------------------------------------------------- */
/* Search                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One search for both lists. There used to be a box for each, and the exclusion one was a
 * blind text field for a while - a typo'd exclusion silently never matches anything, which
 * is the worst failure a "never do this" control can have.
 *
 * It searches every category on Twitch, not just games with a campaign right now: a priority
 * list is a standing preference, so it has to be able to name a game before its campaign is
 * announced.
 */
const query = ref("");
const results = ref([]);
const searching = ref(false);
let searchTimer = null;

function onSearchInput() {
    clearTimeout(searchTimer);
    const term = query.value.trim();
    if (term.length < 2) {
        results.value = [];
        return;
    }
    searchTimer = setTimeout(async () => {
        searching.value = true;
        try {
            const response = await fetch(`/api/games/search?q=${encodeURIComponent(term)}`);
            results.value = (await response.json()).games ?? [];
        } catch {
            results.value = [];
        } finally {
            searching.value = false;
        }
    }, 300);
}

function clearSearch() {
    clearTimeout(searchTimer);
    query.value = "";
    results.value = [];
}

/** Enter, or either button, takes the top search result when there is one. */
function chosenGame() {
    return results.value[0]?.name ?? query.value.trim();
}

/* -------------------------------------------------------------------------- */
/* ① and ⑤ - edited here and saved together, debounced                        */
/* -------------------------------------------------------------------------- */

const saving = ref(false);
let saveTimer = null;

function current() {
    return { priorityGames: priorities.value, excludedGames: excluded.value };
}

function addGame(name) {
    if (!name) return;
    if (edits.isOn(priorities.value, name)) {
        ElMessage.info(`${name} is already in your priorities.`);
    } else {
        const next = edits.prioritise(current(), name);
        priorities.value = next.priorityGames;
        excluded.value = next.excludedGames;
        scheduleSave();
    }
    clearSearch();
}

function excludeGame(name) {
    if (!name) return;
    if (edits.isOn(excluded.value, name)) {
        ElMessage.info(`${name} is already excluded.`);
    } else {
        const next = edits.exclude(current(), name);
        priorities.value = next.priorityGames;
        excluded.value = next.excludedGames;
        scheduleSave();
    }
    clearSearch();
}

function removePriority(index) {
    priorities.value.splice(index, 1);
    scheduleSave();
}

function removeExcluded(index) {
    excluded.value.splice(index, 1);
    scheduleSave();
}

function toExcluded(index) {
    excludeGame(priorities.value[index]);
}

/** Keyboard reordering - drag-only would be an accessibility failure. */
function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= priorities.value.length) return;
    const [game] = priorities.value.splice(index, 1);
    priorities.value.splice(target, 0, game);
    scheduleSave();
}

/** Debounced so a fumbled drag does not fire three writes. */
function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 500);
}

async function persist() {
    saveTimer = null;
    saving.value = true;
    const patch = {
        priorityGames: priorities.value,
        excludedGames: excluded.value,
        priorityMode: priorityMode.value,
    };
    // Excluding is "never", so a game excluded here also leaves the dragged order.
    const order = store.config?.queueOrder ?? [];
    const trimmed = excluded.value.reduce((list, game) => edits.without(list, game), order);
    if (trimmed.length !== order.length) patch.queueOrder = trimmed;

    try {
        if (!(await lists.save(patch))) {
            // Back to whatever the daemon actually holds.
            refill(store.config);
        }
    } finally {
        saving.value = false;
    }
}

function refill(config) {
    if (!config) return;
    priorities.value = [...config.priorityGames];
    excluded.value = [...config.excludedGames];
    priorityMode.value = config.priorityMode ?? "ending_soonest";
}

/**
 * Every save answers with the whole config. Refilling from it while another edit was queued
 * or on its way put back what had just been changed, so the lists here are left alone until
 * nothing is pending - they already hold what was sent.
 */
watch(
    () => store.config,
    (config) => {
        if (saveTimer || saving.value) return;
        refill(config);
    },
    { immediate: true },
);

onUnmounted(() => clearTimeout(searchTimer));

/* -------------------------------------------------------------------------- */
/* What each row shows                                                         */
/* -------------------------------------------------------------------------- */

/** A Steam-driven mode is meaningless until a library has actually been fetched. */
const needsSteam = computed(() => currentMode.value?.steam && !store.hasSteamLibrary);

/** Games we know about from campaigns, active and upcoming alike. */
const knownGames = computed(() => {
    const seen = new Map();
    for (const campaign of store.campaigns) {
        if (!seen.has(campaign.game.id)) seen.set(campaign.game.id, campaign.game);
    }
    return [...seen.values()];
});

function campaignCount(game) {
    const matches = store.campaigns.filter((campaign) => matchesGame(game, campaign.game));
    const active = matches.filter((c) => c.status === "active").length;
    const upcoming = matches.filter((c) => c.status === "upcoming").length;
    if (active) return `${active} active campaign${active > 1 ? "s" : ""}`;
    if (upcoming) return `${upcoming} upcoming`;
    return "no campaigns right now";
}

/**
 * Art for a game named in a list.
 *
 * Campaigns first, because that art comes with the data already on the page. Failing that,
 * the daemon's cache: a game can sit on this list for weeks with no campaign running, and
 * before the cache existed those rows simply had no poster - the art was never missing,
 * Twitch has it, we had just never asked for the game's id.
 */
function artFor(game) {
    const known = knownGames.value.find((entry) => matchesGame(game, entry));
    if (known) {
        return known.boxArtURL ?? boxArt(known.id);
    }
    const cached = store.gameArt?.[game.trim().toLowerCase()];
    return cached ? (cached.boxArtURL ?? boxArt(cached.id)) : null;
}

/** The empty list means something different depending on what "everything else" is set to. */
const emptyNote = computed(() =>
    priorityMode.value === "priority_only"
        ? "No priorities yet, and “Nothing else” is chosen below — so nothing will be mined until you add a game."
        : `No priorities yet — everything is ordered by “${currentMode.value?.label ?? "Whatever ends soonest"}” below. Add games to put them first.`,
);

/* -------------------------------------------------------------------------- */
/* ② ③ ④ and the preview                                                      */
/* -------------------------------------------------------------------------- */

const dragged = computed(() => lists.queueOrder.value);

const libraryPolicy = computed(() => store.config?.libraryPolicy ?? "ownedOrListed");

/** Campaigns sent to the back with Next. They stay there until put back. */
const deferred = computed(() => store.campaigns.filter((campaign) => campaign.isDeferred));
const restoring = ref(false);

async function restoreDeferred() {
    restoring.value = true;
    try {
        const { restored } = await store.restoreDeferred();
        ElMessage.success(
            restored ? `Put ${restored} campaign${restored === 1 ? "" : "s"} back in the queue.` : "Nothing was skipped.",
        );
    } catch (error) {
        ElMessage.error(error.message);
    } finally {
        restoring.value = false;
    }
}

/** The real queue, current campaign included, so the layers can be checked against it. */
const PREVIEW_LENGTH = 5;
const preview = computed(() =>
    store.queue
        .slice(0, PREVIEW_LENGTH)
        .map((id) => store.campaignsById[id])
        .filter(Boolean),
);

/* -------------------------------------------------------------------------- */
/* Arriving from Campaigns' "Rank on Priorities"                               */
/* -------------------------------------------------------------------------- */

const highlighted = ref(null);
let highlightTimer = null;

async function highlight(game) {
    if (!game) return;
    const index = priorities.value.findIndex((entry) => matchesGame(entry, game));
    if (index === -1) {
        ElMessage.info(`${game} isn't on your priority list - search for it above to add it.`);
        return;
    }
    highlighted.value = priorities.value[index];
    await nextTick();
    document.getElementById(`priority-${index}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    document.getElementById(`priority-${index}`)?.focus({ preventScroll: true });
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => (highlighted.value = null), 2500);
}

// Settings may still be loading on arrival; wait for the list rather than call the game
// missing. Later saves re-run this, so it acts only when the game itself is new.
watch(
    () => [Boolean(store.config), route.query.game],
    ([loaded, game], previous) => {
        if (!loaded || !game) return;
        if (previous?.[0] && previous[1] === game) return;
        highlight(game);
    },
    { immediate: true },
);
onUnmounted(() => clearTimeout(highlightTimer));
</script>

<template>
    <div class="space-y-4">
        <header class="flex items-start justify-between gap-3">
            <div>
                <h1 class="text-[15px] font-semibold">Priorities</h1>
                <p class="text-[12px]" :style="{ color: 'var(--text-2)' }">
                    What gets mined next, decided in this order: your games, then anything you
                    dragged, then everything else. Skipped and excluded games sit apart.
                </p>
            </div>
            <span v-if="saving" class="text-[11px] shrink-0" :style="{ color: 'var(--text-2)' }">Saving&hellip;</span>
        </header>

        <div class="flex gap-2">
            <div class="relative flex-1 min-w-0">
                <input
                    v-model="query"
                    placeholder="Search any game on Twitch"
                    aria-label="Search any game on Twitch to prioritise or exclude"
                    class="w-full px-3 py-2 rounded-lg text-[12px] outline-none"
                    :style="{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }"
                    @input="onSearchInput"
                    @keyup.enter="addGame(chosenGame())"
                    @keyup.esc="clearSearch"
                />

                <ul
                    v-if="results.length"
                    class="absolute z-20 left-0 right-0 mt-1 rounded-lg overflow-hidden shadow-xl"
                    :style="{ background: 'var(--surface)', border: '1px solid var(--border)' }"
                >
                    <li
                        v-for="game in results"
                        :key="game.id"
                        class="flex items-center gap-2 px-2 py-1.5"
                        :style="{ background: 'var(--surface)' }"
                    >
                        <img
                            v-if="game.boxArtURL"
                            :src="game.boxArtURL"
                            :alt="game.name"
                            class="w-6 h-8 rounded object-cover"
                        />
                        <span class="text-[12px] truncate flex-1">{{ game.name }}</span>
                        <button
                            class="px-2 py-1 rounded text-[11px] shrink-0"
                            :style="{ background: 'var(--accent)', color: 'white' }"
                            @click="addGame(game.name)"
                        >
                            Prioritise
                        </button>
                        <button
                            class="px-2 py-1 rounded text-[11px] shrink-0"
                            :style="{ background: 'var(--surface-2)', color: 'var(--danger)' }"
                            @click="excludeGame(game.name)"
                        >
                            Exclude
                        </button>
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
                @click="addGame(chosenGame())"
            >
                Prioritise
            </button>
            <button
                class="px-3 py-2 rounded-lg text-[12px] shrink-0"
                :style="{ background: 'var(--surface-2)', color: 'var(--danger)' }"
                @click="excludeGame(chosenGame())"
            >
                Exclude
            </button>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:items-start">
            <div class="lg:col-span-7 space-y-5">
                <!-- ① The curated list. Always first: it is a statement about which games
                     matter, where everything below it is about order. -->
                <section class="space-y-2">
                    <StepHeading :step="1" title="Priority games" :band="isCompact" />
                    <p class="text-[11px]" :style="{ color: 'var(--text-2)' }">
                        Mined top to bottom; within a game, campaigns ending soonest go first.
                        Drag, use the arrows, or Ctrl+&uarr;/&darr; on a focused row.
                    </p>

                    <p v-if="!priorities.length" class="card p-6 text-center text-[12px]" :style="{ color: 'var(--muted)' }">
                        {{ emptyNote }}
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
                                :id="`priority-${index}`"
                                class="card flex items-center gap-3 p-2.5 transition-shadow"
                                :style="highlighted === game ? { boxShadow: '0 0 0 2px var(--accent)' } : {}"
                                tabindex="0"
                                aria-keyshortcuts="Control+ArrowUp Control+ArrowDown"
                                @keydown.ctrl.up.prevent="move(index, -1)"
                                @keydown.ctrl.down.prevent="move(index, 1)"
                            >
                                <!-- Rank rides on the art, as on the dashboard queue, rather than
                                     taking a column of its own. -->
                                <div class="relative shrink-0">
                                    <img
                                        v-if="artFor(game)"
                                        :src="artFor(game)"
                                        :alt="game"
                                        class="w-8 h-11 rounded object-cover"
                                        :style="{ background: 'var(--surface-2)' }"
                                    />
                                    <div v-else class="w-8 h-11 rounded" :style="{ background: 'var(--surface-2)' }" />
                                    <span
                                        class="absolute -top-1 -left-1 min-w-[16px] h-4 px-1 rounded grid place-items-center text-[10px] font-semibold text-white"
                                        :style="{ background: 'var(--accent)' }"
                                    >
                                        {{ index + 1 }}
                                    </span>
                                </div>
                                <span class="text-[13px] flex-1 truncate">{{ game }}</span>
                                <span class="text-[11px] shrink-0 hidden sm:inline" :style="{ color: 'var(--muted)' }">
                                    {{ campaignCount(game) }}
                                </span>
                                <div class="flex gap-1 shrink-0">
                                    <button class="px-1.5 text-[12px]" :style="{ color: 'var(--text-2)' }" title="Move up" :aria-label="`Move ${game} up`" @click="move(index, -1)">↑</button>
                                    <button class="px-1.5 text-[12px]" :style="{ color: 'var(--text-2)' }" title="Move down" :aria-label="`Move ${game} down`" @click="move(index, 1)">↓</button>
                                    <button class="px-1.5 text-[12px]" :style="{ color: 'var(--text-2)' }" title="Exclude" :aria-label="`Exclude ${game}`" @click="toExcluded(index)">⊘</button>
                                    <button class="px-1.5 text-[12px]" :style="{ color: 'var(--danger)' }" title="Remove" :aria-label="`Remove ${game} from priorities`" @click="removePriority(index)">×</button>
                                    <!-- Trailing, so the row reads as what it is before offering a
                                         control to move it. -->
                                    <span
                                        class="drag-handle cursor-grab select-none pl-1"
                                        :style="{ color: 'var(--muted)' }"
                                        title="Drag to reorder"
                                        aria-hidden="true"
                                    >⠿</span>
                                </div>
                            </div>
                        </template>
                    </draggable>
                </section>

                <!-- ② Drags on the dashboard's Up next. Stored apart from the list above and
                     until now visible nowhere, so an order could persist with no way to see
                     or undo it short of dragging everything back. -->
                <section class="space-y-2">
                    <StepHeading :step="2" title="Dragged on Up next" :band="isCompact">
                        <button
                            v-if="dragged.length"
                            class="px-2 py-0.5 rounded text-[11px]"
                            :style="{ background: 'var(--surface-2)', color: 'var(--text-2)' }"
                            @click="lists.resetQueueOrder()"
                        >
                            Reset
                        </button>
                    </StepHeading>
                    <p v-if="!dragged.length" class="text-[11px]" :style="{ color: 'var(--muted)' }">
                        Nothing dragged. Dragging a game on the dashboard&rsquo;s Up next puts it
                        here, ahead of everything else but behind your priority games.
                    </p>
                    <div v-else class="flex flex-wrap gap-1.5">
                        <span
                            v-for="(game, index) in dragged"
                            :key="game"
                            class="flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full text-[12px]"
                            :style="{ background: 'var(--surface-2)', color: 'var(--text)' }"
                        >
                            <span class="text-[10px] tabular pl-1" :style="{ color: 'var(--muted)' }">{{ index + 1 }}</span>
                            <img v-if="artFor(game)" :src="artFor(game)" :alt="game" class="w-4 h-5 rounded-sm object-cover" />
                            {{ game }}
                            <button
                                :style="{ color: 'var(--danger)' }"
                                :aria-label="`Take ${game} out of the dragged order`"
                                title="Leave it to the ordering below"
                                @click="lists.unorder(game)"
                            >×</button>
                        </span>
                    </div>
                </section>

                <!-- ③ The catch-all. Rendering it as a permanent row turns an abstract setting
                     into a spatial fact: everything above is ranked, this is the rest. -->
                <section class="space-y-2">
                    <StepHeading :step="3" title="Everything else" :band="isCompact" />
                    <div
                        class="rounded-[10px] p-2.5"
                        :style="{
                            border: '1px dashed var(--border)',
                            opacity: priorityMode === 'priority_only' ? 0.55 : 1,
                        }"
                    >
                        <div class="flex items-center gap-3 flex-wrap">
                            <span
                                class="w-5 h-5 rounded-full grid place-items-center text-[11px] shrink-0"
                                :style="{ border: '1px solid var(--border)', color: 'var(--text-2)' }"
                            >
                                ∞
                            </span>
                            <span class="text-[13px] flex-1">Ordered by</span>
                            <select
                                v-model="priorityMode"
                                aria-label="How everything else is ordered"
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
                        <p class="text-[11px] mt-1.5 pl-8" :style="{ color: 'var(--text-2)' }">
                            {{ currentMode?.hint }}
                        </p>
                        <p v-if="needsSteam" class="text-[11px] mt-1 pl-8" :style="{ color: 'var(--warn)' }">
                            Steam is not connected, so this falls back to whatever ends soonest.
                            <RouterLink to="/settings" class="underline">Connect Steam</RouterLink>
                        </p>
                        <p
                            v-if="priorityMode !== 'priority_only'"
                            class="text-[11px] mt-1 pl-8"
                            :style="{ color: 'var(--muted)' }"
                        >
                            <template v-if="libraryPolicy === 'ownedOrListed'">
                                Only games you own or list are mined<template v-if="!store.hasSteamLibrary">
                                    once Steam is connected &mdash; until then, every game is</template>.
                            </template>
                            <template v-else>Any game with a campaign is mined, owned or not.</template>
                            <RouterLink to="/settings" class="underline" :style="{ color: 'var(--accent)' }">
                                Library setting
                            </RouterLink>
                        </p>
                    </div>
                </section>
            </div>

            <div class="lg:col-span-5 space-y-5">
                <!-- What the layers add up to, straight from the daemon's queue, so the page
                     can be checked against what will actually happen. -->
                <section class="space-y-2">
                    <StepHeading title="The queue right now" :band="isCompact">
                        <RouterLink to="/campaigns" class="text-[11px] hover:underline normal-case" :style="{ color: 'var(--text-2)' }">
                            All {{ store.queue.length }} &rarr;
                        </RouterLink>
                    </StepHeading>
                    <p v-if="!preview.length" class="text-[11px]" :style="{ color: 'var(--muted)' }">
                        Nothing queued right now.
                    </p>
                    <ol v-else class="space-y-1">
                        <li
                            v-for="(campaign, index) in preview"
                            :key="campaign.id"
                            class="flex items-center gap-2.5 py-1.5 px-2 rounded-lg"
                            :class="isDimmed(campaign) ? 'opacity-45' : ''"
                            :style="{ background: 'var(--surface-2)' }"
                            :title="
                                campaign.isExcluded
                                    ? 'On your excluded list, so it will not be mined'
                                    : campaign.inLibraryScope
                                      ? undefined
                                      : 'Not in your Steam library or priority list, so it will not be mined'
                            "
                        >
                            <div class="relative shrink-0">
                                <img
                                    v-if="campaign.game.boxArtURL"
                                    :src="campaign.game.boxArtURL"
                                    :alt="campaign.game.name"
                                    class="w-6 h-8 rounded object-cover"
                                    :style="{ background: 'var(--surface)' }"
                                />
                                <div v-else class="w-6 h-8 rounded" :style="{ background: 'var(--surface)' }" />
                                <span
                                    class="absolute -top-1 -left-1 min-w-[14px] h-[14px] px-0.5 rounded grid place-items-center text-[9px] font-semibold"
                                    :style="
                                        campaign.inPriorities
                                            ? { background: 'var(--accent)', color: 'white' }
                                            : { background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)' }
                                    "
                                >
                                    {{ index + 1 }}
                                </span>
                            </div>
                            <div class="min-w-0 flex-1">
                                <p class="text-[12px] font-medium truncate">{{ campaign.game.name }}</p>
                                <p class="text-[11px] truncate" :style="{ color: 'var(--text-2)' }">{{ campaign.name }}</p>
                            </div>
                            <StatusChip v-if="campaign.id === store.mining?.campaignId" status="mining" small />
                        </li>
                    </ol>
                </section>

                <!-- ④ Next on the dashboard. These wait at the back until put back, and
                     nothing showed that they were there or how to undo it. -->
                <section class="space-y-2">
                    <StepHeading :step="4" title="Skipped for now" :band="isCompact">
                        <button
                            v-if="deferred.length"
                            class="px-2 py-0.5 rounded text-[11px]"
                            :style="{ background: 'var(--surface-2)', color: 'var(--text-2)' }"
                            :disabled="restoring"
                            @click="restoreDeferred"
                        >
                            Put them back
                        </button>
                    </StepHeading>
                    <p v-if="!deferred.length" class="text-[11px]" :style="{ color: 'var(--muted)' }">
                        Nothing skipped. Next on the dashboard sends a campaign here, behind
                        everything else, until you put it back.
                    </p>
                    <div v-else class="flex flex-wrap gap-1.5">
                        <span
                            v-for="campaign in deferred"
                            :key="campaign.id"
                            class="flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full text-[12px] min-w-0 max-w-full"
                            :style="{ background: 'var(--surface-2)', color: 'var(--text-2)' }"
                            :title="`${campaign.game.name} - ${campaign.name}`"
                        >
                            <img
                                v-if="campaign.game.boxArtURL"
                                :src="campaign.game.boxArtURL"
                                :alt="campaign.game.name"
                                class="w-4 h-5 rounded-sm object-cover shrink-0"
                            />
                            <span class="truncate">{{ campaign.game.name }} &middot; {{ campaign.name }}</span>
                        </span>
                    </div>
                </section>

                <!-- ⑤ Never, whatever the ordering above says. -->
                <section class="space-y-2">
                    <StepHeading :step="5" title="Excluded games" :band="isCompact" />
                    <p v-if="!excluded.length" class="text-[11px]" :style="{ color: 'var(--muted)' }">
                        Nothing excluded. Excluded games are never mined, whatever the ordering
                        says.
                    </p>
                    <div v-else class="flex flex-wrap gap-1.5">
                        <span
                            v-for="(game, index) in excluded"
                            :key="game"
                            class="flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full text-[12px]"
                            :style="{ background: 'var(--surface-2)', color: 'var(--text-2)' }"
                        >
                            <img
                                v-if="artFor(game)"
                                :src="artFor(game)"
                                :alt="game"
                                class="w-4 h-5 rounded-sm object-cover"
                            />
                            {{ game }}
                            <button
                                :style="{ color: 'var(--danger)' }"
                                :aria-label="`Stop excluding ${game}`"
                                title="Stop excluding"
                                @click="removeExcluded(index)"
                            >×</button>
                        </span>
                    </div>
                </section>
            </div>
        </div>
    </div>
</template>
