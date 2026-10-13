/* eslint-disable @typescript-eslint/no-require-imports -- Electron maintenance uses CommonJS without exposing filesystem access to renderers. */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { validateConfig } = require("./runtime.js");

const FORMAT = "subscription-butler-local-backup";
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const FILES = ["data/app.db", "config.json", "credentials.bin", "desktop-preferences.json", "notification-state.json"];
const SIDECARS = ["data/app.db-wal", "data/app.db-shm"];
const SHA256 = /^[a-f0-9]{64}$/u;
function digest(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function ensurePlainPath(root, relative) {
  const result = path.resolve(root, relative);
  if (!result.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("维护文件路径无效。");
  let current = root;
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error("维护目录不能是符号链接。");
  for (const part of relative.split(/[\\/]/u)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("维护文件不能是符号链接。");
  }
  return result;
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function decodeBase64(value, limit = MAX_BYTES) {
  if (typeof value !== "string" || value.length > Math.ceil(limit / 3) * 4 ||
      value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(value)) {
    throw new Error("备份编码或大小无效。");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > limit || bytes.toString("base64") !== value) throw new Error("备份编码无效。");
  return bytes;
}
function sealBackup(payload, protectKey) {
  const plaintext = Buffer.from(JSON.stringify(payload));
  if (plaintext.length > MAX_BYTES) throw new Error("备份超过 128 MB 上限。");
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const header = { format: FORMAT, version: 1, scope: "windows-user", algorithm: "aes-256-gcm+dpapi" };
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ...header, key: protectKey(key.toString("hex")).toString("base64"),
    iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: ciphertext.toString("base64") };
}
function openBackup(envelope, unprotectKey) {
  if (!envelope || envelope.format !== FORMAT || envelope.version !== 1 ||
      envelope.scope !== "windows-user" || envelope.algorithm !== "aes-256-gcm+dpapi") throw new Error("备份格式或版本不受支持。");
  try {
    const hexKey = unprotectKey(decodeBase64(envelope.key, 16384));
    if (!SHA256.test(hexKey)) throw new Error();
    const iv = decodeBase64(envelope.iv, 12), tag = decodeBase64(envelope.tag, 16);
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), iv);
    const header = { format: FORMAT, version: 1, scope: "windows-user", algorithm: "aes-256-gcm+dpapi" };
    decipher.setAAD(Buffer.from(JSON.stringify(header))); decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(decodeBase64(envelope.data)), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch { throw new Error("备份已损坏，或不属于当前 Windows 用户及电脑。"); }
}
function validatePayload(payload) {
  if (payload?.format !== FORMAT || payload.version !== 1 ||
      typeof payload.appVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(payload.appVersion) ||
      typeof payload.createdAt !== "string" || !Number.isFinite(Date.parse(payload.createdAt)) ||
      !Array.isArray(payload.files) || payload.files.length < 2 || payload.files.length > FILES.length ||
      !payload.database?.schema || !payload.database?.summary) throw new Error("备份清单结构无效。");
  const entries = new Map(); let total = 0;
  for (const file of payload.files) {
    if (!FILES.includes(file?.path) || entries.has(file.path) || !SHA256.test(file.sha256 || "") ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_BYTES) throw new Error("备份清单包含无效路径、重复文件或大小。");
    const bytes = decodeBase64(file.data); total += bytes.length;
    if (total > MAX_BYTES || bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error("备份 SHA256 校验失败。");
    entries.set(file.path, bytes);
  }
  if (!entries.has("data/app.db") || !entries.has("config.json")) throw new Error("备份缺少数据库或登录配置。");
  if (entries.get("data/app.db").subarray(0, 16).toString("binary") !== "SQLite format 3\0") throw new Error("备份数据库格式无效。");
  try { validateConfig(JSON.parse(entries.get("config.json").toString("utf8"))); }
  catch { throw new Error("备份登录配置无效。"); }
  for (const filename of ["desktop-preferences.json", "notification-state.json"]) {
    if (!entries.has(filename)) continue;
    if (entries.get(filename).length > 1024 * 1024) throw new Error("备份设置文件过大。");
    try { const value = JSON.parse(entries.get(filename).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); }
    catch { throw new Error("备份设置文件无效。"); }
  }
  return entries;
}
function equalSummary(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function compareVersions(left, right) {
  const parse = value => {
    if (typeof value !== "string" || value.length > 128) throw new Error("软件版本记录无效。");
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([A-Za-z0-9.-]+))?(?:\+([A-Za-z0-9.-]+))?$/u.exec(value);
    if (!match) throw new Error("软件版本记录无效。");
    const identifiers = match[4]?.split(".") || [], build = match[5]?.split(".") || [];
    if ([...identifiers, ...build].some(part => !/^[A-Za-z0-9-]+$/u.test(part)) || identifiers.some(part => /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0"))) throw new Error("软件版本记录无效。");
    return { numbers: match.slice(1, 4).map(BigInt), identifiers };
  };
  const a = parse(left), b = parse(right);
  for (let index = 0; index < 3; index += 1) if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  if (!a.identifiers.length || !b.identifiers.length) return a.identifiers.length === b.identifiers.length ? 0 : a.identifiers.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.identifiers.length, b.identifiers.length); index += 1) {
    const first = a.identifiers[index], second = b.identifiers[index];
    if (first === undefined || second === undefined) return first === undefined ? -1 : 1;
    if (first === second) continue;
    const numericFirst = /^\d+$/u.test(first), numericSecond = /^\d+$/u.test(second);
    if (numericFirst && numericSecond) return BigInt(first) > BigInt(second) ? 1 : -1;
    if (numericFirst !== numericSecond) return numericFirst ? -1 : 1;
    return first > second ? 1 : -1;
  }
  return 0;
}

class BackupManager {
  constructor({ userData, appVersion, protectKey, unprotectKey, backupDb, inspectDb, upgradeDb, retain = 5 }) {
    this.userData = path.resolve(userData); this.appVersion = appVersion;
    Object.assign(this, { protectKey, unprotectKey, backupDb, inspectDb, upgradeDb, retain });
  }
  backupDirectory() { return ensurePlainPath(this.userData, "backups"); }
  async create(destination, reason = "manual") {
    if (!this.protectKey) throw new Error("Windows 安全存储不可用，无法创建敏感资料备份。");
    const temporary = ensurePlainPath(this.userData, `.backup-${crypto.randomUUID()}`);
    fs.mkdirSync(temporary);
    try {
      const database = path.join(temporary, "app.db");
      await this.backupDb(ensurePlainPath(this.userData, "data/app.db"), database);
      const configBytes = fs.readFileSync(ensurePlainPath(this.userData, "config.json"));
      const auth = validateConfig(JSON.parse(configBytes.toString("utf8")));
      const inspection = await this.inspectDb(database, auth.authSecret);
      const files = [];
      for (const filename of FILES) {
        const file = filename === "data/app.db" ? database : ensurePlainPath(this.userData, filename);
        if (!fs.existsSync(file)) continue;
        const size = fs.statSync(file).size;
        if (size > MAX_BYTES) throw new Error("备份文件超过大小上限。");
        const bytes = filename === "config.json" ? configBytes : fs.readFileSync(file);
        files.push({ path: filename, bytes: bytes.length, sha256: digest(bytes), data: bytes.toString("base64") });
      }
      const payload = { format: FORMAT, version: 1, appVersion: this.appVersion,
        createdAt: new Date().toISOString(), reason, database: inspection, files };
      validatePayload(payload);
      const envelope = sealBackup(payload, this.protectKey);
      if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error("备份目标不能是符号链接。");
      writeJsonAtomic(destination, envelope);
      return { file: destination, createdAt: payload.createdAt, appVersion: payload.appVersion, summary: inspection.summary, schema: inspection.schema };
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  async createCheckpoint(reason) {
    const directory = this.backupDirectory(); fs.mkdirSync(directory, { recursive: true });
    const name = `${reason}-${new Date().toISOString().replace(/[:.]/gu, "-")}-${crypto.randomUUID()}.sbbackup`;
    const result = await this.create(path.join(directory, name), reason);
    this.prune(); return result;
  }
  list() {
    const directory = this.backupDirectory(); if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(name => /^(?:upgrade|rollback|manual)-[a-zA-Z0-9.-]+\.sbbackup$/u.test(name))
      .map(name => ({ name, path: path.join(directory, name), modifiedAt: fs.statSync(ensurePlainPath(directory, name)).mtime.toISOString() }))
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }
  prune() {
    const files = this.list();
    for (const file of files.slice(this.retain)) fs.rmSync(file.path, { force: true });
  }
  read(file) {
    if (fs.statSync(file).size > MAX_ARCHIVE_BYTES) throw new Error("备份文件超过大小上限。");
    let envelope; try { envelope = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("备份 JSON 格式无效。"); }
    const payload = openBackup(envelope, this.unprotectKey);
    return { payload, entries: validatePayload(payload) };
  }
  async prepareRestore(file) {
    const { payload, entries } = this.read(file);
    const directory = ensurePlainPath(this.userData, `.restore-${crypto.randomUUID()}`);
    fs.mkdirSync(directory);
    try {
      for (const [filename, bytes] of entries) {
        const target = ensurePlainPath(directory, `candidate/${filename}`);
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { mode: 0o600 });
      }
      const database = path.join(directory, "candidate", "data", "app.db");
      const auth = JSON.parse(entries.get("config.json").toString("utf8"));
      const inspected = await this.inspectDb(database, auth.authSecret);
      const appliedSchema = value => ({ applied: value.applied, latest: value.latest });
      if (!equalSummary(appliedSchema(inspected.schema), appliedSchema(payload.database.schema)) || !equalSummary(inspected.summary, payload.database.summary)) {
        throw new Error("备份数据库结构、账户或金额摘要与清单不符。");
      }
      if (inspected.schema.latest < inspected.schema.supportedLatest) {
        await this.upgradeDb(database, auth.authSecret);
        const upgraded = await this.inspectDb(database, auth.authSecret);
        // Monetary/account checks remain identical; supported migrations may
        // add settings defaults, so their checksum is compared before upgrade.
        const stable = value => ({ counts: value.counts, money: value.money, accountHash: value.accountHash, mfaEnabled: value.mfaEnabled,
          operations: { counts: value.operations.counts, money: value.operations.money, recordsHash: value.operations.recordsHash } });
        if (!equalSummary(stable(inspected.summary), stable(upgraded.summary))) throw new Error("备份升级后账户或金额摘要变化，恢复已取消。");
      }
      const verifiedHashes = Object.fromEntries(payload.files.map(file => [file.path,
        digest(fs.readFileSync(ensurePlainPath(directory, `candidate/${file.path}`)))]));
      return { directory, payload, verifiedHashes, info: { createdAt: payload.createdAt, appVersion: payload.appVersion,
        summary: inspected.summary, schema: inspected.schema } };
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  }
  discardPrepared(prepared) {
    if (!prepared || !/^\.restore-[a-f0-9-]{36}$/u.test(path.basename(prepared.directory))) throw new Error("恢复暂存目录无效。");
    const directory = ensurePlainPath(this.userData, path.basename(prepared.directory));
    fs.rmSync(directory, { recursive: true, force: true });
  }
  journalPath() { return ensurePlainPath(this.userData, "restore-journal.json"); }
  recoverInterruptedRestore() {
    if (!fs.existsSync(this.journalPath())) return false;
    const journal = JSON.parse(fs.readFileSync(this.journalPath(), "utf8"));
    if (journal.version !== 1 || !/^\.restore-[a-f0-9-]{36}$/u.test(journal.directory) ||
        !Array.isArray(journal.files) || journal.files.length !== FILES.length + SIDECARS.length ||
        journal.files.some((file, index) => file.path !== [...FILES, ...SIDECARS][index] || typeof file.existed !== "boolean")) {
      throw new Error("恢复日志无效，已保留原数据与暂存目录。");
    }
    const directory = ensurePlainPath(this.userData, journal.directory);
    for (const file of journal.files) {
      const target = ensurePlainPath(this.userData, file.path);
      const original = ensurePlainPath(directory, `original/${file.path}`);
      if (fs.existsSync(original)) { fs.rmSync(target, { force: true }); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.renameSync(original, target); }
      else if (!file.existed) fs.rmSync(target, { force: true });
    }
    fs.rmSync(this.journalPath(), { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
    return true;
  }
  async restorePrepared(prepared, lifecycle) {
    if (!prepared || !/^\.restore-[a-f0-9-]{36}$/u.test(path.basename(prepared.directory))) throw new Error("恢复暂存目录无效。");
    const directory = ensurePlainPath(this.userData, path.basename(prepared.directory));
    // Repeat hashes after the confirmation dialog, before stopping the service.
    for (const file of prepared.payload.files) {
      if (digest(fs.readFileSync(ensurePlainPath(directory, `candidate/${file.path}`))) !== prepared.verifiedHashes[file.path]) {
        throw new Error("恢复暂存文件发生变化。");
      }
    }
    const auth = validateConfig(JSON.parse(fs.readFileSync(path.join(directory, "candidate/config.json"), "utf8")));
    await this.inspectDb(path.join(directory, "candidate/data/app.db"), auth.authSecret);
    await lifecycle.stop();
    let rollback;
    try {
      rollback = await this.createCheckpoint("rollback");
      const files = [...FILES, ...SIDECARS].map(filename => ({ path: filename, existed: fs.existsSync(ensurePlainPath(this.userData, filename)) }));
      writeJsonAtomic(this.journalPath(), { version: 1, directory: path.basename(directory), files });
      for (const file of files) {
        const target = ensurePlainPath(this.userData, file.path);
        if (file.existed) {
          const original = ensurePlainPath(directory, `original/${file.path}`);
          fs.mkdirSync(path.dirname(original), { recursive: true }); fs.renameSync(target, original);
        }
        const candidate = ensurePlainPath(directory, `candidate/${file.path}`);
        if (fs.existsSync(candidate)) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.renameSync(candidate, target); }
      }
      await lifecycle.start();
      fs.rmSync(this.journalPath(), { force: true });
      fs.rmSync(directory, { recursive: true, force: true });
      return { ...prepared.info, rollbackFile: rollback.file };
    } catch (error) {
      await lifecycle.stop();
      this.recoverInterruptedRestore();
      await lifecycle.start();
      this.discardPrepared(prepared);
      throw new Error(`恢复未完成，已回滚到恢复前状态：${error.message}`);
    }
  }
  async beforeUpgrade() {
    const marker = ensurePlainPath(this.userData, "installed-version.json");
    let installed = null;
    if (fs.existsSync(marker)) {
      try { installed = JSON.parse(fs.readFileSync(marker, "utf8")).version; } catch { throw new Error("已安装版本记录损坏。"); }
      if (compareVersions(installed, this.appVersion) > 0) throw new Error(`此数据目录已由较新版本 ${installed} 使用，当前 ${this.appVersion} 不能启动。请使用当前或更新的软件，从升级前恢复点回滚数据；不要强行用旧版打开。`);
    }
    if (fs.existsSync(ensurePlainPath(this.userData, "data/app.db")) && installed !== this.appVersion) {
      await this.inspectDb(ensurePlainPath(this.userData, "data/app.db"), validateConfig(JSON.parse(fs.readFileSync(ensurePlainPath(this.userData, "config.json"), "utf8"))).authSecret);
      return this.createCheckpoint("upgrade");
    }
    return null;
  }
  markStarted() { writeJsonAtomic(ensurePlainPath(this.userData, "installed-version.json"), { version: this.appVersion }); }
}
module.exports = { BackupManager, FILES, compareVersions, openBackup, sealBackup, validatePayload, writeJsonAtomic };
