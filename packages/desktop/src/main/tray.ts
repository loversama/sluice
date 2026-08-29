import { app, Menu, Tray, nativeImage, nativeTheme, type BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { AppHandle } from "@sluice/core";

/**
 * Held at module scope on purpose: a Tray that is only referenced by a local goes away when
 * the function returns, taking the icon with it, and the bug looks like "the tray icon
 * sometimes does not appear".
 */
let tray: Tray | null = null;

function resource(name: string): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return app.isPackaged
        ? join(process.resourcesPath, name)
        : join(here, "..", "..", "resources", name);
}

/**
 * Whether the taskbar is dark, and so whether the white mark or the purple one will be
 * visible in it.
 *
 * White is the answer unless Windows says otherwise in as many words. The taskbar is dark
 * by default and the white mark is what the app has always shown, so it is the behaviour to
 * preserve; the purple one exists only for a light taskbar, where white would be invisible.
 *
 * Windows keeps the taskbar's theme separate from the one applications follow - a machine
 * set to "Custom" can run light applications against a dark taskbar - so the taskbar's own
 * registry value is the only thing worth reading. Anything else, including not being able
 * to read it at all, leaves the mark white.
 */
function taskbarIsDark(): boolean {
    if (process.platform === "win32") {
        try {
            const out = execFileSync(
                "reg",
                [
                    "query",
                    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                    "/v",
                    "SystemUsesLightTheme",
                ],
                { encoding: "utf8", timeout: 2000, windowsHide: true },
            );
            const value = /SystemUsesLightTheme\s+REG_DWORD\s+0x(\d+)/i.exec(out);
            if (value) {
                return value[1] === "0";
            }
        } catch {
            // No registry value, or reg is unavailable. Stay white rather than guess from
            // the application theme, which is a different setting and can disagree.
        }
    }
    return true;
}

/** The tray mark in whichever colour the taskbar will actually show. */
function trayImage(): Electron.NativeImage {
    return nativeImage.createFromPath(resource(taskbarIsDark() ? "tray-light.ico" : "tray-dark.ico"));
}

/** The application's own mark, in its own colour. */
export function appIconPath(): string {
    return resource("icon.ico");
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
    const image = trayImage();
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    tray.setToolTip("Sluice");
    tray.on("double-click", () => deps.showWindow());

    // Someone switching Windows to light mode should not be left with a white mark on a
    // white taskbar until the next restart.
    nativeTheme.on("updated", () => {
        const refreshed = trayImage();
        if (!refreshed.isEmpty()) {
            tray?.setImage(refreshed);
        }
    });

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
        // Named explicitly, because a balloon otherwise borrows the tray's icon - and that
        // one is white, drawn to sit on a dark taskbar. In a notification it lands on the
        // notification's own background and all but disappears. This is the app's mark in
        // its own colour, which is what belongs beside the app's name.
        const icon = nativeImage.createFromPath(appIconPath());
        tray?.displayBalloon({ title, content, ...(icon.isEmpty() ? {} : { icon }) });
    } catch {
        // Some platforms have no balloons. Nothing here is important enough to report.
    }
}

export function destroyTray(): void {
    tray?.destroy();
    tray = null;
}
