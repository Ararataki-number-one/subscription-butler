// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell, session } = require("electron");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  backendEnvironment, createConfig, externalWebUrl, findFreePort, launchBackend,
  loadConfig, runInitializer, runtimePaths, trustedLocalUrl, writeEnvironmentFile,
} = require("./runtime.js");

const APP_NAME = "订阅管家";
const APP_ID = "io.github.ararataki.subscriptionbutler";
const RELEASES_URL = "https://github.com/Ararataki-number-one/subscription-butler/releases";
const SETUP_URL = pathToFileURL(path.join(__dirname, "setup.html")).href;
app.setName(APP_NAME);
app.setPath("userData", path.join(app.getPath("appData"), APP_NAME));
const smokeTest = process.argv.includes("--smoke-test");
if (smokeTest) {
  const target = process.env.SUBSCRIPTION_BUTLER_USER_DATA ||
    fs.mkdtempSync(path.join(app.getPath("temp"), "subscription-butler-smoke-"));
  if (path.resolve(target) === path.resolve(app.getPath("userData"))) {
    throw new Error("冒烟测试必须使用独立数据目录。");
  }
  fs.mkdirSync(target, { recursive: true });
  app.setPath("userData", target);
}

let config;
let mainWindow;
let setupWindow;
let serverProcess;
let port;
let isQuitting = false;

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

function installCredentialHandlers() {
  ipcMain.handle("credentials:is-available", (event) => {
    assertTrustedRenderer(event);
    return safeStorage.isEncryptionAvailable();
  });
  ipcMain.handle("credentials:load", (event) => {
    assertTrustedRenderer(event);
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(credentialsPath())) return null;
    return safeStorage.decryptString(fs.readFileSync(credentialsPath()));
  });
  ipcMain.handle("credentials:save", (event, loginKey) => {
    assertTrustedRenderer(event);
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
    assertTrustedRenderer(event);
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

function stopOwnedServer() {
  if (!serverProcess || serverProcess.killed || serverProcess.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(serverProcess.pid), "/t", "/f"], {
      windowsHide: true, stdio: "ignore", timeout: 10000,
    });
  } else {
    serverProcess.kill("SIGTERM");
  }
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
  mainWindow.once("ready-to-show", () => mainWindow.show());
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

function configureFirstRun() {
  return new Promise((resolve, reject) => {
    let completed = false;
    setupWindow = new BrowserWindow({
      width: 520, height: 580, resizable: false, maximizable: false,
      parent: mainWindow, modal: true, show: false, title: `${APP_NAME} · 首次设置`,
      autoHideMenuBar: true, backgroundColor: "#f5f9f8",
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        preload: path.join(__dirname, "setup-preload.js"),
      },
    });
    setupWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    setupWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    setupWindow.once("ready-to-show", () => setupWindow.show());
    ipcMain.handle("setup:save", (event, loginKey, confirmation) => {
      if (!setupWindow || event.sender !== setupWindow.webContents ||
          event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== SETUP_URL) {
        throw new Error("首次设置请求来源无效。");
      }
      if (loginKey !== confirmation) throw new Error("两次输入的登录密钥不一致。");
      config = createConfig(app.getPath("userData"), loginKey);
      completed = true;
      // Allow the IPC reply to arrive before the form is destroyed.
      setImmediate(() => { setupWindow?.close(); resolve(config); });
      return { ok: true };
    });
    setupWindow.once("closed", () => {
      ipcMain.removeHandler("setup:save");
      setupWindow = undefined;
      if (!completed) reject(new Error("FIRST_RUN_CANCELLED"));
    });
    setupWindow.loadFile(path.join(__dirname, "setup.html")).catch(reject);
  });
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "应用", submenu: [
      { label: "刷新", accelerator: "Ctrl+R", click: () => mainWindow?.reload() },
      { type: "separator" },
      { label: "退出", accelerator: "Alt+F4", click: () => app.quit() },
    ] },
    { label: "维护", submenu: [
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
    const runtime = runtimePaths(runtimeDirectory);
    port = await findFreePort();
    if (smokeTest) {
      config = loadConfig(userDataDirectory) || createConfig(userDataDirectory, require("node:crypto").randomBytes(32).toString("hex"));
      writeEnvironmentFile(userDataDirectory, config);
      const environment = backendEnvironment(config, userDataDirectory, port);
      await runInitializer(runtime, environment, appendServerLog);
      await launchBackend(runtime, environment, appendServerLog, { onSpawn: (child) => { serverProcess = child; } });
      const response = await fetch(appUrl("/login"), { signal: AbortSignal.timeout(10000), redirect: "manual" });
      if (response.status !== 200) throw new Error(`登录页面检查失败（HTTP ${response.status}）。`);
      fs.writeFileSync(path.join(userDataDirectory, "smoke-result.json"), JSON.stringify({ status: "ok", health: "ok", loginStatus: response.status, version: app.getVersion() }, null, 2));
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
    await createWindow();
    installMenu();
    config = loadConfig(userDataDirectory) || await configureFirstRun();
    writeEnvironmentFile(userDataDirectory, config);
    const environment = backendEnvironment(config, userDataDirectory, port);
    await runInitializer(runtime, environment, appendServerLog);
    await launchBackend(runtime, environment, appendServerLog, { onSpawn: (child) => { serverProcess = child; } });
    serverProcess.once("exit", (code, signal) => {
      if (!isQuitting) {
        appendServerLog("desktop.log", `${new Date().toISOString()} BACKEND_EXIT ${signal || code}\n`);
        dialog.showErrorBox(`${APP_NAME} 服务已停止`, "本地数据服务意外停止，请重新打开程序。数据仍保存在本地数据目录。");
        app.quit();
      }
    });
    await mainWindow.loadURL(appUrl());
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
    const window = setupWindow || mainWindow;
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.whenReady().then(bootstrap);
}
app.on("before-quit", () => { isQuitting = true; stopOwnedServer(); });
app.on("window-all-closed", () => app.quit());
