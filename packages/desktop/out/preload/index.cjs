"use strict";
const electron = require("electron");
const bridge = {
  version: () => electron.ipcRenderer.invoke("desktop:version"),
  getSettings: () => electron.ipcRenderer.invoke("desktop:get-settings"),
  setSettings: (next) => electron.ipcRenderer.invoke("desktop:set-settings", next),
  openLogsFolder: () => electron.ipcRenderer.invoke("desktop:open-logs"),
  importFromDocker: () => electron.ipcRenderer.invoke("desktop:import-docker"),
  updateStatus: () => electron.ipcRenderer.invoke("desktop:update-status"),
  checkForUpdates: () => electron.ipcRenderer.invoke("desktop:check-updates"),
  installUpdate: () => electron.ipcRenderer.invoke("desktop:install-update"),
  changelog: () => electron.ipcRenderer.invoke("desktop:changelog"),
  onUpdateStatus: (fn) => {
    electron.ipcRenderer.on("desktop:update", (_event, status) => fn(status));
  },
  // There is no window frame, so the page draws the controls.
  minimize: () => electron.ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => electron.ipcRenderer.invoke("window:toggle-maximize"),
  close: () => electron.ipcRenderer.invoke("window:close"),
  isMaximized: () => electron.ipcRenderer.invoke("window:is-maximized"),
  onMaximizedChange: (fn) => {
    electron.ipcRenderer.on("window:maximized", (_event, value) => fn(value));
  },
  toggleThin: () => electron.ipcRenderer.invoke("window:toggle-thin"),
  isThin: () => electron.ipcRenderer.invoke("window:is-thin"),
  onThinChange: (fn) => {
    electron.ipcRenderer.on("window:thin", (_event, value) => fn(value));
  }
};
electron.contextBridge.exposeInMainWorld("desktopBridge", bridge);
