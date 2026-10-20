import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";

import { DEFAULT_CONFIG } from "../packages/core/src/config.js";
import { Campaign } from "../packages/core/src/models/campaign.js";
import type { Notification } from "../packages/core/src/notifiers/index.js";
import { wireMinerToBus } from "../packages/core/src/wiring.js";
import { makeCampaign } from "./fixtures.js";

/** Records what it was asked to send, standing in for a configured NotifierGroup. */
class RecordingNotifier {
    readonly sent: Notification[] = [];
    async send(notification: Notification): Promise<void> {
        this.sent.push(notification);
    }
}

function wire(getNotifier: () => RecordingNotifier) {
    const miner = new EventEmitter();
    const bus = new EventEmitter();
    wireMinerToBus({
        miner: miner as never,
        bus,
        getNotifier: getNotifier as never,
        getConfig: () => ({ ...DEFAULT_CONFIG }),
    });
    return { miner, bus };
}

function expiring(miner: EventEmitter): void {
    miner.emit("unlinked-expiring", {
        campaign: new Campaign(makeCampaign({ id: "c" })),
        earnedMinutes: 30,
        rewards: ["Hat"],
        hoursLeft: 2,
    });
}

describe("wireMinerToBus", () => {
    it("sends through the notifier in force now, not the one it was wired with", () => {
        // Saving settings builds a new notifier. A captured one kept delivering to the old
        // destination until the app was restarted.
        const before = new RecordingNotifier();
        const after = new RecordingNotifier();
        let current = before;
        const { miner } = wire(() => current);

        expiring(miner);
        current = after;
        expiring(miner);

        expect(before.sent).toHaveLength(1);
        expect(after.sent).toHaveLength(1);
    });
});
