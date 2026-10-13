/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("subscriptionButlerSetup", {
  save: (loginKey, confirmation) => ipcRenderer.invoke("setup:save", loginKey, confirmation),
});
