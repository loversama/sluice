<script setup>
import { computed } from "vue";
import { useRoute, RouterLink } from "vue-router";

import { useMinerStore } from "@/stores/miner.js";

const props = defineProps({
    nav: { type: Array, required: true },
    compact: { type: Boolean, default: false },
});

const store = useMinerStore();
const route = useRoute();

function isActive(to) {
    return to === "/" ? route.path === "/" : route.path.startsWith(to);
}

/** One line describing what the bot is doing, short enough for a narrow window. */
const activity = computed(() => {
    if (store.daemon?.paused) return "Paused";
    const channel = store.mining?.channel;
    if (!channel) return "Idle";
    return props.compact ? channel.game || channel.displayName : `${channel.game} · ${channel.displayName}`;
});

const connectionTone = computed(() =>
    store.connection === "open" ? "var(--success)" : "var(--warn)",
);
</script>

<template>
    <header
        class="flex items-center gap-2 px-3 shrink-0 select-none"
        :style="{
            height: '44px',
            background: 'var(--surface)',
            borderBottom: '1px solid var(--border)',
        }"
    >
        <!-- Identity. The mark stays at every width; the name is the first thing to go. -->
        <div class="flex items-center gap-2 shrink-0">
            <span class="text-[16px]" :style="{ color: 'var(--accent)' }">◈</span>
            <span v-if="!compact" class="text-[13px] font-semibold tracking-tight">Sluice</span>
        </div>

        <!-- Navigation lives up here at every width. In a narrow window these become the
             only way around, so they are icons with the labels dropped rather than hidden
             behind a menu that costs an extra click. -->
        <nav class="flex items-center gap-0.5 min-w-0" :class="compact ? 'flex-1 justify-around' : 'ml-3'">
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
    </header>
</template>
