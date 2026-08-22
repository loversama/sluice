<script setup>
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";

import { useMinerStore } from "@/stores/miner.js";
import {
    formatDateTime,
    formatDuration,
    formatUntil,
    totalRemainingMinutes,
} from "@/lib/format.js";
import SegmentBar from "@/components/SegmentBar.vue";
import StatusChip from "@/components/StatusChip.vue";

const store = useMinerStore();
const route = useRoute();
const router = useRouter();

const segment = ref("active");

/**
 * Collapsed game groups, remembered per browser. A game the user has decided they do not
 * want to look at should stay shut when they come back to the page.
 */
const STORAGE_KEY = "campaigns.collapsed";
const collapsed = ref(new Set());
try {
    collapsed.value = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));
} catch {
    // Private windows and blocked site data both land here; an empty set is fine.
}

function toggleGroup(gameId) {
    const next = new Set(collapsed.value);
    if (!next.delete(gameId)) {
        next.add(gameId);
    }
    collapsed.value = next;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch {
        // Not being able to remember it is not a reason to refuse to collapse it.
    }
}

function setAll(collapse) {
    const next = collapse ? new Set(groups.value.map((group) => group[0].game.id)) : new Set();
    collapsed.value = next;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch {
        /* ignore */
    }
}
const search = ref("");
const unlinkedOnly = ref(false);
const prioritiesOnly = ref(false);

const pools = computed(() => ({
    active: store.activeCampaigns,
    upcoming: store.upcomingCampaigns,
    completed: store.completedCampaigns,
}));

const filtered = computed(() => {
    const term = search.value.trim().toLowerCase();
    return pools.value[segment.value].filter((campaign) => {
        if (unlinkedOnly.value && campaign.isAccountLinked) return false;
        if (prioritiesOnly.value && !campaign.inPriorities) return false;
        if (!term) return true;
        return (
            campaign.name.toLowerCase().includes(term) ||
            campaign.game.name.toLowerCase().includes(term)
        );
    });
});

/** Grouped by game because users think "what's the Rust stuff", not campaign-by-campaign. */
const groups = computed(() => {
    const byGame = new Map();
    for (const campaign of filtered.value) {
        const list = byGame.get(campaign.game.id) ?? [];
        list.push(campaign);
        byGame.set(campaign.game.id, list);
    }
    // Order by the miner's real queue, so this page and the Dashboard cannot disagree
    // about what comes next. Anything not queued (upcoming, completed) falls back to name.
    const queueIndex = new Map(store.queue.map((id, index) => [id, index]));
    const best = (group) =>
        Math.min(...group.map((c) => queueIndex.get(c.id) ?? Number.MAX_SAFE_INTEGER));
    return [...byGame.values()].sort((a, b) => {
        const delta = best(a) - best(b);
        if (delta !== 0 && Number.isFinite(delta)) return delta;
        return a[0].game.name.localeCompare(b[0].game.name);
    });
});

const selected = computed(() =>
    route.params.id ? store.campaignsById[route.params.id] ?? null : null,
);
const drawerOpen = computed({
    get: () => Boolean(selected.value),
    set: (open) => {
        if (!open) router.push("/campaigns");
    },
});

function open(campaign) {
    router.push(`/campaigns/${campaign.id}`);
}

/** The drop's display state, ordered so the most important reason wins. */
function dropState(drop, campaign) {
    if (drop.isClaimed) return "claimed";
    if (drop.preconditionIds.some((id) => !campaign.drops.find((d) => d.id === id)?.isClaimed)) {
        return "locked";
    }
    if (drop.isClaimable) return "claimable";
    if (new Date(drop.endAt) < new Date()) return "missed";
    return null;
}

function preconditionName(drop, campaign) {
    const blocker = drop.preconditionIds
        .map((id) => campaign.drops.find((entry) => entry.id === id))
        .find((entry) => entry && !entry.isClaimed);
    return blocker?.name ?? "an earlier drop";
}

async function exclude(campaign) {
    const games = [...(store.config?.excludedGames ?? [])];
    if (!games.some((g) => g.toLowerCase() === campaign.game.name.toLowerCase())) {
        games.push(campaign.game.name);
    }
    const priorities = (store.config?.priorityGames ?? []).filter(
        (g) => g.toLowerCase() !== campaign.game.name.toLowerCase(),
    );
    await store.saveConfig({ excludedGames: games, priorityGames: priorities });
    ElMessage.success(`${campaign.game.name} excluded.`);
}

async function prioritise(campaign) {
    const games = [...(store.config?.priorityGames ?? [])];
    if (games.includes(campaign.game.name)) {
        ElMessage.info(`${campaign.game.name} is already in your priorities.`);
        return;
    }
    games.push(campaign.game.name);
    const excluded = (store.config?.excludedGames ?? []).filter(
        (game) => game.toLowerCase() !== campaign.game.name.toLowerCase(),
    );
    await store.saveConfig({ priorityGames: games, excludedGames: excluded });
    ElMessage.success(`${campaign.game.name} added to priorities.`);
}

