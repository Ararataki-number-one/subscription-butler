import type Database from "better-sqlite3";
import { OperationsStore } from "@/db/operations";
import { AUTH_COOKIE_NAME } from "@/lib/auth";
import { assertNoSecrets, assertOperationsAccess, authenticateOperationsRequest, boundedJson, OperationsAccessError, OperationsAccessStore, requireRole } from "./access";
import { OperationsSync } from "./sync";
import type { OpsActor, OpsCommand, OpsRole, ReplicaCommand, ReportOptions } from "./types";

export type OperationsContext = { sqlite: Database.Database; store: OperationsStore; access: OperationsAccessStore; sync: OperationsSync };
export function createOperationsContext(sqlite: Database.Database, transport?: typeof fetch): OperationsContext {
  const access = new OperationsAccessStore(sqlite), store = new OperationsStore(sqlite);
  return { sqlite, store, access, sync: new OperationsSync(sqlite, store, access, transport) };
}
const singleton = globalThis as unknown as { operationsContext?: OperationsContext };
export async function getOperationsContext(): Promise<OperationsContext> {
  if (!singleton.operationsContext) { const { db } = await import("@/db"); singleton.operationsContext = createOperationsContext(db.$client); }
  singleton.operationsContext.sync.start();
  const { startFxRefreshScheduler } = await import("@/lib/fx/scheduler"); startFxRefreshScheduler();
  return singleton.operationsContext;
}
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store, private", vary: "Authorization, Cookie", "x-content-type-options": "nosniff" } });
}
export function safeOperationsError(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof OperationsAccessError) return { code: error.code, message: error.message, status: ({ UNAUTHORIZED: 401, FORBIDDEN: 403, CSRF: 403, INVALID: 400, TOO_LARGE: 413 })[error.code] };
  if (error instanceof Error && error.name === "OperationsError" && typeof (error as Error & { code?: unknown }).code === "string") {
    const code = (error as Error & { code: string }).code;
    // Domain errors contain user-facing validation messages; driver/network
    // exceptions never reach the response body.
    return { code, message: error.message, status: /CONFLICT|REVISION|STALE|PERIOD|DUPLICATE/i.test(code) ? 409 : /FORBIDDEN|PERMISSION/i.test(code) ? 403 : 400 };
  }
  return { code: "UNAVAILABLE", message: "服务暂时未能完成请求，请稍后重试。", status: 503 };
}
function commandOf(input: Record<string, unknown>): OpsCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OperationsAccessError("INVALID", "操作需要有效 JSON 对象。");
  if (typeof input.id !== "string" || !/^[A-Za-z0-9:_-]{1,150}$/.test(input.id) || typeof input.type !== "string" || !/^[a-z][a-z.]{1,80}$/.test(input.type) ||
    !input.payload || typeof input.payload !== "object" || Array.isArray(input.payload) || (input.baseRevision !== undefined && (!Number.isSafeInteger(input.baseRevision) || Number(input.baseRevision) < 0))) {
    throw new OperationsAccessError("INVALID", "操作需要稳定标识、操作类型及有效内容。");
  }
  assertNoSecrets(input.payload);
  return { id: input.id, type: input.type, payload: input.payload as Record<string, unknown>, ...(input.baseRevision === undefined ? {} : { baseRevision: Number(input.baseRevision) }) };
}
async function runCommand(context: OperationsContext, actor: OpsActor, command: OpsCommand) {
  assertOperationsAccess(actor, command);
  const syncStatus = context.sync.status();
  if (syncStatus.requiresReconnect) throw new OperationsAccessError("INVALID", "同步凭证无法读取，请先重新连接或明确断开同步中心。");
  if (!syncStatus.connected) return { actor, ...context.store.execute(command, actor) };
  // In relay mode the hub is authoritative. A disconnected client stores its
  // intent durably without rewriting already posted financial snapshots.
  context.sync.enqueue(actor, command);
  try { await context.sync.flush(actor); }
  catch (error) { if (error instanceof OperationsAccessError && error.code === "FORBIDDEN") throw error; }
  const conflict = context.sync.conflicts(actor).find(item => item.commandId === command.id);
  if (conflict) return json({ actor, ok: false, error: { code: "CONFLICT", message: conflict.reason }, conflictId: conflict.id, snapshot: context.store.snapshot(actor), status: context.sync.status() }, 409);
  const status = context.sync.status();
  return { actor, ok: true, replayed: false, changedIds: [], snapshot: context.store.snapshot(actor), queued: status.pending > 0, status };
}

