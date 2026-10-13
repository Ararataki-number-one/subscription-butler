import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import type { OperationsSnapshot, OpsActor, OpsCommand, OpsRecord, OpsRole } from "./types";

export class OperationsAccessError extends Error {
  constructor(public readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "CSRF" | "INVALID" | "TOO_LARGE", message: string) {
    super(message); this.name = "OperationsAccessError";
  }
}
export const OPS_ROLES: OpsRole[] = ["admin", "operator", "read-only", "customer"];
const SECRET_FIELD = /^(?:password|passwd|token|accessToken|refreshToken|apiKey|secret|authSecret|loginKey|loginKeyHash|smtpUrl|smtpPassword|credentials|cookie)$/i;

/** Ledger replication never includes passwords, SMTP settings or access credentials. */
export function assertNoSecrets(value: unknown, depth = 0): void {
  if (depth > 30) throw new OperationsAccessError("INVALID", "数据嵌套过深。");
  if (typeof value === "string" && /(?:\bsmtps?:\/\/|\bsbm_[A-Za-z0-9_-]{43}\b|\bgithub_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(value)) throw new OperationsAccessError("INVALID", "账本备注不能携带 SMTP 连接、成员凭证或私钥。");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key.replace(/[^A-Za-z0-9]/g, ""))) throw new OperationsAccessError("INVALID", "账本数据不能包含密钥、密码或 SMTP 配置。");
    assertNoSecrets(child, depth + 1);
  }
}
export function requireRole(actor: OpsActor, roles: OpsRole[]): void {
  if (!roles.includes(actor.role)) throw new OperationsAccessError("FORBIDDEN", "当前身份没有此操作权限。");
}
export function assertOperationsAccess(actor: OpsActor, command: OpsCommand): void {
  requireRole(actor, ["admin", "operator"]);
  if (command.type === "import.commit") requireRole(actor, ["admin"]);
  assertNoSecrets(command.payload);
}
export function canReadRecord(actor: OpsActor, record: OpsRecord, snapshot?: OperationsSnapshot): boolean {
  if (actor.role !== "customer") return true;
  if (!actor.customerId) return false;
  if (record.kind === "customer") return record.id === actor.customerId;
  const data = record.data as unknown as Record<string, unknown>;
  if (record.kind === "bill") return data.customerId === actor.customerId;
  if (record.kind === "entry") {
    if (data.type !== "receipt" && data.type !== "refund") return false;
    if (data.customerId && data.customerId !== actor.customerId) return false;
    return data.customerId === actor.customerId || !!snapshot?.bills.some(bill => bill.id === data.billId && bill.data.customerId === actor.customerId);
  }
  return false;
}
export function filterOperationsSnapshot(snapshot: OperationsSnapshot, actor: OpsActor): OperationsSnapshot {
  if (actor.role !== "customer") return snapshot;
  // A customer sees their own bill periods and receipts; account inventory and
  // subscription purchase costs stay server-side.
  const own = <T extends object>(rows: OpsRecord<T>[]) => rows.filter(record => canReadRecord(actor, record as OpsRecord, snapshot));
  const clearPrivateNotes = redactCustomerRecord;
  return { ...snapshot, ...( "channels" in snapshot ? { channels: [] } : {}), customers: own(snapshot.customers).map(clearPrivateNotes), templates: [], plans: [], subscriptions: [], slots: [], rentals: [],
    bills: own(snapshot.bills).map(clearPrivateNotes), entries: own(snapshot.entries).map(clearPrivateNotes) };
}
export function redactCustomerRecord<T extends object>(record: OpsRecord<T>): OpsRecord<T> {
  const data = { ...record.data, tags: [], group: "", note: "", externalKey: undefined, legacy: undefined, channelId: undefined, channelName: undefined } as T & { calendarHistory?: unknown };
  delete data.calendarHistory;
  return { ...record, data };
}

