<script setup>
import { onMounted, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";

import { useMinerStore } from "@/stores/miner.js";
import { formatRelative } from "@/lib/format.js";

const store = useMinerStore();

const form = reactive({
    campaignRefreshMinutes: 20,
    attemptImpossibleCampaigns: true,
    autoClaimDrops: true,
    autoClaimPoints: true,
    warnUnlinkedAccounts: true,
    preferredChannels: [],
    logLevel: "info",
    telegramBotToken: "",
    telegramChatId: "",
    discordWebhookUrl: "",
});

const newChannel = ref("");
const saved = ref(false);
const testing = ref(false);

onMounted(async () => {
    if (!store.config) await store.loadConfig();
});

watch(
    () => store.config,
    (config) => {
        if (!config) return;
        form.campaignRefreshMinutes = config.campaignRefreshMinutes;
        form.attemptImpossibleCampaigns = config.attemptImpossibleCampaigns;
        form.autoClaimDrops = config.autoClaimDrops;
        form.autoClaimPoints = config.autoClaimPoints;
        form.warnUnlinkedAccounts = config.warnUnlinkedAccounts;
        form.preferredChannels = [...config.preferredChannels];
        form.logLevel = config.logLevel;
        form.telegramBotToken = config.notifications?.telegram?.botToken ?? "";
        form.telegramChatId = config.notifications?.telegram?.chatId ?? "";
        form.discordWebhookUrl = config.notifications?.discord?.webhookUrl ?? "";
    },
    { immediate: true },
);

async function save() {
    const notifications = {};
    if (form.telegramBotToken || form.telegramChatId) {
        notifications.telegram = { botToken: form.telegramBotToken, chatId: form.telegramChatId };
    }
    if (form.discordWebhookUrl) {
        notifications.discord = { webhookUrl: form.discordWebhookUrl };
    }
    try {
        await store.saveConfig({
            campaignRefreshMinutes: Number(form.campaignRefreshMinutes),
            attemptImpossibleCampaigns: form.attemptImpossibleCampaigns,
            autoClaimDrops: form.autoClaimDrops,
            autoClaimPoints: form.autoClaimPoints,
            warnUnlinkedAccounts: form.warnUnlinkedAccounts,
            preferredChannels: form.preferredChannels,
            logLevel: form.logLevel,
            notifications,
        });
        saved.value = true;
        setTimeout(() => (saved.value = false), 4000);
    } catch (error) {
        ElMessage.error(error.message);
    }
}

async function test() {
    testing.value = true;
    try {
        await store.testNotification();
        ElMessage.success("Test notification sent.");
    } catch (error) {
        ElMessage.error(error.message);
    } finally {
        testing.value = false;
    }
}

function addChannel() {
    const login = newChannel.value.trim().toLowerCase().replace(/^https?:\/\/(www\.)?twitch\.tv\//, "");
    if (login && !form.preferredChannels.includes(login)) {
        form.preferredChannels.push(login);
    }
    newChannel.value = "";
}
</script>

<template>
    <div class="space-y-4 max-w-[720px]">
        <h1 class="text-[15px] font-semibold">Settings</h1>

        <section class="card p-4 space-y-4">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">Mining</h2>

            <label class="flex items-center justify-between gap-4">
                <span>
                    <span class="text-[13px]">Campaign refresh interval</span>
                    <span class="block text-[11px]" :style="{ color: 'var(--text-2)' }">
                        Minimum 5 &mdash; polling harder risks rate limiting without finding
                        campaigns any sooner.
                    </span>
                </span>
                <input
                    v-model="form.campaignRefreshMinutes"
                    type="number"
                    min="5"
                    class="w-20 px-2 py-1.5 rounded-lg text-[12px] tabular outline-none shrink-0"
                    :style="{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }"
                />
            </label>

            <label class="flex items-center justify-between gap-4">
                <span>
                    <span class="text-[13px]">Attempt campaigns that look too short</span>
                    <span class="block text-[11px]" :style="{ color: 'var(--text-2)' }">
                        Campaigns often get extended, so trying anyway usually pays off.
                    </span>
                </span>
                <el-switch v-model="form.attemptImpossibleCampaigns" />
            </label>

            <label class="flex items-center justify-between gap-4">
                <span class="text-[13px]">Claim drops automatically</span>
                <el-switch v-model="form.autoClaimDrops" />
            </label>

            <label class="flex items-center justify-between gap-4">
                <span class="text-[13px]">Claim channel points bonuses</span>
                <el-switch v-model="form.autoClaimPoints" />
            </label>

            <label class="flex items-center justify-between gap-4">
                <span class="text-[13px]">Warn about unlinked accounts</span>
                <el-switch v-model="form.warnUnlinkedAccounts" />
            </label>

            <div>
                <p class="text-[13px]">Preferred channels</p>
                <p class="text-[11px] mb-2" :style="{ color: 'var(--text-2)' }">
                    Tried before searching the directory, when they are streaming a game you want.
                </p>
                <div class="flex flex-wrap gap-1.5 mb-2">
                    <span
                        v-for="(login, index) in form.preferredChannels"
                        :key="login"
                        class="flex items-center gap-1.5 px-2 py-1 rounded-full text-[12px]"
                        :style="{ background: 'var(--surface-2)' }"
                    >
                        {{ login }}
                        <button :style="{ color: 'var(--danger)' }" @click="form.preferredChannels.splice(index, 1)">×</button>
                    </span>
                </div>
                <input
                    v-model="newChannel"
                    placeholder="Add a channel and press Enter"
                    class="w-full px-3 py-2 rounded-lg text-[12px] outline-none"
                    :style="{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }"
                    @keyup.enter="addChannel"
                />
            </div>
        </section>

        <section class="card p-4 space-y-3">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                Notifications
            </h2>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label class="block">
                    <span class="text-[12px]">Telegram bot token</span>
                    <input
                        v-model="form.telegramBotToken"
                        type="password"
                        class="w-full mt-1 px-3 py-2 rounded-lg text-[12px] outline-none"
                        :style="{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }"
                    />
                </label>
                <label class="block">
                    <span class="text-[12px]">Telegram chat ID</span>
                    <input
                        v-model="form.telegramChatId"
                        class="w-full mt-1 px-3 py-2 rounded-lg text-[12px] outline-none"
                        :style="{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }"
                    />
                </label>
            </div>
            <label class="block">
                <span class="text-[12px]">Discord webhook URL</span>
                <input
                    v-model="form.discordWebhookUrl"
                    type="password"
                    class="w-full mt-1 px-3 py-2 rounded-lg text-[12px] outline-none"
                    :style="{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }"
                />
            </label>
            <button
                class="px-3 py-1.5 rounded-lg text-[12px]"
                :style="{ background: 'var(--surface-2)', color: 'var(--text)' }"
                :disabled="testing"
                @click="test"
            >
                {{ testing ? "Sending..." : "Send test notification" }}
            </button>
        </section>

        <section class="card p-4 space-y-3">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                Account &amp; daemon
            </h2>
            <dl class="grid grid-cols-2 gap-y-2 text-[12px]">
                <dt :style="{ color: 'var(--text-2)' }">Twitch account</dt>
                <dd>{{ store.auth.user?.displayName ?? "-" }}</dd>
                <dt :style="{ color: 'var(--text-2)' }">Version</dt>
                <dd class="tabular">{{ store.daemon?.version ?? "-" }}</dd>
                <dt :style="{ color: 'var(--text-2)' }">Running since</dt>
                <dd class="tabular">
                    {{ store.daemon ? formatRelative(store.daemon.startedAt) : "-" }}
                </dd>
            </dl>
            <label class="flex items-center justify-between gap-4">
                <span class="text-[13px]">Log level</span>
                <select
                    v-model="form.logLevel"
                    class="px-2 py-1.5 rounded-lg text-[12px] outline-none"
                    :style="{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }"
                >
                    <option>error</option>
                    <option>warn</option>
                    <option>info</option>
                    <option>debug</option>
                </select>
            </label>
        </section>

        <footer class="flex items-center gap-3">
            <button
                class="px-4 py-2 rounded-lg text-[13px] font-medium text-white"
                :style="{ background: 'var(--accent)' }"
                @click="save"
            >
                Save changes
            </button>
            <!-- Most settings apply on the next cycle; pretending otherwise breeds bug reports. -->
            <span v-if="saved" class="text-[12px]" :style="{ color: 'var(--success)' }">
                Saved &mdash; applies from the next campaign refresh.
            </span>
        </footer>
    </div>
</template>
