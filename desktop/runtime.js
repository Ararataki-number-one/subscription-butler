/* eslint-disable @typescript-eslint/no-require-imports */
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const CONFIG_VERSION = 1;
const LOCAL_HOST = "127.0.0.1";
function assertSmokeDirectory(target, defaultDirectory, platform = process.platform) {
  function canonicalDirectory(value) {
    let existing = path.resolve(value); const missing = [];
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error("测试目录无法解析。");
      missing.unshift(path.basename(existing)); existing = parent;
    }
    return path.join(fs.realpathSync.native(existing), ...missing);
  }
  const resolvedTarget = canonicalDirectory(target), resolvedDefault = canonicalDirectory(defaultDirectory);
  const normalize = value => platform === "win32" ? value.toLowerCase() : value;
  const first = normalize(resolvedTarget), second = normalize(resolvedDefault);
  const prefix = value => value.endsWith(path.sep) ? value : `${value}${path.sep}`;
  if (first === second || first.startsWith(prefix(second)) || second.startsWith(prefix(first))) {
    throw new Error("冒烟测试必须使用与真实数据目录完全独立的测试目录（不能经符号链接或目录联接指向真实数据）。");
  }
  return resolvedTarget;
}

function validateLoginKey(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 256 ||
      !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("登录密钥需为 8 至 256 个字符，不能包含换行或控制字符。");
  }
  return value;
}

function validateConfig(value) {
  if (value?.version !== CONFIG_VERSION ||
      typeof value.authSecret !== "string" ||
      value.authSecret.length < 32 || value.authSecret.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(value.authSecret) ||
      !/^[a-f0-9]{64}$/u.test(value.loginKeyHash || "")) {
    throw new Error("本地登录配置损坏，请保留数据目录并检查 config.json。");
  }
  return value;
}

function writeAtomic(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, contents, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function loadConfig(userDataDirectory) {
  const filePath = path.join(userDataDirectory, "config.json");
  if (!fs.existsSync(filePath)) return null;
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("本地登录配置无法读取，请保留数据目录并检查 config.json。");
  }
  return validateConfig(value);
}

function createConfig(userDataDirectory, loginKey) {
  validateLoginKey(loginKey);
  if (fs.existsSync(path.join(userDataDirectory, "config.json"))) {
    throw new Error("已设置登录密钥，不能覆盖现有登录配置。");
  }
  const config = {
    version: CONFIG_VERSION,
    authSecret: crypto.randomBytes(32).toString("hex"),
    loginKeyHash: crypto.createHash("sha256").update(loginKey, "utf8").digest("hex"),
  };
  writeAtomic(path.join(userDataDirectory, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeEnvironmentFile(userDataDirectory, config);
  return config;
}
function initializeLocalConfig(userDataDirectory) {
  return loadConfig(userDataDirectory) || createConfig(userDataDirectory, crypto.randomBytes(32).toString("hex"));
}
function createLocalOwnerSession(authSecret, now = Date.now()) {
  if (typeof authSecret !== "string" || authSecret.length < 32 || authSecret.length > 256 ||
      !Number.isSafeInteger(now) || now < 0) throw new Error("本机授权配置无效。");
  const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
  const payload = `v1.${expiresAt}.${crypto.randomUUID()}`;
  const signature = crypto.createHmac("sha256", authSecret).update(payload).digest("hex");
  return { value: `${payload}.${signature}`, expiresAt };
}

function writeEnvironmentFile(userDataDirectory, config) {
  validateConfig(config);
  // This generated file remains in the private data directory. The launcher
  // supplies the same values directly to Node; it never reads a source .env.
  const databasePath = path.join(userDataDirectory, "data", "app.db").replaceAll("\\", "/");
  const lines = [
    `APP_AUTH_SECRET=${config.authSecret}`,
    `APP_LOGIN_KEY_HASH=${config.loginKeyHash}`,
    "APP_MFA_ISSUER=订阅管家",
    "APP_ALLOW_INSECURE_COOKIES=true",
    `DB_FILE_NAME=${JSON.stringify(databasePath)}`,
  ];
  writeAtomic(path.join(userDataDirectory, ".env"), `${lines.join("\n")}\n`);
  fs.mkdirSync(path.join(userDataDirectory, "data"), { recursive: true });
}

function runtimePaths(runtimeDirectory, platform = process.platform) {
  const value = {
    directory: runtimeDirectory,
    node: path.join(runtimeDirectory, platform === "win32" ? "node.exe" : "node"),
    initialize: path.join(runtimeDirectory, "initialize.cjs"),
    server: path.join(runtimeDirectory, "server.js"),
  };
  for (const filePath of [value.node, value.initialize, value.server]) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`应用运行文件缺失：${path.basename(filePath)}。请重新下载完整版本。`);
    }
  }
  return value;
}

