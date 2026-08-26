<script setup>
import { computed, onMounted, ref } from "vue";
import { useRoute, RouterLink } from "vue-router";

import { useMinerStore } from "@/stores/miner.js";

const props = defineProps({
    nav: { type: Array, required: true },
    compact: { type: Boolean, default: false },
    /** True when the sidebar is on screen, in which case it owns navigation. */
    hasSidebar: { type: Boolean, default: false },
});
const emit = defineEmits(["toggle-sidebar"]);

const store = useMinerStore();
const route = useRoute();

function isActive(to) {
    return to === "/" ? route.path === "/" : route.path.startsWith(to);
}

/** One line describing what the bot is doing, short enough for a narrow window. */
const activity = computed(() => {
    // Before the first snapshot lands there is nothing to report, and "Idle" would be a
    // guess presented as fact - the miner may well already be working.
    if (!store.loaded) return "Connecting\u2026";
    if (store.daemon?.paused) return "Paused";
    // Starting up is not idling. The gap is half a minute on a busy account, and calling it
    // idle for all of it is the same guess-as-fact as above.
    if (store.loading) return "Starting up…";
    const channel = store.mining?.channel;
    if (!channel) return "Idle";
    return props.compact ? channel.game || channel.displayName : `${channel.game} · ${channel.displayName}`;
});

const connectionTone = computed(() =>
    store.connection === "open" ? "var(--success)" : "var(--warn)",
);

/**
 * The window has no frame, so this header is the title bar: it provides the drag region and
 * the controls. In a browser there is no bridge and none of it renders, which is what keeps
 * the same build serving both distributions.
 */
const desktop = typeof window !== "undefined" ? (window.desktopBridge ?? null) : null;
const maximized = ref(false);
const thin = ref(false);

onMounted(async () => {
    if (!desktop?.isMaximized) return;
    maximized.value = await desktop.isMaximized();
    desktop.onMaximizedChange?.((value) => (maximized.value = value));
    thin.value = (await desktop.isThin?.()) ?? false;
    desktop.onThinChange?.((value) => (thin.value = value));
});

async function toggleThin() {
    if (!desktop?.toggleThin) return;
    thin.value = await desktop.toggleThin();
}

async function toggleMaximize() {
    if (!desktop?.toggleMaximize) return;
    maximized.value = await desktop.toggleMaximize();
}
</script>

