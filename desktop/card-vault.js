/* eslint-disable @typescript-eslint/no-require-imports -- Private desktop-only encrypted card storage. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const VAULT_FILE = "card-vault.bin";
const FIELDS = ["cardNumber", "cvc", "expiryMonth", "expiryYear", "cardholder", "billingAddress", "postalCode", "country", "note"];
function channelId(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("请选择有效支付渠道。");
  return String(value);
}
function normalizeDetails(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !FIELDS.includes(key))) throw new Error("卡片资料格式无效。");
  const result = {};
  for (const name of FIELDS) {
    const value = input[name] ?? "";
    if (typeof value !== "string" || value.length > (name === "billingAddress" || name === "note" ? 2000 : 200) || /\u0000/u.test(value)) throw new Error("卡片资料格式或长度无效。");
    result[name] = value.trim();
  }
  result.cardNumber = result.cardNumber.replace(/[ -]/gu, "");
  if (result.cardNumber && !/^\d{12,19}$/u.test(result.cardNumber)) throw new Error("卡号应为 12–19 位数字，可使用空格分组。");
  if (result.cvc && !/^\d{3,4}$/u.test(result.cvc)) throw new Error("CVC 应为 3 或 4 位数字。");
  if (result.expiryMonth || result.expiryYear) {
    if (!/^(0?[1-9]|1[0-2])$/u.test(result.expiryMonth) || !/^(\d{2}|20\d{2}|21\d{2})$/u.test(result.expiryYear)) throw new Error("请填写有效的到期月份和年份，例如 08 / 2028。");
    result.expiryMonth = result.expiryMonth.padStart(2, "0");
    if (result.expiryYear.length === 2) result.expiryYear = "20" + result.expiryYear;
  }
  if (!Object.values(result).some(Boolean)) throw new Error("请至少填写一项卡片资料。");
  return result;
}
class CardVault {
  constructor({ userData, safeStorage, clipboard }) { this.userData = userData; this.safeStorage = safeStorage; this.clipboard = clipboard; }
  file() {
    const file = path.join(this.userData, VAULT_FILE);
    if (fs.lstatSync(this.userData).isSymbolicLink() || fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("卡片资料路径无效。");
    return file;
  }
  requireEncryption() {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error("Windows 本机加密暂不可用，卡片资料未写入。");
  }
  readAll() {
    this.requireEncryption();
    const file = this.file();
    if (!fs.existsSync(file)) return { version: 1, records: {} };
    try {
      if (fs.statSync(file).size > 1024 * 1024) throw new Error();
      const data = JSON.parse(this.safeStorage.decryptString(fs.readFileSync(file)));
      if (data.version !== 1 || !data.records || typeof data.records !== "object" || Array.isArray(data.records) || Object.keys(data.records).length > 1000) throw new Error();
      for (const [id, row] of Object.entries(data.records)) {
        if (!/^[1-9]\d*$/u.test(id) || !Number.isSafeInteger(Number(id)) || !/^[a-f0-9-]{36}$/u.test(row.revision) || !Number.isFinite(Date.parse(row.updatedAt))) throw new Error();
        row.details = normalizeDetails(row.details);
      }
      return data;
    } catch { throw new Error("卡片资料无法解密或已损坏，原文件已保留。请从本机加密备份恢复。"); }
  }
  writeAll(data) {
    this.requireEncryption();
    const bytes = this.safeStorage.encryptString(JSON.stringify(data));
    if (bytes.length > 1024 * 1024) throw new Error("卡片资料超过容量上限。");
    const file = this.file(), temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  summary() {
    return Object.fromEntries(Object.entries(this.readAll().records).map(([id, row]) => [id, { last4: row.details.cardNumber.slice(-4), updatedAt: row.updatedAt }]));
  }
  get(id) { return this.readAll().records[channelId(id)] ?? null; }
  save(id, details, expectedRevision) {
    const key = channelId(id), normalized = normalizeDetails(details), data = this.readAll();
    if (!data.records[key] && Object.keys(data.records).length >= 1000) throw new Error("卡片数量已达到上限。");
    if ((data.records[key]?.revision ?? null) !== expectedRevision) throw new Error("卡片资料已在其他窗口修改，请重新读取后再保存。");
    data.records[key] = { details: normalized, revision: crypto.randomUUID(), updatedAt: new Date().toISOString() };
    this.writeAll(data);
    return { revision: data.records[key].revision, updatedAt: data.records[key].updatedAt };
  }
  remove(id, expectedRevision) {
    const key = channelId(id), data = this.readAll();
    if ((data.records[key]?.revision ?? null) !== expectedRevision) throw new Error("卡片资料已变化，请重新读取。");
    delete data.records[key]; this.writeAll(data); this.dispose();
  }
  copy(id, field) {
    if (!FIELDS.includes(field)) throw new Error("请选择可复制的卡片字段。");
    const value = this.get(id)?.details[field];
    if (!value) throw new Error("该项资料尚未填写。");
    this.dispose(); this.clipboard.writeText(value); this.copied = value;
    this.copyTimer = setTimeout(() => this.dispose(), 30000); this.copyTimer.unref?.();
  }
  dispose() {
    clearTimeout(this.copyTimer);
    try { if (this.copied && this.clipboard.readText() === this.copied) this.clipboard.clear(); }
    catch { /* A busy OS clipboard must not prevent application shutdown. */ }
    this.copied = undefined;
  }
}
function installCardVaultHandlers({ ipcMain, assertRenderer, authorize, ready, vault }) {
  for (const method of ["summary", "get", "save", "remove", "copy"]) {
    ipcMain.handle(`card-vault:${method}`, async (event, token, ...args) => {
      assertRenderer(event);
      if (new URL(event.senderFrame.url).pathname !== "/reference-data/channels") throw new Error("请在支付渠道页面管理卡片资料。");
      await authorize(token);
      if (!ready()) throw new Error("本机维护尚未完成，请稍后重试。");
      return vault[method](...args);
    });
  }
}
module.exports = { CardVault, VAULT_FILE, normalizeDetails, installCardVaultHandlers };
