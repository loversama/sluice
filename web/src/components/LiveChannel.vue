<script setup>
import { computed, ref } from "vue";

import { useMinerStore } from "@/stores/miner.js";
import StreamPreview from "@/components/StreamPreview.vue";

const store = useMinerStore();

const collapsed = ref(false);
/** The player is the point of the panel, so it leads; preview is the fallback. */
const playing = ref(true);

const channel = computed(() => store.mining?.channel ?? null);

/**
 * Time on this streamer without a break, which survives claims and campaign switches - the
 * loop is re-entered on both, and measuring from that made an hour look like four minutes.
 */
const watchingFor = computed(() => {
    const start = store.mining?.channelSince ?? store.mining?.since;
    if (!start) return null;
    const minutes = Math.round((store.now - start) / 60_000);
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
});
</script>

<template>
    <section v-if="channel" class="card overflow-hidden">
        <header class="flex items-center gap-2 px-3 py-2">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                Live channel
            </h2>
            <span class="text-[11px] flex-1 truncate" :style="{ color: 'var(--muted)' }">
                &mdash; the stream currently being mined
            </span>
            <button
                v-if="store.allowStreamEmbed"
                class="text-[11px] hover:underline shrink-0"
                :style="{ color: 'var(--text-2)' }"
                @click="playing = !playing"
            >
                {{ playing ? "Preview" : "Player" }}
            </button>
            <button
                class="text-[11px] hover:underline"
                :style="{ color: 'var(--text-2)' }"
                @click="collapsed = !collapsed"
            >
                {{ collapsed ? "Show" : "Hide" }}
            </button>
        </header>

        <template v-if="!collapsed">
            <StreamPreview v-model:playing="playing" :channel="channel" />

            <div class="p-3 space-y-1">
                <div class="flex items-center gap-2">
                    <a
                        :href="channel.url"
                        target="_blank"
                        rel="noreferrer"
                        class="text-[13px] font-medium hover:underline truncate"
                        :style="{ color: 'var(--accent)' }"
                    >
                        {{ channel.displayName }}
                    </a>
                    <span
                        class="text-[10px] px-1.5 py-0.5 rounded font-semibold shrink-0"
                        :style="{ background: 'color-mix(in srgb, var(--danger) 18%, transparent)', color: 'var(--danger)' }"
                    >LIVE</span>
                    <span class="text-[11px] tabular ml-auto shrink-0" :style="{ color: 'var(--text-2)' }">
                        {{ channel.viewers.toLocaleString() }} viewers
                    </span>
                </div>
                <p class="text-[11px] line-clamp-2" :style="{ color: 'var(--text-2)' }">
                    {{ channel.title || "No title" }}
                </p>
                <p class="text-[11px] tabular" :style="{ color: 'var(--muted)' }">
                    {{ channel.game }}<template v-if="watchingFor"> &middot; watched {{ watchingFor }}</template>
                </p>

                <p
                    v-if="!store.allowStreamEmbed || !playing"
                    class="text-[10px] pt-1"
                    :style="{ color: 'var(--muted)' }"
                >
                    Preview image, refreshed every 30s.
                </p>
            </div>
        </template>
    </section>
</template>
