<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import draggable from "vuedraggable";

import { useMinerStore } from "@/stores/miner.js";
import { useViewport } from "@/lib/viewport.js";
import { formatRelative } from "@/lib/format.js";
import { nextPriorityGames } from "@/lib/ranking.js";
import { supportsAnonymousEmbed } from "@/lib/embed.js";
import Skeleton from "@/components/Skeleton.vue";
import StreamPreview from "@/components/StreamPreview.vue";

/**
 * The dashboard for a window narrow enough to sit down the side of a screen.
 *
 * Laid out as one column of full-bleed bands rather than a stack of cards: at 350px the
 * card gutters were costing about a fifth of the width to say nothing. The whole thing is
 * sized to the window - the two lists share whatever is left after the header and the
 * stream, and scroll inside themselves - so the window itself never grows a scrollbar.
 */
const store = useMinerStore();

const channel = computed(() => store.mining?.channel ?? null);
const drop = computed(() => store.currentDrop);
const campaign = computed(() => store.currentCampaign);

const progress = computed(() => {
    const d = drop.value;
    if (!d?.requiredMinutes) return 0;
    return Math.min(100, Math.round((d.currentMinutes / d.requiredMinutes) * 100));
});

const claims = computed(() => store.claims);

/** Minutes left on the current drop, which is the number people actually watch. */
const remaining = computed(() => {
    const d = drop.value;
    if (!d?.requiredMinutes) return null;
    return Math.max(0, d.requiredMinutes - d.currentMinutes);
});

const stats = computed(() => store.stats ?? null);

/**
 * True while the first snapshot is still on its way. Signing in and fetching campaigns can
 * take ten seconds, and "nothing being mined" is a lie during that window - it is not that
 * there is nothing, it is that we do not know yet.
 */
const loading = computed(() => !store.loaded);

/* -------------------------------------------------------------------------- */
/* Status colour                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The header carries its state as a colour as well as a word, so a glance at the edge of
 * the screen is enough. Mixed into the surface rather than used neat: this sits behind
 * body text and runs for hours, so it has to stay furniture.
 */
const tone = computed(() => {
    if (loading.value) return { label: null, colour: "var(--text-2)" };
    if (store.daemon?.paused) return { label: "Paused", colour: "var(--warn)" };
    if (store.isStalled) return { label: "Quiet", colour: "var(--warn)" };
    if (channel.value) return { label: null, colour: "var(--accent)" };
    return { label: null, colour: "var(--text-2)" };
});

const heroStyle = computed(() => ({
    background: `color-mix(in srgb, ${tone.value.colour} 14%, var(--surface))`,
    transition: "background 400ms ease",
}));

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

const { height: windowHeight } = useViewport();

/**
 * Below this there is not enough room for the stream and two useful lists, and the stream
 * is the part you can afford to lose - it is a nice-to-have next to knowing what is queued.
 */
const PREVIEW_NEEDS = 640;

/**
 * Null until the user says otherwise, and then it wins at every size. Auto-hiding is there
 * so a window dragged short does something sensible on its own, not to overrule someone who
 * has already told us what they want.
 */
const previewChoice = ref(localStorage.getItem("sluice.preview"));

const showPreview = computed(() =>
    previewChoice.value ? previewChoice.value === "shown" : windowHeight.value >= PREVIEW_NEEDS,
);

function togglePreview() {
    previewChoice.value = showPreview.value ? "hidden" : "shown";
    localStorage.setItem("sluice.preview", previewChoice.value);
}

/** Compact never falls back to the thumbnail while the player is allowed. */
const playing = ref(true);

const live = computed(() => store.allowStreamEmbed);

/**
 * The player only ever runs signed out, which this engine has to be able to do. Where it
 * cannot, the choice is withdrawn rather than silently downgraded - a credentialed player
 * would open a second watch session and can stall the miner.
 */
const anonymous = supportsAnonymousEmbed();

async function setLive(value) {
    if (value === store.allowStreamEmbed || (value && !anonymous)) return;

    try {
        await store.saveConfig({ allowStreamEmbed: value });
        store.allowStreamEmbed = value;
        playing.value = true;
    } catch (error) {
        ElMessage.error(error.message);
    }
}