watch(
    () => store.config,
    (config) => {
        if (!config) store.loadConfig();
    },
    { immediate: true },
);
</script>

<template>
    <div class="space-y-4">
        <!-- One surface for the whole toolbar, so the controls read as a group rather
             than as loose items floating above the list. -->
        <!-- Sticky: with over a hundred campaigns the filters are otherwise scrolled
             away exactly when they become useful. -->
        <header class="card p-2 flex flex-wrap items-center gap-2 sticky top-0 z-10">
            <div class="flex rounded-lg overflow-hidden shrink-0" :style="{ background: 'var(--surface-2)' }">
                <button
                    v-for="key in ['active', 'upcoming', 'completed']"
                    :key="key"
                    class="px-3 py-1.5 text-[12px] capitalize transition-colors"
                    :style="{
                        background: segment === key ? 'var(--accent)' : 'transparent',
                        color: segment === key ? 'white' : 'var(--text-2)',
                    }"
                    @click="segment = key"
                >
                    {{ key }}
                    <span class="tabular opacity-70">{{ pools[key].length }}</span>
                </button>
            </div>

            <div class="relative flex-1 min-w-[180px]">
                <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-[12px]" :style="{ color: 'var(--muted)' }">
                    &#9906;
                </span>
                <input
                    v-model="search"
                    type="search"
                    placeholder="Search game or campaign"
                    class="w-full pl-7 pr-3 py-1.5 rounded-lg text-[12px] outline-none"
                    :style="{ background: 'var(--surface-2)', border: '1px solid transparent', color: 'var(--text)' }"
                />
            </div>

            <!-- Filters as toggles rather than native checkboxes: these are on/off states
                 the eye should be able to read at a glance, and a platform checkbox is a
                 pale square that ignores the theme entirely. -->
            <button
                v-for="filter in [
                    { key: 'unlinked', label: 'Unlinked only', on: unlinkedOnly },
                    { key: 'priorities', label: 'My priorities', on: prioritiesOnly },
                ]"
                :key="filter.key"
                class="px-2.5 py-1.5 rounded-lg text-[12px] transition-colors flex items-center gap-1.5 shrink-0"
                :style="
                    filter.on
                        ? { background: 'color-mix(in srgb, var(--accent) 18%, transparent)', color: 'var(--accent)' }
                        : { background: 'var(--surface-2)', color: 'var(--text-2)' }
                "
                @click="filter.key === 'unlinked' ? (unlinkedOnly = !unlinkedOnly) : (prioritiesOnly = !prioritiesOnly)"
            >
                <span class="text-[10px]">{{ filter.on ? "\u2713" : "\u25CB" }}</span>
                {{ filter.label }}
            </button>

            <button
                v-if="groups.length"
                class="px-2.5 py-1.5 rounded-lg text-[12px] shrink-0"
                :style="{ background: 'var(--surface-2)', color: 'var(--text-2)' }"
                @click="setAll(collapsed.size < groups.length)"
            >
                {{ collapsed.size < groups.length ? "Collapse all" : "Expand all" }}
            </button>
        </header>

        <p v-if="!groups.length" class="card p-8 text-center text-[12px]" :style="{ color: 'var(--muted)' }">
            <template v-if="search">
                No matches for &ldquo;{{ search }}&rdquo;.
                <button class="underline ml-1" @click="search = ''">Clear search</button>
            </template>
            <template v-else-if="segment === 'upcoming'">
                Nothing announced yet &mdash; check back after the next refresh.
            </template>
            <template v-else-if="segment === 'completed'">Nothing completed yet.</template>
            <template v-else>No active campaigns match your filters.</template>
        </p>

        <section v-for="group in groups" :key="group[0].game.id" class="space-y-1.5">
            <!-- The whole header is the control: a games list is long, and reaching for
                 a small chevron on every row is worse than a large target. -->
            <button
                class="flex items-center gap-2.5 px-2 py-1.5 w-full text-left rounded-lg transition-colors hover:brightness-125"
                :style="{ background: 'var(--surface)' }"
                @click="toggleGroup(group[0].game.id)"
            >
                <span
                    class="text-[11px] w-3 shrink-0 transition-transform"
                    :style="{
                        color: 'var(--text-2)',
                        transform: collapsed.has(group[0].game.id) ? 'rotate(-90deg)' : 'none',
                    }"
                >&#9662;</span>
                <img
                    v-if="group[0].game.boxArtURL"
                    :src="group[0].game.boxArtURL"
                    :alt="group[0].game.name"
                    class="w-8 h-10 rounded object-cover"
                />
                <h2 class="text-[13px] font-semibold">{{ group[0].game.name }}</h2>
                <span
                    v-if="group[0].inPriorities"
                    class="text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
                    :style="{ background: 'var(--accent)', color: 'white' }"
                >
                    #{{ group[0].priorityRank + 1 }}
                </span>
                <StatusChip v-if="group[0].isExcluded" status="excluded" small />
                <span class="text-[11px] ml-auto" :style="{ color: 'var(--muted)' }">
                    {{ group.length }} campaign{{ group.length === 1 ? "" : "s" }}
                </span>
            </button>

            <button
                v-for="campaign in (collapsed.has(group[0].game.id) ? [] : group)"
                :key="campaign.id"
                class="card w-full text-left p-3 flex items-center gap-4 hover:brightness-110 transition ml-3"
                :style="
                    campaign.id === store.mining?.campaignId
                        ? { borderLeft: '3px solid var(--accent)' }
                        : {}
                "
                :class="campaign.isCompleted ? 'opacity-70' : ''"
                @click="open(campaign)"
            >
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                        <p class="text-[13px] font-medium truncate">{{ campaign.name }}</p>
                        <StatusChip
                            v-if="campaign.id === store.mining?.campaignId"
                            status="mining"
                            small
                        />
                        <StatusChip
                            v-if="!campaign.isAccountLinked"
                            status="unlinked"
                            small
                            :href="campaign.accountLinkUrl"
                        />
                        <StatusChip v-if="campaign.allowedChannels.length" status="restricted" small />
                    </div>
                    <p class="text-[11px] mt-0.5" :style="{ color: 'var(--text-2)' }">
                        {{ campaign.drops.length }} drops &middot;
                        {{ formatDuration(campaign.drops.reduce((sum, d) => sum + d.requiredMinutes, 0)) }} total
                    </p>
                </div>

                <div class="w-[180px] hidden sm:block">
                    <SegmentBar :drops="campaign.drops" />
                </div>

                <div class="text-right shrink-0 w-[150px]">
                    <template v-if="campaign.status === 'upcoming'">
                        <p class="text-[12px] tabular">starts {{ formatUntil(campaign.startAt) }}</p>
                        <p class="text-[11px]" :style="{ color: 'var(--muted)' }">
                            {{ formatDateTime(campaign.startAt) }}
                        </p>
                    </template>
                    <template v-else-if="campaign.isCompleted">
                        <StatusChip status="completed" small />
                    </template>
                    <template v-else>
                        <p class="text-[12px] tabular">
                            {{ formatDuration(totalRemainingMinutes(campaign)) }} left
                        </p>
                        <p class="text-[11px] tabular" :style="{ color: 'var(--muted)' }">
                            ends {{ formatUntil(campaign.endAt) }}
                        </p>
                    </template>
                </div>
            </button>

            <!-- Upcoming campaigns are only useful if they say whether the bot will act. -->
            <p
                v-for="campaign in (collapsed.has(group[0].game.id) ? [] : group.filter((c) => c.status === 'upcoming' && !c.inPriorities && !c.isExcluded))"
                :key="`${campaign.id}-hint`"
                class="text-[11px] px-3 pb-1 ml-3"
                :style="{ color: 'var(--text-2)' }"
            >
                Will be mined only because &ldquo;everything else&rdquo; is on.
                <button class="underline" @click="prioritise(campaign)">
                    Add {{ campaign.game.name }} to priorities
                </button>
            </p>
        </section>

        <el-drawer v-model="drawerOpen" :size="480" :with-header="false">
            <div v-if="selected" class="space-y-4 text-[13px]">
                <header class="flex items-start gap-3">
                    <img
                        v-if="selected.game.boxArtURL"
                        :src="selected.game.boxArtURL"
                        :alt="selected.game.name"
                        class="w-14 h-[74px] rounded object-cover"
                    />
                    <div class="min-w-0">
                        <h2 class="text-[15px] font-semibold">{{ selected.name }}</h2>
                        <p class="text-[12px]" :style="{ color: 'var(--text-2)' }">
                            {{ selected.game.name }}
                        </p>
                        <div class="flex gap-1.5 mt-2 flex-wrap">
                            <StatusChip :status="selected.isCompleted ? 'completed' : selected.status" small />
                            <StatusChip
                                v-if="!selected.isAccountLinked"
                                status="unlinked"
                                small
                                :href="selected.accountLinkUrl"
                            />
                        </div>
                    </div>
                </header>

                <p class="text-[11px] tabular" :style="{ color: 'var(--text-2)' }">
                    {{ formatDateTime(selected.startAt) }} &rarr; {{ formatDateTime(selected.endAt) }}
                </p>

                <!-- Unlinked accounts are the quietest way to lose rewards, so this is loud. -->
                <div
                    v-if="!selected.isAccountLinked"
                    class="rounded-lg p-3"
                    :style="{
                        background: 'color-mix(in srgb, var(--warn) 12%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--warn) 40%, transparent)',
                    }"
                >
                    <p class="font-medium" :style="{ color: 'var(--warn)' }">
                        Rewards will not arrive in-game
                    </p>
                    <p class="text-[12px] mt-1" :style="{ color: 'var(--text-2)' }">
                        Progress is still tracked, but your Twitch account is not linked to the
                        publisher. Link it on Twitch, then rewards from this campaign will apply.
                    </p>
                    <a
                        href="https://www.twitch.tv/drops/campaigns"
                        target="_blank"
                        rel="noreferrer"
                        class="text-[12px] underline mt-1 inline-block"
                        :style="{ color: 'var(--warn)' }"
                    >
                        Open Twitch drop campaigns
                    </a>
                </div>

                <section>
                    <h3 class="text-[11px] uppercase tracking-wider mb-2" :style="{ color: 'var(--text-2)' }">
                        Drops
                    </h3>
                    <ul class="space-y-2">
                        <li
                            v-for="drop in selected.drops"
                            :key="drop.id"
                            class="rounded-lg p-2.5 flex gap-3"
                            :style="{ background: 'var(--surface-2)' }"
                        >
                            <img
                                v-if="drop.rewards[0]?.imageURL"
                                :src="drop.rewards[0].imageURL"
                                :alt="drop.name"
                                class="w-11 h-11 rounded object-cover shrink-0"
                            />
                            <div class="min-w-0 flex-1">
                                <div class="flex items-center gap-2">
                                    <p class="text-[12px] font-medium truncate">
                                        {{ drop.rewards.map((r) => r.name).join(", ") || drop.name }}
                                    </p>
                                    <StatusChip
                                        v-if="dropState(drop, selected)"
                                        :status="dropState(drop, selected)"
                                        small
                                    />
                                </div>
                                <div class="flex items-center gap-2 mt-1.5">
                                    <div
                                        class="flex-1 h-1.5 rounded-full overflow-hidden"
                                        :style="{ background: 'var(--surface)' }"
                                    >
                                        <div
                                            class="h-full rounded-full"
                                            :style="{
                                                width: `${Math.min(100, (drop.currentMinutes / drop.requiredMinutes) * 100)}%`,
                                                background: drop.isClaimed ? 'var(--success)' : 'var(--accent)',
                                            }"
                                        />
                                    </div>
                                    <span class="tabular font-mono text-[11px]" :style="{ color: 'var(--text-2)' }">
                                        {{ drop.currentMinutes }}/{{ drop.requiredMinutes }} min
                                    </span>
                                </div>
                                <p
                                    v-if="dropState(drop, selected) === 'locked'"
                                    class="text-[11px] mt-1"
                                    :style="{ color: 'var(--muted)' }"
                                >
                                    Requires {{ preconditionName(drop, selected) }} first.
                                </p>
                            </div>
                        </li>
                    </ul>
                </section>

                <section>
                    <h3 class="text-[11px] uppercase tracking-wider mb-2" :style="{ color: 'var(--text-2)' }">
                        Eligible channels
                    </h3>
                    <p v-if="!selected.allowedChannels.length" class="text-[12px]" :style="{ color: 'var(--text-2)' }">
                        Any drops-enabled channel streaming {{ selected.game.name }}.
                    </p>
                    <div v-else class="flex flex-wrap gap-1.5">
                        <a
                            v-for="login in selected.allowedChannels"
                            :key="login"
                            :href="`https://twitch.tv/${login}`"
                            target="_blank"
                            rel="noreferrer"
                            class="px-2 py-1 rounded text-[11px] hover:underline"
                            :style="{ background: 'var(--surface-2)', color: 'var(--accent)' }"
                        >
                            {{ login }}
                        </a>
                    </div>
                </section>

                <footer class="pt-3" :style="{ borderTop: '1px solid var(--border)' }">
                    <div class="flex items-center gap-2">
                        <button
                            class="px-3 py-1.5 rounded-lg text-[12px]"
                            :style="{ background: 'var(--accent)', color: 'white' }"
                            @click="prioritise(selected)"
                        >
                            Prioritise {{ selected.game.name }}
                        </button>
                        <!-- The action people reach for when they see a campaign they will
                             never want; previously only the positive one existed. -->
                        <button
                            class="px-3 py-1.5 rounded-lg text-[12px]"
                            :style="{ background: 'var(--surface-2)', color: 'var(--danger)' }"
                            @click="exclude(selected)"
                        >
                            Never mine this game
                        </button>
                    </div>
                </footer>
            </div>
        </el-drawer>
    </div>
</template>
