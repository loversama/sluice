import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    applyLinuxAutostart,
    autostartFile,
    desktopEntry,
    isSafeExecPath,
} from "../packages/desktop/src/main/linux-autostart.js";

/**
 * Starting with Windows is the difference between a miner that runs and one that runs when
 * you remember to open it, so it is on by default - and it has to actually happen. Electron
 * accepts setLoginItemSettings without complaint in situations where Windows then ignores
 * it, which is how an app ends up with a switch that means nothing.
 *
 * The module cannot be imported here: it pulls in electron, which needs a real app. So this
 * reads the source, in the manner of the application-id test next door.
 */
const source = readFileSync("packages/desktop/src/main/desktop-settings.ts", "utf8");

describe("starting with Windows", () => {
    it("is on unless the user has said otherwise", () => {
        const defaults = /const DEFAULTS: DesktopSettings = \{([\s\S]*?)\}/.exec(source)?.[1] ?? "";
        expect(defaults).toMatch(/runAtLogin:\s*true/);
    });

    it("never registers a run from source", () => {
        // process.execPath is Electron's own binary then, so Windows would launch a bare
        // Electron at every login from a path inside node_modules.
        expect(source).toMatch(/if \(!app\.isPackaged\)/);
    });

    it("names the executable rather than leaving it implicit", () => {
        expect(source).toMatch(/path:\s*process\.execPath/);
    });

    it("starts into the tray rather than in front of the user", () => {
        expect(source).toMatch(/args:\s*\["--hidden"\]/);
        // ...and the main process has to honour that flag, or it starts up visible anyway.
        const main = readFileSync("packages/desktop/src/main/index.ts", "utf8");
        expect(main).toMatch(/process\.argv\.includes\("--hidden"\)/);
    });

    it("checks Windows actually did it", () => {
        expect(source).toContain("getLoginItemSettings()");
    });
});

/**
 * Linux has no Electron login item to speak of, so the app writes an XDG autostart entry
 * of its own. The rules are the same - packaged builds only, start hidden - plus one Linux
 * adds: an AppImage runs from a temporary mount, so the path written has to be the file
 * the user holds, not the binary that happens to be running.
 */
describe("starting at login on Linux", () => {
    let home: string;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "sluice-autostart-"));
    });
    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
    });

    it("is only set up for a packaged build", () => {
        const guard = source.indexOf("if (!app.isPackaged)");
        const linux = source.indexOf('process.platform === "linux"');
        expect(guard).toBeGreaterThan(-1);
        expect(linux).toBeGreaterThan(guard);
    });

    it("registers the AppImage rather than its temporary mount", () => {
        expect(source).toMatch(/process\.env\.APPIMAGE\s*\?\?\s*process\.execPath/);
    });

    it("lives where every desktop looks for it", () => {
        expect(autostartFile({}, "/home/someone")).toBe("/home/someone/.config/autostart/sluice.desktop");
        expect(autostartFile({ XDG_CONFIG_HOME: "/cfg" }, "/home/someone")).toBe("/cfg/autostart/sluice.desktop");
        // A relative XDG_CONFIG_HOME is invalid by the spec and is ignored.
        expect(autostartFile({ XDG_CONFIG_HOME: "cfg" }, "/home/someone")).toBe(
            "/home/someone/.config/autostart/sluice.desktop",
        );
    });

    it("starts hidden, from the quoted path", () => {
        const file = join(home, "autostart", "sluice.desktop");
        expect(applyLinuxAutostart(true, "/opt/My Apps/Sluice.AppImage", file)).toBeNull();
        const entry = readFileSync(file, "utf8");
        expect(entry).toMatch(/^\[Desktop Entry\]$/m);
        expect(entry).toContain('Exec="/opt/My Apps/Sluice.AppImage" --hidden');
    });

    it("follows the AppImage when an update renames it", () => {
        const file = join(home, "autostart", "sluice.desktop");
        applyLinuxAutostart(true, "/apps/Sluice-0.4.12-x86_64.AppImage", file);
        applyLinuxAutostart(true, "/apps/Sluice-0.4.13-x86_64.AppImage", file);
        expect(readFileSync(file, "utf8")).toContain('Exec="/apps/Sluice-0.4.13-x86_64.AppImage" --hidden');
    });

    it("removes the entry when switched off, and does not mind if it is already gone", () => {
        const file = join(home, "autostart", "sluice.desktop");
        applyLinuxAutostart(true, "/usr/bin/sluice", file);
        expect(applyLinuxAutostart(false, "/usr/bin/sluice", file)).toBeNull();
        expect(existsSync(file)).toBe(false);
        expect(applyLinuxAutostart(false, "/usr/bin/sluice", file)).toBeNull();
    });

    it("refuses a path that cannot be written into Exec safely", () => {
        const file = join(home, "autostart", "sluice.desktop");
        for (const path of ['/a"b/sluice', "/a`b/sluice", "/a$b/sluice", "/a\\b/sluice", "relative/sluice"]) {
            expect(isSafeExecPath(path)).toBe(false);
            expect(applyLinuxAutostart(true, path, file)).not.toBeNull();
        }
        expect(existsSync(file)).toBe(false);
    });

    it("doubles a percent sign, which Exec would read as a field code", () => {
        expect(desktopEntry("/apps/100%/sluice")).toContain('Exec="/apps/100%%/sluice" --hidden');
    });
});
