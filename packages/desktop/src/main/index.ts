import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp, logger, setLogSink, setLogLevel, VERSION, type AppHandle } from "@sluice/core";
import { ApiServer } from "@sluice/server";

import { createFileSink, logDirectory } from "./log-file-sink.js";
import { resolveWebDist } from "./resolve-web-dist.js";
import { isOwnUrl } from "./navigation.js";
import { ToastOverlay } from "./toasts.js";
import { IconCache } from "./icon-cache.js";
import { readDesktopSettings, writeDesktopSettings, applyLoginItem } from "./desktop-settings.js";
import { appIconPath, createTray, destroyTray, setTrayStatus, showBalloon } from "./tray.js";
import { idleTooltip } from "./idle-tooltip.js";
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
    /**
     * The width the side panel opens at, and the width its layout is designed for.
     *
     * Stretching it does not return to the wide layout - the two are different modes, not
     * two sizes of one. It scales instead, so the panel can fill a vertical monitor and
     * still be a side panel.
     */
    const THIN_WIDTH = 420;
    /**
     * How much of the extra width becomes zoom rather than extra room.
     *
     * At 1 the panel keeps its 420px layout exactly and simply gets bigger, which on a
     * full-height portrait monitor is comically large. At half, widening buys some larger
     * text and some more room, which is what the panel actually wants.
     */
    const THIN_ZOOM_RATE = 0.5;
    /** Past this, text stops being readable and starts being a poster. */
    const MAX_THIN_ZOOM = 1.75;
    let thin = false;
    /** What to go back to, so leaving thin does not forget the size you had. */
    let wideWidth = 1180;
    /** Built once the app handle exists, so update state rides the dashboard's own stream. */
    let toasts: ToastOverlay | null = null;
