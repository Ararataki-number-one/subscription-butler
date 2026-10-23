// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell, session, Tray, Notification, nativeImage, clipboard } = require("electron");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  assertSmokeDirectory, backendEnvironment, clearDesktopWorkerCache, createLocalOwnerSession, ensureLocalWorkspaceReady, externalWebUrl, initializeLocalConfig, launchBackend, persistentLoopbackPort,
  loadConfig, runInitializer, runtimePaths, stopBackendAndCloseConnections, trustedLocalUrl, writeEnvironmentFile,
} = require("./runtime.js");
const { BackupManager, writeJsonAtomic } = require("./backups.js");
const { maintenanceRunner, requireMaintenanceAdmin } = require("./maintenance.js");
const { ReminderManager } = require("./reminders.js");
const { CardVault, installCardVaultHandlers } = require("./card-vault.js");
const { readBrowserQueue, readQueue, saveQueue, validateQueue, writeBrowserQueue } = require("./offline-queue.js");

const APP_NAME = "订阅管家";
const APP_ID = "io.github.ararataki.subscriptionbutler";
const RELEASES_URL = "https://github.com/Ararataki-number-one/subscription-butler/releases";
app.setName(APP_NAME);
app.setPath("userData", path.join(app.getPath("appData"), APP_NAME));
const maintenanceSmokeTest = process.argv.includes("--maintenance-smoke-test");
const uiSmokeTest = process.argv.includes("--ui-smoke-test") || process.argv.includes("--first-run-smoke-test");
const smokeTest = process.argv.includes("--smoke-test") || maintenanceSmokeTest || uiSmokeTest;
if (smokeTest) {
  const requestedTarget = process.env.SUBSCRIPTION_BUTLER_USER_DATA ||
    fs.mkdtempSync(path.join(app.getPath("temp"), "subscription-butler-smoke-"));
  const target = assertSmokeDirectory(requestedTarget, app.getPath("userData"));
  fs.mkdirSync(target, { recursive: true });
  app.setPath("userData", target);
}

let config;
let mainWindow;
let serverProcess;
let stoppingServerProcess;
let port;
let isQuitting = false;
let backendReady = false;
let maintenanceBusy = false;
let runtime;
let backupManager;
let tray;
let reminderManager;
let reminderInterval;
let cardVault;
let preferences = { closeToTray: true, notifications: true, closeHintShown: false };

function loadPreferences() {
  const file = path.join(app.getPath("userData"), "desktop-preferences.json");
  if (!fs.existsSync(file)) return;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const key of Object.keys(preferences)) if (typeof value[key] === "boolean") preferences[key] = value[key];
  } catch { /* Invalid preferences must not prevent access to the ledger. */ }
}
function setPreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["closeToTray", "notifications"].includes(key) || typeof value[key] !== "boolean")) {
    throw new Error("桌面偏好设置无效。");
  }
  Object.assign(preferences, value);
  writeJsonAtomic(path.join(app.getPath("userData"), "desktop-preferences.json"), preferences);
  installMenu(); installTrayMenu();
  return { closeToTray: preferences.closeToTray, notifications: preferences.notifications };
}
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}

function appUrl(pathname = "/") {
  return `http://127.0.0.1:${port}${pathname}`;
}

function credentialsPath() {
  return path.join(app.getPath("userData"), "credentials.bin");
}

function assertTrustedRenderer(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      !trustedLocalUrl(event.senderFrame?.url, port)) {
    throw new Error("已拒绝非本地页面的凭据请求。");
  }
}
function assertCredentialRenderer(event) {
  assertTrustedRenderer(event);
  if (new URL(event.senderFrame.url).pathname !== "/login") throw new Error("已拒绝登录页之外的凭据请求。");
}

