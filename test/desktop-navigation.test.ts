import { describe, expect, it } from "vitest";

import { isOwnUrl } from "../packages/desktop/src/main/navigation.js";

/**
 * Getting this wrong fails in one of two ways, both bad: an OAuth page trapped inside a
 * chromeless window that looks like the app, or the dashboard itself thrown out to a
 * browser. Neither is obvious from reading the code, so they are pinned here.
 */
describe("isOwnUrl", () => {
    const PORT = 45678;

    it("keeps our own pages in the window", () => {
        expect(isOwnUrl(`http://127.0.0.1:${PORT}/`, PORT)).toBe(true);
        expect(isOwnUrl(`http://127.0.0.1:${PORT}/#/settings`, PORT)).toBe(true);
        expect(isOwnUrl(`http://127.0.0.1:${PORT}/api/state`, PORT)).toBe(true);
    });

    it("sends Twitch and Steam sign-in out to the browser", () => {
        expect(isOwnUrl("https://www.twitch.tv/activate?device-code=ABCD", PORT)).toBe(false);
        expect(isOwnUrl("https://steamcommunity.com/openid/login", PORT)).toBe(false);
    });

    it("does not trust another service on loopback", () => {
        // The Docker container on 4400 is a different program as far as this window is
        // concerned, even though it answers the same paths.
        expect(isOwnUrl("http://127.0.0.1:4400/", PORT)).toBe(false);
    });

    it("does not accept https on our own host", () => {
        // We only ever serve http on loopback, so an https URL claiming our address is
        // not something we issued.
        expect(isOwnUrl(`https://127.0.0.1:${PORT}/`, PORT)).toBe(false);
    });

    it("does not accept localhost as equivalent", () => {
        // The renderer is loaded from the literal 127.0.0.1, so a localhost URL did not
        // come from our own page - and the two do not always resolve alike.
        expect(isOwnUrl(`http://localhost:${PORT}/`, PORT)).toBe(false);
    });

    it("rejects a host that merely starts the same way", () => {
        expect(isOwnUrl("http://127.0.0.1.evil.example/", PORT)).toBe(false);
    });

    it("rejects anything unparseable, and file urls", () => {
        expect(isOwnUrl("not a url", PORT)).toBe(false);
        expect(isOwnUrl("file:///etc/passwd", PORT)).toBe(false);
        expect(isOwnUrl("javascript:alert(1)", PORT)).toBe(false);
    });

    it("trusts nothing before a port is known", () => {
        expect(isOwnUrl("http://127.0.0.1:0/", 0)).toBe(false);
    });
});
