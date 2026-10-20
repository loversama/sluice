<script setup>
import { computed, ref } from "vue";
import { useMinerStore } from "@/stores/miner.js";
import BrandMark from "./BrandMark.vue";

const store = useMinerStore();
const copied = ref(false);

const device = computed(() => store.auth.device);

const secondsLeft = computed(() =>
    device.value?.expiresAt
        ? Math.max(0, Math.round((new Date(device.value.expiresAt) - store.now) / 1000))
        : null,
);

const expiresIn = computed(() => {
    const seconds = secondsLeft.value;
    // Zero is a real moment here: the old code has lapsed and the daemon is asking for
    // another. Saying so beats a dead 0:00 that looks like the app gave up.
    if (!seconds) return null;
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
});

/**
 * Why there is no code to show, when it is not that one is on its way.
 *
 * Before the first snapshot this screen is all there is, so a daemon that cannot be reached
 * or refused the request, or one that stopped before signing in, used to sit here saying
 * it was requesting a code - forever, and about the wrong thing.
 */
const blocked = computed(() => {
    if (store.fatal) return { message: store.fatal.message, hint: null, retrying: false };
    if (store.loadError && !store.daemon) {
        return { message: store.loadError, hint: store.loadHint, retrying: true };
    }
    return null;
});

async function copyCode() {
    if (!device.value) return;
    try {
        await navigator.clipboard.writeText(device.value.code);
        copied.value = true;
        setTimeout(() => (copied.value = false), 1500);
    } catch {
        /* clipboard blocked - the code is visible anyway */
    }
}
</script>

<template>
    <div class="min-h-full flex items-center justify-center p-6">
        <div class="card p-6 w-full max-w-[420px] text-center">
            <BrandMark :size="34" class="mx-auto mb-2" :style="{ color: 'var(--accent)' }" />
            <h1 class="text-[16px] font-semibold">Sluice</h1>
            <p class="text-[12px] mt-1 mb-5" :style="{ color: 'var(--text-2)' }">
                Authorize this bot with your Twitch account
            </p>

            <div
                v-if="blocked"
                class="rounded-lg p-3 text-left"
                :style="{
                    background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--danger) 40%, transparent)',
                }"
            >
                <p class="text-[13px] font-medium" :style="{ color: 'var(--danger)' }">{{ blocked.message }}</p>
                <p v-if="blocked.hint" class="text-[12px] mt-1" :style="{ color: 'var(--text-2)' }">
                    {{ blocked.hint }}
                </p>
                <p v-if="blocked.retrying" class="text-[11px] mt-2 pulse" :style="{ color: 'var(--muted)' }">Trying again&hellip;</p>
            </div>

            <template v-else-if="device">
                <button
                    class="w-full font-mono font-bold rounded-lg py-4 tracking-[0.3em] text-[34px] transition-colors"
                    :style="{ background: 'var(--surface-2)', color: 'var(--text)' }"
                    :title="'Click to copy'"
                    @click="copyCode"
                >
                    {{ device.code }}
                </button>
                <p class="text-[11px] mt-1 h-4" :style="{ color: 'var(--success)' }">
                    {{ copied ? "Copied to clipboard" : "" }}
                </p>

                <a
                    :href="device.url"
                    target="_blank"
                    rel="noreferrer"
                    class="block w-full mt-3 py-2.5 rounded-lg font-medium text-[13px] text-white"
                    :style="{ background: 'var(--accent)' }"
                >
                    Open twitch.tv/activate
                </a>

                <p v-if="secondsLeft !== null" class="text-[11px] mt-4 tabular" :style="{ color: 'var(--muted)' }">
                    <template v-if="expiresIn">Code expires in {{ expiresIn }}</template>
                    <template v-else>That code expired &mdash; fetching a new one&hellip;</template>
                </p>
                <p class="text-[12px] mt-2 pulse" :style="{ color: 'var(--text-2)' }">
                    Waiting for authorization&hellip;
                </p>
            </template>

            <!-- No code yet usually means none is needed: saved credentials are being
                 checked, and a code only appears if they turn out to have lapsed. -->
            <p v-else class="text-[12px] py-8 pulse" :style="{ color: 'var(--text-2)' }">
                Signing in&hellip;
            </p>

            <p class="text-[11px] mt-6 pt-4" :style="{ color: 'var(--muted)', borderTop: '1px solid var(--border)' }">
                Your password never touches this app. Authorization happens entirely on Twitch.
            </p>
        </div>
    </div>
</template>
