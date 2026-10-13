/* eslint-disable @typescript-eslint/no-require-imports -- Native maintenance privately preserves browser commands during an explicit restore. */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { openBackup, sealBackup, writeJsonAtomic } = require("./backups.js");
const FORMAT = "subscription-butler-offline-queue";
function validateQueue(rows) {
  if (!Array.isArray(rows) || rows.length > 10000 || Buffer.byteLength(JSON.stringify(rows)) > 16 * 1024 * 1024) throw new Error("未提交队列结构或大小无效。");
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row.actorId !== "string" || row.actorId.length > 150 || !row.actorId ||
        typeof row.id !== "string" || !/^[A-Za-z0-9:_-]{1,150}$/u.test(row.id) || ids.has(row.id) ||
        row.command?.id !== row.id || typeof row.command.type !== "string" || !/^[a-z][a-z.]{1,80}$/u.test(row.command.type) ||
        !row.command.payload || typeof row.command.payload !== "object" || Array.isArray(row.command.payload) ||
        typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))) throw new Error("未提交队列条目无效。");
    ids.add(row.id);
  }
  return rows;
}
function saveQueue(userData, origin, rows, protectKey) {
  validateQueue(rows);
  const directory = path.join(userData, "backups");
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error("队列保存目录不能是符号链接。");
  const file = path.join(directory, `offline-${crypto.randomUUID()}.sbqueue`);
  const payload = { format: FORMAT, version: 1, origin, createdAt: new Date().toISOString(), rows };
  writeJsonAtomic(file, sealBackup(payload, protectKey)); return file;
}
function readQueue(file, origin, unprotectKey) {
  if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error("未提交队列文件过大。");
  const payload = openBackup(JSON.parse(fs.readFileSync(file, "utf8")), unprotectKey);
  if (payload?.format !== FORMAT || payload.version !== 1 || payload.origin !== origin ||
      typeof payload.createdAt !== "string" || !Number.isFinite(Date.parse(payload.createdAt))) throw new Error("队列文件不属于当前软件地址。");
  return validateQueue(payload.rows);
}
// These two functions are serialized into a separate, unprivileged Chromium
// isolated world. They cannot see Node, Electron, keys, files or HTTP cookies.
async function readBrowserQueue() {
  const databases = await indexedDB.databases();
  if (!databases.some(item => item.name === "subscription-butler-workspace")) return [];
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("subscription-butler-workspace");
    request.onerror = () => reject(new Error("无法读取未提交队列。"));
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("outbox")) { db.close(); resolve([]); return; }
      const tx = db.transaction("outbox", "readonly"), read = tx.objectStore("outbox").getAll();
      read.onsuccess = () => { const rows = read.result; db.close(); resolve(rows); };
      read.onerror = () => { db.close(); reject(new Error("无法读取未提交队列。")); };
    };
  });
}
async function writeBrowserQueue(rows) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("subscription-butler-workspace", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots", { keyPath: "actorId" });
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "id" });
    };
    request.onerror = () => reject(new Error("无法打开未提交队列。"));
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction("outbox", "readwrite"), store = tx.objectStore("outbox");
      for (const row of rows) store.put(row);
      tx.oncomplete = () => { db.close(); resolve(rows.length); };
      tx.onabort = tx.onerror = () => { db.close(); reject(new Error("无法保存未提交队列。")); };
    };
  });
}
module.exports = { readBrowserQueue, readQueue, saveQueue, validateQueue, writeBrowserQueue };
