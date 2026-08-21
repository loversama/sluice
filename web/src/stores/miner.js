import { defineStore } from "pinia";

/** Treat mining as stalled if progress has not moved for this long. */
const STALL_THRESHOLD_MS = 4 * 60_000;
/** Beats arrive every 59s; past this the heartbeat is suspect. */
const BEAT_TIMEOUT_MS = 75_000;

export const useMinerStore = defineStore("miner", {
    state: () => ({
        loaded: false,
        loadError: null,
        /** "connecting" | "open" | "lost" - drives the status strip. */
        connection: "connecting",

        daemon: null,
        auth: { status: "pending", user: null, device: null },
        mining: null,
        queue: [],
        nextRefreshAt: null,
        campaigns: [],
        claims: [],
        feed: [],

        config: null,
        /**
         * Set by a fatal `problem` event and cleared whenever a fresh snapshot arrives.
         * Declared here so Pinia makes it reactive - assigning it in an action alone left
         * the "Mining paused" banner unable to render.
         */
        fatal: null,
        /** Ticks every second so countdowns recompute without per-component timers. */
        now: Date.now(),

        source: null,
        clockTimer: null,
    }),

    getters: {
        campaignsById: (state) =>
            Object.fromEntries(state.campaigns.map((campaign) => [campaign.id, campaign])),

        activeCampaigns: (state) =>
            state.campaigns.filter((campaign) => campaign.status === "active" && !campaign.isCompleted),

        upcomingCampaigns: (state) =>
            [...state.campaigns.filter((campaign) => campaign.status === "upcoming")].sort(
                (a, b) => new Date(a.startAt) - new Date(b.startAt),
            ),

        completedCampaigns: (state) => state.campaigns.filter((campaign) => campaign.isCompleted),

        /** The campaign being mined right now. */
        currentCampaign(state) {
            return state.mining ? this.campaignsById[state.mining.campaignId] ?? null : null;
        },

        currentDrop(state) {
            const campaign = this.currentCampaign;
            if (!campaign || !state.mining) {
                return null;
            }
            return campaign.drops.find((drop) => drop.id === state.mining.dropId) ?? null;
        },

        /** Queue order as full campaign objects, excluding what is already being mined. */
        upNext(state) {
            return state.queue
                .filter((id) => id !== state.mining?.campaignId)
                .map((id) => this.campaignsById[id])
                .filter(Boolean);
        },

        /**
         * True when progress has gone quiet. The miner recovers on its own, so this is
         * informational - the UI must not imply the user has to act.
         */
        isStalled: (state) => {
            if (!state.mining?.lastProgressAt) {
                return false;
            }
            return state.now - state.mining.lastProgressAt > STALL_THRESHOLD_MS;
        },

        beatAge: (state) => (state.mining?.lastBeatAt ? state.now - state.mining.lastBeatAt : null),

        beatHealthy() {
            return this.beatAge !== null && this.beatAge < BEAT_TIMEOUT_MS;
        },

        secondsToRefresh: (state) =>
            state.nextRefreshAt
                ? Math.max(0, Math.round((new Date(state.nextRefreshAt) - state.now) / 1000))
                : null,
    },

    actions: {
        async hydrate() {
            try {
                const response = await fetch("/api/state");
                if (!response.ok) {
                    throw new Error(`Daemon returned ${response.status}`);
                }
                this.applySnapshot(await response.json());
                this.loadError = null;
                this.loaded = true;
            } catch (error) {
                this.loadError = error.message;
                this.loaded = true;
            }
        },

        applySnapshot(snapshot) {
            // A snapshot means the daemon is answering, so any previous fatal has passed
            // or the process was replaced.
            this.fatal = null;
            this.daemon = snapshot.daemon;
            this.auth = snapshot.auth;
            this.mining = snapshot.mining;
            this.queue = snapshot.queue ?? [];
            this.nextRefreshAt = snapshot.nextRefreshAt;
            this.campaigns = snapshot.campaigns ?? [];
            this.claims = snapshot.claims ?? [];
            this.feed = snapshot.feed ?? [];
        },

        async loadConfig() {
            const response = await fetch("/api/config");
            this.config = await response.json();
            return this.config;
        },

        async saveConfig(patch) {
            const response = await fetch("/api/config", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(patch),
            });
            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                throw new Error(body.error ?? `Save failed (${response.status})`);
            }
            this.config = await response.json();
            return this.config;
        },

        async testNotification() {
            const response = await fetch("/api/notify/test", { method: "POST" });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(body.error ?? "Test failed");
            }
        },

        connect() {
            if (this.source) {
                return;
            }
            if (!this.clockTimer) {
                this.clockTimer = setInterval(() => {
                    this.now = Date.now();
                }, 1000);
            }

            const source = new EventSource("/api/stream");
            this.source = source;

            source.onopen = () => {
                if (this.connection === "lost") {
                    // Re-fetch after a gap: SSE replay only covers what the server still holds.
                    this.hydrate();
                }
                this.connection = "open";
            };
            source.onerror = () => {
                // EventSource reconnects on its own; we only reflect the state.
                this.connection = "lost";
            };

            const on = (event, handler) =>
                source.addEventListener(event, (message) => {
                    try {
                        handler(JSON.parse(message.data));
                    } catch {
                        /* malformed frame - ignore rather than break the stream */
                    }
                });

            on("auth", (payload) => {
                this.auth = { ...this.auth, ...payload };
                if (payload.status === "ok") {
                    this.hydrate();
                }
            });

            on("watching", (payload) => {
                this.mining = {
                    channel: payload.channel,
                    campaignId: payload.campaignId,
                    dropId: payload.dropId,
                    since: Date.now(),
                    lastBeatAt: null,
                    lastProgressAt: Date.now(),
                };
            });

            on("beat", (payload) => {
                if (this.mining) {
                    this.mining = { ...this.mining, lastBeatAt: payload.at };
                }
            });

            on("progress", (payload) => {
                if (this.mining) {
                    this.mining = { ...this.mining, lastProgressAt: Date.now() };
                }
                const campaign = this.campaignsById[payload.campaignId];
                const drop = campaign?.drops.find((candidate) => candidate.id === payload.dropId);
                if (drop) {
                    drop.currentMinutes = payload.minutes;
                }
            });

            on("drop-claimed", (payload) => {
                this.claims = [payload, ...this.claims].slice(0, 50);
                const campaign = this.campaignsById[payload.campaignId];
                const drop = campaign?.drops.find((candidate) => candidate.id === payload.dropId);
                if (drop) {
                    drop.isClaimed = true;
                    drop.isClaimable = false;
                    drop.currentMinutes = drop.requiredMinutes;
                }
            });

            on("campaign-completed", (payload) => {
                const campaign = this.campaignsById[payload.campaignId];
                if (campaign) {
                    campaign.isCompleted = true;
                }
            });

            // Campaign sets are small, so replacing wholesale beats diffing.
            on("campaigns", (payload) => {
                this.campaigns = payload.campaigns ?? this.campaigns;
                this.queue = payload.queue ?? this.queue;
                if (payload.nextRefreshAt) {
                    this.nextRefreshAt = payload.nextRefreshAt;
                }
            });

            on("feed", (entry) => {
                this.feed = [entry, ...this.feed].slice(0, 200);
            });

            on("problem", (payload) => {
                this.feed = [
                    { at: Date.now(), level: payload.level === "fatal" ? "error" : "warn", message: payload.message },
                    ...this.feed,
                ].slice(0, 200);
                if (payload.level === "fatal") {
                    this.fatal = payload;
                }
            });
        },

        disconnect() {
            this.source?.close();
            this.source = null;
            if (this.clockTimer) {
                clearInterval(this.clockTimer);
                this.clockTimer = null;
            }
        },
    },
});
