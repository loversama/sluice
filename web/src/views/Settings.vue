<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";

import { useMinerStore } from "@/stores/miner.js";
import { useViewport } from "@/lib/viewport.js";
import { supportsAnonymousEmbed } from "@/lib/embed.js";
import { formatRelative } from "@/lib/format.js";

const store = useMinerStore();

const form = reactive({
    autoClaimDrops: true,
    autoClaimPoints: true,
    unlinkedPolicy: "mine",
    libraryPolicy: "ownedOrListed",
    switchOnCategoryChange: false,
    holdClaimsWhenUnlinked: false,
    unlinkedExpiryWarningHours: 12,
    warnUnlinkedAccounts: true,
    preferredChannels: [],
    blockedChannels: [],
    broadcasterLanguages: [],
    campaignRefreshMinutes: 20,
    attemptImpossibleCampaigns: true,
    logLevel: "info",
    allowStreamEmbed: false,
    telegramBotToken: "",
    telegramChatId: "",
    discordWebhookUrl: "",
    discordBotToken: "",
    discordChannelId: "",
});

/**
 * The player is only ever embedded signed out. Where the engine cannot do that, the setting
 * is withdrawn rather than quietly downgraded - see lib/embed.js.
 */
const canEmbedAnonymously = supportsAnonymousEmbed();

const { isCompact } = useViewport();

/**
 * The page is long enough that everything at once is a scroll hunt on a wide screen, so it
 * splits into tabs. A narrow window keeps everything on one page - there is no room for a
 * tab strip, and a second level of navigation inside a 350px column is worse than scrolling
 * - and the same categories become headings instead.
 */
const TABS = [
    { id: "mining", label: "Mining" },
    { id: "notifications", label: "Notifications" },
    { id: "accounts", label: "Accounts" },
    { id: "advanced", label: "Advanced" },
];

const activeTab = ref(localStorage.getItem("sluice.settingsTab") ?? "mining");
watch(activeTab, (tab) => localStorage.setItem("sluice.settingsTab", tab));

/** Narrow shows every section; wide shows the open tab's. */
function visible(tab) {
    return isCompact.value || activeTab.value === tab;
}

const testingService = ref("");

/** Which route the Discord panel is showing. Follows whatever is already configured. */
const discordMode = ref("webhook");
const dcChecking = ref(false);
const dcLoadingChannels = ref(false);
const dcBot = ref(null);
const dcBotError = ref("");
const dcChannels = ref([]);
const dcChannelError = ref("");
const dcTruncated = ref(false);

/**
 * An invite link built from the bot's own id, which for a bot is also its application id.
 * Send Messages and Embed Links, and nothing else - a notifier has no business asking for
 * more, and a permissions integer copied off a forum usually does.
 */
const discordInviteUrl = computed(() =>
    dcBot.value
        ? `https://discord.com/oauth2/authorize?client_id=${dcBot.value.id}&scope=bot&permissions=18432`
        : null,
);

async function postDiscord(path) {
    const response = await fetch(`/api/notify/discord/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: form.discordBotToken }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Failed (${response.status})`);
    return body;
}

async function checkDiscordBot() {
    dcChecking.value = true;
    dcBot.value = null;
    dcBotError.value = "";
    try {
        const body = await postDiscord("check");
        if (body.ok) dcBot.value = body;
        else dcBotError.value = body.error ?? "Discord did not recognise that token.";
    } catch (error) {
        dcBotError.value = error.message;
    } finally {
        dcChecking.value = false;
    }
}

async function loadDiscordChannels() {
    dcLoadingChannels.value = true;
    dcChannelError.value = "";
    dcChannels.value = [];
    try {
        const body = await postDiscord("channels");
        if (body.ok) {
            dcChannels.value = body.channels ?? [];
            dcTruncated.value = Boolean(body.truncated);
            if (!dcChannels.value.length) {
                dcChannelError.value = "That bot cannot see any text channels it may post in.";
            }
        } else {
            dcChannelError.value = body.error ?? "Could not list channels.";
        }
    } catch (error) {
        dcChannelError.value = error.message;
    } finally {
        dcLoadingChannels.value = false;
    }
}

const tgChecking = ref(false);
const tgDetecting = ref(false);
const tgBot = ref(null);
const tgChat = ref(null);
const tgBotError = ref("");
const tgChatError = ref("");

/** Steps light up as they are satisfied, so a panel shows how far along you are. */
function stepStyle(done) {
    return done
        ? { background: "var(--accent)", color: "white" }
        : { background: "var(--surface)", color: "var(--text-2)" };
}

/**
 * Both calls go through the daemon rather than straight to Telegram. It already holds the
 * token, so a saved one keeps working after a reload even though the dashboard only ever
 * receives it masked.
 */
async function postTelegram(path) {
    const response = await fetch(`/api/notify/telegram/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: form.telegramBotToken }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Failed (${response.status})`);
    return body;
}

