import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp, logger, setLogSink, setLogLevel, VERSION, type AppHandle } from "@sluice/core";
import { ApiServer } from "@sluice/server";

import { createFileSink, logDirectory } from "./log-file-sink.js";
import { resolveWebDist } from "./resolve-web-dist.js";
import { isOwnUrl } from "./navigation.js";
import { readDesktopSettings, writeDesktopSettings, applyLoginItem } from "./desktop-settings.js";
import { createTray, destroyTray, setTrayStatus, showBalloon } from "./tray.js";
import { importFromDockerData } from "./import-docker.js";
import { AutoUpdate } from "./auto-update.js";

/**
 * Only one copy may run.
 *
 * This is not tidiness. The daemon used to be protected by accident: a second copy failed
 * to bind port 4400 and died. Asking the OS for a free port instead - which is how this
 * avoids colliding with a running container - removes that accident, so the lock has to
 * replace it in the same breath.
 */
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    let win: BrowserWindow | null = null;
    let handle: AppHandle | null = null;
    let server: ApiServer | null = null;
    let port = 0;
    let quitting = false;
    /** Set only by an explicit Quit, so closing the window can mean "hide" instead. */
    let reallyQuitting = false;
    let warnedAboutTray = false;
    /** The side-of-the-screen form. Entered by choice, never by dragging. */
    const THIN_WIDTH = 350;
    let thin = false;
    /** What to go back to, so leaving thin does not forget the size you had. */
    let wideWidth = 1180;
    /** Built once the app handle exists, so update state rides the dashboard's own stream. */
    let updates: AutoUpdate | null = null;

    app.on("second-instance", () => {
        if (win) {
            if (win.isMinimized()) {
                win.restore();
            }
            win.show();
            win.focus();
        }
    });

    /** True for pages we serve ourselves; everything else belongs in the real browser. */
    const isOurs = (url: string): boolean => isOwnUrl(url, port);

    const openExternally = (url: string): void => {
        void shell.openExternal(url);
    };

    function createWindow(): void {
        win = new BrowserWindow({
            width: 1180,
            height: 820,
            // Deliberately above the thin form's width. The narrow layout is a mode you
            // choose with a button, not somewhere you can end up by dragging an edge and
            // wondering why the app rearranged itself.
            minWidth: 560,
            minHeight: 480,
            show: false,
            backgroundColor: "#0e0e10",
            title: "Sluice",
            // The header is the title bar. A native one costs ~32px that the compact
            // layout cannot spare, and leaves the app looking like two designs stacked.
            frame: false,
            // Traffic lights stay put on macOS; Windows and Linux get our own controls.
            titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
            webPreferences: {
                // Built to CommonJS on purpose: a sandboxed preload cannot be an ES module,
                // and sandboxing is worth more than matching the package's module format.
                preload: join(dirname(fileURLToPath(import.meta.url)), "..", "preload", "index.cjs"),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });

        // Signing in to Twitch or Steam has to happen in the user's own browser, where they
        // can see the address bar and their password manager works. An OAuth page inside a
        // chromeless window that looks like this app is exactly what people are told to be
        // suspicious of.
        win.webContents.setWindowOpenHandler(({ url }) => {
            openExternally(url);
            return { action: "deny" };
        });
        win.webContents.on("will-navigate", (event, url) => {
            if (!isOurs(url)) {
                event.preventDefault();
                openExternally(url);
            }
        });
        // The Steam link is a same-tab navigation to our own /api/steam/login, which then
        // 302s out to steamcommunity.com - so the redirect leg needs catching too. Steam's
        // return_to points back at our loopback port, which the external browser can reach,
        // so the round trip finishes there and the dashboard picks it up over SSE.
        win.webContents.on("will-redirect", (event, url) => {
            if (!isOurs(url)) {
                event.preventDefault();
                openExternally(url);
            }
        });

        win.once("ready-to-show", () => win?.show());
        // The button's icon has to follow the real state, which a double-click on the drag
        // region or a Windows snap can change without going through our handler.
        const sendMaximised = () => win?.webContents.send("window:maximized", win.isMaximized());
        win.on("maximize", sendMaximised);
        win.on("unmaximize", sendMaximised);
        win.on("closed", () => {
            win = null;
        });

        // The whole point of the app is to keep mining while you get on with something
        // else, so closing the window hides it. Said out loud the first time, because an
        // app that appears to exit and carries on running is otherwise alarming.
        win.on("close", (event) => {
            if (reallyQuitting || !readDesktopSettings().closeToTray) {
                return;
            }
            event.preventDefault();
            win?.hide();
            if (!warnedAboutTray) {
                warnedAboutTray = true;
                showBalloon(
                    "Still mining",
                    "Sluice is in the tray. Quit from there to stop it.",
                );
            }
        });

        void win.loadURL(`http://127.0.0.1:${port}/`);
    }

    app.whenReady().then(
        async () => {
            const dataDir = app.getPath("userData");
            setLogSink(createFileSink(logDirectory(dataDir), !app.isPackaged));

            handle = createApp({
                dataDir,
                getOwnPort: () => port,
                onDeviceCode: () => {
                    // A login is waiting on the user, so put the window in front of them.
                    win?.show();
                    win?.focus();
                },
                onProblem: (problem) => {
                    if (problem.level === "fatal") {
                        // The window is usually hidden, so the balloon is what actually
                        // reaches the user when mining stops.
                        showBalloon("Mining stopped", problem.message);
                    }
                    if (problem.level === "fatal" && win) {
                        // The dashboard shows this too; the dialog is for when the window
                        // is behind something else and mining has silently stopped.
                        dialog.showMessageBox(win, {
                            type: "warning",
                            title: "Mining stopped",
                            message: problem.message,
                        });
                    }
                },
            });
            setLogLevel(handle.context.getConfig().logLevel);

            server = new ApiServer(handle.context, resolveWebDist());
            // Port 0: the OS picks a free one, so a running Docker container on 4400 is not
            // a collision. The renderer then loads from that exact origin, which is what
            // keeps the server's Origin and Host checks satisfied without loosening them.
            port = await server.listen("127.0.0.1", 0);

            // The bus is already the dashboard's SSE stream, so update state reaches the
            // UI without a second channel.
            updates = new AutoUpdate(handle.bus);
            registerIpc();
            handle.start();

            // Only a packaged build can update itself; in development this would report
            // failures against a version that was never released.
            if (app.isPackaged) {
                const { autoUpdater } = await import("electron-updater");
                // No credential: the releases repository is public, so the updater reads
                // it anonymously. Nothing to embed, leak, expire or rotate.
                updates.start(autoUpdater as never);
            }

            // A tray is a nicety; a window is the app. On a desktop with no system tray -
            // some Linux sessions, and any headless environment - Tray construction throws,
            // and letting that escape would mean no window either.
            try {
                createTray({
                    getWindow: () => win,
                    showWindow: () => {
                        if (!win) {
                            createWindow();
                            return;
                        }
                        if (win.isMinimized()) {
                            win.restore();
                        }
                        win.show();
                        win.focus();
                    },
                    getHandle: () => handle,
                    quit: () => {
                        reallyQuitting = true;
                        app.quit();
                    },
                });
            } catch (error) {
                logger.warn(`No system tray available: ${(error as Error).message}`);
            }

            // Keep the tooltip honest: it is the only status anyone sees while the window
            // is hidden, which is most of the time.
            handle.bus.on("watching", (payload: { channel?: { displayName?: string; game?: string } }) => {
                const channel = payload?.channel;
                setTrayStatus(
                    channel
                        ? `Mining ${channel.game ?? "a game"} on ${channel.displayName ?? "a channel"}`
                        : "Sluice",
                );
            });
            handle.bus.on("auth", (payload: { status?: string }) => {
                if (payload?.status === "pending") {
                    setTrayStatus("Waiting for you to sign in");
                }
            });

            applyLoginItem(readDesktopSettings().runAtLogin);

            // Started hidden by the login item; otherwise show the window. Not gated on
            // being signed in - the dashboard's own device-code screen does that waiting.
            if (!process.argv.includes("--hidden")) {
                createWindow();
            }
        },
        (error: unknown) => {
            dialog.showErrorBox(
                "Sluice could not start",
                error instanceof Error ? (error.stack ?? error.message) : String(error),
            );
            app.exit(1);
        },
    );

    /** The whole native surface the dashboard can reach, and nothing beyond it. */
    function registerIpc(): void {
        ipcMain.handle("desktop:version", () => VERSION);
        ipcMain.handle("desktop:get-settings", () => readDesktopSettings());
        ipcMain.handle("desktop:set-settings", (_event, next) => writeDesktopSettings(next));
        ipcMain.handle("desktop:open-logs", async () => {
            await shell.openPath(logDirectory(app.getPath("userData")));
        });
        ipcMain.handle("desktop:import-docker", () => importFromDockerData(win));

        // Window controls, since there is no frame to provide them.
        ipcMain.handle("window:minimize", () => win?.minimize());
        ipcMain.handle("window:toggle-maximize", () => {
            if (!win) return false;
            if (win.isMaximized()) {
                win.unmaximize();
                return false;
            }
            win.maximize();
            return true;
        });
        ipcMain.handle("window:close", () => win?.close());
        ipcMain.handle("window:is-maximized", () => win?.isMaximized() ?? false);

        /**
         * Switch between the ordinary window and the thin one that lives down the side of
         * a screen.
         *
         * The minimum width moves with it, which is the point: at 350 the dashboard is a
         * different layout, and arriving there by dragging an edge would feel like the app
         * breaking rather than changing shape. Going thin is a decision; coming back
         * restores the size that was in use before.
         */
        ipcMain.handle("window:toggle-thin", () => {
            if (!win) return false;
            if (thin) {
                win.setMinimumSize(560, 480);
                win.setBounds({ width: wideWidth, height: win.getBounds().height }, true);
                thin = false;
            } else {
                if (win.isMaximized()) win.unmaximize();
                wideWidth = win.getBounds().width;
                win.setMinimumSize(320, 420);
                win.setBounds({ width: THIN_WIDTH, height: win.getBounds().height }, true);
                thin = true;
            }
            win.webContents.send("window:thin", thin);
            return thin;
        });
        ipcMain.handle("window:is-thin", () => thin);
        ipcMain.handle("desktop:update-status", () => updates?.status ?? { status: "idle" });
        ipcMain.handle("desktop:check-updates", () => updates?.check());
        ipcMain.handle("desktop:install-update", () => {
            // Restarting mid-session ends a mining session, so it is never done unasked.
            reallyQuitting = true;
            updates?.installNow();
        });
    }

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0 && port) {
            createWindow();
        }
    });

    // Deliberately not quitting: the tray is what keeps the app alive with no window, and
    // Quit there is the only thing that ends it.
    app.on("window-all-closed", () => {});

    app.on("will-quit", (event) => {
        if (quitting) {
            return;
        }
        quitting = true;
        event.preventDefault();
        // Bounded, and deliberately not a wait for the miner to unwind: its loop can be
        // parked in a sleep for a refresh interval, and nobody should watch a window hang
        // for twenty minutes because they clicked close.
        destroyTray();
        updates?.stop();
        void Promise.resolve(handle?.stop())
            .catch(() => undefined)
            .finally(() => {
                server?.close();
                app.exit(0);
            });
    });

    // Without a console there is nothing to print to, so an unhandled rejection would take
    // the app down leaving no trace at all.
    process.on("unhandledRejection", (reason) => {
        const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
        try {
            dialog.showErrorBox("Sluice hit an error", message);
        } catch {
            // Too early for a dialog; the file sink still has it.
        }
    });
    process.on("uncaughtException", (error) => {
        try {
            dialog.showErrorBox("Sluice hit an error", error.stack ?? error.message);
        } catch {
            // As above.
        }
        app.exit(1);
    });
}