export async function handleOperationsApi(request: Request, route: string, context?: OperationsContext): Promise<Response> {
  try {
    context ??= await getOperationsContext();
    const actor = await authenticateOperationsRequest(request, context.access), method = request.method;
    if (route === "snapshot" && method === "GET") {
      const response = json({ actor, snapshot: context.store.snapshot(actor), quotes: actor.role === "customer" ? [] : context.store.quotes() });
      // Verifying a chosen member identity explicitly changes browser mode.
      // Invalid tokens never reach here. Relay clients have no browser cookie jar.
      if (request.headers.has("authorization")) response.headers.append("set-cookie", `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
      return response;
    }
    if (route === "report" && method === "GET") {
      const params = new URL(request.url).searchParams, options: ReportOptions = {};
      for (const name of ["from", "to", "subscriptionId", "customerId", "channelId"] as const) { const value = params.get(name); if (value) { if (value.length > 150) throw new OperationsAccessError("INVALID", "报表筛选条件过长。"); options[name] = value; } }
      if (actor.role === "customer") {
        if (options.customerId && options.customerId !== actor.customerId) throw new OperationsAccessError("FORBIDDEN", "只能查看自己的账期与收款。");
        options.customerId = actor.customerId;
        if (options.channelId) throw new OperationsAccessError("FORBIDDEN", "客户身份不能按内部支付渠道筛选。");
        if (options.subscriptionId && !context.store.snapshot(actor).bills.some(bill => bill.data.subscriptionId === options.subscriptionId)) throw new OperationsAccessError("FORBIDDEN", "此订阅不在当前客户范围内。");
      }
      return json({ actor, report: context.store.report(options, actor) });
    }
    if ((route === "commands" || route === "import") && method === "POST") {
      requireRole(actor, route === "import" ? ["admin"] : ["admin", "operator"]);
      const command = commandOf(await boundedJson(request, route === "import" ? 5 * 1024 * 1024 : 512 * 1024));
      if (route === "import" && command.type !== "import.commit") throw new OperationsAccessError("INVALID", "导入接口仅接受已经预览确认的导入操作。");
      const result = await runCommand(context, actor, command); return result instanceof Response ? result : json(result);
    }
    if (route === "access") {
      requireRole(actor, ["admin"]);
      if (method === "GET") return json({ actor, credentials: context.access.list(actor) });
      if (method === "POST") {
        const input = await boundedJson(request, 8192);
        if (input.role === "customer" && !context.store.snapshot(actor).customers.some(customer => customer.id === input.customerId)) throw new OperationsAccessError("INVALID", "请选择已登记的客户作为权限范围。");
        return json(context.access.invite(actor, { label: input.label as string, role: input.role as OpsRole, customerId: input.customerId as string | undefined, expiresInDays: input.expiresInDays as number | undefined }), 201);
      }
    }
    if (route.startsWith("access/") && method === "DELETE") {
      requireRole(actor, ["admin"]); const id = route.slice(7);
      if (!/^[A-Za-z0-9:_-]{1,150}$/.test(id)) throw new OperationsAccessError("INVALID", "无效凭证标识。");
      context.access.revoke(actor, id); return json({ ok: true });
    }
    if (route === "audit" && method === "GET") {
      requireRole(actor, ["admin", "operator"]);
      return json({ audit: context.store.audit(100, actor), security: actor.role === "admin" ? context.access.securityAudit(actor) : [] });
    }
    return json({ error: { code: "NOT_FOUND", message: "接口不存在。" } }, 404);
  } catch (error) { const safe = safeOperationsError(error); return json({ ok: false, error: { code: safe.code, message: safe.message } }, safe.status); }
}

export async function handleSyncApi(request: Request, route: string, context?: OperationsContext): Promise<Response> {
  try {
    context ??= await getOperationsContext();
    const actor = await authenticateOperationsRequest(request, context.access), method = request.method;
    if (route === "changes" && method === "GET") {
      const cursor = Number(new URL(request.url).searchParams.get("cursor") ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new OperationsAccessError("INVALID", "无效变更游标。");
      const snapshot = context.store.snapshot(actor);
      return json({ actor, deviceId: context.sync.deviceId(), changes: context.store.changes(cursor, 500, actor), nextCursor: snapshot.changeSeq, snapshot });
    }
    if (route === "push" && method === "POST") {
      requireRole(actor, ["admin", "operator"]);
      const input = await boundedJson(request, 5 * 1024 * 1024);
      if (typeof input.deviceId !== "string" || !/^[A-Za-z0-9:_-]{1,150}$/.test(input.deviceId)) throw new OperationsAccessError("INVALID", "设备标识无效。");
      if (input.replica) {
        requireRole(actor, ["admin"]); assertNoSecrets(input.replica);
        const replica = input.replica as ReplicaCommand;
        if (!replica || typeof replica.id !== "string" || !Array.isArray(replica.records) || replica.records.length > 20000) throw new OperationsAccessError("INVALID", "同步记录包格式无效。");
        const result = context.store.applyReplica(replica, actor);
        context.access.audit(actor, "sync.receive.records", input.deviceId, `records=${replica.records.length}`);
        return json({ actor, ...result, snapshot: context.store.snapshot(actor) });
      }
      if (!Array.isArray(input.commands) || input.commands.length > 100) throw new OperationsAccessError("INVALID", "每次最多同步 100 个操作。");
      const acknowledgements = input.commands.map(value => {
        try { const command = commandOf(value as Record<string, unknown>); assertOperationsAccess(actor, command); const result = context!.store.execute(command, actor); return { id: command.id, ok: true, replayed: result.replayed, changedIds: result.changedIds }; }
        catch (error) { const safe = safeOperationsError(error); return { id: typeof value?.id === "string" ? value.id : "", ok: false, error: { code: safe.code, message: safe.message } }; }
      });
      context.access.audit(actor, "sync.receive.commands", input.deviceId, `commands=${input.commands.length}`);
      return json({ actor, acknowledgements, snapshot: context.store.snapshot(actor) });
    }
    if (route === "status" && method === "GET") { requireRole(actor, ["admin", "operator"]); return json(context.sync.status()); }
    if (route === "outbox" && method === "GET") { requireRole(actor, ["admin", "operator"]); return json({ outbox: context.sync.outbox(actor) }); }
    if (route === "outbox/cancel" && method === "POST") { requireRole(actor, ["admin"]); const input = await boundedJson(request, 8192); context.sync.cancel(actor, input.ids as string[], input.reason as string); return json({ ok: true, status: context.sync.status() }); }
    if (route === "connect" && method === "POST") {
      requireRole(actor, ["admin"]); const input = await boundedJson(request, 8192);
      return json(await context.sync.connect(actor, { url: input.url, token: input.token, allowLoopback: input.allowLoopback === true }));
    }
    if (route === "connect" && method === "DELETE") { requireRole(actor, ["admin"]); context.sync.disconnect(actor); return json({ ok: true, status: context.sync.status() }); }
    if (route === "pull" && method === "POST") { requireRole(actor, ["admin", "operator"]); await boundedJson(request, 1024); return json(await context.sync.pull(actor)); }
    if (route === "flush" && method === "POST") { requireRole(actor, ["admin", "operator"]); await boundedJson(request, 1024); const status = await context.sync.flush(actor); return json({ actor, snapshot: context.store.snapshot(actor), status }); }
    if (route === "bootstrap" && method === "POST") { requireRole(actor, ["admin"]); const input = await boundedJson(request, 1024); return json({ ...await context.sync.bootstrap(actor, input.direction as "upload" | "download"), actor }); }
    if (route === "conflicts" && method === "GET") { requireRole(actor, ["admin", "operator"]); return json({ conflicts: context.sync.conflicts(actor) }); }
    const match = /^conflicts\/([A-Za-z0-9:_-]{1,150})\/resolve$/.exec(route);
    if (match && method === "POST") { requireRole(actor, ["admin"]); const input = await boundedJson(request, 1024); return json({ ...await context.sync.resolve(actor, match[1], input.choice as "local" | "remote"), actor }); }
    return json({ error: { code: "NOT_FOUND", message: "接口不存在。" } }, 404);
  } catch (error) { const safe = safeOperationsError(error); return json({ ok: false, error: { code: safe.code, message: safe.message } }, safe.status); }
}