async function checkTelegramBot() {
    tgChecking.value = true;
    tgBot.value = null;
    tgBotError.value = "";
    try {
        const body = await postTelegram("check");
        if (body.ok) tgBot.value = body;
        else tgBotError.value = body.error ?? "Telegram did not recognise that token.";
    } catch (error) {
        tgBotError.value = error.message;
    } finally {
        tgChecking.value = false;
    }
}

async function detectTelegramChat() {
    tgDetecting.value = true;
    tgChat.value = null;
    tgChatError.value = "";
    try {
        const body = await postTelegram("detect-chat");
        if (body.ok) {
            tgChat.value = body;
            form.telegramChatId = body.chatId;
        } else if (body.waiting) {
            tgChatError.value = "No message yet. Send your bot something, then press again.";
        } else {
            tgChatError.value = body.error ?? "Could not read the chat.";
        }
    } catch (error) {
        tgChatError.value = error.message;
    } finally {
        tgDetecting.value = false;
    }
}

const newChannel = ref("");
const newBlocked = ref("");
const saved = ref(false);
const testing = ref(false);
const steam = ref(null);
const steamApiKey = ref("");
const steamAccount = ref("");
const steamBusy = ref(false);
/** Which credential path the card is showing; follows the daemon once loaded. */
const steamProvider = ref("sinfulshadows");
const ssApiKey = ref("");
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
            libraryPolicy: config.libraryPolicy ?? "ownedOrListed",
            switchOnCategoryChange: config.switchOnCategoryChange ?? false,
            holdClaimsWhenUnlinked: config.holdClaimsWhenUnlinked,
            unlinkedExpiryWarningHours: config.unlinkedExpiryWarningHours,
            warnUnlinkedAccounts: config.warnUnlinkedAccounts,
            preferredChannels: [...config.preferredChannels],
            blockedChannels: [...(config.blockedChannels ?? [])],
            broadcasterLanguages: [...(config.broadcasterLanguages ?? [])],
            campaignRefreshMinutes: config.campaignRefreshMinutes,
            attemptImpossibleCampaigns: config.attemptImpossibleCampaigns,
            logLevel: config.logLevel,
            allowStreamEmbed: config.allowStreamEmbed ?? false,
            telegramBotToken: config.notifications?.telegram?.botToken ?? "",
            telegramChatId: config.notifications?.telegram?.chatId ?? "",
            discordWebhookUrl: config.notifications?.discord?.webhookUrl ?? "",
            discordBotToken: config.notifications?.discord?.botToken ?? "",
            discordChannelId: config.notifications?.discord?.channelId ?? "",
        });
        // Arrive on whichever route is already configured, rather than always the first.
        discordMode.value = form.discordBotToken && !form.discordWebhookUrl ? "bot" : "webhook";

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
    if (form.discordWebhookUrl || form.discordBotToken) {
        notifications.discord = {
            webhookUrl: form.discordWebhookUrl,
            botToken: form.discordBotToken,
            channelId: form.discordChannelId,
        };
    }
    try {
        await store.saveConfig({
            autoClaimDrops: form.autoClaimDrops,
            autoClaimPoints: form.autoClaimPoints,
            unlinkedPolicy: form.unlinkedPolicy,
            libraryPolicy: form.libraryPolicy,
            switchOnCategoryChange: form.switchOnCategoryChange,
            holdClaimsWhenUnlinked: form.holdClaimsWhenUnlinked,
            unlinkedExpiryWarningHours: Number(form.unlinkedExpiryWarningHours),
            warnUnlinkedAccounts: form.warnUnlinkedAccounts,
            preferredChannels: form.preferredChannels,
            blockedChannels: form.blockedChannels,
            broadcasterLanguages: form.broadcasterLanguages,
            campaignRefreshMinutes: Number(form.campaignRefreshMinutes),
            attemptImpossibleCampaigns: form.attemptImpossibleCampaigns,
            logLevel: form.logLevel,
            allowStreamEmbed: form.allowStreamEmbed,
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
    if (steam.value?.hasSinfulShadowsKey) ssApiKey.value = "********";
    if (steam.value?.provider) steamProvider.value = steam.value.provider;
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
            provider: "direct",
            apiKey: steamApiKey.value,
            steamId: steamAccount.value || undefined,
        });
        ElMessage.success(`Connected - ${data.gameCount} games found.`);
    } catch (error) { ElMessage.error(error.message); }
}
async function connectSinfulShadows() {
    try {
        const data = await steamPost("/api/steam/connect", {
            provider: "sinfulshadows",
            sinfulshadowsApiKey: ssApiKey.value,
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
    ssApiKey.value = "";
    ElMessage.info("Steam disconnected.");
}
/**
 * Present only in the desktop build, which injects it from its preload script. The Docker
 * build has no such object, so the card below simply never renders - no build flag, no
 * environment check, nothing to keep in sync.
 */
const desktop = window.desktopBridge ?? null;
const desktopSettings = ref({ runAtLogin: false, closeToTray: true });
const desktopVersion = ref("");
const importing = ref(false);

onMounted(async () => {
    if (!desktop) return;
    try {
        desktopSettings.value = await desktop.getSettings();
        desktopVersion.value = await desktop.version();
    } catch {
        // A missing bridge method is not worth breaking the page over.
    }
});

async function saveDesktop(next) {
    if (!desktop) return;
    try {
        desktopSettings.value = await desktop.setSettings(next);
    } catch (error) {
        ElMessage.error(error.message);
    }
}

async function importFromDocker() {
    if (!desktop) return;
    importing.value = true;
    try {
        const result = await desktop.importFromDocker();
        if (result.imported) ElMessage.success(result.message);
        else ElMessage.info(result.message);
    } catch (error) {
        ElMessage.error(error.message);
    } finally {
        importing.value = false;
    }
}

const signingOut = ref(false);
async function signOut() {
    const name = store.auth.user?.displayName ?? "this account";
    const ok = window.confirm(
        `Sign out of ${name}?\n\n` +
            "The token is revoked with Twitch and the bot restarts to the login screen. " +
            "Your claimed drops, settings and Steam library are kept, and come back when " +
            "you sign in again.",
    );
    if (!ok) return;
    signingOut.value = true;
    try {
        await fetch("/api/auth/logout", { method: "POST" });
        ElMessage.success("Signed out. Restarting...");
        // The daemon exits and the container brings it back at the login screen.
        setTimeout(() => window.location.reload(), 3000);
    } catch (error) {
        signingOut.value = false;
        ElMessage.error(error.message);
    }
}

/**
 * Save first, then send. The fields autosave on a debounce, so testing without waiting for
 * that would quietly test the previous value - which looks like the new one failing.
 */
async function test(service) {
    testing.value = true;
    testingService.value = service ?? "";
    try {
        clearTimeout(saveTimer);
        await persist();
        const body = await store.testNotification(service);

        const failed = (body.results ?? []).filter((result) => !result.ok);
        if (!failed.length) {
            const sent = (body.results ?? []).map((result) => result.label).join(", ");
            ElMessage.success(sent ? `Sent via ${sent}.` : "Test notification sent.");
        } else {
            for (const result of failed) {
                ElMessage.error(`${result.label}: ${result.error ?? "failed"}`);
            }
        }
    } catch (error) {
        ElMessage.error(error.message);
    } finally {
        testing.value = false;
        testingService.value = "";
    }
}

const inputStyle = {
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    color: "var(--text)",
};
</script>

<template>
    <div class="space-y-4 max-w-[1100px]">
        <header class="card p-2 px-3 flex items-baseline justify-between sticky top-0 z-10">
            <h1 class="text-[13px] font-semibold">Settings</h1>
            <span class="text-[12px] h-4" :style="{ color: saved ? 'var(--success)' : 'var(--muted)' }">
                {{ saved ? "Saved" : "Changes save automatically" }}
            </span>
        </header>

        <nav v-if="!isCompact" class="flex gap-1 flex-wrap">
            <button
                v-for="tab in TABS"
                :key="tab.id"
                class="px-3 py-1.5 rounded-lg text-[12px] transition-colors"
                :style="
                    activeTab === tab.id
                        ? { background: 'var(--accent)', color: 'white' }
                        : { background: 'var(--surface)', color: 'var(--text-2)' }
                "
                @click="activeTab = tab.id"
            >
                {{ tab.label }}
            </button>
        </nav>

        <!--
            Multi-column rather than a grid: a grid aligns rows to the tallest card, which
            left a short card like Claiming sitting above a large void. Columns let the cards
            pack against each other instead.
        -->
        <div class="xl:columns-2 xl:gap-4">

        <!-- In the narrow window everything is on one page, so the categories that
             are tabs on a wide screen become the same full-bleed bands the compact
             dashboard uses. -->
        <div
            v-if="isCompact"
            class="-mx-4 px-4 py-1.5 mb-3"
            :style="{ background: 'var(--surface-2)' }"
        >
            <span class="text-[10px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                Mining
            </span>
        </div>
        <section v-if="visible('mining')" class="card p-4 space-y-4 break-inside-avoid mb-4">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">Claiming</h2>
            <label class="flex items-center justify-between gap-4">
                <span class="text-[13px]">Claim drops automatically</span>
                <el-switch v-model="form.autoClaimDrops" />
            </label>
            <label class="flex items-center justify-between gap-4">
                <span class="text-[13px]">Claim channel points bonuses</span>
                <el-switch v-model="form.autoClaimPoints" />
            </label>
            <label class="flex items-center justify-between gap-4">
                <span>
                    <span class="text-[13px]">Leave instantly on a category change</span>
                    <span class="block text-[11px]" :style="{ color: 'var(--text-2)' }">
                        Watch time stops counting when a streamer switches to a category the
                        campaign does not cover. This is already noticed either way &mdash; the
                        drop stops progressing and the channel is dropped after about fifteen
                        minutes. Turning this on subscribes to the change and reacts at once,
                        at the cost of one extra subscription per channel watched.
                    </span>
                </span>
                <el-switch v-model="form.switchOnCategoryChange" />
            </label>
        </section>
        <section v-if="visible('mining')" class="card p-4 space-y-4 break-inside-avoid mb-4">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                Which games to mine
            </h2>
            <p class="text-[12px]" :style="{ color: 'var(--text-2)' }">
                Twitch runs campaigns for hundreds of games at once. Watching one you neither
                own nor asked for earns a reward you cannot use.
            </p>

            <label class="flex items-center justify-between gap-4">
                <span>
                    <span class="text-[13px]">Limit to games I own</span>
                    <span class="block text-[11px]" :style="{ color: 'var(--text-2)' }">
                        Your
                        <RouterLink to="/priorities" class="underline" :style="{ color: 'var(--accent)' }">priority list</RouterLink>
                        always counts as owned &mdash; that is how you include anything Steam
                        cannot see, like an Epic or console title, or a category such as
                        &ldquo;Special Events&rdquo;.
                    </span>
                </span>
                <select v-model="form.libraryPolicy" class="px-2 py-1.5 rounded-lg text-[12px] outline-none shrink-0 max-w-[210px]" :style="inputStyle">
                    <option value="ownedOrListed">Owned or on my list</option>
                    <option value="all">Any game with a campaign</option>
                </select>
            </label>

            <p v-if="form.libraryPolicy === 'ownedOrListed' && !steam?.connected"
               class="text-[11px]" :style="{ color: 'var(--warn)' }">
                No Steam library connected, so this is currently inactive &mdash; every game is
                being mined.
                <!-- "below" was true on one long page and is not once this is a tab. -->
                <button
                    class="underline"
                    :style="{ color: 'var(--accent)' }"
                    @click="activeTab = 'accounts'"
                >{{ isCompact ? "Connect Steam under Accounts" : "Connect Steam" }}</button>
                to apply it.
            </p>
            <p v-else-if="form.libraryPolicy === 'ownedOrListed'"
               class="text-[11px]" :style="{ color: 'var(--text-2)' }">
                Active &mdash; matching against {{ steam?.gameCount || 0 }} owned games.
            </p>
        </section>
        <section v-if="visible('mining')" class="card p-4 space-y-4 break-inside-avoid mb-4">
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
        <section v-if="visible('mining')" class="card p-4 space-y-4 break-inside-avoid mb-4">
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
        <!-- In the narrow window everything is on one page, so the categories that
             are tabs on a wide screen become the same full-bleed bands the compact
             dashboard uses. -->
        <div
            v-if="isCompact"
            class="-mx-4 px-4 py-1.5 mb-3"
            :style="{ background: 'var(--surface-2)' }"
        >
            <span class="text-[10px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                Notifications
            </span>
        </div>
        <section v-if="visible('notifications')" class="card p-4 space-y-3 break-inside-avoid mb-4">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">Notifications</h2>
            <!--
                Numbered rather than two bare boxes. Creating the bot is easy; finding the
                chat ID is where people give up, so that step does the work itself instead
                of naming a number and leaving them to find it.
            -->
            <div class="rounded-lg p-3 space-y-3" :style="{ background: 'var(--surface-2)' }">
                <div class="flex items-baseline gap-2">
                    <span class="text-[12px] font-medium">Telegram</span>
                    <span class="text-[11px]" :style="{ color: 'var(--text-2)' }">
                        Get a message when a drop is claimed.
                    </span>
                </div>

                <div class="flex gap-2">
                    <span class="tg-step" :style="stepStyle(Boolean(form.telegramBotToken))">1</span>
                    <div class="flex-1 min-w-0">
                        <p class="text-[12px]">Make a bot for yourself</p>
                        <p class="text-[11px] mb-1.5" :style="{ color: 'var(--text-2)' }">
                            Open BotFather in Telegram, send it <code>/newbot</code>, and follow
                            the two questions. It replies with a token.
                        </p>
                        <a
                            href="https://t.me/BotFather"
                            target="_blank"
                            rel="noreferrer"
                            class="text-[11px] underline"
                            :style="{ color: 'var(--accent)' }"
                        >Open BotFather</a>
                    </div>
                </div>

                <div class="flex gap-2">
                    <span class="tg-step" :style="stepStyle(Boolean(tgBot))">2</span>
                    <div class="flex-1 min-w-0">
                        <p class="text-[12px] mb-1.5">Paste the token</p>
                        <div class="flex gap-2">
                            <input
                                v-model="form.telegramBotToken"
                                type="password"
                                placeholder="1234567890:AA..."
                                class="flex-1 min-w-0 px-3 py-2 rounded-lg text-[12px] outline-none"
                                :style="inputStyle"
                            />
                            <button
                                class="px-3 py-2 rounded-lg text-[12px] shrink-0"
                                :style="{ background: 'var(--surface)', color: 'var(--text)' }"
                                :disabled="tgChecking || !form.telegramBotToken"
                                @click="checkTelegramBot"
                            >
                                {{ tgChecking ? "Checking&hellip;" : "Check" }}
                            </button>
                        </div>
                        <p v-if="tgBot" class="text-[11px] mt-1" :style="{ color: 'var(--ok, var(--accent))' }">
                            Connected to @{{ tgBot.username }}.
                        </p>
                        <p v-else-if="tgBotError" class="text-[11px] mt-1" :style="{ color: 'var(--warn)' }">
                            {{ tgBotError }}
                        </p>
                    </div>
                </div>

                <div class="flex gap-2">
                    <span class="tg-step" :style="stepStyle(Boolean(form.telegramChatId))">3</span>
                    <div class="flex-1 min-w-0">
                        <p class="text-[12px]">Say hello to it</p>
                        <p class="text-[11px] mb-1.5" :style="{ color: 'var(--text-2)' }">
                            Send your bot any message in Telegram, then press this &mdash; it
                            reads the chat ID off that message, so you never have to find it.
                        </p>
                        <div class="flex gap-2">
                            <input
                                v-model="form.telegramChatId"
                                placeholder="Chat ID"
                                class="flex-1 min-w-0 px-3 py-2 rounded-lg text-[12px] outline-none"
                                :style="inputStyle"
                            />
                            <button
                                class="px-3 py-2 rounded-lg text-[12px] shrink-0"
                                :style="{ background: 'var(--surface)', color: 'var(--text)' }"
                                :disabled="tgDetecting || !form.telegramBotToken"
                                @click="detectTelegramChat"
                            >
                                {{ tgDetecting ? "Looking&hellip;" : "Find it for me" }}
                            </button>
                        </div>
                        <p v-if="tgChat" class="text-[11px] mt-1" :style="{ color: 'var(--text-2)' }">
                            Found {{ tgChat.label }}.
                        </p>
                        <p v-else-if="tgChatError" class="text-[11px] mt-1" :style="{ color: 'var(--warn)' }">
                            {{ tgChatError }}
                        </p>
                    </div>
                </div>

                <button
                    class="px-3 py-1.5 rounded-lg text-[12px]"
                    :style="{ background: 'var(--surface)', color: 'var(--text)' }"
                    :disabled="testing"
                    @click="test('telegram')"
                >
                    {{ testing && testingService === "telegram" ? "Sending&hellip;" : "Test Telegram" }}
                </button>
            </div>
            <!--
                Two routes, because they suit different people. A webhook is a URL out of
                channel settings and needs no bot at all; a bot posts under an identity you
                already own. Whichever is configured is the one shown on arrival.
            -->
            <div class="rounded-lg p-3 space-y-3" :style="{ background: 'var(--surface-2)' }">
                <div class="flex items-baseline gap-2 flex-wrap">
                    <span class="text-[12px] font-medium">Discord</span>
                    <span class="text-[11px]" :style="{ color: 'var(--text-2)' }">
                        The same messages, in a channel.
                    </span>
                    <div class="ml-auto flex gap-1">
                        <button
                            v-for="mode in [{ id: 'webhook', label: 'Webhook' }, { id: 'bot', label: 'Bot' }]"
                            :key="mode.id"
                            class="text-[10px] px-2 py-0.5 rounded"
                            :style="
                                discordMode === mode.id
                                    ? { background: 'var(--surface)', color: 'var(--text)' }
                                    : { color: 'var(--muted)' }
                            "
                            @click="discordMode = mode.id"
                        >
                            {{ mode.label }}
                        </button>
                    </div>
                </div>

                <template v-if="discordMode === 'webhook'">
                    <div>
                        <p class="text-[11px] mb-1.5" :style="{ color: 'var(--text-2)' }">
                            In Discord, open the channel's settings &rarr; Integrations &rarr;
                            Webhooks &rarr; New Webhook, then Copy Webhook URL. No bot needed.
                        </p>
                        <input
                            v-model="form.discordWebhookUrl"
                            type="password"
                            placeholder="https://discord.com/api/webhooks/..."
                            class="w-full px-3 py-2 rounded-lg text-[12px] outline-none"
                            :style="inputStyle"
                        />
                    </div>
                </template>

                <template v-else>
                    <div class="flex gap-2">
                        <span class="tg-step" :style="stepStyle(Boolean(form.discordBotToken))">1</span>
                        <div class="flex-1 min-w-0">
                            <p class="text-[12px]">Make an application</p>
                            <p class="text-[11px] mb-1.5" :style="{ color: 'var(--text-2)' }">
                                In the Developer Portal: New Application &rarr; Bot &rarr; Reset
                                Token, and copy what it shows you. It is only shown once.
                            </p>
                            <a
                                href="https://discord.com/developers/applications"
                                target="_blank"
                                rel="noreferrer"
                                class="text-[11px] underline"
                                :style="{ color: 'var(--accent)' }"
                            >Open the Developer Portal</a>
                        </div>
                    </div>

                    <div class="flex gap-2">
                        <span class="tg-step" :style="stepStyle(Boolean(dcBot))">2</span>
                        <div class="flex-1 min-w-0">
                            <p class="text-[12px] mb-1.5">Paste the bot token</p>
                            <div class="flex gap-2">
                                <input
                                    v-model="form.discordBotToken"
                                    type="password"
                                    class="flex-1 min-w-0 px-3 py-2 rounded-lg text-[12px] outline-none"
                                    :style="inputStyle"
                                />
                                <button
                                    class="px-3 py-2 rounded-lg text-[12px] shrink-0"
                                    :style="{ background: 'var(--surface)', color: 'var(--text)' }"
                                    :disabled="dcChecking || !form.discordBotToken"
                                    @click="checkDiscordBot"
                                >
                                    {{ dcChecking ? "Checking&hellip;" : "Check" }}
                                </button>
                            </div>
                            <p v-if="dcBot" class="text-[11px] mt-1" :style="{ color: 'var(--text-2)' }">
                                Connected to {{ dcBot.username }}.
                                <a
                                    v-if="discordInviteUrl"
                                    :href="discordInviteUrl"
                                    target="_blank"
                                    rel="noreferrer"
                                    class="underline"
                                    :style="{ color: 'var(--accent)' }"
                                >Invite it to a server</a>
                            </p>
                            <p v-else-if="dcBotError" class="text-[11px] mt-1" :style="{ color: 'var(--warn)' }">
                                {{ dcBotError }}
                            </p>
                        </div>
                    </div>

                    <div class="flex gap-2">
                        <span class="tg-step" :style="stepStyle(Boolean(form.discordChannelId))">3</span>
                        <div class="flex-1 min-w-0">
                            <p class="text-[12px]">Pick a channel</p>
                            <p class="text-[11px] mb-1.5" :style="{ color: 'var(--text-2)' }">
                                Once the bot is in your server, ask it what it can see &mdash;
                                Discord hides channel IDs unless you turn on Developer Mode.
                            </p>
                            <div class="flex gap-2">
                                <select
                                    v-if="dcChannels.length"
                                    v-model="form.discordChannelId"
                                    class="flex-1 min-w-0 px-2 py-2 rounded-lg text-[12px] outline-none"
                                    :style="inputStyle"
                                >
                                    <option value="">Choose a channel&hellip;</option>
                                    <option v-for="channel in dcChannels" :key="channel.id" :value="channel.id">
                                        {{ channel.guild }} &middot; #{{ channel.name }}
                                    </option>
                                </select>
                                <input
                                    v-else
                                    v-model="form.discordChannelId"
                                    placeholder="Channel ID"
                                    class="flex-1 min-w-0 px-3 py-2 rounded-lg text-[12px] outline-none"
                                    :style="inputStyle"
                                />
                                <button
                                    class="px-3 py-2 rounded-lg text-[12px] shrink-0"
                                    :style="{ background: 'var(--surface)', color: 'var(--text)' }"
                                    :disabled="dcLoadingChannels || !form.discordBotToken"
                                    @click="loadDiscordChannels"
                                >
                                    {{ dcLoadingChannels ? "Looking&hellip;" : "List channels" }}
                                </button>
                            </div>
                            <p v-if="dcTruncated && dcChannels.length" class="text-[11px] mt-1" :style="{ color: 'var(--muted)' }">
                                Showing the first few servers only.
                            </p>
                            <p v-if="dcChannelError" class="text-[11px] mt-1" :style="{ color: 'var(--warn)' }">
                                {{ dcChannelError }}
                            </p>
                        </div>
                    </div>
                </template>

                <button
                    class="px-3 py-1.5 rounded-lg text-[12px]"
                    :style="{ background: 'var(--surface)', color: 'var(--text)' }"
                    :disabled="testing"
                    @click="test('discord')"
                >
                    {{ testing && testingService === "discord" ? "Sending&hellip;" : "Test Discord" }}
                </button>
            </div>

            <button class="px-3 py-1.5 rounded-lg text-[12px]" :style="{ background: 'var(--surface-2)', color: 'var(--text)' }"
                    :disabled="testing" @click="test()">
                {{ testing && !testingService ? "Sending&hellip;" : "Send test notification" }}
            </button>
        </section>
        <!-- In the narrow window everything is on one page, so the categories that
             are tabs on a wide screen become the same full-bleed bands the compact
             dashboard uses. -->
        <div
            v-if="isCompact"
            class="-mx-4 px-4 py-1.5 mb-3"
            :style="{ background: 'var(--surface-2)' }"
        >
            <span class="text-[10px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                Accounts
            </span>
        </div>
        <section v-if="visible('accounts')" class="card p-4 space-y-3 break-inside-avoid mb-4">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                Twitch account
            </h2>
            <div class="rounded-lg p-3 flex items-center gap-3" :style="{ background: 'var(--surface-2)' }">
                <div class="flex-1 min-w-0">
                    <p class="text-[13px] font-medium">
                        {{ store.auth.user?.displayName || "Not signed in" }}
                    </p>
                    <p class="text-[11px]" :style="{ color: 'var(--text-2)' }">
                        Signing out revokes the token with Twitch. Your drops, settings and
                        Steam library are kept for when you come back.
                    </p>
                </div>
                <button
                    class="px-3 py-1.5 rounded-lg text-[12px] shrink-0"
                    :style="{ color: 'var(--danger)' }"
                    :disabled="signingOut"
                    @click="signOut"
                >
                    {{ signingOut ? "Signing out..." : "Sign out" }}
                </button>
            </div>
        </section>
        <section v-if="visible('accounts')" class="card p-4 space-y-3 break-inside-avoid mb-4">
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
                        &middot; via {{ steam.provider === "sinfulshadows" ? "SinfulShadows" : "your Steam key" }}
                        <template v-if="steam.fetchedAt"> &middot; synced {{ formatRelative(steam.fetchedAt) }}</template>

                        <template v-if="steam.stale"> &middot; cached</template>
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

            <!-- Steam only reports a last-played time to the key that owns the account, so a
                 borrowed key cannot rank by recency and quietly falls back. Say so. -->
            <p v-if="steam?.connected && steam?.recencySignal && steam.recencySignal !== 'lastPlayed'"
               class="text-[11px]" :style="{ color: 'var(--text-2)' }">
                &ldquo;Recently played&rdquo; ranking is using
                {{ steam.recencySignal === "playtimeRecent" ? "two-week playtime" : "total playtime" }}
                &mdash; Steam only reveals last-played times to the key that owns the account.
            </p>

            <!-- Two ways in. The SinfulShadows one is first because it asks for less. -->
            <div class="flex gap-1 p-1 rounded-lg" :style="{ background: 'var(--surface-2)' }">
                <button
                    v-for="option in [['sinfulshadows', 'SinfulShadows account'], ['direct', 'Your own Steam key']]"
                    :key="option[0]"
                    class="flex-1 px-3 py-1.5 rounded-md text-[12px]"
                    :style="steamProvider === option[0]
                        ? { background: 'var(--surface)', color: 'var(--text)' }
                        : { color: 'var(--text-2)' }"
                    @click="steamProvider = option[0]"
                >
                    {{ option[1] }}
                </button>
            </div>

            <template v-if="steamProvider === 'sinfulshadows'">
                <label class="block">
                    <span class="text-[12px]">SinfulShadows API key</span>
                    <span class="block text-[11px] mb-1" :style="{ color: 'var(--text-2)' }">
                        No Steam key needed. Create one at
                        <a href="https://sinfulshadows.com/settings/api" target="_blank" rel="noreferrer" class="underline">sinfulshadows.com &rarr; Settings &rarr; API keys</a>.
                        Your library comes from the Steam account linked there, so link Steam
                        on the site first.
                    </span>
                    <input v-model="ssApiKey" type="password" placeholder="ss_..."
                           class="w-full px-3 py-2 rounded-lg text-[12px] outline-none" :style="inputStyle" />
                </label>
                <div class="flex items-center gap-2 flex-wrap">
                    <button
                        class="px-3 py-1.5 rounded-lg text-[12px] text-white"
                        :style="{ background: 'var(--accent)' }"
                        :disabled="steamBusy"
                        @click="connectSinfulShadows"
                    >
                        {{ steamBusy ? "Connecting..." : steam?.hasSinfulShadowsKey ? "Update key" : "Connect" }}
                    </button>
                    <span class="text-[11px]" :style="{ color: 'var(--text-2)' }">
                        Not autosaved &mdash; press Connect to apply.
                    </span>
                </div>
            </template>

            <template v-else>
                <template v-if="!steam?.connected || steam?.provider !== 'direct'">
                    <a href="/api/steam/login" class="inline-block px-3 py-2 rounded-lg text-[13px] font-medium text-white" :style="{ background: '#1b2838' }">
                        Sign in through Steam
                    </a>
                    <input v-model="steamAccount" placeholder="Or paste a profile URL / 17-digit Steam ID"
                           class="w-full px-3 py-2 rounded-lg text-[12px] outline-none" :style="inputStyle" />
                </template>

                <label class="block">
                    <span class="text-[12px]">Steam Web API key</span>
                    <span class="block text-[11px] mb-1" :style="{ color: 'var(--text-2)' }">
                        Required to read your library. Your profile URL alone identifies the
                        account, but only a key grants access to what is in it. Get one at
                        <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noreferrer" class="underline">steamcommunity.com/dev/apikey</a>.
                        Your profile's &ldquo;Game details&rdquo; must be public.
                    </span>
                    <input v-model="steamApiKey" type="password" class="w-full px-3 py-2 rounded-lg text-[12px] outline-none" :style="inputStyle" />
                </label>
                <!-- Connecting makes live API calls, so it is an explicit action rather than
                     part of the page's autosave. -->
                <div class="flex items-center gap-2 flex-wrap">
                    <button
                        class="px-3 py-1.5 rounded-lg text-[12px] text-white"
                        :style="{ background: 'var(--accent)' }"
                        :disabled="steamBusy"
                        @click="connectSteam"
                    >
                        {{ steamBusy ? "Connecting..." : steam?.hasApiKey ? "Update key" : "Connect Steam" }}
                    </button>
                    <span v-if="steam?.steamId && !steam?.hasApiKey" class="text-[11px]" :style="{ color: 'var(--warn)' }">
                        Account identified. A key is still needed to read the library.
                    </span>
                    <span v-else class="text-[11px]" :style="{ color: 'var(--text-2)' }">
                        Not autosaved &mdash; press Connect to apply.
                    </span>
                </div>
            </template>
        </section>
        <!-- In the narrow window everything is on one page, so the categories that
             are tabs on a wide screen become the same full-bleed bands the compact
             dashboard uses. -->
        <div
            v-if="isCompact"
            class="-mx-4 px-4 py-1.5 mb-3"
            :style="{ background: 'var(--surface-2)' }"
        >
            <span class="text-[10px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                Advanced
            </span>
        </div>
        <section v-if="desktop && visible('advanced')" class="card p-4 space-y-4 break-inside-avoid mb-4">
            <h2 class="text-[11px] uppercase tracking-wider" :style="{ color: 'var(--text-2)' }">
                Desktop app
            </h2>

            <label class="flex items-center justify-between gap-4">
                <span>
                    <span class="text-[13px]">Start with Windows</span>
                    <span class="block text-[11px]" :style="{ color: 'var(--text-2)' }">
                        Starts hidden in the tray, so mining resumes without a window
                        appearing.
                    </span>
                </span>
                <el-switch
                    :model-value="desktopSettings.runAtLogin"
                    @update:model-value="(v) => saveDesktop({ runAtLogin: v })"
                />
            </label>

            <label class="flex items-center justify-between gap-4">
                <span>
                    <span class="text-[13px]">Close to tray</span>
                    <span class="block text-[11px]" :style="{ color: 'var(--text-2)' }">
                        Closing the window keeps mining. Turn this off and the close button
                        quits instead.
                    </span>
                </span>
                <el-switch
                    :model-value="desktopSettings.closeToTray"
                    @update:model-value="(v) => saveDesktop({ closeToTray: v })"
                />
            </label>

            <div class="flex items-center justify-between gap-4">
                <span>
                    <span class="text-[13px]">Import from a Docker install</span>
                    <span class="block text-[11px]" :style="{ color: 'var(--text-2)' }">
                        Copies credentials and drop history across. Stop the container
                        first &mdash; both mining one account is what corrupts progress.
                    </span>
                </span>
                <button
                    class="px-3 py-1.5 rounded-lg text-[12px] shrink-0"
                    :style="{ background: 'var(--surface-2)', color: 'var(--text)' }"
                    :disabled="importing"
                    @click="importFromDocker"
                >
                    {{ importing ? "Importing..." : "Choose folder" }}
                </button>
            </div>

            <div class="flex items-center justify-between gap-4">
                <span class="text-[11px]" :style="{ color: 'var(--text-2)' }">
                    Desktop build {{ desktopVersion }}
                </span>
                <button
                    class="px-3 py-1.5 rounded-lg text-[12px] shrink-0"
                    :style="{ background: 'var(--surface-2)', color: 'var(--text)' }"
                    @click="desktop.openLogsFolder()"
                >
                    Open logs
                </button>
            </div>
        </section>
        <section v-if="visible('advanced')" class="card p-4 space-y-4 break-inside-avoid mb-4">
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
                <span>
                    <span class="text-[13px]">Allow the live stream player</span>
                    <span class="block text-[11px]" :style="{ color: 'var(--text-2)' }">
                        Plays the stream being mined, muted, on the dashboard. It is embedded
                        signed out &mdash; the player never receives your Twitch cookies, so it
                        watches as a guest and cannot open a second watch session on your
                        account or interfere with mining. Being a guest also means ad breaks:
                        either an advertiser's video or Twitch's own "commercial break in
                        progress" filler, with no supported way to detect or skip them. The
                        thumbnail costs nothing and shows no ads.
                    </span>
                    <span
                        v-if="!canEmbedAnonymously"
                        class="block text-[11px] mt-1"
                        :style="{ color: 'var(--warn)' }"
                    >
                        Unavailable in this browser: it cannot embed the player signed out, and
                        a signed-in player would risk stalling the miner. Chrome, Edge and the
                        desktop app support it.
                    </span>
                </span>
                <el-switch v-model="form.allowStreamEmbed" :disabled="!canEmbedAnonymously" />
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
    </div>
</template>

<style scoped>
/*
 * Label beside control needs width this window does not have. Left alone, the control keeps
 * its size and the explanation next to it is squeezed to two words a line, which is how the
 * narrow settings page read before this. Same 560px the layout uses elsewhere.
 */
@media (max-width: 559px) {
    label.flex.items-center.justify-between {
        flex-direction: column;
        align-items: stretch;
        gap: 0.5rem;
    }

    label.flex.items-center.justify-between :is(select, input) {
        width: 100%;
        max-width: 100%;
    }

    /* Switches would stretch to the full width and look like a bug, so they stay put. */
    label.flex.items-center.justify-between :deep(.el-switch) {
        align-self: flex-start;
    }
}

.tg-step {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    margin-top: 1px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
}
</style>
