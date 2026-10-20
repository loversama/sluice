import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Linux build is packaged only in CI, so nothing local would notice it drifting. These
 * read the configuration and source, in the manner of the application-id test, and pin the
 * parts that would otherwise fail only after a release had shipped.
 *
 * Read as text rather than parsed: no YAML parser is a dependency, and the checks only need
 * one top-level section at a time.
 */
const builderText = readFileSync("packages/desktop/electron-builder.yml", "utf8");
const main = readFileSync("packages/desktop/src/main/index.ts", "utf8");
const tray = readFileSync("packages/desktop/src/main/tray.ts", "utf8");

/** One top-level section of the builder config: its key line up to the next top-level key. */
function section(key: string): string {
    return new RegExp(`^${key}:\\n((?:[ #].*\\n|\\n)*)`, "m").exec(builderText)?.[1] ?? "";
}

const linux = section("linux");
const appImage = section("appImage");
const deb = section("deb");

describe("the Linux packages", () => {
    it("are an AppImage and a deb", () => {
        expect(linux).toMatch(/- target: AppImage\b/);
        expect(linux).toMatch(/- target: deb\b/);
    });

    it("are named sluice where a name is typed", () => {
        expect(linux).toMatch(/^\s+executableName: sluice$/m);
        expect(deb).toMatch(/^\s+packageName: sluice$/m);
    });

    /**
     * ${name} is "@sluice/desktop", and the slash makes a directory. Spaces are what broke
     * updating in 0.4.1 and 0.4.2: the feed names one file and GitHub holds another.
     */
    it("have file names the update feed and GitHub will agree on", () => {
        const names = [builderText, appImage, deb].map((text) => /^\s*artifactName: (.*)$/m.exec(text)?.[1]);
        for (const name of names) {
            expect(name).toBeDefined();
            expect(name).not.toContain("${name}");
            expect(name?.trim()).not.toMatch(/\s/);
        }
    });

    it("ship the PNG icons Linux loads", () => {
        expect(linux).toMatch(/^\s+icon: resources\/icon\.png$/m);
        for (const file of ["icon.png", "tray-light.png", "tray-dark.png"]) {
            expect(linux).toContain(`to: "${file}"`);
        }
    });
});

describe("the main process on Linux", () => {
    it("only sets the Windows application id on Windows", () => {
        expect(main).toMatch(
            /if \(process\.platform === "win32"\) \{\s*app\.setAppUserModelId\(/,
        );
    });

    it("loads PNG tray and window icons anywhere but Windows", () => {
        expect(tray).toMatch(/process\.platform === "win32" \? "ico" : "png"/);
        expect(tray).toContain("`${taskbarIsDark() ? \"tray-light\" : \"tray-dark\"}.${ICON_EXT}`");
        expect(tray).toContain("resource(`icon.${ICON_EXT}`)");
    });

    it("opens the window on a single click of the tray, which is all Linux passes on", () => {
        expect(tray).toMatch(/process\.platform === "linux"\) \{\s*tray\.on\("click"/);
    });
});
