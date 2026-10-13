/* eslint-disable @typescript-eslint/no-require-imports -- Maintenance executes the bundled external Node helper. */
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
async function requireMaintenanceAdmin(baseUrl, token, cookie, transport = fetch) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) throw new Error("维护身份检查地址无效。");
  if (token !== undefined && token !== null && (typeof token !== "string" || !/^sbm_[A-Za-z0-9_-]{43}$/u.test(token))) throw new Error("当前成员凭证无效。");
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (cookie) headers.Cookie = `tam_session=${encodeURIComponent(cookie)}`;
  const response = await transport(new URL("/api/operations/access", url), { headers, redirect: "manual", signal: AbortSignal.timeout(10000) });
  if (response.status !== 200) throw new Error("网页备份与恢复需要已登录的管理员身份。可由本机用户从原生“维护”菜单恢复。");
  const value = await response.json();
  if (value?.actor?.role !== "admin" || typeof value.actor.id !== "string" || !value.actor.id || value.actor.id.length > 150) throw new Error("管理员身份检查失败。");
  return value.actor;
}
function maintenanceRunner(runtime, environment) {
  async function run(args, overrides = {}, json = true) {
    try {
      const result = await execFileAsync(runtime.node, [runtime.initialize, ...args], {
        cwd: runtime.directory, env: { ...environment, ...overrides }, windowsHide: true,
        timeout: 60000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8",
      });
      return json ? JSON.parse(result.stdout.trim()) : undefined;
    } catch (error) {
      // execFile errors include arguments/environment context; expose only the
      // helper's bounded message, never keys or its captured stdout.
      const message = String(error.stderr || "本地维护操作失败。").trim().slice(0, 500);
      throw new Error(message.replaceAll(environment.APP_AUTH_SECRET || "\0", "[redacted]"));
    }
  }
  return {
    backupDb: (source, target) => run(["--backup-source", source, "--backup-target", target]),
    inspectDb: (database, authSecret) => run(["--inspect"], { DB_FILE_NAME: database, APP_AUTH_SECRET: authSecret }),
    upgradeDb: (database, authSecret) => run([], { DB_FILE_NAME: database, APP_AUTH_SECRET: authSecret }, false),
    reminders: () => run(["--reminders"]),
  };
}
module.exports = { maintenanceRunner, requireMaintenanceAdmin };
