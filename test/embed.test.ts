import { describe, expect, it } from "vitest";

// @ts-expect-error - plain JS module shared with the dashboard build.
import { playerEmbedUrl, previewImageUrl, supportsAnonymousEmbed } from "../web/src/lib/embed.js";

/**
 * The player must never run as the signed-in user. A plain iframe to player.twitch.tv
 * carries the browser's twitch.tv cookies and registers a second watch session on the
 * account, which can make the miner report false progress and stall - the dashboard
 * sabotaging the thing it exists to report on.
 */
describe("supportsAnonymousEmbed", () => {
    const engineWith = (props: string[]) => ({
        HTMLIFrameElement: { prototype: Object.fromEntries(props.map((p) => [p, null])) },
    });

    it("is true only where the frame can be loaded without credentials", () => {
        expect(supportsAnonymousEmbed(engineWith(["credentialless", "src"]))).toBe(true);
    });

    it("is false on an engine that has not shipped it", () => {
        // Firefox and Safari land here. The player is withdrawn rather than downgraded.
        expect(supportsAnonymousEmbed(engineWith(["src", "allow"]))).toBe(false);
    });

    it("is false rather than throwing where there is no DOM at all", () => {
        expect(supportsAnonymousEmbed({})).toBe(false);
        expect(supportsAnonymousEmbed(undefined)).toBe(false);
    });
});

describe("playerEmbedUrl", () => {
    it("starts muted, so a background window cannot start talking", () => {
        expect(playerEmbedUrl("shroud", "127.0.0.1")).toContain("muted=true");
    });

    it("names the embedding host, which Twitch refuses to frame without", () => {
        expect(playerEmbedUrl("shroud", "127.0.0.1")).toContain("parent=127.0.0.1");
    });

    it("escapes what it is given rather than pasting it in", () => {
        const url = playerEmbedUrl("a b&c=d", "host");
        expect(url).toContain("channel=a+b%26c%3Dd");
        expect(new URL(url).searchParams.get("channel")).toBe("a b&c=d");
    });
});

describe("previewImageUrl", () => {
    it("carries a nonce, or the browser serves a stale frame forever", () => {
        expect(previewImageUrl("shroud", 1234)).toContain("?v=1234");
    });
});