export type AccessCredential = { id: string; label: string; role: OpsRole; customerId?: string; createdAt: string; expiresAt: string | null; revokedAt: string | null };
type CredentialRow = { id: string; label: string; role: OpsRole; customer_id: string | null; created_at: string; expires_at: string | null; revoked_at: string | null };
function credentialView(row: CredentialRow): AccessCredential {
  return { id: row.id, label: row.label, role: row.role, customerId: row.customer_id ?? undefined, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at };
}
export class OperationsAccessStore {
  constructor(readonly sqlite: Database.Database) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS ops_access (id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, customer_id TEXT, created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS ops_security_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, action TEXT NOT NULL, resource_id TEXT, detail TEXT NOT NULL, created_at TEXT NOT NULL);`);
  }
  audit(actor: OpsActor, action: string, resourceId?: string, detail = "") {
    this.sqlite.prepare("INSERT INTO ops_security_audit(actor_id,action,resource_id,detail,created_at) VALUES(?,?,?,?,?)").run(actor.id, action, resourceId ?? null, detail.slice(0, 500), new Date().toISOString());
  }
  list(actor: OpsActor) { requireRole(actor, ["admin"]); return (this.sqlite.prepare("SELECT id,label,role,customer_id,created_at,expires_at,revoked_at FROM ops_access ORDER BY created_at DESC").all() as CredentialRow[]).map(credentialView); }
  securityAudit(actor: OpsActor, limit = 100) { requireRole(actor, ["admin"]); return this.sqlite.prepare("SELECT seq,actor_id AS actorId,action,resource_id AS resourceId,detail,created_at AS createdAt FROM ops_security_audit ORDER BY seq DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 500)); }
  invite(actor: OpsActor, input: { label: string; role: OpsRole; customerId?: string; expiresInDays?: number }) {
    requireRole(actor, ["admin"]);
    if (!OPS_ROLES.includes(input.role) || typeof input.label !== "string" || !input.label.trim() || input.label.length > 80 ||
      (input.role === "customer" && (!input.customerId || input.customerId.length > 150)) ||
      (input.expiresInDays !== undefined && (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > 365))) {
      throw new OperationsAccessError("INVALID", "请填写有效名称、角色、客户范围和有效期。");
    }
    const id = randomUUID(), token = "sbm_" + randomBytes(32).toString("base64url"), now = new Date();
    const expiresAt = input.expiresInDays ? new Date(now.getTime() + input.expiresInDays * 86400000).toISOString() : null;
    this.sqlite.prepare("INSERT INTO ops_access(id,label,token_hash,role,customer_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, input.label.trim(), createHash("sha256").update(token).digest("hex"), input.role, input.role === "customer" ? input.customerId : null, now.toISOString(), expiresAt);
    this.audit(actor, "access.invite", id, `role=${input.role}`);
    return { credential: { id, label: input.label.trim(), role: input.role, customerId: input.role === "customer" ? input.customerId : undefined, createdAt: now.toISOString(), expiresAt, revokedAt: null }, token };
  }
  revoke(actor: OpsActor, id: string) {
    requireRole(actor, ["admin"]);
    const result = this.sqlite.prepare("UPDATE ops_access SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(new Date().toISOString(), id);
    if (result.changes) this.audit(actor, "access.revoke", id);
  }
  authenticateToken(token: string): OpsActor | null {
    if (!/^sbm_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.sqlite.prepare("SELECT id,label,role,customer_id,created_at,expires_at,revoked_at FROM ops_access WHERE token_hash=?")
      .get(createHash("sha256").update(token).digest("hex")) as CredentialRow | undefined;
    if (!row || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) <= Date.now()) || !OPS_ROLES.includes(row.role)) return null;
    return { id: row.id, role: row.role, customerId: row.customer_id ?? undefined };
  }
  isActorActive(actor: OpsActor) {
    if (actor.id === "local-admin" && actor.role === "admin") return true;
    const row = this.sqlite.prepare("SELECT role,customer_id,expires_at,revoked_at FROM ops_access WHERE id=?").get(actor.id) as CredentialRow | undefined;
    return !!row && !row.revoked_at && (!row.expires_at || Date.parse(row.expires_at) > Date.now()) && row.role === actor.role && (row.customer_id ?? undefined) === actor.customerId;
  }
}

function configuredPublicOrigin(): string | undefined {
  try {
    if (!process.env.OPS_PUBLIC_ORIGIN) return;
    const value = new URL(process.env.OPS_PUBLIC_ORIGIN);
    if (value.protocol === "https:" && !value.username && !value.password) return value.origin;
  } catch { /* Invalid configuration never expands trusted origins. */ }
}
function configuredDesktopOrigin(): string | undefined {
  try {
    if (process.env.APP_ALLOW_INSECURE_COOKIES !== "true" || !process.env.OPS_DESKTOP_ORIGIN) return;
    const value = new URL(process.env.OPS_DESKTOP_ORIGIN);
    if (value.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(value.hostname) && !value.username && !value.password && !value.search && !value.hash && value.pathname === "/") return value.origin;
  } catch { /* A non-loopback or malformed desktop setting is not trusted. */ }
}
/** Next can canonicalize Request.url to localhost while retaining the actual
 * browser authority in Host. Never trust forwarded headers or wildcard hosts. */
export function isOperationsWriteOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  try {
    const parsedOrigin = new URL(origin);
    if (!["http:", "https:"].includes(parsedOrigin.protocol) || parsedOrigin.username || parsedOrigin.password || parsedOrigin.origin !== origin) return false;
    const configured = [configuredPublicOrigin(), configuredDesktopOrigin()].filter((value): value is string => !!value);
    if (configured.length) return configured.includes(origin);
    const requestUrl = new URL(request.url);
    if (!["http:", "https:"].includes(requestUrl.protocol)) return false;
    const host = request.headers.get("host");
    if (host !== null) {
      // Browser Host is tied to the request URL. Reject commas, userinfo,
      // slash/backslash, control characters and invalid port authorities.
      if (!/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/.test(host)) return false;
      const actual = new URL(requestUrl.protocol + "//" + host);
      return actual.origin === origin;
    }
    // Direct Request objects and framework contexts without Host retain their
    // URL origin. This is an exact comparison, not a missing-Origin fallback.
    return requestUrl.origin === origin;
  } catch { return false; }
}

/** A supplied member token takes precedence, even when an admin cookie also exists. */
export async function authenticateOperationsRequest(request: Request, access: OperationsAccessStore): Promise<OpsActor> {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    const actor = match && access.authenticateToken(match[1]);
    if (!actor) throw new OperationsAccessError("UNAUTHORIZED", "成员凭证无效、已撤销或已过期。");
    return actor;
  }
  const cookie = request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(AUTH_COOKIE_NAME + "="))?.slice(AUTH_COOKIE_NAME.length + 1);
  let valid = false;
  try { valid = await verifySessionToken(cookie ? decodeURIComponent(cookie) : undefined); } catch { valid = false; }
  if (!valid) throw new OperationsAccessError("UNAUTHORIZED", "请先登录或输入有效成员凭证。");
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    if (!isOperationsWriteOriginAllowed(request)) throw new OperationsAccessError("CSRF", "写入请求必须来自当前应用页面。");
  }
  return { id: "local-admin", role: "admin" };
}

export async function boundedJson(request: Pick<Request, "headers" | "body">, maxBytes = 512 * 1024): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new OperationsAccessError("TOO_LARGE", "请求内容超过允许大小。");
  if (!request.body) return {};
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new OperationsAccessError("TOO_LARGE", "请求内容超过允许大小。"); } chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    if (!size) return {};
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object");
    return value;
  } catch (error) { if (error instanceof OperationsAccessError) throw error; throw new OperationsAccessError("INVALID", "请求需要有效 JSON 对象。"); }
  finally { reader.releaseLock(); }
}
