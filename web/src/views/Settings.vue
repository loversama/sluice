<script setup>
import { onMounted, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";

import { useMinerStore } from "@/stores/miner.js";
import { formatRelative } from "@/lib/format.js";

const store = useMinerStore();

const form = reactive({
    autoClaimDrops: true,
    autoClaimPoints: true,
    unlinkedPolicy: "mine",
    holdClaimsWhenUnlinked: false,
    unlinkedExpiryWarningHours: 12,
    warnUnlinkedAccounts: true,
    preferredChannels: [],
    blockedChannels: [],
    broadcasterLanguages: [],
    campaignRefreshMinutes: 20,
    attemptImpossibleCampaigns: true,
    logLevel: "info",
    telegramBotToken: "",
    telegramChatId: "",
    discordWebhookUrl: "",
});

const newChannel = ref("");
const newBlocked = ref("");
const saved = ref(false);
const testing = ref(false);
const steam = ref(null);
const steamApiKey = ref("");
const steamAccount = ref("");
const steamBusy = ref(false);
/** Suppresses the autosave watcher while the form is being populated from the daemon. */
let hydrating = true;
let saveTimer = null;

const LANGUAGES = [
    ["EN", "English"], ["ES", "Spanish"], ["DE", "German"], ["FR", "French"],
    ["PT", "Portuguese"], ["RU", "Russian"], ["JA", "Japanese"], ["KO", "Korean"],
    ["IT", "Italian"], ["PL", "Polish"], ["TR", "Turkish"], ["ZH", "Chinese"],
];

onMounted(async () => {
    if (!store.config) await store.loadConfig();
    await loadSteam();
    const outcome = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("steam");
    if (outcome === "connected") ElMessage.success("Steam account connected.");
    if (outcome === "failed") ElMessage.error("Steam sign-in could not be verified.");
    if (outcome === "needs-key") ElMessage.warning("Signed in. Add your Web API key to read your library.");
});

watch(
    () => store.config,
    (config) => {
        if (!config) return;
        hydrating = true;
        Object.assign(form, {
            autoClaimDrops: config.autoClaimDrops,
            autoClaimPoints: config.autoClaimPoints,
            unlinkedPolicy: config.unlinkedPolicy ?? "mine",
            holdClaimsWhenUnlinked: config.holdClaimsWhenUnlinked,
            unlinkedExpiryWarningHours: config.unlinkedExpiryWarningHours,
            warnUnlinkedAccounts: config.warnUnlinkedAccounts,
            preferredChannels: [...config.preferredChannels],
            blockedChannels: [...(config.blockedChannels ?? [])],
            broadcasterLanguages: [...(config.broadcasterLanguages ?? [])],
            campaignRefreshMinutes: config.campaignRefreshMinutes,
            attemptImpossibleCampaigns: config.attemptImpossibleCampaigns,
            logLevel: config.logLevel,
            telegramBotToken: config.notifications?.telegram?.botToken ?? "",
            telegramChatId: config.notifications?.telegram?.chatId ?? "",
            discordWebhookUrl: config.notifications?.discord?.webhookUrl ?? "",
        });
        // Let the assignment settle before the watcher starts treating edits as user intent.
        setTimeout(() => (hydrating = false), 0);
    },
    { immediate: true },
);

/**
 * Autosave, debounced. Priorities already worked this way, and having one page save on a
 * button while the other saved as you typed made the behaviour unpredictable - the safer
 * convention won.
 */
watch(
    form,
    () => {
        if (hydrating) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, 800);
    },
    { deep: true },
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
            autoClaimDrops: form.autoClaimDrops,
            autoClaimPoints: form.autoClaimPoints,
            unlinkedPolicy: form.unlinkedPolicy,
            holdClaimsWhenUnlinked: form.holdClaimsWhenUnlinked,
            unlinkedExpiryWarningHours: Number(form.unlinkedExpiryWarningHours),
            warnUnlinkedAccounts: form.warnUnlinkedAccounts,
            preferredChannels: form.preferredChannels,
            blockedChannels: form.blockedChannels,
            broadcasterLanguages: form.broadcasterLanguages,
            campaignRefreshMinutes: Number(form.campaignRefreshMinutes),
            attemptImpossibleCampaigns: form.attemptImpossibleCampaigns,
            logLevel: form.logLevel,
            notifications,
        });
        saved.value = true;
        setTimeout(() => (saved.value = false), 2500);
    } catch (error) {
        ElMessage.error(error.message);
    }
}

