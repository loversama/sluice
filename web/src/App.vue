<script setup>
import { computed, onMounted, onUnmounted } from "vue";
import { useRoute } from "vue-router";

import { useMinerStore } from "@/stores/miner.js";
import AuthGate from "@/components/AuthGate.vue";

const store = useMinerStore();
const route = useRoute();

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

onMounted(async () => {
    await store.hydrate();
    store.connect();
});
onUnmounted(() => store.disconnect());
</script>

<template>
    <div class="min-h-full" :style="{ background: 'var(--bg)', color: 'var(--text)' }">
        <AuthGate v-if="store.loaded && store.auth.status !== 'ok'" />

        <div v-else class="flex min-h-screen">
            <!-- Sidebar: icon rail that expands on wider screens. -->
            <nav
                class="hidden md:flex flex-col w-[72px] xl:w-[220px] shrink-0 py-4"
                :style="{ background: 'var(--surface)', borderRight: '1px solid var(--border)' }"
            >
                <div class="px-4 mb-6 flex items-center gap-2">
                    <span class="text-[18px]" :style="{ color: 'var(--accent)' }">◈</span>
                    <span class="hidden xl:block text-[13px] font-semibold">Drops Bot</span>
                </div>

                <RouterLink
                    v-for="item in NAV"
                    :key="item.to"
                    :to="item.to"
                    class="flex items-center gap-3 px-4 py-2.5 mx-2 rounded-lg text-[13px] transition-colors"
                    :style="{
                        background: isActive(item.to) ? 'var(--surface-2)' : 'transparent',
                        color: isActive(item.to) ? 'var(--text)' : 'var(--text-2)',
                    }"
                >
                    <span class="text-[15px] w-5 text-center">{{ item.icon }}</span>
                    <span class="hidden xl:block">{{ item.label }}</span>
                </RouterLink>

                <div class="mt-auto px-4 pt-4 flex items-center gap-2" :style="{ borderTop: '1px solid var(--border)' }">
                    <span
                        class="w-2 h-2 rounded-full shrink-0"
                        :class="store.connection === 'open' ? 'pulse' : ''"
                        :style="{ background: store.connection === 'open' ? 'var(--success)' : 'var(--warn)' }"
                        :title="store.connection"
                    />
                    <span class="hidden xl:block text-[11px] truncate" :style="{ color: 'var(--text-2)' }">
                        {{ store.auth.user?.displayName ?? "not signed in" }}
                    </span>
                </div>
            </nav>

            <main class="flex-1 min-w-0 pb-20 md:pb-0">
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

                <div class="p-4 max-w-[1200px] mx-auto">
                    <RouterView />
                </div>
            </main>

            <!-- Mobile: the rail becomes a bottom tab bar. -->
            <nav
                class="md:hidden fixed bottom-0 inset-x-0 flex"
                :style="{ background: 'var(--surface)', borderTop: '1px solid var(--border)' }"
            >
                <RouterLink
                    v-for="item in NAV"
                    :key="item.to"
                    :to="item.to"
                    class="flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px]"
                    :style="{ color: isActive(item.to) ? 'var(--accent)' : 'var(--text-2)' }"
                >
                    <span class="text-[16px]">{{ item.icon }}</span>
                    {{ item.label }}
                </RouterLink>
            </nav>
        </div>
    </div>
</template>
