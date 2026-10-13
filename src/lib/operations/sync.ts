import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { OperationsStore } from "@/db/operations";
import type { OperationsSnapshot, OpsActor, OpsCommand, OpsRecord, ReplicaRecord } from "./types";
import { assertNoSecrets, assertOperationsAccess, boundedJson, OperationsAccessError, OperationsAccessStore, requireRole } from "./access";

type Connection = { url: string; token: string; allowLoopback: boolean; remoteActor: OpsActor; cursor: number };
export type SyncConflict = { id: string; commandId?: string; recordId?: string; local: unknown; remote: unknown; reason: string; createdAt: string; resolvedAt: string | null };
type OutboxRow = { command_id: string; command_json: string; actor_json: string; state: string };
type SyncReply = { acknowledgements: { id: string; ok: boolean; error?: { code: string; message: string } }[]; snapshot?: OperationsSnapshot };
const SYSTEM: OpsActor = { id: "sync-replication", role: "admin" };
const arrays = ["customers", "templates", "subscriptions", "slots", "rentals", "bills", "entries"] as const;
export function snapshotRecords(snapshot: OperationsSnapshot): OpsRecord[] { return arrays.flatMap(name => snapshot[name] as OpsRecord[]); }
function equalData(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
export function validateHubUrl(raw: unknown, allowLoopback = false): string {
  if (typeof raw !== "string" || raw.length > 2000) throw new OperationsAccessError("INVALID", "请输入有效同步中心地址。");
  let value: URL; try { value = new URL(raw); } catch { throw new OperationsAccessError("INVALID", "请输入有效同步中心地址。"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(value.hostname);
  if (value.username || value.password || value.search || value.hash || (value.protocol !== "https:" && !(allowLoopback && loopback && value.protocol === "http:"))) {
    throw new OperationsAccessError("INVALID", "同步中心必须使用 HTTPS；本机开发 HTTP 需要显式允许回环地址。");
  }
  return value.href.replace(/\/+$/, "");
}
function key() {
  const secret = process.env.APP_AUTH_SECRET;
  if (!secret) throw new OperationsAccessError("INVALID", "本机安全配置未完成，不能保存同步凭证。");
  return createHash("sha256").update("subscription-butler:sync:v1:" + secret).digest();
}
function seal(value: Connection) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
  const payload = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), payload]).toString("base64");
}
function open(value: string): Connection {
  try {
    const payload = Buffer.from(value, "base64"), decipher = createDecipheriv("aes-256-gcm", key(), payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8"));
  } catch { throw new OperationsAccessError("INVALID", "同步凭证无法读取，请重新连接同步中心。"); }
}
export class OperationsSync {
  private flushing?: Promise<ReturnType<OperationsSync["status"]>>;
  private pulling?: Promise<{ actor: OpsActor; snapshot: OperationsSnapshot; status: ReturnType<OperationsSync["status"]> }>;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private retryDelay = 60000;
  private retryAt?: string;
  private lastError?: string;
  constructor(readonly sqlite: Database.Database, readonly store: OperationsStore, readonly access: OperationsAccessStore,
    private readonly transport: typeof fetch = fetch) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS ops_device (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ops_sync_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT,command_id TEXT NOT NULL UNIQUE,command_json TEXT NOT NULL,actor_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ops_sync_baseline (record_id TEXT PRIMARY KEY,remote_revision INTEGER NOT NULL,local_revision INTEGER NOT NULL,data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ops_sync_conflict (id TEXT PRIMARY KEY,command_id TEXT,record_id TEXT,local_json TEXT NOT NULL,remote_json TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,resolved_at TEXT);`);
    sqlite.prepare("INSERT OR IGNORE INTO ops_device(key,value) VALUES('deviceId',?)").run(randomUUID());
  }
  deviceId(): string { return (this.sqlite.prepare("SELECT value FROM ops_device WHERE key='deviceId'").get() as { value: string }).value; }
  private connection(): Connection | null {
    const row = this.sqlite.prepare("SELECT value FROM ops_device WHERE key='connection'").get() as { value: string } | undefined;
    return row ? open(row.value) : null;
  }
  private saveConnection(connection: Connection) { this.sqlite.prepare("INSERT INTO ops_device(key,value) VALUES('connection',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(seal(connection)); }
  status() {
    const configured = !!this.sqlite.prepare("SELECT 1 FROM ops_device WHERE key='connection'").get();
    let connection: Connection | null = null, requiresReconnect = false;
    try { connection = this.connection(); } catch { requiresReconnect = true; }
    return { deviceId: this.deviceId(), connected: !!connection, configured, requiresReconnect, url: connection?.url, remoteRole: connection?.remoteActor.role,
      cursor: connection?.cursor ?? 0, pending: (this.sqlite.prepare("SELECT count(*) AS n FROM ops_sync_outbox WHERE state='queued'").get() as { n: number }).n,
      conflicts: (this.sqlite.prepare("SELECT count(*) AS n FROM ops_sync_conflict WHERE resolved_at IS NULL").get() as { n: number }).n, retryAt: this.retryAt, lastError: requiresReconnect ? "本机安全密钥已变化，请重新连接同步中心。" : this.lastError };
  }
  private async remote(connection: Connection, endpoint: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await this.transport(connection.url + "/api/" + endpoint, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + connection.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15000), cache: "no-store" });
    const result = await boundedJson(response, 8 * 1024 * 1024);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new OperationsAccessError("FORBIDDEN", "同步中心凭证已撤销、过期或没有权限，请重新连接。");
      throw new OperationsAccessError("INVALID", response.status === 409 ? "远端记录已变化，需要解决同步冲突。" : "同步中心未能完成请求。");
    }
    return result;
  }
  async connect(actor: OpsActor, input: { url: unknown; token: unknown; allowLoopback?: boolean }) {
    requireRole(actor, ["admin"]);
    if (this.flushing || this.pulling) throw new OperationsAccessError("INVALID", "同步正在进行，请完成后再更换同步中心。");
    const url = validateHubUrl(input.url, input.allowLoopback === true);
    if (typeof input.token !== "string" || !/^sbm_[A-Za-z0-9_-]{43}$/.test(input.token)) throw new OperationsAccessError("INVALID", "请输入同步中心签发的成员凭证。");
    const connection: Connection = { url, token: input.token, allowLoopback: input.allowLoopback === true, remoteActor: { id: "", role: "read-only" }, cursor: 0 };
    const verified = await this.remote(connection, "operations/snapshot");
    const remoteActor = verified.actor as OpsActor;
    if (!remoteActor || !["admin", "operator", "read-only", "customer"].includes(remoteActor.role) || typeof remoteActor.id !== "string") throw new OperationsAccessError("INVALID", "目标不是兼容的订阅管家同步中心。");
    if (remoteActor.role === "customer") throw new OperationsAccessError("FORBIDDEN", "客户凭证只用于中心工作台查看自己的账期与收款，不能作为完整账本的设备同步凭证。");
    const status = this.status();
    if (status.configured && status.pending > 0) throw new OperationsAccessError("INVALID", "请先处理现有同步队列，再切换同步中心。");
    connection.remoteActor = remoteActor;
    this.sqlite.prepare("DELETE FROM ops_sync_baseline").run();
    this.saveConnection(connection);
    this.access.audit(actor, "sync.connect", this.deviceId(), new URL(url).host);
    return this.status();
  }
  disconnect(actor: OpsActor) {
    requireRole(actor, ["admin"]);
    if (this.flushing || this.pulling) throw new OperationsAccessError("INVALID", "同步正在进行，请完成后再断开。");
    if (this.status().pending) throw new OperationsAccessError("INVALID", "请先处理同步队列；断开连接不能丢弃待发送操作。");
    this.sqlite.prepare("DELETE FROM ops_device WHERE key='connection'").run(); this.access.audit(actor, "sync.disconnect", this.deviceId());
  }
  enqueue(actor: OpsActor, command: OpsCommand) {
    assertOperationsAccess(actor, command);
    const connection = this.connection();
    if (connection && (!["admin", "operator"].includes(connection.remoteActor.role) || command.type === "import.commit" && connection.remoteActor.role !== "admin")) throw new OperationsAccessError("FORBIDDEN", "中心分配的设备凭证没有此写入权限。");
    const json = JSON.stringify(command);
    const previous = this.sqlite.prepare("SELECT command_json FROM ops_sync_outbox WHERE command_id=?").get(command.id) as { command_json: string } | undefined;
    if (previous && previous.command_json !== json) throw new OperationsAccessError("INVALID", "同一个操作标识不能用于不同内容。");
    this.sqlite.prepare("INSERT OR IGNORE INTO ops_sync_outbox(command_id,command_json,actor_json,created_at) VALUES(?,?,?,?)")
      .run(command.id, json, JSON.stringify(actor), new Date().toISOString());
  }
  private conflict(actor: OpsActor, input: { commandId?: string; recordId?: string; local: unknown; remote: unknown; reason: string }) {
    const prior = this.sqlite.prepare("SELECT id FROM ops_sync_conflict WHERE resolved_at IS NULL AND COALESCE(command_id,'')=? AND COALESCE(record_id,'')=?").get(input.commandId ?? "", input.recordId ?? "");
    if (prior) return;
    const id = randomUUID(); this.sqlite.prepare("INSERT INTO ops_sync_conflict(id,command_id,record_id,local_json,remote_json,reason,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, input.commandId ?? null, input.recordId ?? null, JSON.stringify(input.local), JSON.stringify(input.remote), input.reason.slice(0, 300), new Date().toISOString());
    this.access.audit(actor, "sync.conflict", id, input.reason.slice(0, 100));
  }
  conflicts(actor: OpsActor): SyncConflict[] {
    requireRole(actor, ["admin", "operator"]);
    return (this.sqlite.prepare("SELECT * FROM ops_sync_conflict WHERE resolved_at IS NULL ORDER BY created_at").all() as { id: string; command_id: string | null; record_id: string | null; local_json: string; remote_json: string; reason: string; created_at: string; resolved_at: string | null }[])
      .map(row => ({ id: row.id, commandId: row.command_id ?? undefined, recordId: row.record_id ?? undefined, local: JSON.parse(row.local_json), remote: JSON.parse(row.remote_json), reason: row.reason, createdAt: row.created_at, resolvedAt: row.resolved_at }));
  }
  async pull(actor: OpsActor) {
    requireRole(actor, ["admin", "operator"]);
    if (this.flushing) { await this.flushing; return { actor, snapshot: this.store.snapshot(actor), status: this.status() }; }
    if (!this.pulling) this.pulling = this.performPull(actor).finally(() => { this.pulling = undefined; });
    const result = await this.pulling;
    return { ...result, actor, snapshot: this.store.snapshot(actor) };
  }
  private async performPull(actor: OpsActor) {
    requireRole(actor, ["admin", "operator"]);
    const connection = this.connection(); if (!connection) throw new OperationsAccessError("INVALID", "请先连接同步中心。");
    const remote = await this.remote(connection, "sync/changes?cursor=" + connection.cursor);
    const snapshot = remote.snapshot as OperationsSnapshot;
    if (!snapshot || snapshot.version !== 1) throw new OperationsAccessError("INVALID", "同步中心返回了不兼容的账本。");
    const remoteRecords = snapshotRecords(snapshot); assertNoSecrets(remoteRecords);
    const localRecords = new Map(snapshotRecords(this.store.snapshot()).map(record => [record.id, record]));
    const replacements: ReplicaRecord[] = [];
    for (const record of remoteRecords) {
      const local = localRecords.get(record.id);
      const baseline = this.sqlite.prepare("SELECT remote_revision,local_revision,data_json FROM ops_sync_baseline WHERE record_id=?").get(record.id) as { remote_revision: number; local_revision: number; data_json: string } | undefined;
      if (local && equalData(local.data, record.data)) {
        if (local.revision !== record.revision) replacements.push({ id: record.id, kind: record.kind, data: record.data, expectedRevision: local.revision, sourceRevision: record.revision });
        else this.baseline(record, local.revision);
        continue;
      }
      if (local && (!baseline || local.revision !== baseline.local_revision)) {
        this.conflict(actor, { recordId: record.id, local, remote: record, reason: "本地和远端记录同时变化，需要明确选择保留内容。" }); continue;
      }
      replacements.push({ id: record.id, kind: record.kind, data: record.data, expectedRevision: local?.revision ?? 0, sourceRevision: record.revision });
    }
    if (replacements.length) {
      this.store.applyReplica({ id: "pull:" + this.deviceId() + ":" + randomUUID(), records: replacements, reason: "authenticated hub pull" }, SYSTEM);
      for (const record of remoteRecords.filter(record => replacements.some(item => item.id === record.id))) this.baseline(record, record.revision);
    }
    connection.cursor = snapshot.changeSeq; this.saveConnection(connection);
    this.access.audit(actor, "sync.pull", this.deviceId(), `records=${replacements.length}`);
    return { actor, snapshot: this.store.snapshot(actor), status: this.status() };
  }
  private baseline(record: OpsRecord, localRevision: number) {
    this.sqlite.prepare("INSERT INTO ops_sync_baseline(record_id,remote_revision,local_revision,data_json) VALUES(?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET remote_revision=excluded.remote_revision,local_revision=excluded.local_revision,data_json=excluded.data_json")
      .run(record.id, record.revision, localRevision, JSON.stringify(record.data));
  }
  flush(actor: OpsActor) {
    requireRole(actor, ["admin", "operator"]);
    if (!this.flushing) this.flushing = this.runFlush(actor).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  private async runFlush(actor: OpsActor) {
    if (this.pulling) await this.pulling;
    const connection = this.connection(); if (!connection) throw new OperationsAccessError("INVALID", "请先连接同步中心。");
    const rows = this.sqlite.prepare("SELECT command_id,command_json,actor_json,state FROM ops_sync_outbox WHERE state='queued' ORDER BY seq LIMIT 100").all() as OutboxRow[];
    const activeRows = rows.filter(row => {
      if (this.access.isActorActive(JSON.parse(row.actor_json))) return true;
      this.sqlite.prepare("UPDATE ops_sync_outbox SET state='cancelled' WHERE command_id=?").run(row.command_id);
      this.access.audit(actor, "sync.outbox.revoked", row.command_id); return false;
    });
    if (activeRows.length) {
      const response = await this.remote(connection, "sync/push", { deviceId: this.deviceId(), commands: activeRows.map(row => JSON.parse(row.command_json)) }) as unknown as SyncReply;
      for (const acknowledgement of response.acknowledgements ?? []) {
        const row = rows.find(row => row.command_id === acknowledgement.id); if (!row) continue;
        this.sqlite.prepare("UPDATE ops_sync_outbox SET state=? WHERE command_id=?").run(acknowledgement.ok ? "sent" : "conflict", row.command_id);
        if (!acknowledgement.ok) this.conflict(actor, { commandId: row.command_id, local: JSON.parse(row.command_json), remote: response.snapshot ?? null, reason: acknowledgement.error?.message || "远端未接受该操作。" });
      }
    }
    await this.performPull(actor); return this.status();
  }
  /** Server-side retry also runs while the desktop window is closed to tray. */
  start() {
    if (this.running || process.env.NODE_ENV === "test" || process.env.NEXT_PHASE === "phase-production-build" || process.env.npm_lifecycle_event === "build") return;
    this.running = true;
    const schedule = () => {
      if (!this.running) return;
      this.retryAt = new Date(Date.now() + this.retryDelay).toISOString();
      this.timer = setTimeout(async () => {
        try {
          if (this.connection()) await this.flush({ id: "local-admin", role: "admin" });
          this.retryDelay = 60000; this.lastError = undefined;
        } catch (error) { this.retryDelay = Math.min(this.retryDelay * 2, 15 * 60000); this.lastError = error instanceof OperationsAccessError && error.code === "FORBIDDEN" ? "中心授权已失效，请重新连接。" : "同步暂时不可用，正在自动重试。"; }
        schedule();
      }, this.retryDelay);
      this.timer.unref?.();
    };
    schedule();
  }
  stop() { this.running = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.retryAt = undefined; }
  cancel(actor: OpsActor, ids: string[], reason: string) {
    requireRole(actor, ["admin"]);
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== "string" || id.length > 150) || typeof reason !== "string" || !reason.trim() || reason.length > 300) throw new OperationsAccessError("INVALID", "请选择待发送操作并填写取消原因。");
    this.sqlite.transaction(() => { for (const id of ids) {
      const result = this.sqlite.prepare("UPDATE ops_sync_outbox SET state='cancelled' WHERE command_id=? AND state IN ('queued','conflict')").run(id);
      if (result.changes) this.access.audit(actor, "sync.outbox.cancel", id, reason);
    } })();
  }
  outbox(actor: OpsActor) {
    requireRole(actor, ["admin", "operator"]);
    return (this.sqlite.prepare("SELECT command_id,command_json,state,created_at FROM ops_sync_outbox WHERE state IN ('queued','conflict') ORDER BY seq LIMIT 100").all() as { command_id: string; command_json: string; state: string; created_at: string }[])
      .map(row => ({ id: row.command_id, command: JSON.parse(row.command_json), state: row.state, createdAt: row.created_at }));
  }
  /** Explicit bootstrap prevents connecting to a URL from silently uploading an existing ledger. */
  async bootstrap(actor: OpsActor, direction: "upload" | "download") {
    requireRole(actor, ["admin"]);
    const connection = this.connection(); if (!connection) throw new OperationsAccessError("INVALID", "请先连接同步中心。");
    if (direction === "download") return this.pull(actor);
    if (direction !== "upload") throw new OperationsAccessError("INVALID", "请选择初始化方向。");
    const snapshot = this.store.snapshot(actor), records = snapshotRecords(snapshot);
    await this.remote(connection, "sync/push", { deviceId: this.deviceId(), replica: { id: "bootstrap:" + this.deviceId() + ":" + randomUUID(), records: records.map(record => ({ id: record.id, kind: record.kind, data: record.data, expectedRevision: 0, sourceRevision: record.revision })), reason: "explicit initial ledger upload" } });
    this.access.audit(actor, "sync.bootstrap.upload", this.deviceId(), `records=${records.length}`);
    return this.pull(actor);
  }
  async resolve(actor: OpsActor, id: string, choice: "local" | "remote") {
    requireRole(actor, ["admin"]);
    const conflict = this.conflicts(actor).find(item => item.id === id);
    if (!conflict) throw new OperationsAccessError("INVALID", "同步冲突不存在或已处理。");
    if (choice !== "local" && choice !== "remote") throw new OperationsAccessError("INVALID", "请选择保留本地或远端内容。");
    const connection = this.connection(); if (!connection) throw new OperationsAccessError("INVALID", "请先连接同步中心。");
    if (conflict.commandId) {
      const command = structuredClone(conflict.local) as OpsCommand;
      if (choice === "local") {
        const current = await this.remote(connection, "operations/snapshot");
        const records = snapshotRecords(current.snapshot as OperationsSnapshot);
        const targetId = typeof command.payload.id === "string" ? command.payload.id : typeof command.payload.recordId === "string" ? command.payload.recordId : undefined;
        const target = records.find(record => record.id === targetId);
        if (target) { command.payload.expectedRevision = target.revision; if (target.kind === "rental") command.payload.expectedPeriod = (target.data as { periodVersion: number }).periodVersion; }
        command.id = randomUUID(); this.enqueue(actor, command);
      }
      this.sqlite.prepare("UPDATE ops_sync_outbox SET state='resolved' WHERE command_id=?").run(conflict.commandId);
    } else if (conflict.recordId) {
      const remoteSnapshot = await this.remote(connection, "operations/snapshot");
      const remote = snapshotRecords(remoteSnapshot.snapshot as OperationsSnapshot).find(record => record.id === conflict.recordId);
      const local = snapshotRecords(this.store.snapshot()).find(record => record.id === conflict.recordId);
      if (!remote || !local) throw new OperationsAccessError("INVALID", "记录范围已经变化，请重新拉取检查。");
      if (choice === "remote") {
        this.store.applyReplica({ id: "resolve:" + randomUUID(), records: [{ id: remote.id, kind: remote.kind, data: remote.data, expectedRevision: local.revision, sourceRevision: remote.revision }], reason: "explicit remote conflict choice" }, actor);
        this.baseline(remote, remote.revision);
      } else {
        await this.remote(connection, "sync/push", { deviceId: this.deviceId(), replica: { id: "resolve:" + randomUUID(), records: [{ id: local.id, kind: local.kind, data: local.data, expectedRevision: remote.revision }], reason: "explicit local conflict choice" } });
        // The next pull receives the authoritative revision for the chosen data.
        this.sqlite.prepare("DELETE FROM ops_sync_baseline WHERE record_id=?").run(local.id);
      }
    }
    this.sqlite.prepare("UPDATE ops_sync_conflict SET resolved_at=? WHERE id=?").run(new Date().toISOString(), id);
    this.access.audit(actor, "sync.resolve." + choice, id);
    await this.flush(actor); return { ok: true, snapshot: this.store.snapshot(actor), status: this.status() };
  }
}
