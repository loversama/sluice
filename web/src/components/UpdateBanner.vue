<script setup>
import { computed, onMounted, ref } from "vue";

/**
 * What the updater is doing, when it is doing something worth interrupting for.
 *
 * Silent while idle and while checking - a bar that appears three times every two hours to
 * say "nothing new" is worse than no bar. It only speaks when there is something to
 * download, something downloading, or something waiting to be installed.
 */
const bridge = typeof window === "undefined" ? null : window.desktopBridge;

const state = ref({ status: "idle" });
const installing = ref(false);

onMounted(async () => {
    if (!bridge) return;
    state.value = (await bridge.updateStatus?.()) ?? { status: "idle" };
    bridge.onUpdateStatus?.((next) => (state.value = next));
});

const shown = computed(() =>
    ["available", "downloading", "ready", "installing"].includes(state.value.status),
);

/** Speed and size, when the download is far enough along for them to mean anything. */
const rate = computed(() => {
    const perSecond = state.value.bytesPerSecond ?? 0;
    if (!perSecond) return "";
    const mb = perSecond / 1_000_000;
    return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(perSecond / 1000)} kB/s`;
});

const size = computed(() => {
    const { transferred = 0, total = 0 } = state.value;
    if (!total) return "";
    return `${(transferred / 1_000_000).toFixed(0)} of ${(total / 1_000_000).toFixed(0)} MB`;
});

const tone = computed(() => (state.value.status === "ready" ? "var(--success)" : "var(--accent)"));

async function install() {
    installing.value = true;
    await bridge?.installUpdate?.();
}
</script>

<template>
    <div
        v-if="shown"
        class="flex items-center gap-3 px-4 py-2 text-[12px]"
        :style="{
            background: `color-mix(in srgb, ${tone} 14%, transparent)`,
            borderBottom: `1px solid color-mix(in srgb, ${tone} 30%, transparent)`,
        }"
    >
        <template v-if="state.status === 'available'">
            <span>Version {{ state.version }} is available &mdash; downloading it now.</span>
        </template>

        <template v-else-if="state.status === 'downloading'">
            <span class="shrink-0">Downloading update</span>
            <div class="flex-1 h-1 rounded-full overflow-hidden max-w-[320px]" :style="{ background: 'var(--surface-2)' }">
                <div
                    class="h-full rounded-full transition-[width] duration-300"
                    :style="{ width: `${Math.round(state.percent ?? 0)}%`, background: tone }"
                />
            </div>
            <span class="tabular shrink-0" :style="{ color: 'var(--text-2)' }">
                {{ Math.round(state.percent ?? 0) }}%
            </span>
            <span v-if="size" class="tabular shrink-0 hidden sm:inline" :style="{ color: 'var(--muted)' }">
                {{ size }}<template v-if="rate"> &middot; {{ rate }}</template>
            </span>
        </template>

        <template v-else-if="state.status === 'installing'">
            <span :style="{ color: tone }">Installing&hellip; the app will restart.</span>
        </template>

        <template v-else>
            <span :style="{ color: tone }">Version {{ state.version }} is ready to install.</span>
            <!--
                Never automatic. Installing restarts the app, which ends a mining session -
                so it waits to be asked, however long that takes.
            -->
            <button
                class="ml-auto px-2.5 py-1 rounded-md text-[11px] font-medium text-white shrink-0"
                :style="{ background: tone }"
                :disabled="installing"
                @click="install"
            >
                {{ installing ? "Restarting…" : "Restart and install" }}
            </button>
            <span class="text-[11px]" :style="{ color: 'var(--text-2)' }">
                or next time you close it
            </span>
        </template>
    </div>
</template>
