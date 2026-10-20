<script setup>
import { computed } from "vue";

import { useMinerStore } from "@/stores/miner.js";
import BrandMark from "@/components/BrandMark.vue";
import draggable from "vuedraggable";
import { useQueueOrder } from "@/composables/useQueueOrder.js";
import { formatDuration, formatRelative, formatUntil, totalRemainingMinutes } from "@/lib/format.js";
import NowMining from "@/components/NowMining.vue";
import LiveChannel from "@/components/LiveChannel.vue";
import TierLadder from "@/components/TierLadder.vue";
import EventFeed from "@/components/EventFeed.vue";
import StatusChip from "@/components/StatusChip.vue";

const store = useMinerStore();

/** Max five, since this is a preview of the queue rather than the full list. */
const { order, saving, dragging, onReorder, move } = useQueueOrder();

/** The queue as the daemon sees it, for the count; `order` is what is rendered. */
/**
 * Watched time, split so the minutes can be dropped when the column is too narrow to hold
 * them on one line.
 */
const watchedHours = computed(() => `${Math.floor((store.stats?.minutesEarned ?? 0) / 60)}h`);
const watchedMinutes = computed(() => {
    const minutes = (store.stats?.minutesEarned ?? 0) % 60;
    return minutes ? ` ${minutes}m` : "";
});

const queue = computed(() => store.upNext);

/**
 * Campaigns the ranking puts in the queue but the policy will not let it mine.
 *
 * They stay visible, because knowing a campaign exists and is being passed over is useful,
 * but they are dimmed, counted, and ranked below everything that will actually be mined.
 * They used to be left wherever the ordering happened to put them, which stranded rows that
 * were genuinely next below rows that were never going to be touched.
 */
const skipped = computed(
    () => queue.value.filter((campaign) => !campaign.inLibraryScope || campaign.isExcluded).length,
);

/**
 * How many of the queue will actually be mined.
 *
 * The count used to be the whole list, dimmed rows included, so a queue of a hundred and
 * seven campaigns none of which the policy allowed still read as "107 queued" - a number
 * that looked like plenty of work and meant none. Shown as a fraction only when some are
 * being passed over, since "107/107" is just noise.
 */
const mineable = computed(() => queue.value.length - skipped.value);

const limitedToOwned = computed(() => store.config?.libraryPolicy === "ownedOrListed");

const claims = computed(() => store.claims);

/** Of the time invested, how much went to campaigns that can actually pay out. */
const deliverableShare = computed(() => {
    const stats = store.stats;
    if (!stats) return null;
    const known = stats.deliverableMinutes + stats.wastedMinutes;
    if (!known) return null;
    return {
        percent: Math.round((stats.deliverableMinutes / known) * 100),
        deliverable: stats.deliverableMinutes,
        wasted: stats.wastedMinutes,
    };
});
</script>

