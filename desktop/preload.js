/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");
function currentMemberToken() {
  try { return window.sessionStorage.getItem("ops-token") || undefined; } catch { return undefined; }
}

contextBridge.exposeInMainWorld("teamAccountManagerDesktop", {
  cardVault: {
    summary: () => ipcRenderer.invoke("card-vault:summary", currentMemberToken()),
    get: id => ipcRenderer.invoke("card-vault:get", currentMemberToken(), id),
    save: (id, details, revision) => ipcRenderer.invoke("card-vault:save", currentMemberToken(), id, details, revision),
    remove: (id, revision) => ipcRenderer.invoke("card-vault:remove", currentMemberToken(), id, revision),
    copy: (id, field) => ipcRenderer.invoke("card-vault:copy", currentMemberToken(), id, field),
  },
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
