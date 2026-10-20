import { describe, expect, it, vi } from "vitest";

import { TwitchGql } from "../packages/core/src/twitch/gql.js";

/**
 * DropCampaignDetails names its variable channelLogin, but it takes the numeric user ID.
 * Sending the login stopped working in October 2026 without an error: Twitch answered
 * `dropCampaign: null`, every campaign arrived without drops, an empty drop list counts as
 * "everything claimed", and the miner idled at "all caught up" for days.
 */
describe("getCampaignDetails", () => {
    it("sends the numeric user ID, not the login", async () => {
        const auth = { userId: "51786482", login: "someone" };
        const gql = new TwitchGql(auth as never);
        const query = vi
            .spyOn(gql, "query")
            .mockResolvedValue({ user: { dropCampaign: { id: "c" } } } as never);

        await gql.getCampaignDetails("c");

        expect(query).toHaveBeenCalledWith("campaignDetails", {
            dropID: "c",
            channelLogin: "51786482",
        });
    });
});
