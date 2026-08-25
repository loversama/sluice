import { app, BrowserWindow, dialog, shell } from "electron";
import { join } from "node:path";

import { createApp, setLogSink, setLogLevel, type AppHandle } from "@tdb/core";
import { ApiServer } from "@tdb/server";

import { createFileSink, logDirectory } from "./log-file-sink.js";
import { resolveWebDist } from "./resolve-web-dist.js";

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
    const isOurs = (url: string): boolean => {
        try {
            return new URL(url).host === `127.0.0.1:${port}`;
        } catch {
            return false;
        }
    };

    const openExternally = (url: string): void => {
        void shell.openExternal(url);
    };

    function createWindow(): void {
        win = new BrowserWindow({
            width: 1180,
            height: 820,
            minWidth: 900,
            minHeight: 600,
            show: false,
            backgroundColor: "#0e0e10",
            title: "Twitch Drops Bot",
            webPreferences: {
                // No preload script. The dashboard is an ordinary web app talking to our
                // own server over HTTP; it needs nothing from Node, and an empty preload
                // would only force a choice between sandboxing and module format. When
                // something genuinely native is needed, add one then and decide there.
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
        win.on("closed", () => {
            win = null;
        });

        void win.loadURL(`http://127.0.0.1:${port}/`);
    }

    app.whenReady().then(
        async () => {
            const dataDir = app.getPath("userData");
            setLogSink(createFileSink(logDirectory(dataDir), !app.isPackaged));

            handle = createApp({
                dataDir,
                // Electron keeps cookies between runs, so an embedded player is far more
                // likely here than in a browser tab to become a second watch session on the
                // same account - which is the documented way to make progress stall.
                configDefaults: { allowStreamEmbed: false },
                getOwnPort: () => port,
                onDeviceCode: () => {
                    // A login is waiting on the user, so put the window in front of them.
                    win?.show();
                    win?.focus();
                },
                onProblem: (problem) => {
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

            handle.start();
            // Not gated on being signed in: the server is up, and the dashboard's own
            // device-code screen is what the user should be looking at while they log in.
            createWindow();
        },
        (error: unknown) => {
            dialog.showErrorBox(
                "Twitch Drops Bot could not start",
                error instanceof Error ? (error.stack ?? error.message) : String(error),
            );
            app.exit(1);
        },
    );

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0 && port) {
            createWindow();
        }
    });

    app.on("window-all-closed", () => {
        // Phase 5 turns this into minimise-to-tray. Until then, closing the window means
        // quitting, which is at least honest about whether mining is still happening.
        app.quit();
    });

    app.on("will-quit", (event) => {
        if (quitting) {
            return;
        }
        quitting = true;
        event.preventDefault();
        // Bounded, and deliberately not a wait for the miner to unwind: its loop can be
        // parked in a sleep for a refresh interval, and nobody should watch a window hang
        // for twenty minutes because they clicked close.
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
            dialog.showErrorBox("Twitch Drops Bot hit an error", message);
        } catch {
            // Too early for a dialog; the file sink still has it.
        }
    });
    process.on("uncaughtException", (error) => {
        try {
            dialog.showErrorBox("Twitch Drops Bot hit an error", error.stack ?? error.message);
        } catch {
            // As above.
        }
        app.exit(1);
    });
}