function backendEnvironment(config, userDataDirectory, port, inherited = process.env) {
  validateConfig(config);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("本地服务端口无效。");
  }
  const environment = { ...inherited };
  // Do not inherit launcher/runtime overrides from a development shell.
  delete environment.NODE_OPTIONS;
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.OPS_PUBLIC_ORIGIN;
  return {
    ...environment,
    NODE_ENV: "production",
    HOSTNAME: LOCAL_HOST,
    PORT: String(port),
    DB_FILE_NAME: path.join(userDataDirectory, "data", "app.db"),
    APP_AUTH_SECRET: config.authSecret,
    APP_LOGIN_KEY_HASH: config.loginKeyHash,
    APP_MFA_ISSUER: "订阅管家",
    APP_ALLOW_INSECURE_COOKIES: "true",
    OPS_DESKTOP_ORIGIN: `http://${LOCAL_HOST}:${port}`,
    TZ: "Asia/Shanghai",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, LOCAL_HOST, () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function trustedLocalUrl(target, port) {
  try {
    const url = new URL(target);
    return url.protocol === "http:" && url.hostname === LOCAL_HOST &&
      url.port === String(port) && !url.username && !url.password;
  } catch {
    return false;
  }
}
async function persistentLoopbackPort(userDataDirectory) {
  const file = path.join(userDataDirectory, "server-port.json");
  if (!fs.existsSync(file)) {
    const port = await findFreePort();
    writeAtomic(file, JSON.stringify({ version: 1, port }));
    return port;
  }
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error("本地端口配置不能是符号链接。");
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("本地端口配置损坏，已保留账本和离线队列。"); }
  if (value?.version !== 1 || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw new Error("本地端口配置无效，已保留账本和离线队列。");
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error(`本地端口 ${value.port} 已被占用，启动已停止。请退出占用程序后重新启动，以保留同一地址下的离线队列。`)));
    server.listen(value.port, LOCAL_HOST, () => server.close(error => error ? reject(error) : resolve()));
  });
  return value.port;
}

function externalWebUrl(target) {
  try {
    const url = new URL(target);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function requestHealth(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: LOCAL_HOST, port, path: "/api/health" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 16384) request.destroy();
      });
      response.on("error", () => resolve(false));
      response.on("end", () => {
        try {
          resolve(response.statusCode === 200 && JSON.parse(body).status === "ok");
        } catch {
          resolve(false);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

function runInitializer(runtime, env, onLog = () => {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.node, [runtime.initialize], {
      cwd: runtime.directory, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => onLog("server.log", chunk));
    child.stderr.on("data", (chunk) => onLog("server-error.log", chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("本地数据库初始化超时，请查看应用日志。"));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`本地数据库初始化失败（退出码 ${code}），请查看应用日志。`));
    });
  });
}

async function launchBackend(runtime, env, onLog = () => {}, options = {}) {
  const child = spawn(runtime.node, [runtime.server], {
    cwd: runtime.directory, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  options.onSpawn?.(child);
  child.stdout.on("data", (chunk) => onLog("server.log", chunk));
  child.stderr.on("data", (chunk) => onLog("server-error.log", chunk));
  let failure;
  child.once("error", (error) => { failure = error; });
  child.once("exit", (code, signal) => {
    failure = new Error(`本地数据服务已退出（${signal || code}）。`);
  });
  const deadline = Date.now() + (options.timeoutMs ?? 30000);
  const intervalMs = options.intervalMs ?? 250;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    if (await requestHealth(Number(env.PORT))) {
      if (failure) throw failure;
      return child;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  child.kill();
  throw new Error("本地服务启动超时，请查看应用日志。");
}
async function stopBackendAndCloseConnections(child, terminate, closeConnections, timeoutMs = 10000) {
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve, reject) => {
      const onExit = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { child.removeListener("exit", onExit); reject(new Error("本地服务停止超时，原数据尚未替换。")); }, timeoutMs);
      child.once("exit", onExit);
      try { terminate(child); }
      catch (error) { clearTimeout(timer); child.removeListener("exit", onExit); reject(error); }
    });
  }
  // Chromium may otherwise reuse an idle socket belonging to the process
  // that just exited, even after Node reports the replacement service healthy.
  await closeConnections();
}
async function clearDesktopWorkerCache(desktopSession) {
  // This dedicated application session may contain workers installed by an
  // older desktop build. Preserve its cookies, IndexedDB outbox and settings.
  await desktopSession.clearStorageData({ storages: ["serviceworkers", "cachestorage"] });
}

module.exports = {
  LOCAL_HOST, assertSmokeDirectory, backendEnvironment, clearDesktopWorkerCache, createConfig, createLocalOwnerSession, externalWebUrl, findFreePort, initializeLocalConfig,
  launchBackend, loadConfig, persistentLoopbackPort, requestHealth, runInitializer, runtimePaths,
  stopBackendAndCloseConnections, trustedLocalUrl, validateConfig, validateLoginKey, writeEnvironmentFile,
};
