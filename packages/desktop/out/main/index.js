import { app, nativeImage, Tray, Menu, dialog, BrowserWindow, ipcMain, shell } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { consoleSink, logger, setLogSink, createApp, setLogLevel, VERSION } from "@tdb/core";
import { ApiServer } from "@tdb/server";
import { mkdirSync, statSync, renameSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { inspect } from "node:util";
import { stat, readdir, cp } from "node:fs/promises";
const MAX_BYTES = 5 * 1024 * 1024;
const ANSI = /\x1b\[[0-9;]*m/g;
function render(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  return inspect(value, { depth: 3, colors: false });
}
function createFileSink(directory, alsoConsole) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "desktop.log");
  return {
    write(level, args) {
      if (alsoConsole) {
        consoleSink.write(level, args);
      }
      const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${level.padEnd(5)} ` + `${args.map(render).join(" ")}
`.replace(ANSI, "");
      try {
        try {
          if (statSync(path).size > MAX_BYTES) {
            renameSync(path, `${path}.old`);
          }
        } catch {
        }
        appendFileSync(path, line);
      } catch {
      }
    }
  };
}
function logDirectory(dataDir) {
  return join(dataDir, "logs");
}
function resolveWebDist() {
  const override = process.env.TDB_WEB_DIR;
  if (override) {
    return override;
  }
  if (!app.isPackaged) {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "..", "..", "..", "..", "web", "dist");
  }
  return join(process.resourcesPath, "web");
}
const DEFAULTS = {
  runAtLogin: false,
  closeToTray: true
};
function file() {
  return join(app.getPath("userData"), "desktop.json");
}
function readDesktopSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(file(), "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}
function writeDesktopSettings(next) {
  const merged = { ...readDesktopSettings(), ...next };
  try {
    writeFileSync(file(), `${JSON.stringify(merged, null, 2)}
`);
  } catch {
  }
  applyLoginItem(merged.runAtLogin);
  return merged;
}
function applyLoginItem(enabled) {
  if (process.platform === "linux") {
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, args: ["--hidden"] });
}
let tray = null;
function iconPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  return app.isPackaged ? join(process.resourcesPath, "icon.ico") : join(here, "..", "..", "resources", "icon.ico");
}
function createTray(deps) {
  if (tray) {
    return;
  }
  const image = nativeImage.createFromPath(iconPath());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip("Twitch Drops Bot");
  tray.on("double-click", () => deps.showWindow());
  const render2 = () => {
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
            if (paused) {
              miner?.resume();
            } else {
              miner?.pause();
            }
            render2();
          }
        },
        { type: "separator" },
        { label: "Quit", click: () => deps.quit() }
      ])
    );
  };
  render2();
  const bus = deps.getHandle()?.bus;
  bus?.on("watching", render2);
  bus?.on("auth", render2);
}
function setTrayStatus(text) {
  tray?.setToolTip(text.length > 120 ? `${text.slice(0, 117)}...` : text);
}
function showBalloon(title, content) {
  try {
    tray?.displayBalloon({ title, content });
  } catch {
  }
}
function destroyTray() {
  tray?.destroy();
  tray = null;
}
async function importFromDockerData(win) {
  const picked = await dialog.showOpenDialog(win ?? void 0, {
    title: "Choose the bot's data folder",
    message: "Pick the 'data' folder used by the Docker container.",
    properties: ["openDirectory"],
    buttonLabel: "Import"
  });
  if (picked.canceled || !picked.filePaths[0]) {
    return { imported: false, message: "Import cancelled." };
  }
  const source = picked.filePaths[0];
  const looksRight = await stat(join(source, "auth.json")).then(
    () => true,
    async () => readdir(join(source, "users")).then(
      (entries) => entries.length > 0,
      () => false
    )
  );
  if (!looksRight) {
    return {
      imported: false,
      message: "That folder does not look like a bot data directory - expected auth.json or a users folder inside it."
    };
  }
  const confirmed = await dialog.showMessageBox(win ?? void 0, {
    type: "warning",
    buttons: ["Import", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Stop the container first",
    message: "Is the Docker container stopped?",
    detail: "Both copies mining the same account at once makes Twitch credit neither reliably. Nothing is written back to the folder you picked, so you can start the container again afterwards - but not at the same time as this app."
  });
  if (confirmed.response !== 0) {
    return { imported: false, message: "Import cancelled." };
  }
  const target = app.getPath("userData");
  try {
    await cp(join(source, "auth.json"), join(target, "auth.json"), { force: true }).catch(
      () => void 0
    );
    await cp(join(source, "users"), join(target, "users"), {
      recursive: true,
      force: true
    }).catch(() => void 0);
    logger.info(`Imported data from ${source}`);
    return {
      imported: true,
      message: "Imported. Restart the app to sign in with the imported account."
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Import failed: ${message}`);
    return { imported: false, message: `Import failed: ${message}` };
  }
}
const CHECK_INTERVAL_MS = 15 * 60 * 1e3;
const RETRY_AFTER_MS = 5 * 60 * 1e3;
class AutoUpdate {
  constructor(bus) {
    this.bus = bus;
  }
  bus;
  checkTimer = null;
  retryTimer = null;
  updater = null;
  lastStatus = { status: "idle" };
  get status() {
    return this.lastStatus;
  }
  publish(status) {
    this.lastStatus = status;
    this.bus.emit("update", status);
  }
  start(updater) {
    this.updater = updater;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on("checking-for-update", () => this.publish({ status: "checking" }));
    updater.on(
      "update-available",
      (info) => this.publish({ status: "available", version: info?.version ?? "" })
    );
    updater.on("update-not-available", () => this.publish({ status: "idle" }));
    updater.on(
      "download-progress",
      (progress) => this.publish({ status: "downloading", percent: Math.round(progress?.percent ?? 0) })
    );
    updater.on("update-downloaded", (info) => {
      logger.info(`Update ${info?.version ?? ""} downloaded; it will install on quit.`);
      this.publish({ status: "ready", version: info?.version ?? "" });
    });
    updater.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const transient = message.includes("latest.yml") || message.includes("404") || message.includes("ENOTFOUND") || message.includes("ECONNRESET") || message.includes("net::ERR");
      if (transient) {
        logger.debug(`Update check deferred: ${message}`);
        this.publish({ status: "idle" });
        this.retryTimer?.refresh() ?? (this.retryTimer = setTimeout(() => this.check(), RETRY_AFTER_MS));
        this.retryTimer?.unref();
        return;
      }
      logger.warn(`Update check failed: ${message}`);
      this.publish({ status: "error", message });
    });
    this.check();
    this.checkTimer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    this.checkTimer.unref();
  }
  check() {
    try {
      void this.updater?.checkForUpdates();
    } catch (error) {
      logger.debug("Update check threw:", error);
    }
  }
  /** Restart into the new version now, rather than waiting for the next quit. */
  installNow() {
    try {
      this.updater?.quitAndInstall();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.publish({ status: "error", message });
    }
  }
  stop() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let createWindow = function() {
    win = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      show: false,
      backgroundColor: "#0e0e10",
      title: "Twitch Drops Bot",
      webPreferences: {
        // Built to CommonJS on purpose: a sandboxed preload cannot be an ES module,
        // and sandboxing is worth more than matching the package's module format.
        preload: join(dirname(fileURLToPath(import.meta.url)), "..", "preload", "index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
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
          "Twitch Drops Bot is in the tray. Quit from there to stop it."
        );
      }
    });
    void win.loadURL(`http://127.0.0.1:${port}/`);
  }, registerIpc = function() {
    ipcMain.handle("desktop:version", () => VERSION);
    ipcMain.handle("desktop:get-settings", () => readDesktopSettings());
    ipcMain.handle("desktop:set-settings", (_event, next) => writeDesktopSettings(next));
    ipcMain.handle("desktop:open-logs", async () => {
      await shell.openPath(logDirectory(app.getPath("userData")));
    });
    ipcMain.handle("desktop:import-docker", () => importFromDockerData(win));
    ipcMain.handle("desktop:update-status", () => updates?.status ?? { status: "idle" });
    ipcMain.handle("desktop:check-updates", () => updates?.check());
    ipcMain.handle("desktop:install-update", () => {
      reallyQuitting = true;
      updates?.installNow();
    });
  };
  let win = null;
  let handle = null;
  let server = null;
  let port = 0;
  let quitting = false;
  let reallyQuitting = false;
  let warnedAboutTray = false;
  let updates = null;
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) {
        win.restore();
      }
      win.show();
      win.focus();
    }
  });
  const isOurs = (url) => {
    try {
      return new URL(url).host === `127.0.0.1:${port}`;
    } catch {
      return false;
    }
  };
  const openExternally = (url) => {
    void shell.openExternal(url);
  };
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
          win?.show();
          win?.focus();
        },
        onProblem: (problem) => {
          if (problem.level === "fatal") {
            showBalloon("Mining stopped", problem.message);
          }
          if (problem.level === "fatal" && win) {
            dialog.showMessageBox(win, {
              type: "warning",
              title: "Mining stopped",
              message: problem.message
            });
          }
        }
      });
      setLogLevel(handle.context.getConfig().logLevel);
      server = new ApiServer(handle.context, resolveWebDist());
      port = await server.listen("127.0.0.1", 0);
      updates = new AutoUpdate(handle.bus);
      registerIpc();
      handle.start();
      if (app.isPackaged) {
        const { autoUpdater } = await import("electron-updater");
        updates.start(autoUpdater);
      }
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
          }
        });
      } catch (error) {
        logger.warn(`No system tray available: ${error.message}`);
      }
      handle.bus.on("watching", (payload) => {
        const channel = payload?.channel;
        setTrayStatus(
          channel ? `Mining ${channel.game ?? "a game"} on ${channel.displayName ?? "a channel"}` : "Twitch Drops Bot"
        );
      });
      handle.bus.on("auth", (payload) => {
        if (payload?.status === "pending") {
          setTrayStatus("Waiting for you to sign in");
        }
      });
      applyLoginItem(readDesktopSettings().runAtLogin);
      if (!process.argv.includes("--hidden")) {
        createWindow();
      }
    },
    (error) => {
      dialog.showErrorBox(
        "Twitch Drops Bot could not start",
        error instanceof Error ? error.stack ?? error.message : String(error)
      );
      app.exit(1);
    }
  );
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && port) {
      createWindow();
    }
  });
  app.on("window-all-closed", () => {
  });
  app.on("will-quit", (event) => {
    if (quitting) {
      return;
    }
    quitting = true;
    event.preventDefault();
    destroyTray();
    updates?.stop();
    void Promise.resolve(handle?.stop()).catch(() => void 0).finally(() => {
      server?.close();
      app.exit(0);
    });
  });
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    try {
      dialog.showErrorBox("Twitch Drops Bot hit an error", message);
    } catch {
    }
  });
  process.on("uncaughtException", (error) => {
    try {
      dialog.showErrorBox("Twitch Drops Bot hit an error", error.stack ?? error.message);
    } catch {
    }
    app.exit(1);
  });
}
