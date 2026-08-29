<script setup>
import { computed, ref } from "vue";
import { ElMessage } from "element-plus";

import { useMinerStore } from "@/stores/miner.js";
import StreamPreview from "@/components/StreamPreview.vue";
import CameraPlaceholder from "@/components/CameraPlaceholder.vue";
import Skeleton from "@/components/Skeleton.vue";
import { supportsAnonymousEmbed } from "@/lib/embed.js";

const store = useMinerStore();

/** No player where it cannot be embedded signed out - see lib/embed.js. */
const anonymous = supportsAnonymousEmbed();

const collapsed = ref(false);
/** The player is the point of the panel, so it leads; preview is the fallback. */
const playing = ref(true);

const channel = computed(() => store.mining?.channel ?? null);

/** Whether the live player is chosen, which is a saved setting rather than a view state. */
const live = computed(() => store.allowStreamEmbed);

/**
 * The same control the narrow layout has.
 *
 * The wide panel only ever offered a Preview/Player button, and only once the live player
 * was already switched on - so from here there was no way to switch it on at all, and the
 * setting it depends on lives two pages away. Turning the stream on is the one thing
 * someone looking at this panel is most likely to want.
 */
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
    <section class="card overflow-hidden">
        <header class="flex items-center gap-2 px-3 py-2">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                Live channel
            </h2>
            <span class="text-[11px] flex-1 truncate" :style="{ color: 'var(--muted)' }">
                &mdash; the stream currently being mined
            </span>
            <div class="flex items-center gap-1 shrink-0">
                <button
                    v-for="option in [{ value: false, label: 'Image' }, { value: true, label: 'Live' }]"
                    :key="option.label"
                    class="text-[11px] px-1.5 py-0.5 rounded"
                    :style="
                        live === option.value
                            ? { background: 'var(--surface-2)', color: 'var(--text)' }
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
                    class="text-[11px] pl-1.5 hover:underline"
                    :style="{ color: 'var(--text-2)' }"
                    :title="collapsed ? 'Show the stream' : 'Hide the stream to give the lists more room'"
                    @click="collapsed = !collapsed"
                >
                    {{ collapsed ? "Show" : "Hide" }}
                </button>
            </div>
        </header>

        <template v-if="!collapsed">
            <StreamPreview v-if="channel" v-model:playing="playing" :channel="channel" />
            <div v-else class="aspect-video">
                <CameraPlaceholder :label="store.loading ? 'Finding a channel…' : 'Nothing being watched'" />
            </div>

            <div v-if="!channel" class="p-3 space-y-2">
                <Skeleton width="45%" height="12px" />
                <Skeleton width="70%" height="10px" />
            </div>

            <div v-else class="p-3 space-y-1">
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
                        {{ (channel.viewers ?? 0).toLocaleString() }} viewers
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
                <p v-else class="text-[10px] pt-1" :style="{ color: 'var(--muted)' }">
                    Playing signed out, so it cannot affect what is being mined.
                </p>
            </div>
        </template>
    </section>
</template>
