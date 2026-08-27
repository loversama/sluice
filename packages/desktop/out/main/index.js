import { app, screen, BrowserWindow, shell, nativeImage, Tray, Menu, dialog, ipcMain, Notification } from "electron";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { consoleSink, logger, setLogSink, createApp, setLogLevel, VERSION } from "@sluice/core";
import { ApiServer } from "@sluice/server";
import { mkdirSync, statSync, renameSync, appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { inspect } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readdir, stat, unlink, cp } from "node:fs/promises";
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
function isOwnUrl(url, port) {
  if (!port) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" && parsed.host === `127.0.0.1:${port}`;
}
const WIDTH = 380;
const HEIGHT = 330;
const DISMISS_MS = 6500;
class ToastOverlay {
  constructor(focusMain) {
    this.focusMain = focusMain;
  }
  focusMain;
  win = null;
  queued = [];
  ready = false;
  hideTimer;
  show(toast) {
    this.queued.push(toast);
    this.ensureWindow();
    if (this.ready) this.flush();
  }
  destroy() {
    clearTimeout(this.hideTimer);
    this.win?.destroy();
    this.win = null;
    this.ready = false;
  }
  ensureWindow() {
    if (this.win && !this.win.isDestroyed()) {
      if (!this.win.isVisible()) this.win.showInactive();
      return;
    }
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    this.win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      x: x + width - WIDTH - 12,
      y: y + height - HEIGHT - 12,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      // Never steals focus: a claim arriving must not interrupt what is being typed.
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    this.win.setAlwaysOnTop(true, "screen-saver");
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      if (url === "sluice://focus") this.focusMain();
      else void shell.openExternal(url);
      return { action: "deny" };
    });
    this.win.once("ready-to-show", () => {
      this.ready = true;
      this.win?.showInactive();
      this.flush();
    });
    void this.win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  }
  flush() {
    const pending = this.queued;
    this.queued = [];
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.win.isVisible()) this.win.showInactive();
    for (const toast of pending) {
      void this.win.webContents.executeJavaScript(
        `window.addToast(${JSON.stringify(toast)})`,
        true
      );
    }
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.win?.hide(), DISMISS_MS + 600);
  }
}
const PAGE = `<!doctype html>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; overflow: hidden; background: transparent;
    display: flex; flex-direction: column; justify-content: flex-end; height: 100vh; gap: 8px;
    font: 13px/1.4 "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    -webkit-user-select: none; user-select: none;
  }
  .toast {
    display: flex; gap: 12px; align-items: center;
    padding: 12px 14px; margin: 0 4px;
    border-radius: 12px;
    background: rgba(23, 21, 32, 0.96);
    border: 1px solid rgba(255,255,255,0.09);
    border-left: 3px solid var(--accent, #a970ff);
    box-shadow: 0 10px 34px rgba(0,0,0,0.55);
    cursor: pointer;
    animation: in 260ms cubic-bezier(.2,.9,.3,1) both;
  }
  .toast.out { animation: out 260ms ease forwards; }
  .toast.complete { --accent: #3ddc84; }
  @keyframes in  { from { opacity: 0; transform: translateX(24px) scale(.98); } }
  @keyframes out { to   { opacity: 0; transform: translateX(24px); } }
  @media (prefers-reduced-motion: reduce) {
    .toast, .toast.out { animation: none; }
  }
  .art {
    width: 48px; height: 48px; flex: 0 0 auto; border-radius: 8px; object-fit: cover;
    background: rgba(255,255,255,0.06);
  }
  .text { min-width: 0; flex: 1; }
  .kind {
    font-size: 10px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--accent, #a970ff); font-weight: 600;
  }
  .name {
    color: #f2f0f6; font-weight: 600; font-size: 14px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px;
  }
  .game {
    color: #a9a4b8; font-size: 12px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
</style>
<body>
<script>
  const DISMISS = ${DISMISS_MS};

  window.addToast = function (toast) {
    const el = document.createElement("div");
    el.className = "toast" + (toast.kind === "complete" ? " complete" : "");

    if (toast.imageUrl) {
      const img = document.createElement("img");
      img.className = "art";
      img.src = toast.imageUrl;
      // A CDN that refuses leaves a neat empty tile rather than a broken-image glyph.
      img.onerror = () => img.remove();
      el.appendChild(img);
    }

    const text = document.createElement("div");
    text.className = "text";
    for (const [cls, value] of [["kind", toast.title], ["name", toast.name], ["game", toast.game]]) {
      if (!value) continue;
      const line = document.createElement("div");
      line.className = cls;
      line.textContent = value;
      text.appendChild(line);
    }
    el.appendChild(text);

    // window.open is intercepted by the main process; the page opens nothing itself.
    el.onclick = () => { window.open(toast.url || "sluice://focus"); dismiss(el); };
    document.body.appendChild(el);

    // Only ever three on screen; the oldest goes rather than the stack growing off-screen.
    while (document.body.children.length > 3) document.body.firstElementChild.remove();

    setTimeout(() => dismiss(el), DISMISS);
  };

  function dismiss(el) {
    if (!el.isConnected || el.classList.contains("out")) return;
    el.classList.add("out");
    setTimeout(() => el.remove(), 280);
  }
<\/script>
</body>`;
const MAX_FILES = 200;
const EXTENSIONS = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
function nameFor(url) {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
  const suffix = extname(new URL(url).pathname).toLowerCase();
  return `${hash}${EXTENSIONS.has(suffix) ? suffix : ".png"}`;
}
class IconCache {
  constructor(dir) {
    this.dir = dir;
  }
  dir;
  /**
   * A local path for the art, or null if it cannot be had.
   *
   * Never throws. A notification without its picture is a great deal better than a claim
   * that goes unannounced because a CDN was slow.
   */
  async pathFor(url) {
    if (!url || !/^https?:\/\//i.test(url)) return null;
    try {
      const target = join(this.dir, nameFor(url));
      if (existsSync(target)) return target;
      await mkdir(this.dir, { recursive: true });
      const response = await fetch(url, { signal: AbortSignal.timeout(5e3) });
      if (!response.ok) return null;
      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength < 64 || body.byteLength > 4e6) return null;
      await writeFile(target, body);
      void this.prune();
      return target;
    } catch {
      return null;
    }
  }
  /** Oldest first, once there are more than a campaign's worth. */
  async prune() {
    try {
      const names = await readdir(this.dir);
      if (names.length <= MAX_FILES) return;
      const entries = await Promise.all(
        names.map(async (name) => {
          const path = join(this.dir, name);
          return { path, at: (await stat(path)).mtimeMs };
        })
      );
      entries.sort((a, b) => a.at - b.at);
      await Promise.all(
        entries.slice(0, entries.length - MAX_FILES).map((entry) => unlink(entry.path))
      );
    } catch {
    }
  }
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
  tray.setToolTip("Sluice");
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
const CHECK_WINDOW_MS = 2 * 60 * 60 * 1e3;
const CHECKS_PER_WINDOW = 3;
function nextCheckDelay(random = Math.random) {
  const slot = CHECK_WINDOW_MS / CHECKS_PER_WINDOW;
  return slot * (0.5 + random() * 0.5);
}
const RETRY_AFTER_MS = 5 * 60 * 1e3;
class AutoUpdate {
  /**
   * @param enabled whether automatic checking is switched on. Read at each check rather
   *                than captured, so turning it off in settings takes effect immediately
   *                instead of at the next restart.
   */
  constructor(bus, enabled = () => true) {
    this.bus = bus;
    this.enabled = enabled;
  }
  bus;
  enabled;
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
    if (!updater || typeof updater.on !== "function") {
      logger.warn("No usable updater was provided; automatic updates are off.");
      this.publish({ status: "idle" });
      return;
    }
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
      (progress) => this.publish({
        status: "downloading",
        percent: Math.round(progress?.percent ?? 0),
        bytesPerSecond: progress?.bytesPerSecond ?? 0,
        transferred: progress?.transferred ?? 0,
        total: progress?.total ?? 0
      })
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
    this.scheduleNext();
  }
  /**
   * Three looks every two hours, scattered rather than on the hour.
   *
   * A fixed interval means every installation in the world asks GitHub at the same second
   * after a release, which is both rude and the surest way to be rate limited. Spreading
   * each check randomly across its slot costs nothing and avoids the stampede.
   */
  scheduleNext() {
    this.checkTimer = setTimeout(() => {
      this.check();
      this.scheduleNext();
    }, nextCheckDelay());
    this.checkTimer.unref();
  }
  /** A manual check, which happens whatever the automatic setting says. */
  checkNow() {
    this.check(true);
  }
  check(manual = false) {
    if (!manual && !this.enabled()) {
      logger.debug("Automatic update check skipped: switched off.");
      return;
    }
    try {
      void this.updater?.checkForUpdates();
    } catch (error) {
      logger.debug("Update check threw:", error);
    }
  }
  /** Restart into the new version now, rather than waiting for the next quit. */
  installNow() {
    try {
      this.publish({ status: "installing" });
      this.updater?.quitAndInstall();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.publish({ status: "error", message });
    }
  }
  stop() {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
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
    const sendMaximised = () => win?.webContents.send("window:maximized", win.isMaximized());
    win.on("maximize", sendMaximised);
    win.on("unmaximize", sendMaximised);
    win.on("resize", applyThinZoom);
    win.on("maximize", applyThinZoom);
    win.on("unmaximize", applyThinZoom);
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
          "Sluice is in the tray. Quit from there to stop it."
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
    ipcMain.handle("window:toggle-thin", () => {
      if (!win) return false;
      if (thin) {
        win.setMinimumSize(720, 480);
        win.setBounds({ width: wideWidth, height: win.getBounds().height }, true);
        thin = false;
      } else {
        if (win.isMaximized()) win.unmaximize();
        wideWidth = win.getBounds().width;
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
    ipcMain.handle("desktop:changelog", async () => {
      try {
        const response = await fetch(
          "https://api.github.com/repos/loversama/sluice-releases/releases?per_page=10",
          { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(1e4) }
        );
        if (!response.ok) return { ok: false, error: `GitHub returned ${response.status}` };
        const releases = await response.json();
        return {
          ok: true,
          releases: releases.map((release) => ({
            version: release.tag_name ?? release.name ?? "",
            name: release.name ?? "",
            at: release.published_at ?? null,
            notes: release.body ?? ""
          }))
        };
      } catch {
        return { ok: false, error: "Could not reach GitHub." };
      }
    });
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
  const THIN_WIDTH = 420;
  const MAX_THIN_ZOOM = 1.75;
  let thin = false;
  let wideWidth = 1180;
  let toasts = null;
  let icons = null;
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
  const isOurs = (url) => isOwnUrl(url, port);
  const openExternally = (url) => {
    void shell.openExternal(url);
  };
  const applyThinZoom = () => {
    if (!win) return;
    if (!thin) {
      win.webContents.setZoomFactor(1);
      return;
    }
    const { width } = win.getContentBounds();
    const factor = Math.min(MAX_THIN_ZOOM, Math.max(1, width / THIN_WIDTH));
    win.webContents.setZoomFactor(factor);
  };
  app.setAppUserModelId("com.sluice.desktop");
  app.whenReady().then(
    async () => {
      const dataDir = app.getPath("userData");
      setLogSink(createFileSink(logDirectory(dataDir), !app.isPackaged));
      handle = createApp({
        dataDir,
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
      handle.bus.on("update", (status) => {
        win?.webContents.send("desktop:update", status);
      });
      updates = new AutoUpdate(handle.bus, () => handle?.context.getConfig().autoUpdate !== false);
      registerIpc();
      handle.start();
      if (app.isPackaged) {
        const updaterModule = await import("electron-updater");
        const autoUpdater = updaterModule.autoUpdater ?? updaterModule.default?.autoUpdater;
        if (!autoUpdater) {
          logger.warn("electron-updater did not load; automatic updates are off.");
        } else {
          updates.start(autoUpdater);
        }
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
      const focusApp = () => {
        win?.show();
        win?.focus();
      };
      icons = new IconCache(join(dataDir, "reward-icons"));
      toasts = new ToastOverlay(focusApp);
      const announce = async (toast) => {
        const config = handle?.context.getConfig();
        if (config?.desktopNotifications === false) return;
        const icon = await icons?.pathFor(toast.imageUrl) ?? void 0;
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
          body: toast.game ? `${toast.name}
${toast.game}` : toast.name,
          icon,
          silent: true
          // The dashboard already plays its own sound, if enabled.
        });
        notification.on("click", focusApp);
        notification.show();
      };
      handle.bus.on(
        "drop-claimed",
        (payload) => {
          void announce({
            kind: "claim",
            title: "Drop claimed",
            name: payload.dropName ?? "Reward claimed",
            game: payload.gameName ?? null,
            imageUrl: payload.rewardImageURL ?? null
          });
        }
      );
      handle.bus.on("campaign-completed", (payload) => {
        void announce({
          kind: "complete",
          title: "Campaign complete",
          name: payload.gameName ?? "Campaign complete",
          game: payload.name ?? null
        });
      });
      handle.bus.on("watching", (payload) => {
        const channel = payload?.channel;
        setTrayStatus(
          channel ? `Mining ${channel.game ?? "a game"} on ${channel.displayName ?? "a channel"}` : "Sluice"
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
        "Sluice could not start",
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
      dialog.showErrorBox("Sluice hit an error", message);
    } catch {
    }
  });
  process.on("uncaughtException", (error) => {
    try {
      dialog.showErrorBox("Sluice hit an error", error.stack ?? error.message);
    } catch {
    }
    app.exit(1);
  });
}
