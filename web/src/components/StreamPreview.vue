<script setup>
import { computed, onUnmounted, ref } from "vue";

import { useMinerStore } from "@/stores/miner.js";

/**
 * The video surface for the channel being mined: a live preview image by default, the real
 * player when the user has allowed it.
 *
 * Extracted so the full dashboard and the narrow one cannot drift apart on the two details
 * that are easy to get wrong - the CDN path Twitch publishes previews at, and the nonce
 * that stops the browser serving a ten-minute-old frame forever.
 */
const props = defineProps({
    channel: { type: Object, required: true },
    /** Compact drops the "Watch live" affordance: at 350px it covers the frame. */
    compact: { type: Boolean, default: false },
});

/**
 * Owned by the parent so a header button elsewhere can flip it, but defaulted here so a
 * caller that does not care about the distinction can leave it off entirely.
 */
const playing = defineModel("playing", { type: Boolean, default: true });

const store = useMinerStore();

/** Bumped to bust the CDN cache; Twitch refreshes previews every few minutes. */
const nonce = ref(Date.now());
const timer = setInterval(() => (nonce.value = Date.now()), 30_000);
onUnmounted(() => clearInterval(timer));

/**
 * Twitch publishes a live preview per channel at a predictable path. It costs the account
 * nothing - unlike the player, which would open a competing watch session.
 */
const previewUrl = computed(
    () =>
        `https://static-cdn.jtvnw.net/previews-ttv/live_user_${props.channel.login}-640x360.jpg?v=${nonce.value}`,
);

const embedUrl = computed(() => {
    const parent = window.location.hostname;
    return `https://player.twitch.tv/?channel=${props.channel.login}&parent=${parent}&muted=true&autoplay=true`;
});

/** The player runs in this browser with your Twitch cookies, so it is opt-in in settings. */
const showPlayer = computed(() => playing.value && store.allowStreamEmbed);
</script>

<template>
    <div class="relative aspect-video overflow-hidden" :style="{ background: 'var(--surface-2)' }">
        <iframe
            v-if="showPlayer"
            :src="embedUrl"
            class="absolute inset-0 w-full h-full"
            allow="autoplay; fullscreen"
            frameborder="0"
        />
        <template v-else>
            <img
                :src="previewUrl"
                :alt="channel.displayName"
                class="absolute inset-0 w-full h-full object-cover"
            />
            <button
                v-if="store.allowStreamEmbed && !compact"
                class="absolute inset-0 grid place-items-center"
                @click="playing = true"
            >
                <span
                    class="px-3 py-1.5 rounded-full text-[12px] font-medium"
                    :style="{ background: 'rgba(0,0,0,0.65)', color: 'white' }"
                >
                    &#9654; Watch live
                </span>
            </button>
        </template>
        <slot />
    </div>
</template>
