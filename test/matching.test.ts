import { describe, expect, it } from "vitest";

import { findBestMatch, normalizeTitle, similarity } from "../packages/core/src/steam/matching.js";

const library = [
    { name: "Tom Clancy's Ghost Recon® Wildlands" },
    { name: "Rust" },
    { name: "The Witcher 3: Wild Hunt - Game of the Year Edition" },
    { name: "Counter-Strike 2" },
    { name: "Left 4 Dead 2" },
    { name: "DEATH STRANDING DIRECTOR'S CUT" },
];

describe("normalizeTitle", () => {
    it("strips trademark symbols and punctuation", () => {
        expect(normalizeTitle("Tom Clancy's Ghost Recon® Wildlands")).toBe(
            "tom clancy s ghost recon wildlands",
        );
    });

    it("strips edition suffixes", () => {
        expect(normalizeTitle("Foo - Game of the Year Edition")).toBe("foo");
    });
});

describe("findBestMatch", () => {
    it("matches across punctuation and trademark differences", () => {
        expect(findBestMatch("Tom Clancy's Ghost Recon: Wildlands", library)?.name).toContain(
            "Ghost Recon",
        );
    });

    it("matches a Steam title carrying extra edition words", () => {
        expect(findBestMatch("The Witcher 3: Wild Hunt", library)?.name).toContain("Witcher 3");
    });

    it("refuses to match a game to its sequel", () => {
        // Plain containment scored these as identical, which would have silently ranked a
        // campaign against the wrong game.
        expect(findBestMatch("Counter-Strike", library)).toBeNull();
        expect(findBestMatch("Left 4 Dead", library)).toBeNull();
    });

    it("still matches when both sides carry the same sequel number", () => {
        expect(findBestMatch("Counter-Strike 2", library)?.name).toBe("Counter-Strike 2");
    });

    it("returns null for a game that is not owned", () => {
        expect(findBestMatch("Escape from Tarkov", library)).toBeNull();
    });

    it("scores nothing for an empty title", () => {
        expect(similarity("", "Rust")).toBe(0);
    });
});
