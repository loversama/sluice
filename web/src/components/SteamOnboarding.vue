<script setup>
import { computed, ref, watch } from "vue";

import { useMinerStore } from "@/stores/miner.js";
import { useViewport } from "@/lib/viewport.js";

/**
 * The three ways to link Steam, in one place.
 *
 * Rendered twice: as a sheet the moment Twitch sign-in finishes, and inline in
 * Settings -> Accounts. One component rather than two, so the wording, the ordering and the
 * handling of a private library cannot drift apart - the second copy is always the one that
 * gets forgotten.
 *
 * No key is asked for, of any kind. Steam is read through a service that holds one, so all
 * that is wanted here is which account is the user's - and a Steam ID names a public
 * profile, which is why offering to paste one is reasonable at all.
 */
const props = defineProps({
    /** Inline in Settings rather than over the top of everything. */
    embedded: { type: Boolean, default: false },
});
const emit = defineEmits(["close"]);

const store = useMinerStore();
const { isCompact } = useViewport();

const profileInput = ref("");
const busy = ref(false);
/** What went wrong, and whether the account ended up linked regardless. */
const failure = ref(null);
const showPaste = ref(false);

/**
 * A sign-in can finish anywhere - the desktop build deliberately sends it out to the user's
 * real browser - so the answer arrives over SSE rather than from a click in here.
 *
 * Not while this component is the one doing the linking, though: pasting a profile whose
 * library turns out to be private links the account and reports a problem, and closing on
 * the link would take the explanation off the screen before it was read.
 */
watch(
    () => store.steam.linked,
    (linked) => {
        if (linked && !props.embedded && !busy.value && !failure.value) {
            emit("close");
        }
    },
);

/**
 * The sheet is a dialog on a wide screen and a full-viewport sheet on a narrow one.
 *
 * Compact is a mode rather than a width: on the desktop side panel it is chosen, and stays
 * chosen however wide the window gets. So this is the narrow *form*, not a dialog shrunk
 * down to fit - full-bleed, with buttons that run the width.
 */
const overlayClass = computed(() => {
    if (props.embedded) return "";
    return isCompact.value
        ? "fixed inset-0 z-50 flex items-stretch"
        : "fixed inset-0 z-50 flex items-center justify-center p-6";
});

const panelClass = computed(() => {
    if (props.embedded) return "";
    return isCompact.value
        ? "card w-full rounded-none overflow-y-auto"
        : "card w-full max-w-[440px]";
});

async function post(path, body) {
    const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error ?? `Request failed (${response.status})`);
    }
    return data;
}

async function usePastedProfile() {
    if (!profileInput.value.trim() || busy.value) return;
    busy.value = true;
    failure.value = null;
    try {
        const result = await post("/api/steam/connect", { steamId: profileInput.value });
        if (result.error) {
            // The account linked; only its library did not come back. Reporting that as a
            // failed link would send someone off to redo something that already worked.
            failure.value = { message: result.error.message, linked: true };
        } else {
            profileInput.value = "";
            if (!props.embedded) emit("close");
        }
    } catch (error) {
        failure.value = { message: error.message, linked: false };
    } finally {
        busy.value = false;
        await store.hydrate();
    }
}

async function skip() {
    busy.value = true;
    try {
        await post("/api/steam/skip");
    } catch {
        /* Nothing to recover: Settings still offers it, and the prompt closes either way. */
    } finally {
        busy.value = false;
        await store.hydrate();
        emit("close");
    }
}
</script>