/* -------------------------------------------------------------------------- */
/* The queue, and what dragging it means                                       */
/* -------------------------------------------------------------------------- */

/**
 * A local copy of the queue, so a drag has something to write to.
 *
 * The queue itself is computed by the daemon and arrives read-only on every snapshot; the
 * only durable way to hold an order is the priority list. So this mirrors the queue until
 * the user drags, and then briefly holds their arrangement while it is persisted.
 */
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
        campaign.value?.game?.name ?? channel.value?.game ?? null,
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
</script>

<template>
    <!--
        Sized to the window, so in normal use nothing here scrolls but the two lists. The
        root is auto rather than hidden purely as a floor: the thin window can be dragged to
        420px, where the header and the stream alone nearly fill it, and clipping the lists
        out of existence would be a worse answer than one scrollbar.
    -->
    <div class="flex-1 min-h-0 flex flex-col overflow-y-auto scroll-thin">
        <!-- Now mining. Tinted by state, so the header reads at a glance. -->
        <section class="shrink-0" :style="heroStyle">
            <div class="px-3 pt-2.5 pb-2">
                <div class="flex items-center justify-between gap-2 mb-1">
                    <span class="text-[10px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                        Now mining
                    </span>
                    <span
                        v-if="tone.label"
                        class="text-[10px] px-1.5 py-0.5 rounded"
                        :style="{ background: 'var(--surface-2)', color: tone.colour }"
                        :title="tone.label === 'Quiet' ? 'Progress has gone quiet. The miner recovers on its own.' : undefined"
                    >
                        {{ tone.label }}
                    </span>
                </div>

                <template v-if="channel">
                    <p class="text-[15px] font-semibold leading-tight truncate">{{ channel.game }}</p>
                    <p class="text-[11px] truncate" :style="{ color: 'var(--text-2)' }">
                        {{ channel.displayName }}<template v-if="drop"> &middot; {{ drop.name }}</template>
                    </p>

                    <div v-if="drop" class="flex items-baseline justify-between gap-2 mt-1.5">
                        <span class="text-[11px] font-medium" :style="{ color: remaining === 0 ? 'var(--accent)' : 'var(--text-2)' }">
                            {{ remaining === 0 ? "Ready to claim" : `${remaining} min left` }}
                        </span>
                        <span class="text-[11px] tabular shrink-0" :style="{ color: 'var(--text-2)' }">
                            {{ drop.currentMinutes }}/{{ drop.requiredMinutes }}m &middot; {{ progress }}%
                        </span>
                    </div>

                    <p v-if="campaign && !campaign.isDeliverable" class="text-[10px] mt-1" :style="{ color: 'var(--warn)' }">
                        Not linked &mdash; the reward will not reach the game.
                    </p>
                </template>

                <template v-else-if="loading">
                    <Skeleton width="60%" height="15px" />
                    <Skeleton width="40%" height="10px" class="mt-1.5" />
                    <p class="text-[10px] mt-2" :style="{ color: 'var(--muted)' }">
                        Connecting to Twitch&hellip;
                    </p>
                </template>

                <p v-else class="text-[12px] py-1" :style="{ color: 'var(--text-2)' }">
                    Nothing being mined right now.
                </p>
            </div>

            <!-- Edge to edge and deliberately heavy: this is the one number the window
                 exists to report, and at 3px it was losing the argument with the
                 screenshot underneath it. -->
            <div class="h-[7px]" :style="{ background: 'color-mix(in srgb, var(--bg) 55%, transparent)' }">
                <div
                    v-if="drop"
                    class="h-full transition-[width] duration-700"
                    :style="{
                        width: `${progress}%`,
                        background: tone.colour,
                        boxShadow: `0 0 10px color-mix(in srgb, ${tone.colour} 70%, transparent)`,
                    }"
                />
            </div>
        </section>

        <!-- Preview. Labelled like the other bands, and carrying its own controls. -->
        <div
            v-if="channel || loading"
            class="shrink-0 flex items-center gap-2 px-3 py-1.5"
            :style="{ background: 'var(--surface-2)' }"
        >
            <span class="text-[10px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                Preview
            </span>
            <div class="ml-auto flex items-center gap-1">
                <button
                    v-for="option in [{ value: false, label: 'Image' }, { value: true, label: 'Live' }]"
                    :key="option.label"
                    class="text-[10px] px-1.5 py-0.5 rounded"
                    :style="
                        live === option.value
                            ? { background: 'var(--surface)', color: 'var(--text)' }
                            : { color: 'var(--muted)', opacity: option.value && !anonymous ? 0.4 : 1 }
                    "
                    :disabled="option.value && !anonymous"
                    :title="
                        option.value
                            ? anonymous
                                ? 'Play the stream here, muted, signed out. Does not touch your Twitch session.'
                                : 'This browser cannot embed the player signed out, so it is not offered.'
                            : 'Thumbnail from Twitch, refreshed every 30s. No watch session.'
                    "
                    @click="setLive(option.value)"
                >
                    {{ option.label }}
                </button>
                <button
                    class="text-[10px] pl-1.5"
                    :style="{ color: 'var(--muted)' }"
                    :title="showPreview ? 'Hide the stream to give the lists more room' : 'Show the stream'"
                    @click="togglePreview"
                >
                    {{ showPreview ? "Hide" : "Show" }}
                </button>
            </div>
        </div>

        <template v-if="showPreview">
            <StreamPreview
                v-if="channel"
                :key="channel.login"
                v-model:playing="playing"
                :channel="channel"
                compact
                class="shrink-0 max-h-[30vh]"
            />
            <div v-else-if="loading" class="shrink-0 aspect-video max-h-[30vh] skeleton" />
        </template>

        <!-- Recently claimed. The reason any of this is running, so it leads. -->
        <div class="shrink-0 flex items-center gap-2 px-3 py-1.5" :style="{ background: 'var(--surface-2)' }">
            <span class="text-[10px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                Recently claimed
            </span>
            <span v-if="claims.length" class="text-[10px] tabular" :style="{ color: 'var(--muted)' }">
                {{ claims.length }}
            </span>
        </div>

        <div class="flex-1 min-h-[56px] overflow-y-auto scroll-thin px-3 py-2">
            <ul v-if="claims.length" class="flex flex-col gap-2">
                <li v-for="claim in claims" :key="`${claim.dropId}-${claim.at}`" class="flex items-center gap-2 min-w-0">
                    <img
                        v-if="claim.rewardImageURL"
                        :src="claim.rewardImageURL"
                        alt=""
                        class="w-6 h-6 rounded object-cover shrink-0"
                        loading="lazy"
                    />
                    <div class="min-w-0 flex-1">
                        <p class="text-[12px] truncate leading-tight">{{ claim.dropName }}</p>
                        <p class="text-[10px] truncate" :style="{ color: 'var(--text-2)' }">
                            {{ claim.gameName }}
                        </p>
                    </div>
                    <span class="text-[10px] shrink-0 tabular" :style="{ color: 'var(--muted)' }">
                        {{ formatRelative(claim.at) }}
                    </span>
                </li>
            </ul>
            <div v-else-if="loading" class="flex flex-col gap-2.5">
                <div v-for="n in 3" :key="n" class="flex items-center gap-2">
                    <Skeleton width="24px" height="24px" />
                    <div class="flex-1 flex flex-col gap-1">
                        <Skeleton :width="`${75 - n * 8}%`" height="10px" />
                        <Skeleton :width="`${50 - n * 6}%`" height="8px" />
                    </div>
                </div>
            </div>
            <p v-else class="text-[12px]" :style="{ color: 'var(--text-2)' }">No drops claimed yet.</p>
        </div>

        <!-- Up next. -->
        <div class="shrink-0 flex items-center gap-2 px-3 py-1.5" :style="{ background: 'var(--surface-2)' }">
            <span class="text-[10px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                Up next
            </span>
            <span v-if="order.length" class="text-[10px] tabular" :style="{ color: 'var(--muted)' }">
                {{ order.length }}
            </span>
            <span
                v-if="order.length"
                class="text-[10px] ml-auto"
                :style="{ color: 'var(--muted)' }"
                title="Dragging pins the game in your priority list. Whatever is mining now stays first."
            >
                {{ saving ? "Saving…" : "Drag to rank" }}
            </span>
        </div>

        <div class="flex-1 min-h-[56px] overflow-y-auto scroll-thin px-3 py-2">
            <draggable
                v-if="order.length"
                v-model="order"
                item-key="id"
                handle=".drag-handle"
                :animation="150"
                class="flex flex-col gap-1"
                @end="onReorder"
            >
                <template #item="{ element: item, index }">
                    <div
                        class="flex items-center gap-2 py-1.5 px-1.5 rounded-lg"
                        :style="{ background: 'var(--surface)' }"
                        tabindex="0"
                        @keydown.ctrl.up.prevent="move(index, -1)"
                        @keydown.ctrl.down.prevent="move(index, 1)"
                    >
                        <span
                            class="drag-handle cursor-grab select-none text-[12px] shrink-0"
                            :style="{ color: 'var(--muted)' }"
                        >&#10287;</span>

                        <!-- Rank rides on the art, as on the full dashboard, rather than
                             taking a column of its own. -->
                        <div class="relative shrink-0">
                            <img
                                v-if="item.game.boxArtURL"
                                :src="item.game.boxArtURL"
                                :alt="item.game.name"
                                class="w-7 h-9 rounded object-cover"
                                :style="{ background: 'var(--surface-2)' }"
                                loading="lazy"
                            />
                            <div v-else class="w-7 h-9 rounded" :style="{ background: 'var(--surface-2)' }" />
                            <span
                                class="absolute -top-1 -left-1 min-w-[15px] h-[15px] px-1 rounded grid place-items-center text-[9px] font-semibold"
                                :style="
                                    item.inPriorities
                                        ? { background: 'var(--accent)', color: 'white' }
                                        : { background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-2)' }
                                "
                                :title="item.inPriorities ? 'In your priority list' : 'Not pinned - drag to pin it'"
                            >
                                {{ index + 1 }}
                            </span>
                        </div>

                        <div class="min-w-0 flex-1">
                            <p class="text-[12px] truncate leading-tight">{{ item.game.name }}</p>
                            <p class="text-[10px] truncate" :style="{ color: 'var(--text-2)' }">
                                {{ item.name }}
                            </p>
                        </div>

                        <span
                            v-if="!item.isDeliverable"
                            class="text-[9px] shrink-0"
                            :style="{ color: 'var(--warn)' }"
                            title="Account not linked"
                        >&#9675;</span>
                    </div>
                </template>
            </draggable>

            <div v-else-if="loading" class="flex flex-col gap-2">
                <div v-for="n in 3" :key="n" class="flex items-center gap-2">
                    <Skeleton width="28px" height="36px" />
                    <div class="flex-1 flex flex-col gap-1">
                        <Skeleton :width="`${75 - n * 8}%`" height="10px" />
                        <Skeleton :width="`${50 - n * 6}%`" height="8px" />
                    </div>
                </div>
            </div>

            <p v-else class="text-[12px]" :style="{ color: 'var(--text-2)' }">Nothing queued.</p>
        </div>

        <!-- Totals. One line, because at this width a stat grid is just noise. -->
        <div
            class="shrink-0 flex items-center justify-between px-3 py-1.5 text-[10px]"
            :style="{ borderTop: '1px solid var(--border)', color: 'var(--text-2)' }"
        >
            <template v-if="loading">
                <Skeleton v-for="n in 3" :key="n" width="52px" height="9px" />
            </template>
            <template v-else-if="stats">
                <span>{{ stats.dropsAllTime }} drops</span>
                <span>{{ stats.campaignsCompleted }} campaigns</span>
                <span>{{ Math.round(stats.minutesEarned / 60) }}h mined</span>
            </template>
        </div>
    </div>
</template>
