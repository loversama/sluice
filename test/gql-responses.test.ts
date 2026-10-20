import { describe, expect, it, vi, beforeEach } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("undici", () => ({ request: requestMock }));

// Imported after the mock so the client picks up the stub.
const { GqlError, TwitchGql } = await import("../packages/core/src/twitch/gql.js");

function data(payload: unknown) {
    return {
        statusCode: 200,
        headers: {},
        body: {
            json: async () => ({ data: payload }),
            dump: async () => {},
        },
    };
}

const auth = { accessToken: "t", userId: "42", headers: () => ({}), refresh: async () => false };

describe("reading GQL answers", () => {
    beforeEach(() => {
        requestMock.mockReset();
    });

    it("reads a campaign list with no current user as no campaigns", async () => {
        // Not an error: the empty list is what sends a TV-client login to the catalogue.
        requestMock.mockResolvedValue(data({ currentUser: null }));
        const gql = new TwitchGql(auth as never);

        await expect(gql.getCampaigns()).resolves.toEqual([]);
        await expect(gql.getCampaigns()).resolves.toEqual([]);
    });

    it("returns the campaigns when there are some", async () => {
        requestMock.mockResolvedValue(data({ currentUser: { dropCampaigns: [{ id: "c1" }] } }));

        await expect(new TwitchGql(auth as never).getCampaigns()).resolves.toEqual([{ id: "c1" }]);
    });

    it("names an inventory answered with no current user as a GQL failure", async () => {
        // It used to dereference null, which read as a bug rather than a failed request.
        requestMock.mockResolvedValue(data({ currentUser: null }));

        await expect(new TwitchGql(auth as never).getInventory()).rejects.toBeInstanceOf(GqlError);
    });
});