<template>
    <header
        class="app-drag flex items-center gap-2 pl-3 shrink-0 select-none"
        :class="desktop ? 'pr-0' : 'pr-3'"
        :style="{
            height: '44px',
            background: 'var(--surface)',
            borderBottom: '1px solid var(--border)',
        }"
    >
        <!-- Identity. The mark stays at every width; the name is the first thing to go. -->
        <button
            v-if="hasSidebar"
            class="app-no-drag flex items-center gap-2 shrink-0 rounded-md px-1 py-1 -ml-1 transition-colors hover:bg-[var(--surface-2)]"
            title="Collapse or expand the sidebar"
            @click="emit('toggle-sidebar')"
        >
            <span class="text-[16px]" :style="{ color: 'var(--accent)' }">◈</span>
            <span class="text-[13px] font-semibold tracking-tight">Sluice</span>
        </button>
        <div v-else class="flex items-center gap-2 shrink-0">
            <span class="text-[16px]" :style="{ color: 'var(--accent)' }">◈</span>
            <span v-if="!compact" class="text-[13px] font-semibold tracking-tight">Sluice</span>
        </div>

        <!-- Navigation lives up here at every width. In a narrow window these become the
             only way around, so they are icons with the labels dropped rather than hidden
             behind a menu that costs an extra click. -->
        <!-- Only when the sidebar is not on screen. Two rows of the same five links is
             clutter, and leaves you wondering whether they do different things. -->
        <nav
            v-if="!hasSidebar"
            class="app-no-drag flex items-center gap-0.5 min-w-0"
            :class="compact ? 'flex-1 justify-around' : 'ml-3'"
        >
            <RouterLink
                v-for="item in nav"
                :key="item.to"
                :to="item.to"
                class="flex items-center gap-1.5 rounded-md transition-colors"
                :class="compact ? 'px-2 py-1.5' : 'px-2.5 py-1.5'"
                :title="item.label"
                :style="{
                    background: isActive(item.to) ? 'var(--surface-2)' : 'transparent',
                    color: isActive(item.to) ? 'var(--text)' : 'var(--text-2)',
                }"
            >
                <span class="text-[14px] leading-none">{{ item.icon }}</span>
                <span v-if="!compact" class="text-[12px]">{{ item.label }}</span>
            </RouterLink>
        </nav>

        <!-- Status. Pushed right when there is room; dropped entirely when there is not,
             since the compact dashboard says the same thing with more space. -->
        <div v-if="!compact" class="ml-auto flex items-center gap-3 min-w-0">
            <span class="text-[11px] truncate max-w-[220px]" :style="{ color: 'var(--text-2)' }">
                {{ activity }}
            </span>
            <span
                class="w-1.5 h-1.5 rounded-full shrink-0"
                :class="store.connection === 'open' ? 'pulse' : ''"
                :style="{ background: connectionTone }"
                :title="`Daemon ${store.connection}`"
            />
            <span class="text-[11px] truncate max-w-[120px]" :style="{ color: 'var(--text-2)' }">
                {{ store.auth.user?.displayName ?? "not signed in" }}
            </span>
        </div>
        <span
            v-else
            class="w-1.5 h-1.5 rounded-full shrink-0 ml-1"
            :class="store.connection === 'open' ? 'pulse' : ''"
            :style="{ background: connectionTone }"
            :title="`Daemon ${store.connection}`"
        />

        <!-- Only in the desktop build, and only where the platform expects them: macOS
             keeps its own traffic lights on the left. -->
        <div v-if="desktop" class="app-no-drag flex items-stretch self-stretch ml-2 shrink-0">
            <button
                class="win-btn"
                :title="thin ? 'Back to the full window' : 'Shrink to a side panel'"
                :style="thin ? { color: 'var(--accent)' } : undefined"
                @click="toggleThin"
            >
                <svg width="10" height="10" viewBox="0 0 10 10">
                    <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
                    <rect :x="thin ? 0.5 : 6.5" y="0.5" :width="thin ? 9 : 3" height="9" fill="currentColor" opacity="0.55" />
                </svg>
            </button>
            <button class="win-btn" title="Minimise" @click="desktop.minimize()">
                <svg width="10" height="10" viewBox="0 0 10 10"><rect y="4.5" width="10" height="1" fill="currentColor" /></svg>
            </button>
            <button class="win-btn" :title="maximized ? 'Restore' : 'Maximise'" @click="toggleMaximize">
                <svg v-if="maximized" width="10" height="10" viewBox="0 0 10 10">
                    <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
                    <path d="M2.5 2.5V0.5H9.5V7.5H7.5" fill="none" stroke="currentColor" />
                </svg>
                <svg v-else width="10" height="10" viewBox="0 0 10 10">
                    <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
                </svg>
            </button>
            <button class="win-btn win-close" title="Close" @click="desktop.close()">
                <svg width="10" height="10" viewBox="0 0 10 10">
                    <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" fill="none" />
                </svg>
            </button>
        </div>
    </header>
</template>

<style scoped>
/* The bar drags the window; every control inside it has to opt out or it cannot be
   clicked at all. */
.app-drag {
    -webkit-app-region: drag;
}
.app-no-drag,
.app-no-drag * {
    -webkit-app-region: no-drag;
}

.win-btn {
    width: 46px;
    display: grid;
    place-items: center;
    color: var(--text-2);
    transition: background-color 0.12s ease, color 0.12s ease;
}
.win-btn:hover {
    background: var(--surface-2);
    color: var(--text);
}
/* Red on hover, as every Windows app does - the one control worth making unmistakable. */
.win-close:hover {
    background: #c42b1c;
    color: #fff;
}
</style>
