<script setup>
import { computed, ref } from "vue";
import { useMinerStore } from "@/stores/miner.js";

const store = useMinerStore();
const copied = ref(false);

const device = computed(() => store.auth.device);

const expiresIn = computed(() => {
    if (!device.value?.expiresAt) {
        return null;
    }
    const seconds = Math.max(0, Math.round((new Date(device.value.expiresAt) - store.now) / 1000));
    // Zero is a real moment here: the old code has lapsed and the daemon is asking for
    // another. Saying so beats a dead 0:00 that looks like the app gave up.
    if (seconds === 0) return null;
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
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
            <h1 class="text-[16px] font-semibold">Sluice</h1>
            <p class="text-[12px] mt-1 mb-5" :style="{ color: 'var(--text-2)' }">
                Authorize this bot with your Twitch account
            </p>

            <template v-if="device">
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

                <p v-if="expiresIn" class="text-[11px] mt-4 tabular" :style="{ color: 'var(--muted)' }">
                    <template v-if="expiresIn">Code expires in {{ expiresIn }}</template>
                    <template v-else>That code expired &mdash; fetching a new one&hellip;</template>
                </p>
                <p class="text-[12px] mt-2 pulse" :style="{ color: 'var(--text-2)' }">
                    Waiting for authorization&hellip;
                </p>
            </template>

            <p v-else class="text-[12px] py-8 pulse" :style="{ color: 'var(--text-2)' }">
                Requesting a code from Twitch&hellip;
            </p>

            <p class="text-[11px] mt-6 pt-4" :style="{ color: 'var(--muted)', borderTop: '1px solid var(--border)' }">
                Your password never touches this app. Authorization happens entirely on Twitch.
            </p>
        </div>
    </div>
</template>