function normaliseLogin(value) {
    return value.trim().toLowerCase().replace(/^https?:\/\/(www\.)?twitch\.tv\//, "").replace(/\/.*$/, "");
}
function addChannel() {
    const login = normaliseLogin(newChannel.value);
    if (login && !form.preferredChannels.includes(login)) form.preferredChannels.push(login);
    newChannel.value = "";
}
function addBlocked() {
    const login = normaliseLogin(newBlocked.value);
    if (login && !form.blockedChannels.includes(login)) {
        form.blockedChannels.push(login);
        form.preferredChannels = form.preferredChannels.filter((entry) => entry !== login);
    }
    newBlocked.value = "";
}
function toggleLanguage(code) {
    const index = form.broadcasterLanguages.indexOf(code);
    if (index === -1) form.broadcasterLanguages.push(code);
    else form.broadcasterLanguages.splice(index, 1);
}

async function loadSteam() {
    steam.value = await fetch("/api/steam").then((r) => r.json()).catch(() => null);
    if (steam.value?.hasApiKey) steamApiKey.value = "********";
}
async function steamPost(path, body) {
    steamBusy.value = true;
    try {
        const response = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body ?? {}),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
        await loadSteam();
        return data;
    } finally {
        steamBusy.value = false;
    }
}
async function connectSteam() {
    try {
        const data = await steamPost("/api/steam/connect", {
            apiKey: steamApiKey.value,
            steamId: steamAccount.value || undefined,
        });
        ElMessage.success(`Connected - ${data.gameCount} games found.`);
    } catch (error) { ElMessage.error(error.message); }
}
async function refreshSteam() {
    try {
        const data = await steamPost("/api/steam/refresh");
        ElMessage.success(`Refreshed - ${data.gameCount} games.`);
    } catch (error) { ElMessage.error(error.message); }
}
async function disconnectSteam() {
    await steamPost("/api/steam/disconnect");
    steamApiKey.value = "";
    steamAccount.value = "";
    ElMessage.info("Steam disconnected.");
}
async function test() {
    testing.value = true;
    try {
        await store.testNotification();
        ElMessage.success("Test notification sent.");
    } catch (error) { ElMessage.error(error.message); }
    finally { testing.value = false; }
}

const inputStyle = {
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    color: "var(--text)",
};
</script>