let icons: IconCache | null = null;
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

        /**
     * Scale the side panel to whatever width it has been given.
     *
     * The layout is drawn for THIN_WIDTH. Widening the window used to mean the page
     * simply had more room, which is how it fell back into the wide layout by accident;
     * zooming keeps it the same panel, just bigger, which is what makes it usable
     * full-screen on a portrait monitor.
     */
    const applyThinZoom = (): void => {
        if (!win) return;
        if (!thin) {
            win.webContents.setZoomFactor(1);
            return;
        }
        const { width } = win.getContentBounds();
        const factor = Math.min(MAX_THIN_ZOOM, Math.max(1, width / THIN_WIDTH));
        win.webContents.setZoomFactor(factor);
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
            // Packaged builds take this from the executable; a development run would
            // otherwise show Electron's own default.
            icon: appIconPath(),
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
        // Denied, without exception.
        //
        // This used to open whatever was asked for, which meant anything embedded in the
        // window could open a browser tab - and the stream preview is an iframe of Twitch,
        // whose ads did exactly that: a click on nothing at all put an amazon-adsystem
        // tracking URL in the user's browser. There is no way here to tell an ad in a
        // subframe from a link in our own interface, so nothing is trusted.
        //
        // Our own links go through desktop:open-external instead, which is only reachable
        // from the preload and so only from our own pages.
        win.webContents.setWindowOpenHandler(({ url }) => {
            logger.debug(`Refused a window.open for ${url}`);
            return { action: "deny" };
        });
        win.webContents.on("will-navigate", (event, url) => {
            if (!isOurs(url)) {
                event.preventDefault();
                openExternally(url);
            }
        });
        // The Steam link opens a new window, so the handler above sends the whole round
        // trip out to the real browser. This catches the same journey started any other
        // way: a same-tab navigation to our own /api/steam/login is ours, but the 302 it
        // answers with is not. Steam's return_to points back at our loopback port, which
        // the external browser can reach, so the trip finishes on the confirmation page
        // there and the window learns about it over SSE.
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

        // The side panel scales with its width rather than reflowing, so every change of
        // size has to re-apply it. Attached here rather than where the IPC is registered:
        // that runs before there is a window to attach to.
        win.on("resize", applyThinZoom);
        win.on("maximize", applyThinZoom);
        win.on("unmaximize", applyThinZoom);
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

    // Windows identifies an app by this for notifications and taskbar grouping; without
    // it both attach to "electron.app.Electron" instead of Sluice.
    // Must be the appId from electron-builder.yml, exactly.
    //
    // Windows works out a toast's title and icon by finding a Start Menu shortcut whose
    // AppUserModelID matches this. The installer stamps the shortcut with the appId, so
    // announcing anything else finds no shortcut - and Windows falls back to printing this
    // string as the title, with no icon beside it. There is no error; the notification just
    // looks like it belongs to nothing.
    //
    // A test asserts these two stay equal, because nothing at build time would notice.
    app.setAppUserModelId("dev.loversama.sluice");

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
            handle.bus.on("update", (status: unknown) => {
                win?.webContents.send("desktop:update", status);
            });

            updates = new AutoUpdate(handle.bus, () => handle?.context.getConfig().autoUpdate !== false);
            registerIpc();
            handle.start();

            // Only a packaged build can update itself; in development this would report
            // failures against a version that was never released.
            if (app.isPackaged) {
                // electron-updater is CommonJS. Bundled as ESM, the named import comes
                // back undefined in the packaged app - which is exactly where it cannot be
                // caught in development - so the interop default is unwrapped by hand.
                // 0.4.0 shipped without this and crashed on first launch.
                const updaterModule = (await import("electron-updater")) as unknown as {
                    autoUpdater?: unknown;
                    default?: { autoUpdater?: unknown };
                };
                const autoUpdater = updaterModule.autoUpdater ?? updaterModule.default?.autoUpdater;

                if (!autoUpdater) {
                    // Never fatal. Not being able to update is a bad day; refusing to start
                    // because of it is a worse one.
                    logger.warn("electron-updater did not load; automatic updates are off.");
                } else {
                    // No credential: the releases repository is public, so the updater reads
                    // it anonymously. Nothing to embed, leak, expire or rotate.
                    updates.start(autoUpdater as never);
                }
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
            // Claims are the whole point of the app, and the app is usually behind
            // something else when one lands. The dashboard's own notification only exists
            // while a window is looking at it; this one does not need one.
            const focusApp = (): void => {
                win?.show();
                win?.focus();
            };

            icons = new IconCache(join(dataDir, "reward-icons"));
            toasts = new ToastOverlay(focusApp);

            /**
             * Announce a claim, in whichever style is configured.
             *
             * Native is the default and looks like everything else on the machine, which is
             * what most people want from a notification. The themed card remains for anyone
             * who would rather it matched the app.
             */
            const announce = async (toast: {
                kind: "claim" | "complete";
                title: string;
                name: string;
                game?: string | null;
                imageUrl?: string | null;
            }): Promise<void> => {
                const config = handle?.context.getConfig();
                if (config?.desktopNotifications === false) return;

                // Downloaded before showing either way: a native notification cannot fetch
                // a URL, and the art is the most recognisable part of a claim.
                const icon = (await icons?.pathFor(toast.imageUrl)) ?? undefined;

                if (config?.desktopNotificationStyle === "themed") {
                    toasts?.show({ ...toast, imageUrl: toast.imageUrl ?? null });
                    return;
                }

                if (!Notification.isSupported()) {
                    toasts?.show({ ...toast, imageUrl: toast.imageUrl ?? null });
                    return;
                }

                const notification = new Notification({
                    title: toast.title,
                    body: toast.game ? `${toast.name}\n${toast.game}` : toast.name,
                    icon,
                    silent: true, // The dashboard already plays its own sound, if enabled.
                });
                notification.on("click", focusApp);
                notification.show();
            };

            handle.bus.on(
                "drop-claimed",
                (payload: { dropName?: string; gameName?: string; rewardImageURL?: string | null }) => {
                    void announce({
                        kind: "claim",
                        title: "Drop claimed",
                        name: payload.dropName ?? "Reward claimed",
                        game: payload.gameName ?? null,
                        imageUrl: payload.rewardImageURL ?? null,
                    });
                },
            );

            handle.bus.on(
                "campaign-completed",
                (payload: { name?: string; gameName?: string; boxArtUrl?: string | null }) => {
                    void announce({
                        kind: "complete",
                        title: "Campaign complete",
                        name: payload.gameName ?? "Campaign complete",
                        game: payload.name ?? null,
                        imageUrl: payload.boxArtUrl ?? null,
                    });
                },
            );

            // The tray said "Mining ..." for as long as the app was open, whatever had
            // happened since - including all night after the last drop was claimed.
            handle.bus.on("idle", (payload: { reason?: string }) => {
                setTrayStatus(idleTooltip(payload));
            });

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
        // Only our own pages can reach this, and only http(s) leaves by it - a file:// or
        // javascript: URL handed to the shell is a different kind of problem entirely.
        ipcMain.handle("desktop:open-external", (_event, url: unknown) => {
            if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
                logger.debug(`Refused to open ${String(url)}`);
                return;
            }
            openExternally(url);
        });
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
                // Wide has a floor of its own: below this the columns stop being columns,
                // and the answer to wanting it narrower is the side panel, not a squeeze.
                win.setMinimumSize(720, 480);
                win.setBounds({ width: wideWidth, height: win.getBounds().height }, true);
                thin = false;
            } else {
                if (win.isMaximized()) win.unmaximize();
                wideWidth = win.getBounds().width;
                // No maximum: the panel is allowed to be as wide as the user likes, and
                // scales rather than reflowing.
                win.setMinimumSize(THIN_WIDTH, 420);
                win.setBounds({ width: THIN_WIDTH, height: win.getBounds().height }, true);
                thin = true;
            }
            applyThinZoom();
            win.webContents.send("window:thin", thin);
            return thin;
        });
        ipcMain.handle("window:is-thin", () => thin);
        ipcMain.handle("desktop:update-status", () => updates?.status ?? { status: "idle" });
        ipcMain.handle("desktop:check-updates", () => updates?.checkNow());
        /**
         * Release notes, fetched here rather than in the page.
         *
         * The renderer is the same build the container serves, and it has no business
         * knowing which GitHub repository this came from.
         */
        ipcMain.handle("desktop:changelog", async () => {
            try {
                const response = await fetch(
                    "https://api.github.com/repos/loversama/sluice-releases/releases?per_page=10",
                    { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10_000) },
                );
                if (!response.ok) return { ok: false, error: `GitHub returned ${response.status}` };
                const releases = (await response.json()) as {
                    tag_name?: string;
                    name?: string;
                    published_at?: string;
                    body?: string;
                }[];
                return {
                    ok: true,
                    releases: releases.map((release) => ({
                        version: release.tag_name ?? release.name ?? "",
                        name: release.name ?? "",
                        at: release.published_at ?? null,
                        notes: release.body ?? "",
                    })),
                };
            } catch {
                return { ok: false, error: "Could not reach GitHub." };
            }
        });

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

    /**
     * A rejected promise is written down, not put on the screen.
     *
     * It used to open a modal with the stack in it. That is the wrong trade for something
     * that is usually a network call having a bad minute: an update check hitting a GitHub
     * 504 covered the whole window with a stack trace, over a failure that fixes itself on
     * the next look and that the app had already recovered from.
     *
     * The log keeps it, Settings shows the last update failure, and Open Logs is there for
     * the rest. An uncaught exception is different - the process is going down either way,
     * so that one still says so.
     */
    process.on("unhandledRejection", (reason) => {
        const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
        logger.error(`Unhandled rejection: ${message}`);
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
