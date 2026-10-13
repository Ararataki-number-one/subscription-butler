/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("teamAccountManagerDesktop", {
  credentials: {
    isAvailable: () => ipcRenderer.invoke("credentials:is-available"),
    loadLoginKey: () => ipcRenderer.invoke("credentials:load"),
    saveLoginKey: (loginKey) => ipcRenderer.invoke("credentials:save", loginKey),
    clearLoginKey: () => ipcRenderer.invoke("credentials:clear"),
  },
});