function installCredentialHandlers() {
  ipcMain.handle("credentials:is-available", (event) => {
    assertCredentialRenderer(event);
    return safeStorage.isEncryptionAvailable();
  });
  ipcMain.handle("credentials:load", (event) => {
    assertCredentialRenderer(event);
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(credentialsPath())) return null;
    return safeStorage.decryptString(fs.readFileSync(credentialsPath()));
  });
  ipcMain.handle("credentials:save", (event, loginKey) => {
    assertCredentialRenderer(event);
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 安全存储当前不可用。");
    if (typeof loginKey !== "string" || !loginKey || loginKey.length > 4096) {
      throw new Error("登录密钥格式无效。");
    }
    const filePath = credentialsPath();
    const temporaryPath = `${filePath}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(temporaryPath, safeStorage.encryptString(loginKey), { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  });
  ipcMain.handle("credentials:clear", (event) => {
    assertCredentialRenderer(event);
    fs.rmSync(credentialsPath(), { force: true });
  });
}

function appendServerLog(name, chunk) {
  const logDirectory = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const logFile = path.join(logDirectory, name);
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) {
    fs.rmSync(`${logFile}.1`, { force: true });
    fs.renameSync(logFile, `${logFile}.1`);
  }
  let text = String(chunk);
  if (config) {
    text = text.replaceAll(config.authSecret, "[redacted]").replaceAll(config.loginKeyHash, "[redacted]");
  }
  fs.appendFileSync(logFile, text, { mode: 0o600 });
}

function terminateProcess(child) {
  if (!child || child.killed || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true, stdio: "ignore", timeout: 10000,
    });
    if (result.status !== 0) child.kill();
  } else {
    child.kill("SIGTERM");
  }
}
function stopOwnedServer() { terminateProcess(serverProcess); }
async function stopBackend() {
  backendReady = false;
  const child = serverProcess; stoppingServerProcess = child;
  try {
    await stopBackendAndCloseConnections(child, terminateProcess, () => session.defaultSession.closeAllConnections());
    if (serverProcess === child) serverProcess = undefined;
  } finally { stoppingServerProcess = undefined; }
}
async function startBackend() {
  config = loadConfig(app.getPath("userData"));
  writeEnvironmentFile(app.getPath("userData"), config);
  const environment = backendEnvironment(config, app.getPath("userData"), port);
  await runInitializer(runtime, environment, appendServerLog);
  const child = await launchBackend(runtime, environment, appendServerLog, { onSpawn: value => { serverProcess = value; } });
  child.once("exit", (code, signal) => {
    if (serverProcess === child && stoppingServerProcess !== child && !isQuitting) {
      backendReady = false;
      appendServerLog("desktop.log", `${new Date().toISOString()} BACKEND_EXIT ${signal || code}\n`);
      dialog.showErrorBox(`${APP_NAME} 服务已停止`, "本地数据服务意外停止，请重新打开程序。数据仍保存在本地数据目录。");
      app.quit();
    }
  });
  const ownerCookie = await authorizeLocalDesktop();
  await ensureLocalWorkspaceReady(port, ownerCookie);
  backendReady = true;
  if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(appUrl("/"));
}
async function authorizeLocalDesktop() {
  const ownerSession = createLocalOwnerSession(config.authSecret);
  await session.defaultSession.cookies.set({ url: appUrl(), name: "tam_session", value: ownerSession.value,
    path: "/", httpOnly: true, sameSite: "lax", secure: false, expirationDate: Math.floor(ownerSession.expiresAt / 1000) });
  return ownerSession.value;
}
async function enterLocalWorkspace() {
  if (!backendReady || maintenanceBusy) throw new Error("本地服务尚未准备好，请稍后重试。");
  if (mainWindow && trustedLocalUrl(mainWindow.webContents.getURL(), port)) {
    await mainWindow.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: "sessionStorage.removeItem('ops-token'); sessionStorage.removeItem('ops-actor'); sessionStorage.removeItem('ops-role'); localStorage.removeItem('ops-actor');" }]);
  }
  await authorizeLocalDesktop();
  await mainWindow.loadURL(appUrl("/")); showMainWindow();
}

function setupMaintenance() {
  const environment = backendEnvironment(config, app.getPath("userData"), port);
  const operations = maintenanceRunner(runtime, environment);
  backupManager = new BackupManager({ userData: app.getPath("userData"), appVersion: app.getVersion(), ...operations,
    protectKey: value => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 安全存储不可用，无法创建敏感资料备份。");
      return safeStorage.encryptString(value);
    },
    unprotectKey: value => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 安全存储不可用。");
      return safeStorage.decryptString(value);
    },
  });
  reminderManager = new ReminderManager({ userData: app.getPath("userData"), fetchReminders: operations.reminders,
    enabled: () => preferences.notifications && backendReady && !maintenanceBusy && !isQuitting,
    notify: details => new Promise(resolve => {
      if (!Notification.isSupported()) return resolve(false);
      const notification = new Notification(details);
      const timer = setTimeout(() => resolve(false), 5000);
      notification.once("show", () => { clearTimeout(timer); resolve(true); });
      notification.once("failed", () => { clearTimeout(timer); resolve(false); });
      notification.once("click", () => { showMainWindow(); void mainWindow?.loadURL(appUrl("/")); });
      notification.show();
    }),
  });
}
function checkReminders() {
  if (reminderManager) void reminderManager.check().catch(() => appendServerLog("desktop.log", `${new Date().toISOString()} REMINDER_CHECK_FAILED\n`));
}
async function exclusiveMaintenance(action) {
  if (maintenanceBusy || !backendReady) throw new Error("本地维护正在运行，请稍后重试。");
  maintenanceBusy = true; installMenu(); installTrayMenu();
  try { return await action(); }
  finally { maintenanceBusy = false; installMenu(); installTrayMenu(); }
}
async function requestBackup() {
  return exclusiveMaintenance(async () => {
    const answer = await dialog.showMessageBox(mainWindow, { type: "info", title: "创建本机加密备份", buttons: ["选择保存位置", "取消"], defaultId: 0, cancelId: 1,
      message: "备份包括完整账本、登录配置、MFA 与邮件设置。",
      detail: "备份经过 Windows 安全存储加密，只能由这台电脑上的当前 Windows 用户恢复。请保存在自己的本机磁盘，勿将私账提交到 GitHub。" });
    if (answer.response !== 0) return { cancelled: true };
    const result = await dialog.showSaveDialog(mainWindow, { title: "保存订阅管家加密备份", defaultPath: `SubscriptionButler-${new Date().toISOString().slice(0, 10)}.sbbackup`,
      filters: [{ name: "订阅管家本机备份", extensions: ["sbbackup"] }] });
    if (result.canceled || !result.filePath) return { cancelled: true };
    const backup = await backupManager.create(result.filePath);
    await dialog.showMessageBox(mainWindow, { type: "info", title: "备份完成", message: "加密备份已保存。", detail: result.filePath });
    return { cancelled: false, fileName: path.basename(backup.file), createdAt: backup.createdAt };
  });
}
function restoreSummary(info) {
  const counts = info.summary.counts;
  const operational = info.summary.operations?.counts;
  const ledger = operational?.subscription ? `工作台：客户 ${operational.customer || 0} 个，订阅 ${operational.subscription || 0} 个，租期 ${operational.rental || 0} 个，收支 ${operational.entry || 0} 条。\n` : "";
  return `备份时间：${new Date(info.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n软件版本：${info.appVersion}\n${ledger}旧版资料：订阅 ${counts.space} 个，母号 ${counts.mother_account} 个，成员 ${counts.child_account} 个，实收记录 ${counts.account_receipt} 条。\n数据库完整性、账户、金额与安全设置校验已通过。\n恢复前会自动保存当前状态，可从“恢复点”回滚。恢复后自动进入本机工作区，原网页访问与 MFA 配置继续保留。`;
}
async function restoreSelected(file) {
  const manager = backupManager;
  const prepared = await manager.prepareRestore(file);
  let pending;
  try { pending = validateQueue(await inspectBrowserQueue()); }
  catch (error) { manager.discardPrepared(prepared); throw error; }
  const answer = await dialog.showMessageBox(mainWindow, { type: "warning", title: "确认恢复备份", buttons: ["恢复并进入本机工作区", "取消"], defaultId: 1, cancelId: 1,
    message: "此备份将替换当前本机账本和安全配置。", detail: restoreSummary(prepared.info) + (pending.length
      ? `\n另有 ${pending.length} 项浏览器未提交操作，不在账本备份中。继续后会先单独加密保存，再清除旧队列；可在“维护 → 恢复已保存的未提交队列”人工重新排队。`
      : "\n恢复会清除旧网页缓存和登录会话。") });
  if (answer.response !== 0) { manager.discardPrepared(prepared); return { cancelled: true }; }
  const queueFile = pending.length ? saveQueue(app.getPath("userData"), new URL(appUrl()).origin, pending, manager.protectKey) : undefined;
  await mainWindow.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: "sessionStorage.clear()" }]);
  // Detach old IndexedDB handles and prevent background browser retry while
  // replacing the ledger. Pending commands already have an encrypted export.
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml())}`);
  const result = await manager.restorePrepared(prepared, { stop: stopBackend, start: async () => {
    await session.defaultSession.clearStorageData({ origin: new URL(appUrl()).origin,
      storages: ["cookies", "indexdb", "localstorage", "serviceworkers", "cachestorage"] });
    await startBackend(); loadPreferences(); setupMaintenance();
  } });
  await dialog.showMessageBox(mainWindow, { type: "info", title: "恢复完成", message: "备份已恢复，已进入本机工作区。", detail: `恢复前的回滚备份：${path.basename(result.rollbackFile)}` + (queueFile ? `\n未提交队列已单独加密保存：${path.basename(queueFile)}` : "") });
  return { cancelled: false, restoredAt: new Date().toISOString() };
}
async function inspectBrowserQueue() {
  if (!mainWindow || !trustedLocalUrl(mainWindow.webContents.getURL(), port)) throw new Error("请先返回本地页面，再检查未提交队列。");
  return mainWindow.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${readBrowserQueue.toString()})()` }]);
}
async function importSavedQueue() {
  return exclusiveMaintenance(async () => {
    const token = await mainWindow.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: "sessionStorage.getItem('ops-token') || undefined" }]);
    const actor = await assertMaintenanceOwner(token);
    const choice = await dialog.showOpenDialog(mainWindow, { title: "选择本机加密未提交队列", defaultPath: backupManager.backupDirectory(), properties: ["openFile"],
      filters: [{ name: "订阅管家未提交队列", extensions: ["sbqueue"] }] });
    if (choice.canceled || !choice.filePaths[0]) return;
    const rows = readQueue(choice.filePaths[0], new URL(appUrl()).origin, backupManager.unprotectKey);
    const answer = await dialog.showMessageBox(mainWindow, { type: "warning", title: "恢复未提交队列", message: `将 ${rows.length} 项操作重新放入当前管理员的待提交队列。`,
      detail: "不会直接写入账本。返回客户页面检查后再重试提交；服务端仍会核对权限、命令编号和记录版本，重复命令不会重复入账。", buttons: ["放入待提交队列", "取消"], defaultId: 1, cancelId: 1 });
    if (answer.response !== 0) return;
    const reassigned = rows.map(row => ({ ...row, actorId: actor.id }));
    const serialized = JSON.stringify(JSON.stringify(reassigned));
    await mainWindow.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${writeBrowserQueue.toString()})(JSON.parse(${serialized}))` }]);
    await mainWindow.loadURL(appUrl("/customers"));
    await dialog.showMessageBox(mainWindow, { type: "info", message: "队列已恢复，请在客户页面检查后再提交。" });
  });
}
async function requestRestore() {
  return exclusiveMaintenance(async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: "选择订阅管家本机加密备份", properties: ["openFile"],
      filters: [{ name: "订阅管家本机备份", extensions: ["sbbackup"] }] });
    if (result.canceled || !result.filePaths[0]) return { cancelled: true };
    return restoreSelected(result.filePaths[0]);
  });
}
async function requestRestorePoint(name) {
  return exclusiveMaintenance(async () => {
    const points = backupManager.list();
    let selected;
    if (name !== undefined) {
      if (typeof name !== "string" || !points.some(point => point.name === name)) throw new Error("恢复点不存在。");
      selected = points.find(point => point.name === name);
    } else {
      if (!points.length) { await dialog.showMessageBox(mainWindow, { type: "info", message: "暂无自动恢复点。升级与恢复前会自动创建。" }); return { cancelled: true }; }
      const answer = await dialog.showMessageBox(mainWindow, { type: "question", title: "选择恢复点", message: "选择要恢复的本机加密恢复点。",
        buttons: [...points.map(point => `${point.name.startsWith("upgrade-") ? "升级前" : "恢复前"} · ${new Date(point.modifiedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`), "取消"], defaultId: points.length, cancelId: points.length });
      if (answer.response >= points.length) return { cancelled: true };
      selected = points[answer.response];
    }
    return restoreSelected(selected.path);
  });
}
function installMaintenanceHandlers() {
  cardVault = new CardVault({ userData: app.getPath("userData"), safeStorage, clipboard });
  installCardVaultHandlers({ ipcMain, vault: cardVault, assertRenderer: assertTrustedRenderer,
    authorize: assertMaintenanceOwner, ready: () => backendReady && !maintenanceBusy && !isQuitting });
  const handle = (name, handler) => ipcMain.handle(name, (event, ...args) => { assertTrustedRenderer(event); return handler(...args); });
  const owner = (action) => async (token, ...args) => { await assertMaintenanceOwner(token); return action(...args); };
  handle("maintenance:backup", owner(requestBackup));
  handle("maintenance:restore", owner(requestRestore));
  handle("maintenance:restore-point", owner(requestRestorePoint));
  handle("maintenance:list-points", owner(() => (backupManager?.list() || []).map(({ name, modifiedAt }) => ({ name, modifiedAt }))));
  handle("desktop:preferences", () => ({ closeToTray: preferences.closeToTray, notifications: preferences.notifications }));
  handle("desktop:set-preferences", setPreferences);
}
async function assertMaintenanceOwner(token) {
  const cookies = await session.defaultSession.cookies.get({ url: appUrl(), name: "tam_session" });
  return requireMaintenanceAdmin(appUrl(), token, cookies[0]?.value);
}
function menuAction(action) {
  void action().catch(error => dialog.showErrorBox("本地维护未完成", error.message));
}
function installTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开订阅管家", click: showMainWindow }, { type: "separator" },
    { label: "创建加密备份…", enabled: backendReady && !maintenanceBusy, click: () => menuAction(requestBackup) },
    { label: "恢复备份…", enabled: backendReady && !maintenanceBusy, click: () => menuAction(requestRestore) },
    { label: "到期通知", type: "checkbox", checked: preferences.notifications, click: item => setPreferences({ notifications: item.checked }) },
    { type: "separator" }, { label: "退出订阅管家", click: () => app.quit() },
  ]));
}
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "assets/icon.ico"));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("订阅管家 · 本地后台服务"); tray.on("click", showMainWindow); tray.on("double-click", showMainWindow);
  installTrayMenu();
}