<template>
    <div class="space-y-4 max-w-[720px]">
        <header class="flex items-baseline justify-between">
            <h1 class="text-[15px] font-semibold">Settings</h1>
            <span class="text-[12px] h-4" :style="{ color: 'var(--success)' }">
                {{ saved ? "Saved" : "" }}
            </span>
        </header>

        <section class="card p-4 space-y-4">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">Claiming</h2>
            <label class="flex items-center justify-between gap-4">
                <span class="text-[13px]">Claim drops automatically</span>
                <el-switch v-model="form.autoClaimDrops" />
            </label>
            <label class="flex items-center justify-between gap-4">
                <span class="text-[13px]">Claim channel points bonuses</span>
                <el-switch v-model="form.autoClaimPoints" />
            </label>
        </section>

        <section class="card p-4 space-y-4">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                Unlinked rewards
            </h2>
            <p class="text-[12px]" :style="{ color: 'var(--text-2)' }">
                A campaign whose account is not linked to the publisher may never deliver its
                reward. Linked campaigns are always ranked first; these settings decide what
                happens once they run out. Badge and emote rewards are always mined &mdash; Twitch
                grants those directly, so no link is involved.
                <RouterLink to="/links" class="underline" :style="{ color: 'var(--accent)' }">
                    See which accounts are worth linking
                </RouterLink>
            </p>

            <label class="flex items-center justify-between gap-4">
                <span class="text-[13px]">Mine unlinked campaigns</span>
                <select v-model="form.unlinkedPolicy" class="px-2 py-1.5 rounded-lg text-[12px] outline-none shrink-0 max-w-[210px]" :style="inputStyle">
                    <option value="mine">Mine them all</option>
                    <option value="ownedOrChosen">Only games I own or chose</option>
                    <option value="skip">Never mine them</option>
                </select>
            </label>

            <label class="flex items-center justify-between gap-4">
                <span>
                    <span class="text-[13px]">Hold claims until linked</span>
                    <span class="block text-[11px]" :style="{ color: 'var(--text-2)' }">
                        Publishers differ on whether a drop claimed before linking can be
                        recovered. Holding waits for you, but an unclaimed drop is definitely
                        gone 24 hours after its campaign ends.
                    </span>
                </span>
                <el-switch v-model="form.holdClaimsWhenUnlinked" />
            </label>

            <label class="flex items-center justify-between gap-4">
                <span>
                    <span class="text-[13px]">Warn before expiry</span>
                    <span class="block text-[11px]" :style="{ color: 'var(--text-2)' }">
                        Hours of notice that earned progress is about to be lost. Zero disables it.
                    </span>
                </span>
                <input v-model="form.unlinkedExpiryWarningHours" type="number" min="0"
                       class="w-20 px-2 py-1.5 rounded-lg text-[12px] tabular outline-none shrink-0" :style="inputStyle" />
            </label>

            <label class="flex items-center justify-between gap-4">
                <span class="text-[13px]">Note unlinked campaigns in the activity feed</span>
                <el-switch v-model="form.warnUnlinkedAccounts" />
            </label>
        </section>

        <section class="card p-4 space-y-4">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">Channels</h2>

            <div>
                <p class="text-[13px]">Preferred channels</p>
                <p class="text-[11px] mb-2" :style="{ color: 'var(--text-2)' }">
                    Tried first, when they are streaming a game you want.
                </p>
                <div class="flex flex-wrap gap-1.5 mb-2">
                    <span v-for="(login, index) in form.preferredChannels" :key="login"
                          class="flex items-center gap-1.5 px-2 py-1 rounded-full text-[12px]"
                          :style="{ background: 'var(--surface-2)' }">
                        {{ login }}
                        <button @click="form.preferredChannels.splice(index, 1)">&times;</button>
                    </span>
                </div>
                <input v-model="newChannel" placeholder="Add a channel and press Enter"
                       class="w-full px-3 py-2 rounded-lg text-[12px] outline-none" :style="inputStyle"
                       @keyup.enter="addChannel" />
            </div>

            <div>
                <p class="text-[13px]">Blocked channels</p>
                <p class="text-[11px] mb-2" :style="{ color: 'var(--text-2)' }">
                    Never watched, even when a campaign's own allow-list includes them.
                </p>
                <div class="flex flex-wrap gap-1.5 mb-2">
                    <span v-for="(login, index) in form.blockedChannels" :key="login"
                          class="flex items-center gap-1.5 px-2 py-1 rounded-full text-[12px]"
                          :style="{ background: 'color-mix(in srgb, var(--danger) 12%, transparent)', color: 'var(--danger)' }">
                        {{ login }}
                        <button @click="form.blockedChannels.splice(index, 1)">&times;</button>
                    </span>
                </div>
                <input v-model="newBlocked" placeholder="Block a channel and press Enter"
                       class="w-full px-3 py-2 rounded-lg text-[12px] outline-none" :style="inputStyle"
                       @keyup.enter="addBlocked" />
            </div>

            <div>
                <p class="text-[13px]">Stream languages</p>
                <p class="text-[11px] mb-2" :style="{ color: 'var(--text-2)' }">
                    None selected means any language, which finds a channel more often.
                </p>
                <div class="flex flex-wrap gap-1.5">
                    <button v-for="[code, label] in LANGUAGES" :key="code"
                            class="px-2 py-1 rounded-full text-[12px] transition-colors"
                            :style="form.broadcasterLanguages.includes(code)
                                ? { background: 'var(--accent)', color: 'white' }
                                : { background: 'var(--surface-2)', color: 'var(--text-2)' }"
                            @click="toggleLanguage(code)">
                        {{ label }}
                    </button>
                </div>
            </div>
        </section>

        <section class="card p-4 space-y-3">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">Steam library</h2>
            <p class="text-[12px]" :style="{ color: 'var(--text-2)' }">
                Lets the miner rank campaigns by the games you actually own and play, and shows
                which accounts are worth linking.
            </p>

            <div v-if="steam?.connected" class="rounded-lg p-3 flex items-center gap-3" :style="{ background: 'var(--surface-2)' }">
                <div class="flex-1 min-w-0">
                    <p class="text-[13px] font-medium">{{ steam.personaName || steam.steamId }}</p>
                    <p class="text-[11px]" :style="{ color: 'var(--text-2)' }">
                        {{ steam.gameCount }} games
                        <template v-if="steam.fetchedAt"> &middot; synced {{ formatRelative(steam.fetchedAt) }}</template>
                    </p>
                </div>
                <button class="px-3 py-1.5 rounded-lg text-[12px]" :style="{ background: 'var(--surface)', color: 'var(--text)' }"
                        :disabled="steamBusy" @click="refreshSteam">
                    {{ steamBusy ? "Syncing..." : "Sync now" }}
                </button>
                <button class="px-3 py-1.5 rounded-lg text-[12px]" :style="{ color: 'var(--danger)' }" @click="disconnectSteam">
                    Disconnect
                </button>
            </div>

            <template v-else>
                <a href="/api/steam/login" class="inline-block px-3 py-2 rounded-lg text-[13px] font-medium text-white" :style="{ background: '#1b2838' }">
                    Sign in through Steam
                </a>
                <input v-model="steamAccount" placeholder="Or paste a profile URL / 17-digit Steam ID"
                       class="w-full px-3 py-2 rounded-lg text-[12px] outline-none" :style="inputStyle" />
            </template>

            <label class="block">
                <span class="text-[12px]">Steam Web API key</span>
                <span class="block text-[11px] mb-1" :style="{ color: 'var(--text-2)' }">
                    Required to read your library &mdash; signing in proves who you are but grants
                    no access. Get one at
                    <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noreferrer" class="underline">steamcommunity.com/dev/apikey</a>.
                    Your profile's &ldquo;Game details&rdquo; must be public.
                </span>
                <input v-model="steamApiKey" type="password" class="w-full px-3 py-2 rounded-lg text-[12px] outline-none" :style="inputStyle" />
            </label>
            <button class="px-3 py-1.5 rounded-lg text-[12px] text-white" :style="{ background: 'var(--accent)' }"
                    :disabled="steamBusy" @click="connectSteam">
                {{ steam?.connected ? "Update key" : "Connect Steam" }}
            </button>
        </section>

        <section class="card p-4 space-y-3">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">Notifications</h2>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label class="block">
                    <span class="text-[12px]">Telegram bot token</span>
                    <input v-model="form.telegramBotToken" type="password" class="w-full mt-1 px-3 py-2 rounded-lg text-[12px] outline-none" :style="inputStyle" />
                </label>
                <label class="block">
                    <span class="text-[12px]">Telegram chat ID</span>
                    <input v-model="form.telegramChatId" class="w-full mt-1 px-3 py-2 rounded-lg text-[12px] outline-none" :style="inputStyle" />
                </label>
            </div>
            <label class="block">
                <span class="text-[12px]">Discord webhook URL</span>
                <input v-model="form.discordWebhookUrl" type="password" class="w-full mt-1 px-3 py-2 rounded-lg text-[12px] outline-none" :style="inputStyle" />
            </label>
            <button class="px-3 py-1.5 rounded-lg text-[12px]" :style="{ background: 'var(--surface-2)', color: 'var(--text)' }"
                    :disabled="testing" @click="test">
                {{ testing ? "Sending..." : "Send test notification" }}
            </button>
        </section>

        <!-- Walled off deliberately: nothing here needs changing in normal use. -->
        <section class="card p-4 space-y-4">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                Advanced
            </h2>
            <p class="text-[12px]" :style="{ color: 'var(--text-2)' }">
                You should not need to change these.
            </p>

            <label class="flex items-center justify-between gap-4">
                <span>
                    <span class="text-[13px]">Campaign refresh interval</span>
                    <span class="block text-[11px]" :style="{ color: 'var(--text-2)' }">
                        Minimum 5 &mdash; polling harder risks rate limiting without finding
                        campaigns any sooner.
                    </span>
                </span>
                <input v-model="form.campaignRefreshMinutes" type="number" min="5"
                       class="w-20 px-2 py-1.5 rounded-lg text-[12px] tabular outline-none shrink-0" :style="inputStyle" />
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
                <span class="text-[13px]">Log level</span>
                <select v-model="form.logLevel" class="px-2 py-1.5 rounded-lg text-[12px] outline-none" :style="inputStyle">
                    <option>error</option><option>warn</option><option>info</option><option>debug</option>
                </select>
            </label>

            <dl class="grid grid-cols-2 gap-y-2 text-[12px] pt-2" :style="{ borderTop: '1px solid var(--border)' }">
                <dt :style="{ color: 'var(--text-2)' }">Twitch account</dt>
                <dd>{{ store.auth.user?.displayName ?? "-" }}</dd>
                <dt :style="{ color: 'var(--text-2)' }">Version</dt>
                <dd class="tabular">{{ store.daemon?.version ?? "-" }}</dd>
                <dt :style="{ color: 'var(--text-2)' }">Running since</dt>
                <dd class="tabular">{{ store.daemon ? formatRelative(store.daemon.startedAt) : "-" }}</dd>
            </dl>
        </section>
    </div>
</template>
