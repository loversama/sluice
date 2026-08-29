import { app } from "electron";
import { logger } from "@sluice/core";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Settings that only mean anything on the desktop, so they never enter the shared config. */
export interface DesktopSettings {
    /**
     * Start with Windows, into the tray.
     *
     * On by default. The app exists to mine while you are doing something else, and a
     * miner that only runs when you remember to open it earns a fraction of what it could.
     * Anyone who turns it off has that stored, so this default only reaches a fresh install.
     */
    runAtLogin: boolean;
    /** Closing the window hides it rather than quitting. */
    closeToTray: boolean;
}

const DEFAULTS: DesktopSettings = {
    runAtLogin: true,
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

    // A run from source must never register itself. process.execPath is then Electron's own
    // binary inside node_modules, so Windows would launch a bare Electron at every login
    // from a path that disappears the moment the checkout is moved or cleaned.
    if (!app.isPackaged) {
        logger.debug("Not a packaged build; leaving the login item alone.");
        return;
    }

    // The path is named rather than left implicit. Sluice installs with NSIS, where the
    // executable to register is the one running - but Electron's default has been the wrong
    // one often enough, on Squirrel layouts especially, that stating it is worth the line.
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ["--hidden"] });

    // Windows accepts the request and does not always honour it - a policy, another
    // installation holding the same registry name, or a permission it will not explain.
    // Reading it back is the only way to know, and a toggle that silently means nothing is
    // worse than one that admits it.
    const actual = app.getLoginItemSettings().openAtLogin;
    if (actual !== enabled) {
        logger.warn(
            `Windows was asked to ${enabled ? "start" : "stop starting"} Sluice at login, ` +
                `and reports ${actual}. The setting will not take effect.`,
        );
    }
}
