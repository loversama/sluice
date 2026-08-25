<script setup>
import { computed, onUnmounted, ref } from "vue";

import { useMinerStore } from "@/stores/miner.js";
import { playerEmbedUrl, previewImageUrl, supportsAnonymousEmbed } from "@/lib/embed.js";

/**
 * The video surface for the channel being mined: a live thumbnail by default, the real
 * player when the user has asked for it.
 *
 * The player is always embedded anonymously - see lib/embed.js. It must never run as the
 * signed-in user, because that registers a second watch session and can stall the miner.
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

const previewUrl = computed(() => previewImageUrl(props.channel.login, nonce.value));
const embedUrl = computed(() => playerEmbedUrl(props.channel.login, window.location.hostname));

const anonymous = supportsAnonymousEmbed();

/**
 * Three things have to hold before the player runs: the user asked for it, it is switched
 * on, and this engine can load it without credentials. The last is not negotiable.
 */
const showPlayer = computed(() => playing.value && store.allowStreamEmbed && anonymous);
</script>

<template>
    <div class="relative aspect-video overflow-hidden" :style="{ background: 'var(--surface-2)' }">
        <!--
            credentialless keeps the player signed out. Without it this frame would carry the
            user's twitch.tv cookies and open a second watch session on their account.
        -->
        <iframe
            v-if="showPlayer"
            credentialless
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
                v-if="store.allowStreamEmbed && anonymous && !compact"
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