function openExternalWebUrl(target) {
  if (externalWebUrl(target)) void shell.openExternal(target);
}

function loadingHtml() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>${APP_NAME}</title><style>
    :root{color-scheme:light;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f9f8;color:#17212b}
    main{text-align:center}.mark{width:56px;height:56px;margin:0 auto 20px;border-radius:15px;background:#00795e;display:grid;place-items:center;color:white;font-size:24px;font-weight:700}
    h1{margin:0;font-size:22px}p{margin:12px 0 0;color:#68747e;font-size:14px}
    .bar{width:220px;height:3px;margin:24px auto 0;border-radius:2px;overflow:hidden;background:#dfe5e8}.bar::after{content:"";display:block;width:45%;height:100%;background:#00795e;animation:move 1.2s ease-in-out infinite}
    @keyframes move{from{transform:translateX(-110%)}to{transform:translateX(250%)}}
    </style><main><div class="mark">订</div><h1>${APP_NAME}</h1><p>正在启动本地数据服务…</p><div class="bar"></div></main></html>`;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320, height: 860, minWidth: 980, minHeight: 680, show: false,
    backgroundColor: "#f5f9f8", title: APP_NAME,
    icon: path.join(__dirname, "assets", "icon.ico"),
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow.once("ready-to-show", () => { if (!smokeTest) mainWindow.show(); });
  mainWindow.on("close", event => {
    if (!isQuitting && preferences.closeToTray && backendReady && tray) {
      event.preventDefault(); mainWindow.hide();
      if (!preferences.closeHintShown) {
        preferences.closeHintShown = true;
        writeJsonAtomic(path.join(app.getPath("userData"), "desktop-preferences.json"), preferences);
        tray.displayBalloon({ title: "订阅管家仍在后台运行", content: "点击托盘图标返回，右键选择“退出订阅管家”停止服务。", iconType: "info" });
      }
    } else if (!isQuitting) app.quit();
  });
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!trustedLocalUrl(targetUrl, port)) {
      event.preventDefault();
      openExternalWebUrl(targetUrl);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (trustedLocalUrl(url, port)) void mainWindow.loadURL(url);
    else openExternalWebUrl(url);
    return { action: "deny" };
  });
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml())}`);
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "应用", submenu: [
      { label: "刷新", accelerator: "Ctrl+R", click: () => mainWindow?.reload() },
      { label: "重新进入本机工作区", enabled: backendReady && !maintenanceBusy, click: () => menuAction(enterLocalWorkspace) },
      { label: "关闭窗口到托盘", type: "checkbox", checked: preferences.closeToTray, click: item => setPreferences({ closeToTray: item.checked }) },
      { label: "到期通知", type: "checkbox", checked: preferences.notifications, click: item => setPreferences({ notifications: item.checked }) },
      { type: "separator" },
      { label: "退出", accelerator: "Alt+F4", click: () => app.quit() },
    ] },
    { label: "维护", submenu: [
      { label: "创建本机加密备份…", enabled: backendReady && !maintenanceBusy, click: () => menuAction(requestBackup) },
      { label: "恢复备份…", enabled: backendReady && !maintenanceBusy, click: () => menuAction(requestRestore) },
      { label: "从自动恢复点回滚…", enabled: backendReady && !maintenanceBusy, click: () => menuAction(requestRestorePoint) },
      { label: "恢复已保存的未提交队列…", enabled: backendReady && !maintenanceBusy, click: () => menuAction(importSavedQueue) },
      { type: "separator" },
      { label: "下载最新版本…", click: () => openExternalWebUrl(RELEASES_URL) },
      { label: "打开数据目录", click: () => void shell.openPath(app.getPath("userData")) },
      { label: "打开日志目录", click: () => {
        const directory = path.join(app.getPath("userData"), "logs");
        fs.mkdirSync(directory, { recursive: true });
        void shell.openPath(directory);
      } },
    ] },
    { label: "帮助", submenu: [
      { label: "GitHub 项目", click: () => openExternalWebUrl("https://github.com/Ararataki-number-one/subscription-butler") },
      { label: "关于订阅管家", click: () => void dialog.showMessageBox(mainWindow, {
        type: "info", title: APP_NAME, message: `${APP_NAME} ${app.getVersion()}`,
        detail: "本地订阅成本与出租收益管理。\n基于 Team Account Manager，遵循 Apache License 2.0。\n第三方许可见程序资源目录内的 LICENSE 与 NOTICE。",
      }) },
    ] },
  ]));
}

