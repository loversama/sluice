<script setup>
import { computed, onUnmounted, ref } from "vue";

import { useMinerStore } from "@/stores/miner.js";

const store = useMinerStore();

const collapsed = ref(false);
/** The player is the point of the panel, so it leads; preview is the fallback. */
const playing = ref(true);
/** Bumped to bust the CDN cache; Twitch refreshes previews every few minutes. */
const nonce = ref(Date.now());

const channel = computed(() => store.mining?.channel ?? null);

/**
 * Twitch publishes a live preview per channel at a predictable path. It costs the account
 * nothing - unlike the player, which would open a competing watch session.
 */
const previewUrl = computed(() =>
    channel.value
        ? `https://static-cdn.jtvnw.net/previews-ttv/live_user_${channel.value.login}-640x360.jpg?v=${nonce.value}`
        : null,
);

const embedUrl = computed(() => {
    if (!channel.value) return null;
    const parent = window.location.hostname;
    return `https://player.twitch.tv/?channel=${channel.value.login}&parent=${parent}&muted=true&autoplay=true`;
});

const enabling = ref(false);

/**
 * Turn the player on from here rather than making the user go and find the setting. It is
 * still a stored preference, so the choice persists.
 */
async function enableEmbed() {
    enabling.value = true;
    try {
        await store.saveConfig({ allowStreamEmbed: true });
        store.allowStreamEmbed = true;
        playing.value = true;
    } finally {
        enabling.value = false;
    }
}

const timer = setInterval(() => (nonce.value = Date.now()), 30_000);
onUnmounted(() => clearInterval(timer));

const watchingFor = computed(() => {
    if (!store.mining) return null;
    const minutes = Math.round((store.now - store.mining.since) / 60_000);
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
            <div class="relative aspect-video" :style="{ background: 'var(--surface-2)' }">
                <!-- The player only appears when explicitly allowed in settings AND turned
                     on here: it runs in this browser with your Twitch cookies, so it can
                     open a second watch session and stall the miner. -->
                <iframe
                    v-if="playing && store.allowStreamEmbed"
                    :src="embedUrl"
                    class="absolute inset-0 w-full h-full"
                    allow="autoplay; fullscreen"
                    frameborder="0"
                />
                <template v-else>
                    <img
                        v-if="previewUrl"
                        :src="previewUrl"
                        :alt="channel.displayName"
                        class="absolute inset-0 w-full h-full object-cover"
                    />
                    <button
                        v-if="store.allowStreamEmbed"
                        class="absolute inset-0 grid place-items-center"
                        @click="playing = true"
                    >
                        <span
                            class="px-3 py-1.5 rounded-full text-[12px] font-medium"
                            :style="{ background: 'rgba(0,0,0,0.65)', color: 'white' }"
                        >
                            ▶ Watch live
                        </span>
                    </button>
                </template>
            </div>

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