<template>
    <div :class="overlayClass" :style="embedded ? null : { background: 'rgba(0, 0, 0, 0.55)' }">
        <div :class="panelClass">
            <div v-if="!embedded" class="flex items-start gap-3 p-4 pb-0">
                <div class="flex-1">
                    <h2 class="text-[15px] font-semibold">Link your Steam library</h2>
                    <p class="text-[12px] mt-1" :style="{ color: 'var(--text-2)' }">
                        It lets Sluice rank campaigns by the games you actually own and play,
                        and point out which accounts are worth linking.
                    </p>
                </div>
                <!-- Closing is "not now", not an answer. Only Skip is remembered. -->
                <button
                    class="px-2 py-1 rounded-lg text-[13px] shrink-0"
                    :style="{ color: 'var(--text-2)' }"
                    title="Not now"
                    @click="emit('close')"
                >
                    &#10005;
                </button>
            </div>

            <div class="space-y-3" :class="embedded ? '' : 'p-4'">
                <!-- Steam's own sign-in first: it needs nothing typed and cannot name the
                     wrong account.

                     In a new tab deliberately. The round trip ends on a page that says
                     "close this tab and go back to Sluice", which is only true if the
                     dashboard is still open behind it - and on the desktop build a new
                     window is what sends the whole thing out to a real browser, where the
                     address bar and a password manager both work. Either way the answer
                     comes back over the event stream rather than from this click. -->
                <a
                    href="/api/steam/login"
                    target="_blank"
                    rel="noopener"
                    class="block w-full py-2.5 rounded-lg text-center font-medium text-[13px] text-white"
                    :style="{ background: '#1b2838' }"
                >
                    Sign in through Steam
                </a>

                <button
                    v-if="!showPaste"
                    class="block w-full py-2.5 rounded-lg text-[13px]"
                    :style="{ background: 'var(--surface-2)', color: 'var(--text)' }"
                    @click="showPaste = true"
                >
                    Paste a profile URL instead
                </button>

                <div v-else class="space-y-2">
                    <label class="block">
                        <span class="text-[12px]">Steam profile</span>
                        <span class="block text-[11px] mb-1" :style="{ color: 'var(--text-2)' }">
                            Your profile URL, custom URL name, or 17-digit Steam ID. Both the
                            profile and its &ldquo;Game details&rdquo; have to be public, or
                            there is nothing for Sluice to read.
                        </span>
                        <input
                            v-model="profileInput"
                            placeholder="steamcommunity.com/id/yourname"
                            class="w-full px-3 py-2 rounded-lg text-[12px] outline-none"
                            :style="{
                                background: 'var(--surface-2)',
                                border: '1px solid var(--border)',
                                color: 'var(--text)',
                            }"
                            @keyup.enter="usePastedProfile"
                        />
                    </label>
                    <button
                        class="block w-full py-2.5 rounded-lg text-[13px] font-medium text-white"
                        :style="{ background: 'var(--accent)' }"
                        :disabled="busy || !profileInput.trim()"
                        @click="usePastedProfile"
                    >
                        {{ busy ? "Reading your library..." : "Use this profile" }}
                    </button>
                </div>

                <!-- A library that will not come back is not a failed link, and the two
                     read very differently to someone who has just signed in. -->
                <p
                    v-if="failure"
                    class="text-[11px]"
                    :style="{ color: failure.linked ? 'var(--warn)' : 'var(--danger)' }"
                >
                    <template v-if="failure.linked">Account linked, but&nbsp;</template>
                    {{ failure.message }}
                    <button class="underline" :disabled="busy" @click="usePastedProfile">
                        Try again
                    </button>
                </p>

                <!-- Offered wherever the question has not been answered, including in
                     Settings: "no thanks" is a real answer and should be sayable from
                     either place. Once it has been said there is nothing left to skip. -->
                <button
                    v-if="!embedded || store.steam.linked === null"
                    class="block w-full py-2.5 rounded-lg text-[13px]"
                    :style="{ color: 'var(--text-2)' }"
                    :disabled="busy"
                    @click="skip"
                >
                    Skip &mdash; do not use my Steam library
                </button>

                <p v-if="!embedded" class="text-[11px] text-center" :style="{ color: 'var(--muted)' }">
                    You can link it later in Settings &rarr; Accounts.
                </p>
            </div>
        </div>
    </div>
</template>
