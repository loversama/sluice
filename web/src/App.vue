<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElNotification } from "element-plus";
import { useRoute } from "vue-router";

import { useMinerStore } from "@/stores/miner.js";
import { useViewport } from "@/lib/viewport.js";
import AuthGate from "@/components/AuthGate.vue";
import AppHeader from "@/components/AppHeader.vue";
import Compact from "@/views/Compact.vue";

const store = useMinerStore();
const route = useRoute();
const { isCompact } = useViewport();

/**
 * Collapsing leaves the icons rather than removing the rail: it buys back width without
 * taking away the way around, which is what a disappearing sidebar does.
 */
const sidebarCollapsed = ref(localStorage.getItem("sluice.sidebar") === "collapsed");
watch(sidebarCollapsed, (value) =>
    localStorage.setItem("sluice.sidebar", value ? "collapsed" : "open"),
);

/** The rail is only worth its width when there is width; below that the header takes over. */
const hasSidebar = computed(() => !isCompact.value);

/**
 * Settings sits apart from the rest. The other four are places you move between while
 * using the app; settings is somewhere you go to change it and then leave, so it belongs
 * at the bottom rather than in the run of them.
 */
const primaryNav = computed(() => NAV.filter((item) => item.to !== "/settings"));
const settingsNav = computed(() => NAV.find((item) => item.to === "/settings"));

/**
 * In a narrow window the dashboard is replaced by a stacked one rather than reflowed.
 * The full dashboard needs width for the tier ladder, the live channel and the activity
 * feed; squeezing those to 350px makes three unreadable things instead of dropping to the
 * three that matter. Every other page reflows fine and is left alone.
 */
const showCompactHome = computed(() => isCompact.value && route.path === "/");

const NAV = [
    { to: "/", label: "Dashboard", icon: "◧" },
    { to: "/campaigns", label: "Campaigns", icon: "▤" },
    { to: "/priorities", label: "Priorities", icon: "☰" },
    { to: "/links", label: "Links", icon: "⚿" },
    { to: "/settings", label: "Settings", icon: "⚙" },
];

/** Only surface the strip when something is wrong; a green "all good" banner is noise. */
const problem = computed(() => {
    if (store.loadError) {
        return { level: "danger", message: `Daemon unreachable - ${store.loadError}` };
    }
    if (store.connection === "lost") {
        return { level: "warn", message: "Reconnecting to daemon..." };
    }
    return null;
});

function isActive(to) {
    return to === "/" ? route.path === "/" : route.path.startsWith(to);
}

/**
 * Surface a claim wherever the user happens to be, not only on the dashboard. Keyed on the
 * newest claim rather than list length, so a re-hydrate that replaces the list cannot
 * re-announce everything in it.
 */
watch(
    () => store.claims[0],
    (claim, previous) => {
        if (!claim || !previous || claim.at === previous.at) {
            return;
        }
        ElNotification({
            title: "Drop claimed",
            message: `${claim.dropName} — ${claim.gameName}`,
            type: "success",
            position: "bottom-right",
            duration: 6000,
        });
    },
);

/**
 * Keyed on the completion event rather than a count of completed campaigns. The count went
 * from zero to whatever the account already held the moment a snapshot arrived, so every
 * page load announced a completion that had happened hours earlier.
 */
watch(
    () => store.lastCompletion,
    (completion) => {
        if (!completion) {
            return;
        }
        ElNotification({
            title: "Campaign complete",
            message: `${completion.gameName} — ${completion.name}`,
            type: "success",
            position: "bottom-right",
            duration: 6000,
        });
    },
);

onMounted(async () => {
    await store.hydrate();
    store.connect();
});
onUnmounted(() => store.disconnect());
</script>

<template>
    <div class="h-screen overflow-hidden" :style="{ background: 'var(--bg)', color: 'var(--text)' }">
        <AuthGate v-if="store.loaded && store.auth.status !== 'ok'" />

        <div v-else class="flex flex-col h-full">
            <!-- Sidebar: icon rail that expands on wider screens. -->
        <AppHeader
            :nav="NAV"
            :compact="isCompact"
            :has-sidebar="hasSidebar"
            @toggle-sidebar="sidebarCollapsed = !sidebarCollapsed"
        />

        <div class="flex-1 flex min-h-0">
            <!-- The rail is a second way to the same places, so it earns its width only
                 when there is width to spare. Below that the header carries navigation
                 on its own. -->
            <nav
                v-if="hasSidebar"
                class="shrink-0 flex flex-col gap-0.5 py-2 transition-[width] duration-150"
                :style="{
                    width: sidebarCollapsed ? '52px' : '176px',
                    background: 'var(--surface)',
                    borderRight: '1px solid var(--border)',
                }"
            >
                <RouterLink
                    v-for="item in primaryNav"
                    :key="item.to"
                    :to="item.to"
                    class="flex items-center gap-3 mx-2 rounded-lg text-[13px] transition-colors"
                    :class="sidebarCollapsed ? 'px-0 py-2.5 justify-center' : 'px-3 py-2'"
                    :title="sidebarCollapsed ? item.label : undefined"
                    :style="{
                        background: isActive(item.to) ? 'var(--surface-2)' : 'transparent',
                        color: isActive(item.to) ? 'var(--text)' : 'var(--text-2)',
                    }"
                >
                    <span class="text-[15px] w-5 text-center shrink-0">{{ item.icon }}</span>
                    <span v-if="!sidebarCollapsed" class="truncate">{{ item.label }}</span>
                </RouterLink>

                <!-- The rule is its own element rather than a border on the link, so it
                     stays put instead of moving with the hover and active states. -->
                <div class="mt-auto mx-3 mb-1" :style="{ borderTop: '1px solid var(--border)' }" />

                <RouterLink
                    v-if="settingsNav"
                    :to="settingsNav.to"
                    class="flex items-center gap-3 mx-2 mb-1 rounded-lg text-[13px] transition-colors"
                    :class="sidebarCollapsed ? 'px-0 py-2.5 justify-center' : 'px-3 py-2'"
                    :title="sidebarCollapsed ? settingsNav.label : undefined"
                    :style="{
                        background: isActive(settingsNav.to) ? 'var(--surface-2)' : 'transparent',
                        color: isActive(settingsNav.to) ? 'var(--text)' : 'var(--text-2)',
                    }"
                >
                    <span class="text-[15px] w-5 text-center shrink-0">{{ settingsNav.icon }}</span>
                    <span v-if="!sidebarCollapsed" class="truncate">{{ settingsNav.label }}</span>
                </RouterLink>
            </nav>

            <main class="flex-1 min-w-0 overflow-y-auto">
                <div
                    v-if="problem"
                    class="px-4 py-2 text-[12px]"
                    :style="{
                        background: `color-mix(in srgb, var(--${problem.level}) 15%, transparent)`,
                        color: `var(--${problem.level})`,
                    }"
                >
                    {{ problem.message }}
                </div>

                <Compact v-if="showCompactHome" />
                <div v-else class="p-4 max-w-[1800px] mx-auto [&_.sticky]:backdrop-blur">
                    <RouterView />
                </div>
            </main>
        </div>
        </div>
    </div>
</template>
