import { contextBridge, ipcRenderer } from "electron";

/**
 * The entire native surface, and deliberately small.
 *
 * The dashboard is the same web app the container serves and talks to the daemon over
 * ordinary HTTP; none of that goes through here. This exists only for the handful of things
 * that have no meaning over HTTP because they are about *this machine* - starting with
 * Windows, hiding to the tray, opening a folder.
 *
 * The dashboard checks whether `window.desktopBridge` exists and renders its Desktop card
 * only when it does, so the Docker build is unaffected by construction.
 */
export interface DesktopSettings {
    runAtLogin: boolean;
    closeToTray: boolean;
}

const bridge = {
    version: (): Promise<string> => ipcRenderer.invoke("desktop:version"),
    getSettings: (): Promise<DesktopSettings> => ipcRenderer.invoke("desktop:get-settings"),
    setSettings: (next: Partial<DesktopSettings>): Promise<DesktopSettings> =>
        ipcRenderer.invoke("desktop:set-settings", next),
    openLogsFolder: (): Promise<void> => ipcRenderer.invoke("desktop:open-logs"),
    importFromDocker: (): Promise<{ imported: boolean; message: string }> =>
        ipcRenderer.invoke("desktop:import-docker"),
    updateStatus: (): Promise<{ status: string; version?: string; percent?: number }> =>
        ipcRenderer.invoke("desktop:update-status"),
    checkForUpdates: (): Promise<void> => ipcRenderer.invoke("desktop:check-updates"),
    installUpdate: (): Promise<void> => ipcRenderer.invoke("desktop:install-update"),

    // There is no window frame, so the page draws the controls.
    minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke("window:toggle-maximize"),
    close: (): Promise<void> => ipcRenderer.invoke("window:close"),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),
    onMaximizedChange: (fn: (maximized: boolean) => void): void => {
        ipcRenderer.on("window:maximized", (_event, value: boolean) => fn(value));
    },
    toggleThin: (): Promise<boolean> => ipcRenderer.invoke("window:toggle-thin"),
    isThin: (): Promise<boolean> => ipcRenderer.invoke("window:is-thin"),
    onThinChange: (fn: (thin: boolean) => void): void => {
        ipcRenderer.on("window:thin", (_event, value: boolean) => fn(value));
    },
};

contextBridge.exposeInMainWorld("desktopBridge", bridge);

export type DesktopBridge = typeof bridge;
