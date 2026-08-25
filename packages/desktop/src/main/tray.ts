import { app, Menu, Tray, nativeImage, type BrowserWindow } from "electron";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { AppHandle } from "@tdb/core";

/**
 * Held at module scope on purpose: a Tray that is only referenced by a local goes away when
 * the function returns, taking the icon with it, and the bug looks like "the tray icon
 * sometimes does not appear".
 */
let tray: Tray | null = null;

function iconPath(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return app.isPackaged
        ? join(process.resourcesPath, "icon.ico")
        : join(here, "..", "..", "resources", "icon.ico");
}

export interface TrayDeps {
    getWindow(): BrowserWindow | null;
    showWindow(): void;
    getHandle(): AppHandle | null;
    quit(): void;
}

export function createTray(deps: TrayDeps): void {
    if (tray) {
        return;
    }
    const image = nativeImage.createFromPath(iconPath());
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    tray.setToolTip("Twitch Drops Bot");
    tray.on("double-click", () => deps.showWindow());

    const render = (): void => {
        const miner = deps.getHandle()?.context.getMiner() ?? null;
        const paused = miner?.isPaused ?? false;
        tray?.setContextMenu(
            Menu.buildFromTemplate([
                { label: "Open dashboard", click: () => deps.showWindow() },
                { type: "separator" },
                {
                    label: paused ? "Resume mining" : "Pause mining",
                    enabled: miner !== null,
                    click: () => {
                        // Calling straight into the miner is the dividend of running the
                        // core in this process rather than a child.
                        if (paused) {
                            miner?.resume();
                        } else {
                            miner?.pause();
                        }
                        render();
                    },
                },
                { type: "separator" },
                { label: "Quit", click: () => deps.quit() },
            ]),
        );
    };
    render();

    // Rebuild on state changes so Pause/Resume never disagrees with what is happening.
    const bus = deps.getHandle()?.bus;
    bus?.on("watching", render);
    bus?.on("auth", render);
}

/** Short enough for a tooltip, which Windows truncates without mercy. */
export function setTrayStatus(text: string): void {
    tray?.setToolTip(text.length > 120 ? `${text.slice(0, 117)}...` : text);
}

export function showBalloon(title: string, content: string): void {
    // Windows only; a no-op elsewhere rather than a crash.
    try {
        tray?.displayBalloon({ title, content });
    } catch {
        // Some platforms have no balloons. Nothing here is important enough to report.
    }
}

export function destroyTray(): void {
    tray?.destroy();
    tray = null;
}
