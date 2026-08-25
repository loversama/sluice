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
  installUpdate: () => electron.ipcRenderer.invoke("desktop:install-update")
};
electron.contextBridge.exposeInMainWorld("desktopBridge", bridge);