async function bootstrap() {
  try {
    const userDataDirectory = app.getPath("userData");
    fs.mkdirSync(userDataDirectory, { recursive: true });
    const runtimeDirectory = app.isPackaged
      ? path.join(process.resourcesPath, "runtime")
      : process.env.SUBSCRIPTION_BUTLER_RUNTIME_DIR || path.join(__dirname, "runtime");
    runtime = runtimePaths(runtimeDirectory);
    port = await persistentLoopbackPort(userDataDirectory);
    await clearDesktopWorkerCache(session.defaultSession);
    if (smokeTest) {
      if (uiSmokeTest) {
        if (loadConfig(userDataDirectory)) throw new Error("首次 UI 验收必须使用新的独立测试目录。");
        await createWindow(); installCredentialHandlers();
      }
      config = initializeLocalConfig(userDataDirectory);
      await startBackend();
      const response = await fetch(appUrl("/login"), { signal: AbortSignal.timeout(10000), redirect: "manual" });
      if (response.status !== 200) throw new Error(`登录页面检查失败（HTTP ${response.status}）。`);
      if (uiSmokeTest) {
        installMaintenanceHandlers();
        await require("./ui-smoke.js").runUiSmoke({ BrowserWindow, url: appUrl(), authSecret: config.authSecret,
          userData: userDataDirectory, preload: path.join(__dirname, "preload.js"), existingWindow: mainWindow,
          onWindow: window => { mainWindow = window; }, restartBackend: async () => { await stopBackend(); await startBackend(); } });
        await require("./card-vault-smoke.js").runCardVaultSmoke({ BrowserWindow, url: appUrl(), userData: userDataDirectory,
          preload: path.join(__dirname, "preload.js"), onWindow: window => { mainWindow = window; } });
      }
      let maintenance;
      if (maintenanceSmokeTest) {
        setupMaintenance();
        const privateCards = fs.existsSync(path.join(userDataDirectory, "card-vault.bin"))
          ? new CardVault({ userData: userDataDirectory, safeStorage, clipboard }).summary() : null;
        const snapshot = path.join(userDataDirectory, "smoke-backup.sbbackup");
        await backupManager.create(snapshot);
        const prepared = await backupManager.prepareRestore(snapshot);
        const restored = await backupManager.restorePrepared(prepared, { stop: stopBackend, start: startBackend });
        const afterRestore = await fetch(appUrl("/login"), { signal: AbortSignal.timeout(10000), redirect: "manual" });
        if (afterRestore.status !== 200) throw new Error("恢复后登录页面检查失败。");
        if (privateCards && JSON.stringify(new CardVault({ userData: userDataDirectory, safeStorage, clipboard }).summary()) !== JSON.stringify(privateCards)) throw new Error("恢复后的卡片资料校验未通过。");
        maintenance = { encryptedBackup: true, restored: true, rollback: fs.existsSync(restored.rollbackFile) };
        if (privateCards) maintenance.cardVaultVerified = true;
      }
      fs.writeFileSync(path.join(userDataDirectory, "smoke-result.json"), JSON.stringify({ status: "ok", health: "ok", loginStatus: response.status, version: app.getVersion(), maintenance }, null, 2));
      isQuitting = true;
      stopOwnedServer();
      app.exit(0);
      return;
    }
    // All web content is unprivileged. Local UI never receives Electron APIs
    // except the explicitly checked optional credentials interface.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    installCredentialHandlers();
    installMaintenanceHandlers();
    new BackupManager({ userData: userDataDirectory, appVersion: app.getVersion() }).recoverInterruptedRestore();
    loadPreferences();
    await createWindow();
    installMenu();
    config = initializeLocalConfig(userDataDirectory);
    setupMaintenance();
    await backupManager.beforeUpgrade();
    await startBackend();
    backupManager.markStarted();
    createTray(); installMenu();
    setTimeout(checkReminders, 10000);
    reminderInterval = setInterval(checkReminders, 5 * 60 * 1000);
    if (!trustedLocalUrl(mainWindow.webContents.getURL(), port)) {
      throw new Error("桌面窗口未完成本地页面加载，请重新启动应用。");
    }
  } catch (error) {
    if (smokeTest) {
      appendServerLog("desktop.log", `${new Date().toISOString()} SMOKE_FAILED ${error.message}\n`);
      fs.writeFileSync(path.join(app.getPath("userData"), "smoke-result.json"), JSON.stringify({ status: "failed", message: error.message }, null, 2));
      isQuitting = true;
      stopOwnedServer();
      app.exit(1);
      return;
    }
    if (error.message !== "FIRST_RUN_CANCELLED") {
      appendServerLog("desktop.log", `${new Date().toISOString()} DESKTOP_STARTUP_FAILED ${error.stack || error.message}\n`);
      dialog.showErrorBox(`${APP_NAME} 启动失败`, `${error.message}\n\n可在本地数据目录的 logs 文件夹查看日志。`);
    }
    app.quit();
  }
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.setAppUserModelId(APP_ID);
  app.on("second-instance", () => {
    const window = mainWindow;
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
    }
  });
  app.whenReady().then(bootstrap);
}
app.on("before-quit", () => { isQuitting = true; cardVault?.dispose(); clearInterval(reminderInterval); tray?.destroy(); stopOwnedServer(); });
app.on("window-all-closed", () => { if (smokeTest && !isQuitting) return; if (isQuitting || !preferences.closeToTray || !tray) app.quit(); });
