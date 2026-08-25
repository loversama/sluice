import { app, dialog, BrowserWindow, shell } from "electron";
import { consoleSink, setLogSink, createApp, setLogLevel } from "@tdb/core";
import { ApiServer } from "@tdb/server";
import { mkdirSync, statSync, renameSync, appendFileSync } from "node:fs";
import { inspect } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
        // No preload script. The dashboard is an ordinary web app talking to our
        // own server over HTTP; it needs nothing from Node, and an empty preload
        // would only force a choice between sandboxing and module format. When
        // something genuinely native is needed, add one then and decide there.
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
    void win.loadURL(`http://127.0.0.1:${port}/`);
  };
  let win = null;
  let handle = null;
  let server = null;
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
      handle.start();
      createWindow();
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
    app.quit();
  });
  app.on("will-quit", (event) => {
    if (quitting) {
      return;
    }
    quitting = true;
    event.preventDefault();
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
