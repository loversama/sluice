import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Settings that only mean anything on the desktop, so they never enter the shared config. */
export interface DesktopSettings {
    /** Start with Windows, into the tray. */
    runAtLogin: boolean;
    /** Closing the window hides it rather than quitting. */
    closeToTray: boolean;
}

const DEFAULTS: DesktopSettings = {
    runAtLogin: false,
    closeToTray: true,
};

function file(): string {
    return join(app.getPath("userData"), "desktop.json");
}

export function readDesktopSettings(): DesktopSettings {
    try {
        return { ...DEFAULTS, ...(JSON.parse(readFileSync(file(), "utf8")) as DesktopSettings) };
    } catch {
        return { ...DEFAULTS };
    }
}

export function writeDesktopSettings(next: Partial<DesktopSettings>): DesktopSettings {
    const merged = { ...readDesktopSettings(), ...next };
    try {
        writeFileSync(file(), `${JSON.stringify(merged, null, 2)}\n`);
    } catch {
        // Not worth failing a toggle over; it will simply be back to the default next run.
    }
    applyLoginItem(merged.runAtLogin);
    return merged;
}

/**
 * Ask Windows to start us at login, into the tray rather than in the user's face.
 *
 * Kept next to the setting so the stored value and the OS cannot drift apart: writing the
 * file without telling Windows would leave a toggle that lies.
 */
export function applyLoginItem(enabled: boolean): void {
    if (process.platform === "linux") {
        // Electron's implementation here depends on the desktop environment; skip rather
        // than write a .desktop file we would then have to own.
        return;
    }
    app.setLoginItemSettings({ openAtLogin: enabled, args: ["--hidden"] });
}
