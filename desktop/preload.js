/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");
function currentMemberToken() {
  try { return window.sessionStorage.getItem("ops-token") || undefined; } catch { return undefined; }
}

contextBridge.exposeInMainWorld("teamAccountManagerDesktop", {
  maintenance: {
    createBackup: () => ipcRenderer.invoke("maintenance:backup", currentMemberToken()),
    restoreBackup: () => ipcRenderer.invoke("maintenance:restore", currentMemberToken()),
    listRestorePoints: () => ipcRenderer.invoke("maintenance:list-points", currentMemberToken()),
    restorePoint: (name) => ipcRenderer.invoke("maintenance:restore-point", currentMemberToken(), name),
  },
  getPreferences: () => ipcRenderer.invoke("desktop:preferences"),
  setPreferences: (preferences) => ipcRenderer.invoke("desktop:set-preferences", preferences),
  credentials: {
    isAvailable: () => ipcRenderer.invoke("credentials:is-available"),
    loadLoginKey: () => ipcRenderer.invoke("credentials:load"),
    saveLoginKey: (loginKey) => ipcRenderer.invoke("credentials:save", loginKey),
    clearLoginKey: () => ipcRenderer.invoke("credentials:clear"),
  },
});
