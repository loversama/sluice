import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Windows decides a notification's title and icon by finding a Start Menu shortcut whose
 * AppUserModelID matches the one the application announces. The installer stamps that
 * shortcut with electron-builder's appId, so the two have to agree.
 *
 * They did not, and the failure is entirely silent: no error, no warning, just toasts
 * titled "com.sluice.desktop" with no icon, which reads as Windows being awkward rather
 * than as a line of configuration being wrong. Nothing at build time compares them, so
 * this does.
 */
describe("the Windows application id", () => {
    const main = readFileSync("packages/desktop/src/main/index.ts", "utf8");
    const builder = readFileSync("packages/desktop/electron-builder.yml", "utf8");

    const announced = /const APP_USER_MODEL_ID = "([^"]+)"/.exec(main)?.[1];
    const appId = /^appId:\s*(\S+)/m.exec(builder)?.[1];

    it("is announced by the application", () => {
        expect(announced).toBeDefined();
    });

    it("is set by the installer", () => {
        expect(appId).toBeDefined();
    });

    it("is the same on both sides", () => {
        expect(announced).toBe(appId);
    });
});

describe("a run from source", () => {
    const main = readFileSync("packages/desktop/src/main/index.ts", "utf8");

    /**
     * Electron plants a Start Menu shortcut for whatever id it is told, so that toasts work
     * in development. Point that at the installed app's id and the development shortcut
     * takes the name: every notification from the real Sluice then arrives as "Electron",
     * with Electron's icon, pointing at a binary in node_modules.
     */
    it("does not claim the installed application's id", () => {
        expect(main).toMatch(/app\.setAppUserModelId\(\s*app\.isPackaged\s*\?/);
        expect(main).toContain("${APP_USER_MODEL_ID}.dev");
    });
});