<template>
    <div class="space-y-4">
        <!-- Outside the centred wrapper on purpose: the banner spans the window. -->
        <NowMining />

        <!-- Centring returns here, so only the banner is full width. -->
        <!-- A fixed row height on wide screens so the three columns end level; each
             panel scrolls inside itself rather than stretching the row. -->
        <!--
            Three equal-height columns on wide screens. The row is pinned to minmax(0,1fr)
            rather than left as auto: a fixed height on the grid alone does not constrain an
            auto row, so h-full would resolve against the content and the panels would run to
            thousands of pixels instead of scrolling.
        -->
        <div
            class="grid grid-cols-1 lg:grid-cols-12 gap-4 max-w-[1800px] mx-auto
                   xl:h-[calc(100vh-34rem)] xl:min-h-[320px] xl:max-h-[880px]
                   xl:grid-rows-[minmax(0,1fr)] xl:items-stretch"
        >
            <!-- Showing the real queue is the strongest trust signal a bot UI has: the user
                 can see exactly why the miner will do what it does next. -->
            <section class="card p-3 lg:col-span-7 xl:col-span-4 flex flex-col min-h-0 max-h-[560px] xl:max-h-none">
                <header class="flex items-center justify-between mb-3">
                    <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                        Up next
                    </h2>
                    <RouterLink to="/campaigns" class="text-[11px] hover:underline" :style="{ color: 'var(--text-2)' }">
                        <template v-if="skipped">{{ mineable }}/{{ queue.length }}</template>
                        <template v-else>{{ queue.length }}</template>
                        queued &rarr;
                    </RouterLink>
                </header>
                <p v-if="queue.length" class="text-[10px] -mt-2 mb-2" :style="{ color: 'var(--muted)' }">
                    <template v-if="saving">Saving&hellip;</template>
                    <template v-else-if="skipped">
                        Drag to rank. {{ skipped }} dimmed &mdash; not in your Steam library or
                        your <RouterLink to="/priorities" class="underline">priority list</RouterLink>.
                    </template>
                    <template v-else>Drag to rank. Whatever is mining now stays first.</template>
                </p>
                <p v-if="!queue.length" class="text-[12px] py-4 text-center" :style="{ color: 'var(--muted)' }">
                    <template v-if="store.loading">
                        Working out what to queue&hellip;
                    </template>
                    <template v-else>Nothing queued behind the current campaign.</template>
                </p>

                <!-- Scrolls rather than truncating: the queue routinely runs past a
                     hundred campaigns and the count is itself informative. -->
                <!-- Scrolls rather than truncating, and drags to rank: the same list and
                     the same rule as the narrow layout, which had this first. -->
                <draggable
                    v-else
                    v-model="order"
                    item-key="id"
                    handle=".drag-handle"
                    :animation="150"
                    class="space-y-1 flex-1 min-h-0 overflow-y-auto pr-1 scroll-thin"
                    @start="dragging = true"
                    @end="dragging = false; onReorder($event)"
                >
                    <template #item="{ element: campaign, index }">
                    <div
                        class="flex items-center gap-3 py-2 px-2 rounded-lg"
                        :class="campaign.inLibraryScope && !campaign.isExcluded ? '' : 'opacity-45'"
                        :title="
                            campaign.isExcluded
                                ? 'On your excluded list, so it will not be mined'
                                : campaign.inLibraryScope
                                  ? undefined
                                  : 'Not in your Steam library or priority list, so it will not be mined'
                        "
                        :style="{ background: 'var(--surface-2)' }"
                        tabindex="0"
                        @keydown.ctrl.up.prevent="move(index, -1)"
                        @keydown.ctrl.down.prevent="move(index, 1)"
                    >
                        <!-- Box art with the rank as a corner tag, so the number rides
                             with the game rather than taking a column of its own. -->
                        <div class="relative shrink-0">
                            <img
                                v-if="campaign.game.boxArtURL"
                                :src="campaign.game.boxArtURL"
                                :alt="campaign.game.name"
                                class="w-9 h-12 rounded object-cover"
                                :style="{ background: 'var(--surface)' }"
                            />
                            <div v-else class="w-9 h-12 rounded" :style="{ background: 'var(--surface)' }" />
                            <span
                                class="absolute -top-1 -left-1 min-w-[16px] h-4 px-1 rounded grid place-items-center text-[10px] font-semibold"
                                :style="
                                    campaign.inPriorities
                                        ? { background: 'var(--accent)', color: 'white' }
                                        : { background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)' }
                                "
                                :title="campaign.inPriorities ? `Priority #${campaign.priorityRank + 1}` : 'Not in your priority list'"
                            >
                                {{ index + 1 }}
                            </span>
                        </div>

                        <div class="min-w-0 flex-1">
                            <p class="text-[13px] font-medium truncate">{{ campaign.game.name }}</p>
                            <p class="text-[11px] truncate" :style="{ color: 'var(--text-2)' }">
                                {{ campaign.name }}
                            </p>
                        </div>

                        <!-- Ahead of the time, so the eye meets the warning before the number
                             it qualifies. -->
                        <StatusChip
                            v-if="!campaign.isAccountLinked"
                            status="unlinked"
                            small
                            :href="campaign.accountLinkUrl"
                        />

                        <div class="text-right shrink-0">
                            <p class="text-[12px] tabular">
                                {{ formatDuration(totalRemainingMinutes(campaign)) }} left
                            </p>
                            <p class="text-[11px] tabular" :style="{ color: 'var(--muted)' }">
                                ends {{ formatUntil(campaign.endAt, store.now) }}
                            </p>
                        </div>

                        <!-- Trailing, as on the priorities page: the row reads as what it
                             is before offering a control to move it. -->
                        <span
                            class="drag-handle cursor-grab select-none shrink-0 text-[12px]"
                            :style="{ color: 'var(--muted)' }"
                            title="Drag to rank"
                        >&#10287;</span>
                    </div>
                    </template>
                </draggable>
            </section>

            <section class="card p-3 lg:col-span-5 xl:col-span-3 xl:order-2 flex flex-col min-h-0 max-h-[560px] xl:max-h-none">
                <header class="flex items-baseline justify-between mb-3">
                    <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                        Recently claimed
                    </h2>
                    <span v-if="store.stats" class="text-[11px] tabular" :style="{ color: 'var(--text-2)' }">
                        {{ store.stats.dropsLast7Days }} this week
                        &middot; {{ store.stats.dropsAllTime }} all time
                    </span>
                </header>

                <!-- A miner is judged by what it produced, so the totals lead. -->
                <div
                    v-if="store.stats && store.stats.dropsAllTime"
                    class="grid grid-cols-3 gap-2 mb-3 pb-3"
                    :style="{ borderBottom: '1px solid var(--border)' }"
                >
                    <div>
                        <p class="text-[18px] font-semibold tabular">{{ store.stats.dropsAllTime }}</p>
                        <p class="text-[10px] uppercase tracking-wide" :style="{ color: 'var(--text-2)' }">
                            drops
                        </p>
                    </div>
                    <div>
                        <p class="text-[18px] font-semibold tabular">
                            {{ store.stats.campaignsCompleted }}
                        </p>
                        <p class="text-[10px] uppercase tracking-wide" :style="{ color: 'var(--text-2)' }">
                            campaigns
                        </p>
                    </div>
                    <div>
                        <!-- "184h 30m" wraps to two lines once this column narrows, which
                             makes the row of three sit unevenly. The minutes are the part
                             nobody reads, so they are what goes. -->
                        <p class="text-[18px] font-semibold tabular whitespace-nowrap">
                            {{ watchedHours }}<span class="hidden 2xl:inline">{{ watchedMinutes }}</span>
                        </p>
                        <p class="text-[10px] uppercase tracking-wide" :style="{ color: 'var(--text-2)' }">
                            watched
                        </p>
                    </div>
                </div>

                <!-- The number that says whether the bot is working FOR you: watch time on
                     campaigns that can pay out, versus time that can never arrive. -->
                <RouterLink
                    v-if="deliverableShare"
                    to="/links"
                    class="block mb-3 pb-3 group"
                    :style="{ borderBottom: '1px solid var(--border)' }"
                >
                    <div class="flex items-baseline justify-between mb-1.5">
                        <span class="text-[11px]" :style="{ color: 'var(--text-2)' }">
                            Reaches your games
                        </span>
                        <span class="text-[12px] tabular font-semibold">{{ deliverableShare.percent }}%</span>
                    </div>
                    <div class="h-1.5 rounded-full overflow-hidden flex" :style="{ background: 'var(--surface-2)' }">
                        <div :style="{ width: `${deliverableShare.percent}%`, background: 'var(--success)' }" />
                        <div :style="{ width: `${100 - deliverableShare.percent}%`, background: 'var(--warn)' }" />
                    </div>
                    <p class="text-[10px] mt-1 group-hover:underline" :style="{ color: 'var(--muted)' }">
                        {{ formatDuration(deliverableShare.wasted) }} went to unlinked campaigns &rarr;
                    </p>
                </RouterLink>

                <div v-if="!claims.length" class="text-center py-6">
                    <BrandMark :size="26" class="mx-auto mb-2" :style="{ color: 'var(--muted)' }" />
                    <p class="text-[12px]" :style="{ color: 'var(--muted)' }">
                        Claimed drops will appear here.
                    </p>
                </div>

                <ul v-else class="space-y-1 flex-1 min-h-0 overflow-y-auto pr-1 scroll-thin">
                    <li
                        v-for="(claim, index) in claims"
                        :key="`${claim.dropId}-${claim.at}`"
                        class="flex items-center gap-3 py-1.5 px-2 rounded-lg"
                        :class="index === 0 ? 'claim-enter' : ''"
                    >
                        <img
                            v-if="claim.rewardImageURL"
                            :src="claim.rewardImageURL"
                            :alt="claim.dropName"
                            class="w-10 h-10 rounded-lg object-cover shrink-0"
                            :style="{ background: 'var(--surface-2)' }"
                        />
                        <div class="min-w-0 flex-1">
                            <p class="text-[12px] font-medium truncate">{{ claim.dropName }}</p>
                            <p class="text-[11px] truncate" :style="{ color: 'var(--text-2)' }">
                                {{ claim.gameName }}
                            </p>
                        </div>
                        <span class="text-[11px] shrink-0" :style="{ color: 'var(--muted)' }">
                            {{ formatRelative(claim.at, store.now) }}
                        </span>
                    </li>
                </ul>
            </section>

            <!--
                Rightmost and widest: it is the one panel you actually watch. Hidden below xl
                entirely - a video player and a tier ladder are not what a phone-sized screen
                should spend its height on when the queue and the claims are the point.
            -->
            <div class="hidden xl:flex xl:col-span-5 xl:order-3 flex-col gap-4 min-h-0">
                <LiveChannel />
                <TierLadder class="flex-1 min-h-0" />
            </div>
        </div>

        <!-- Also desktop-only: on a small screen the log is noise below the two lists
             that actually answer "what is it doing". -->
        <EventFeed class="hidden lg:block max-w-[1800px] mx-auto" :entries="store.feed" />
    </div>
</template>
