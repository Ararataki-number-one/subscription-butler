import type Database from "better-sqlite3";
import { freezeUsdMinor } from "@/lib/money";
import { paymentFee } from "@/lib/payment-fees";
import { assertOperationsAccess, canReadRecord, filterOperationsSnapshot } from "@/lib/operations/access";
import { OperationsError } from "@/lib/operations/errors";
import { validateRecord } from "@/lib/operations/validation";
import { legacyCandidates } from "@/lib/operations/legacy";
import { billBalance, buildOperationsReport, calculatePricing } from "@/lib/operations/report";
import { addPeriod, canonical, crossMinor, date, fingerprint, integer, invalid, metadata, period, periodValueForRange, range, rentalIntervals, required, shanghaiToday, text } from "@/lib/operations/utils";
import type { BillData, CustomerData, EntryData, FrozenFx, FxQuote, OpsActor, OpsAudit, OpsChange, OpsCommand, OpsData, OpsKind, OpsRecord, OpsResult, OperationsSnapshot, RentalData, ReplicaCommand, ReportOptions, SlotData, SubscriptionData, TemplateData } from "@/lib/operations/types";

export { OperationsError } from "@/lib/operations/errors";
export type { OpsActor, OpsCommand, OperationsSnapshot, OpsRecord, OpsResult } from "@/lib/operations/types";
const ADMIN: OpsActor = { id: "local-admin", role: "admin" };
type DbRecord = { id: string; kind: OpsKind; data: string; revision: number; updated_at: string };
type Context = { id: string; actor: OpsActor; type: string; changed: Set<string> };
const decode = (row: DbRecord): OpsRecord => ({ id: row.id, kind: row.kind, data: JSON.parse(row.data), revision: row.revision, updatedAt: row.updated_at });
const today = shanghaiToday;

/** Transactional operational ledger. Reads old tables, but never rewrites them. */
export class OperationsStore {
  constructor(public readonly sqlite: Database.Database) {
    const priorOwnerTable = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ops_legacy_owner'").get();
    sqlite.exec("CREATE TABLE IF NOT EXISTS ops_legacy_owner(record_id TEXT PRIMARY KEY NOT NULL); CREATE TABLE IF NOT EXISTS ops_legacy_conflict(record_id TEXT PRIMARY KEY NOT NULL,local_fingerprint TEXT NOT NULL,detected_at TEXT NOT NULL);");
    if (!priorOwnerTable && sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ops_audit'").get()) {
      const history = sqlite.prepare("SELECT action,record_ids FROM ops_audit ORDER BY seq").all() as { action: string; record_ids: string }[];
      const authority = new Set<string>();
      for (const event of history) for (const id of JSON.parse(event.record_ids) as string[]) {
        if (event.action === "legacy.refresh") authority.add(id);
        if (event.action === "sync.apply") authority.delete(id);
      }
      const insert = sqlite.prepare("INSERT OR IGNORE INTO ops_legacy_owner(record_id) VALUES(?)");
      for (const id of authority) insert.run(id);
    }
  }

  private all(): OpsRecord[] { return (this.sqlite.prepare("SELECT * FROM ops_record ORDER BY id").all() as DbRecord[]).map(decode); }
  private get<T extends OpsData>(id: string, kind?: OpsKind): OpsRecord<T> {
    const row = this.sqlite.prepare("SELECT * FROM ops_record WHERE id=?").get(id) as DbRecord | undefined;
    if (!row || kind && row.kind !== kind) throw new OperationsError("not_found", "记录不存在。");
    return decode(row) as OpsRecord<T>;
  }
  private find(id: string) { return this.sqlite.prepare("SELECT * FROM ops_record WHERE id=?").get(id) as DbRecord | undefined; }
  private snapshotRaw(): OperationsSnapshot {
    const records = this.all();
    const select = <T>(kind: OpsKind) => records.filter(row => row.kind === kind) as OpsRecord<T>[];
    const templates = select<TemplateData>("template");
    const channelRows = this.sqlite.prepare("SELECT id,name,fee_percent AS feePercent,is_active AS isActive FROM payment_channel ORDER BY id").all() as { id: number; name: string; feePercent: string; isActive: number }[];
    const channels: OperationsSnapshot["channels"] = channelRows.map(row => ({ ...row, isActive: Boolean(row.isActive) }));
    for (const record of records) {
      if (record.data.channelId === undefined) continue;
      const name = record.data.channelName ?? String(record.data.channelId);
      const existing = channels.find(row => String(row.id) === String(record.data.channelId));
      if (!existing) channels.push({ id: record.data.channelId, name, feePercent: "feePercent" in record.data ? record.data.feePercent : "0", isActive: true });
      else if (existing.name !== name && !existing.names?.includes(name)) {
        existing.names = [...new Set([...(existing.names ?? [existing.name]), name])]; existing.conflict = true;
      }
    }
    return { version: 1, changeSeq: (this.sqlite.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM ops_change").get() as { seq: number }).seq, channels, customers: select<CustomerData>("customer"), templates, plans: templates, subscriptions: select<SubscriptionData>("subscription"), slots: select<SlotData>("slot"), rentals: select<RentalData>("rental"), bills: select<BillData>("bill"), entries: select<EntryData>("entry") };
  }
  snapshot(actor: OpsActor = ADMIN): OperationsSnapshot {
    this.syncLegacy();
    return filterOperationsSnapshot(this.snapshotRaw(), actor);
  }
  quotes(): FxQuote[] {
    const exists = this.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fx_rate'").get();
    if (!exists) return [{ currency: "USD", rateToUsd: "1", minorUnit: 2, quoteDate: today(), fetchedAt: new Date().toISOString(), source: "identity" }];
    const rows = this.sqlite.prepare("SELECT f.currency_code AS currency, f.rate_to_usd AS rateToUsd, c.minor_unit AS minorUnit, COALESCE(f.quote_date,f.fetched_at) AS quoteDate, f.fetched_at AS fetchedAt, f.source AS source FROM fx_rate f JOIN currency c ON c.code=f.currency_code").all() as FxQuote[];
    if (!rows.some(row => row.currency === "USD")) rows.push({ currency: "USD", rateToUsd: "1", minorUnit: 2, quoteDate: today(), fetchedAt: new Date().toISOString(), source: "identity" });
    return rows;
  }
  report(options: ReportOptions = {}, actor: OpsActor = ADMIN) { return buildOperationsReport(this.snapshot(actor), this.quotes(), options); }
  pricing(subscriptionId: string, options: { occupied?: number; marginPercent?: number } = {}, actor: OpsActor = ADMIN) {
    const snapshot = this.snapshot(actor); const subscription = snapshot.subscriptions.find(row => row.id === subscriptionId);
    if (!subscription) throw new OperationsError("not_found", "订阅不存在。");
    return calculatePricing({ amountMinor: subscription.data.amountMinor, feePercent: subscription.data.feePercent, capacity: snapshot.slots.filter(row => row.data.subscriptionId === subscriptionId && row.data.status !== "disabled").length, ...options });
  }
  changes(afterSeq = 0, limit = 500, actor: OpsActor = ADMIN): OpsChange[] {
    integer(afterSeq, "变更序号"); integer(limit, "数量", 1); if (limit > 5000) invalid("一次最多读取 5000 条变更。");
    const snapshot = this.snapshot(actor);
    const rows = this.sqlite.prepare("SELECT * FROM ops_change WHERE seq>? ORDER BY seq LIMIT ?").all(afterSeq, limit) as { seq: number; command_id: string; record_id: string; kind: OpsKind; record_json: string; created_at: string }[];
    return rows.map(row => ({ seq: row.seq, commandId: row.command_id, recordId: row.record_id, kind: row.kind, record: JSON.parse(row.record_json) as OpsRecord, createdAt: row.created_at })).filter(change => canReadRecord(actor, change.record, snapshot)).map(change => actor.role === "customer" ? { ...change, record: { ...change.record, data: { ...change.record.data, tags: [], group: "", note: "", externalKey: undefined, legacy: undefined, channelId: undefined, channelName: undefined } } } : change);
  }
  audit(limit = 100, actor: OpsActor = ADMIN): OpsAudit[] {
    if (actor.role === "customer" || actor.role === "read-only") throw new OperationsError("forbidden", "无权读取审计记录。");
    integer(limit, "数量", 1); if (limit > 5000) invalid("一次最多读取 5000 条审计。");
    return (this.sqlite.prepare("SELECT * FROM ops_audit ORDER BY seq DESC LIMIT ?").all(limit) as { seq: number; command_id: string; actor_id: string; action: string; record_ids: string; reason: string; created_at: string }[]).map(row => ({ seq: row.seq, commandId: row.command_id, actorId: row.actor_id, action: row.action, recordIds: JSON.parse(row.record_ids), reason: row.reason, createdAt: row.created_at }));
  }
  private write(kind: OpsKind, id: string, data: OpsData, context: Context, expectedRevision?: number, sourceRevision?: number) {
    const prior = this.find(id);
    if (prior && prior.kind !== kind) invalid("不能更改记录类型。");
    if (prior && expectedRevision !== prior.revision || !prior && expectedRevision !== undefined && expectedRevision !== 0) throw new OperationsError("conflict", "记录已被修改，请刷新后重试。");
    const revision = sourceRevision ?? (prior?.revision ?? 0) + 1;
    integer(revision, "版本", 1);
    const updatedAt = new Date().toISOString();
    if (prior) this.sqlite.prepare("UPDATE ops_record SET data=?,revision=?,updated_at=? WHERE id=? AND revision=?").run(JSON.stringify(data), revision, updatedAt, id, prior.revision);
    else this.sqlite.prepare("INSERT INTO ops_record(id,kind,data,revision,updated_at) VALUES(?,?,?,?,?)").run(id, kind, JSON.stringify(data), revision, updatedAt);
    const record = { id, kind, data, revision, updatedAt };
    this.sqlite.prepare("INSERT INTO ops_change(command_id,record_id,kind,record_json,created_at) VALUES(?,?,?,?,?)").run(context.id, id, kind, JSON.stringify(record), updatedAt);
    context.changed.add(id);
    return record;
  }
  private auditWrite(context: Context, reason = "") {
    if (!context.changed.size) return;
    this.sqlite.prepare("INSERT INTO ops_audit(command_id,actor_id,action,record_ids,reason,created_at) VALUES(?,?,?,?,?,?)").run(context.id, context.actor.id, context.type, JSON.stringify([...context.changed]), reason, new Date().toISOString());
  }
  private detach<T extends OpsData>(data: T, fields: string[]): T {
    return data.legacy ? { ...data, legacy: { ...data.legacy, managedFields: data.legacy.managedFields.filter(field => !fields.includes(field)), detachedFields: [...new Set([...(data.legacy.detachedFields ?? []), ...fields])] } } : data;
  }
  private claimLegacyFields(id: string, kind: OpsKind, fields: string[], context: Context) {
    const record = this.get(id, kind);
    if (!record.data.legacy || !record.data.legacy.managedFields.some(field => fields.includes(field))) return;
    this.write(kind, id, this.detach(record.data, fields), context, record.revision);
  }
  /** Three-way field ownership: an operation edit detaches only touched fields from legacy. */
  syncLegacy() {
    this.sqlite.transaction(() => {
      const candidates = legacyCandidates(this.sqlite); const ids = new Set(candidates.map(candidate => candidate.id));
      const context: Context = { id: `legacy:${fingerprint(candidates)}`, actor: { id: "legacy-bridge", role: "admin" }, type: "legacy.refresh", changed: new Set() };
      const owned = new Set((this.sqlite.prepare("SELECT record_id FROM ops_legacy_owner").all() as { record_id: string }[]).map(row => row.record_id));
      const blockedSubscriptions = new Set(candidates.filter(candidate => candidate.kind === "subscription" && this.find(candidate.id) && !owned.has(candidate.id)).map(candidate => candidate.id));
      const customerSubscriptions = new Map(candidates.filter(candidate => candidate.kind === "rental").map(candidate => [(candidate.data as RentalData).customerId, (candidate.data as RentalData).subscriptionId]));
      for (const candidate of candidates) {
        const prior = this.find(candidate.id);
        const subscriptionId = candidate.kind === "subscription" ? candidate.id : "subscriptionId" in candidate.data ? candidate.data.subscriptionId : candidate.kind === "customer" ? customerSubscriptions.get(candidate.id) : undefined;
        if (subscriptionId && blockedSubscriptions.has(subscriptionId) || prior && !owned.has(candidate.id)) {
          const localFingerprint = candidate.data.legacy!.fingerprint;
          const previousConflict = this.sqlite.prepare("SELECT local_fingerprint FROM ops_legacy_conflict WHERE record_id=?").get(candidate.id) as { local_fingerprint: string } | undefined;
          if (!previousConflict || previousConflict.local_fingerprint !== localFingerprint) {
            this.sqlite.prepare("INSERT INTO ops_legacy_conflict(record_id,local_fingerprint,detected_at) VALUES(?,?,?) ON CONFLICT(record_id) DO UPDATE SET local_fingerprint=excluded.local_fingerprint,detected_at=excluded.detected_at").run(candidate.id, localFingerprint, new Date().toISOString());
            const conflict: Context = { ...context, type: "legacy.conflict", changed: new Set([candidate.id]) };
            this.auditWrite(conflict, "本地旧表与已同步的稳定 ID 相撞；保留远端账本，本地来源没有自动并入，请明确核对后导入。");
          }
          continue;
        }
        if (!prior) {
          this.write(candidate.kind, candidate.id, candidate.data, context, 0);
          this.sqlite.prepare("INSERT INTO ops_legacy_owner(record_id) VALUES(?)").run(candidate.id);
          continue;
        }
        const current = decode(prior); const link = current.data.legacy;
        const currentData = current.data as OpsData & Record<string, unknown>;
        const candidateData = candidate.data as OpsData & Record<string, unknown>;
        const backfillFields = ["cycleAnchorDay", "countryCode", "openingDate"].filter(key => currentData[key] === undefined && candidateData[key] !== undefined && !link?.detachedFields?.includes(key));
        if (!link || link.fingerprint === candidate.data.legacy?.fingerprint && link.present && !backfillFields.length) continue;
        if (candidate.kind === "entry") {
          this.write(candidate.kind, candidate.id, { ...current.data, legacy: { ...link, fingerprint: candidate.data.legacy!.fingerprint, present: true, conflict: "旧收款来源已更改；冻结金额保留，请用退款或作废调整。" } }, context, current.revision);
          continue;
        }
        const next = { ...current.data } as OpsData & Record<string, unknown>;
        for (const key of link.managedFields) if (!link.detachedFields?.includes(key)) next[key] = candidateData[key];
        for (const key of backfillFields) next[key] = candidateData[key];
        next.legacy = { ...link, managedFields: [...new Set([...link.managedFields, ...backfillFields])], sources: candidate.data.legacy!.sources, fingerprint: candidate.data.legacy!.fingerprint, present: true };
        this.write(candidate.kind, candidate.id, next, context, current.revision);
      }
      for (const record of this.all()) {
        const link = record.data.legacy;
        if (!link?.present || ids.has(record.id) || !owned.has(record.id)) continue;
        const next = { ...record.data, legacy: { ...link, present: false } } as OpsData & Record<string, unknown>;
        if (record.kind !== "entry" && link.managedFields.includes("status")) next.status = record.kind === "rental" ? "ended" : "disabled";
        if (link.managedFields.includes("archived")) next.archived = true;
        if (record.kind === "entry") next.legacy = { ...next.legacy!, conflict: "旧收款来源已删除；已确认金额仍保留，请在运营中心明确退款或作废。" };
        this.write(record.kind, record.id, next, context, record.revision);
      }
      this.auditWrite(context, "旧账本映射更新，用户已编辑字段保留。");
    }).immediate();
  }
  execute(command: OpsCommand, actor: OpsActor = ADMIN): OpsResult {
    required(command.id, "命令 ID"); required(command.type, "命令类型");
    if (!command.payload || typeof command.payload !== "object" || Array.isArray(command.payload)) invalid("命令内容无效。");
    assertOperationsAccess(actor, command);
    this.syncLegacy();
    return this.sqlite.transaction(() => {
      const hash = fingerprint({ command, actor: actor.id });
      const existing = this.sqlite.prepare("SELECT hash,result FROM ops_command WHERE id=?").get(command.id) as { hash: string; result: string } | undefined;
      if (existing) {
        if (existing.hash !== hash) throw new OperationsError("idempotency", "同一命令 ID 不能用于不同内容或执行者。");
        return { ok: true as const, replayed: true, changedIds: JSON.parse(existing.result), snapshot: filterOperationsSnapshot(this.snapshotRaw(), actor) };
      }
      const context: Context = { id: command.id, actor, type: command.type, changed: new Set() };
      this.dispatch(command, context);
      this.validateRelations();
      this.auditWrite(context, text(command.payload.reason));
      this.sqlite.prepare("INSERT INTO ops_command(id,hash,result,actor_id,created_at) VALUES(?,?,?,?,?)").run(command.id, hash, JSON.stringify([...context.changed]), actor.id, new Date().toISOString());
      return { ok: true as const, replayed: false, changedIds: [...context.changed], snapshot: filterOperationsSnapshot(this.snapshotRaw(), actor) };
    }).immediate();
  }
  private expected(command: OpsCommand, record: OpsRecord) {
    const expected = command.payload.expectedRevision ?? command.baseRevision;
    if (expected !== record.revision) throw new OperationsError("conflict", "记录版本已变化，请刷新后重试。");
    return record.revision;
  }
  private currency(value: unknown, fallback = "CNY") {
    const result = text(value, fallback).toUpperCase();
    const row = this.sqlite.prepare("SELECT minor_unit FROM currency WHERE code=?").get(result);
    if (!row) invalid("币种未登记。"); return result;
  }
  private freeze(amountMinor: number, currency: string): { usdMinor: number; cnyMinor: number | null; fx: FrozenFx } {
    const quotes = this.quotes(); const quote = quotes.find(row => row.currency === currency); const cny = quotes.find(row => row.currency === "CNY");
    if (!quote) invalid(`缺少 ${currency} 汇率，请刷新汇率后再登记。`);
    const usdMinor = freezeUsdMinor(amountMinor, quote.minorUnit, quote.rateToUsd);
    const cnyMinor = cny ? crossMinor(amountMinor, quote.minorUnit, quote.rateToUsd, cny.minorUnit, cny.rateToUsd) : null;
    if (!Number.isSafeInteger(usdMinor) || cnyMinor !== null && !Number.isSafeInteger(cnyMinor)) invalid("折算金额过大。");
    return { usdMinor, cnyMinor, fx: { rateToUsd: quote.rateToUsd, rateToCny: cny ? (Number(quote.rateToUsd) / Number(cny.rateToUsd)).toFixed(18).replace(/0+$/, "").replace(/\.$/, "") : null, cnyRateToUsd: cny?.rateToUsd ?? null, quoteDate: quote.quoteDate, fetchedAt: quote.fetchedAt, source: quote.source, minorUnit: quote.minorUnit } };
  }
  private save(command: OpsCommand, context: Context, kind: "customer" | "template" | "subscription" | "slot") {
    const payload = Object.fromEntries(Object.entries(command.payload).filter(([, value]) => value !== undefined)); const id = text(payload.id) || `${kind}:${command.id}`; const prior = this.find(id) ? this.get(id, kind) : undefined;
    if (prior) this.expected(command, prior);
    const previous = prior?.data as OpsData & Record<string, unknown> | undefined;
    const value: Record<string, unknown> = { ...previous, ...payload };
    const meta = metadata(payload, previous);
    let data: OpsData;
    if (kind === "customer") {
      data = { ...meta, name: required(value.name, "客户名称"), contact: text(value.contact), email: text(value.email), archived: Boolean(value.archived ?? false) };
    } else if (kind === "slot") {
      const subscriptionId = required(value.subscriptionId, "订阅 ID"); const subscription = this.get<SubscriptionData>(subscriptionId, "subscription");
      if (subscription.data.status === "disabled") invalid("订阅已停用。");
      const slotKind = text(value.kind, "generic"); if (!["mother", "child", "member", "generic"].includes(slotKind)) invalid("位置类型无效。");
      if (prior && (previous as SlotData).subscriptionId !== subscriptionId && this.snapshotRaw().rentals.some(row => row.data.slotId === id)) invalid("有租赁历史的位置不能改换订阅，请新增位置后换号。");
      data = { ...meta, subscriptionId, label: required(value.label ?? value.account ?? "位置", "位置名称"), account: text(value.account), kind: slotKind as SlotData["kind"], weight: integer(value.weight ?? 1, "分摊权重", 1), fixedCostMinor: integer(value.fixedCostMinor ?? 0, "固定分摊金额"), status: value.status === "disabled" ? "disabled" : "available" };
    } else {
      const template = kind === "subscription" && value.templateId ? this.get<TemplateData>(text(value.templateId), "template").data : undefined;
      const merged: Record<string, unknown> = { ...template, ...value }; const channel = merged.channelId !== undefined ? this.snapshotRaw().channels.find(row => String(row.id) === String(merged.channelId)) : undefined;
      if (merged.channelId !== undefined && !channel) invalid("支付渠道不存在。");
      const feePercent = text(merged.feePercent, channel?.feePercent ?? "0"); const amountMinor = integer(merged.amountMinor ?? 0, "金额"); paymentFee(amountMinor, feePercent);
      if (channel) { meta.channelId = channel.id; meta.channelName = channel.name; }
      const allocation = merged.allocation === "daily" ? "daily" as const : merged.allocation === "fixed-amount" ? "fixed-amount" as const : "fixed" as const;
      const common = { ...meta, name: required(merged.name, "名称"), service: required(merged.service ?? "ChatGPT", "服务"), planName: text(merged.planName ?? merged.plan), currency: this.currency(merged.currency ?? merged.currencyCode), amountMinor, feePercent, period: period(merged.period ?? (merged.periodMonths ? { unit: "month", count: merged.periodMonths } : undefined)), allocation };
      if (kind === "template") {
        const capacity = integer(merged.capacity ?? 1, "容量", 1); if (capacity > 1000) invalid("模板容量最多 1000。"); data = { ...common, capacity };
      } else {
        const startDate = date(merged.startDate ?? today());
        const cycleAnchorDay = integer(payload.cycleAnchorDay ?? (payload.startDate && payload.startDate !== previous?.startDate ? Number(startDate.slice(8, 10)) : merged.cycleAnchorDay ?? Number(startDate.slice(8, 10))), "周期锚点", 1); if (cycleAnchorDay > 31) invalid("周期锚点不能超过 31。");
        const endDate = date(payload.endDate ?? (prior && payload.period === undefined && payload.startDate === undefined ? merged.endDate : undefined) ?? addPeriod(startDate, common.period, cycleAnchorDay));
        const countryCode = text(merged.countryCode).toUpperCase(); if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) invalid("国家代码需为两位英文字母。");
        const openingDate = text(merged.openingDate) ? date(merged.openingDate, "首次开通日") : undefined;
        data = { ...common, ...range(startDate, endDate), cycleAnchorDay, ...(countryCode ? { countryCode } : {}), ...(openingDate ? { openingDate } : {}), account: text(merged.account), ...(merged.templateId ? { templateId: text(merged.templateId) } : {}), status: merged.status === "disabled" ? "disabled" : "active" };
      }
    }
    data = this.detach(data, Object.keys(payload));
    this.write(kind, id, data, context, prior?.revision ?? 0);
    if (kind === "subscription" && (payload.capacity !== undefined || !prior && value.templateId)) {
      const capacity = integer(payload.capacity ?? this.get<TemplateData>(text(value.templateId), "template").data.capacity, "容量", 1);
      if (capacity > 1000) invalid("容量最多 1000。");
      const existing = this.snapshotRaw().slots.filter(row => row.data.subscriptionId === id).length;
      for (let i = existing; i < capacity; i++) this.write("slot", `slot:${command.id}:${i}`, { ...metadata({}), subscriptionId: id, label: `位置 ${i + 1}`, account: "", kind: "generic", weight: 1, status: "available" }, context, 0);
    }
  }
  private occupied(slotId: string, startDate: string, endDate: string, exclude?: string) {
    return this.snapshotRaw().rentals.some(row => row.id !== exclude && rentalIntervals(row.data).some(interval => interval.slotId === slotId && interval.startDate < endDate && interval.endDate > startDate));
  }
  private issueBill(payload: Record<string, unknown>, context: Context, id = `bill:${context.id}`) {
    const rental = payload.rentalId ? this.get<RentalData>(text(payload.rentalId), "rental") : undefined;
    const subscriptionId = required(payload.subscriptionId ?? rental?.data.subscriptionId, "订阅 ID"); const subscription = this.get<SubscriptionData>(subscriptionId, "subscription");
    if (rental && subscriptionId !== rental.data.subscriptionId) invalid("账单订阅与租赁不一致。");
    const customerId = text(payload.customerId ?? rental?.data.customerId) || undefined;
    if (customerId) this.get(customerId, "customer");
    if (rental) {
      this.claimLegacyFields(rental.id, "rental", ["customerId", "usage", "slotId", "subscriptionId", "startDate", "status"], context);
      this.claimLegacyFields(rental.data.slotId, "slot", ["status"], context);
      this.claimLegacyFields(rental.data.subscriptionId, "subscription", ["status"], context);
    }
    if (customerId) this.claimLegacyFields(customerId, "customer", ["archived"], context);
    const currency = this.currency(payload.currency ?? payload.currencyCode ?? rental?.data.billing.currency);
    const amountMinor = integer(payload.amountMinor ?? rental?.data.billing.amountMinor ?? 0, "应收金额");
    const interval = range(payload.startDate ?? rental?.data.startDate, payload.endDate ?? rental?.data.endDate);
    if (this.snapshotRaw().bills.some(row => row.data.status !== "void" && row.data.rentalId === rental?.id && row.data.subscriptionId === subscriptionId && row.data.startDate === interval.startDate && row.data.endDate === interval.endDate && row.data.customerId === customerId)) throw new OperationsError("conflict", "该租赁账期已开账单。");
    const data: BillData = { ...metadata({ ...payload, channelId: payload.channelId ?? subscription.data.channelId, channelName: payload.channelName ?? subscription.data.channelName }), subscriptionId, ...(rental ? { rentalId: rental.id } : {}), ...(customerId ? { customerId } : {}), ...interval, dueDate: date(payload.dueDate ?? interval.startDate), amountMinor, discountMinor: 0, currency, ...this.freeze(amountMinor, currency), status: "open" };
    this.write("bill", id, data, context, 0);
    return id;
  }
  private join(command: OpsCommand, context: Context) {
    const p = command.payload; const slotId = required(p.slotId, "位置 ID"); const slot = this.get<SlotData>(slotId, "slot"); const sub = this.get<SubscriptionData>(slot.data.subscriptionId, "subscription");
    if (slot.data.status === "disabled" || sub.data.status === "disabled") invalid("位置或订阅已停用。");
    const usage = p.usage === "self" ? "self" : "rented"; const customerId = text(p.customerId) || undefined;
    if (usage === "rented" && !customerId) invalid("出租需要选择客户。");
    if (customerId && this.get<CustomerData>(customerId, "customer").data.archived) invalid("客户已归档。");
    const billingInput = p.billing && typeof p.billing === "object" ? p.billing as Record<string, unknown> : p;
    const billingPeriod = period(billingInput.period); const startDate = date(p.startDate ?? today()); const cycleAnchorDay = integer(p.cycleAnchorDay ?? Number(startDate.slice(8, 10)), "周期锚点", 1); if (cycleAnchorDay > 31) invalid("周期锚点不能超过 31。"); const endDate = date(p.endDate ?? addPeriod(startDate, billingPeriod, cycleAnchorDay)); range(startDate, endDate);
    if (this.occupied(slotId, startDate, endDate)) throw new OperationsError("conflict", "位置在该租期已被占用。");
    const id = text(p.id) || `rental:${command.id}`;
    this.claimLegacyFields(slotId, "slot", ["status"], context);
    this.claimLegacyFields(sub.id, "subscription", ["status"], context);
    if (customerId) this.claimLegacyFields(customerId, "customer", ["archived"], context);
    const data: RentalData = { ...metadata(p), subscriptionId: sub.id, slotId, ...(customerId ? { customerId } : {}), usage, startDate, endDate, cycleAnchorDay, billing: { amountMinor: usage === "self" ? 0 : integer(billingInput.amountMinor ?? 0, "租金"), currency: this.currency(billingInput.currency ?? billingInput.currencyCode), period: billingPeriod }, status: "active", periodVersion: 1, history: [{ type: "join", date: startDate, commandId: context.id, toSlotId: slotId, periodVersion: 1 }] };
    this.write("rental", id, data, context, 0);
    if (usage === "rented") this.issueBill({ ...p, rentalId: id, startDate, endDate }, context, `bill:${context.id}:${id}`);
  }
  private renewRental(command: OpsCommand, context: Context) {
    const p = command.payload; const record = this.get<RentalData>(required(p.id, "租赁 ID"), "rental"); this.expected(command, record);
    if (p.expectedPeriod !== record.data.periodVersion) throw new OperationsError("conflict", "租期已续，请刷新后再操作。");
    if (record.data.status !== "active") invalid("已退出的租赁不能续期，请重新加入。");
    const slot = this.get<SlotData>(record.data.slotId, "slot"); const sub = this.get<SubscriptionData>(slot.data.subscriptionId, "subscription"); if (slot.data.status === "disabled" || sub.data.status === "disabled") invalid("位置或订阅已停用。");
    const billing = { amountMinor: p.amountMinor === undefined ? record.data.billing.amountMinor : integer(p.amountMinor, "租金"), currency: this.currency(p.currency, record.data.billing.currency), period: period(p.period, record.data.billing.period) };
    const cycleAnchorDay = record.data.cycleAnchorDay ?? Number((record.data.legacy ? record.data.endDate : record.data.startDate).slice(8, 10));
    const startDate = record.data.endDate; const endDate = addPeriod(startDate, billing.period, cycleAnchorDay);
    if (this.occupied(record.data.slotId, startDate, endDate, record.id)) throw new OperationsError("conflict", "下一租期位置已被占用。");
    const periodVersion = record.data.periodVersion + 1;
    this.claimLegacyFields(slot.id, "slot", ["status"], context);
    this.claimLegacyFields(sub.id, "subscription", ["status"], context);
    if (record.data.customerId) this.claimLegacyFields(record.data.customerId, "customer", ["archived"], context);
    const data = this.detach({ ...record.data, billing, endDate, cycleAnchorDay, periodVersion, history: [...record.data.history, { type: "renew" as const, date: date(p.date ?? today()), periodStart: startDate, periodEnd: endDate, commandId: context.id, periodVersion }] }, ["billing", "endDate", "cycleAnchorDay", "periodVersion", "history", "customerId", "usage", "slotId", "subscriptionId", "startDate", "status"]);
    this.write("rental", record.id, data, context, record.revision);
    if (data.usage === "rented") this.issueBill({ rentalId: record.id, startDate, endDate, dueDate: p.dueDate ?? startDate, amountMinor: billing.amountMinor, currency: billing.currency }, context, `bill:${record.id}:${periodVersion}`);
  }
  private exitRental(command: OpsCommand, context: Context) {
    const p = command.payload; const record = this.get<RentalData>(required(p.id, "租赁 ID"), "rental"); this.expected(command, record);
    if (record.data.status !== "active") throw new OperationsError("conflict", "租赁已经退出。");
    const exitDate = date(p.date ?? today()); const physicalDate = record.data.history.filter(event => event.type !== "renew").at(-1)!.date; if (exitDate < physicalDate) invalid("退出日期不能早于最后一次实际加入或换号。");
    const endDate = exitDate < record.data.endDate ? exitDate : record.data.endDate;
    const reason = required(p.reason, "退出原因");
    this.write("rental", record.id, this.detach({ ...record.data, status: "ended", endDate, history: [...record.data.history, { type: "exit", date: exitDate, commandId: context.id, reason, periodVersion: record.data.periodVersion }] }, ["status", "endDate", "history"]), context, record.revision);
  }
  private receive(command: OpsCommand, context: Context) {
    const p = command.payload; const bill = p.billId ? this.get<BillData>(text(p.billId), "bill") : undefined;
    if (bill?.data.status === "void") invalid("账单已作废。");
    if (bill && p.expectedBillRevision !== undefined && p.expectedBillRevision !== bill.revision) throw new OperationsError("conflict", "账单已修改。");
    const amountMinor = integer(p.amountMinor, "收款金额", 1); const currency = this.currency(p.currency ?? p.currencyCode, bill?.data.currency);
    const feePercent = text(p.feePercent, "0"); const feeAmountMinor = paymentFee(amountMinor, feePercent).feeAmountMinor;
    const frozen = this.freeze(amountMinor - feeAmountMinor, currency);
    const gross = this.freeze(amountMinor, currency);
    const billQuote = bill ? this.quotes().find(quote => quote.currency === bill.data.currency) : undefined;
    if (bill && currency !== bill.data.currency && !billQuote) invalid("缺少账单币种当前汇率。");
    const appliedMinor = bill ? currency === bill.data.currency ? amountMinor : crossMinor(amountMinor, gross.fx.minorUnit, gross.fx.rateToUsd, bill.data.fx.minorUnit, billQuote!.rateToUsd) : undefined;
    if (bill && appliedMinor! > billBalance(this.snapshotRaw(), bill.id).outstandingMinor) invalid("收款超过账单未收金额，请拆分未分配收款。");
    const subscriptionId = text(p.subscriptionId ?? bill?.data.subscriptionId) || undefined; if (subscriptionId) this.get(subscriptionId, "subscription");
    const customerId = text(p.customerId ?? bill?.data.customerId) || undefined; if (customerId) this.get(customerId, "customer");
    if (bill && (subscriptionId !== bill.data.subscriptionId || customerId !== bill.data.customerId)) invalid("收款归属与账单不一致。");
    const subscription = subscriptionId ? this.get<SubscriptionData>(subscriptionId, "subscription").data : undefined;
    const data: EntryData = { ...metadata({ ...p, channelId: p.channelId ?? bill?.data.channelId ?? subscription?.channelId, channelName: p.channelName ?? bill?.data.channelName ?? subscription?.channelName }), type: "receipt", ...(subscriptionId ? { subscriptionId } : {}), ...(customerId ? { customerId } : {}), ...(bill?.data.rentalId ? { rentalId: bill.data.rentalId } : {}), ...(bill ? { billId: bill.id, appliedMinor, billFx: { currency: bill.data.currency, minorUnit: bill.data.fx.minorUnit, rateToUsd: billQuote?.rateToUsd ?? bill.data.fx.rateToUsd } } : {}), amountMinor, currency, feePercent, feeAmountMinor, totalMinor: amountMinor - feeAmountMinor, ...frozen, date: date(p.date ?? p.receivedDate ?? today()), status: "posted" };
    this.write("entry", `entry:${command.id}`, data, context, 0);
  }
  private refund(command: OpsCommand, context: Context) {
    const p = command.payload; const source = this.get<EntryData>(required(p.sourceEntryId, "原收款 ID"), "entry");
    if (source.data.type !== "receipt" || source.data.status !== "posted") invalid("只能退回有效收款。");
    const previous = this.snapshotRaw().entries.filter(row => row.data.sourceEntryId === source.id && row.data.type === "refund" && row.data.status === "posted");
    const already = previous.reduce((sum, row) => sum + row.data.amountMinor, 0); const amountMinor = integer(p.amountMinor, "退款金额", 1);
    if (amountMinor + already > source.data.amountMinor) invalid("累计退款不能超过原收款。");
    const reason = required(p.reason, "退款原因"); const currency = source.data.currency;
    const sourceApplied = source.data.appliedMinor ?? 0;
    const cumulativeApplied = Number(BigInt(sourceApplied) * BigInt(already + amountMinor) / BigInt(source.data.amountMinor));
    const appliedMinor = cumulativeApplied - previous.reduce((sum, row) => sum + (row.data.appliedMinor ?? 0), 0);
    const data: EntryData = { ...metadata({ ...p, channelId: source.data.channelId, channelName: source.data.channelName }), type: "refund", subscriptionId: source.data.subscriptionId, rentalId: source.data.rentalId, customerId: source.data.customerId, billId: source.data.billId, sourceEntryId: source.id, amountMinor, currency, feePercent: "0", feeAmountMinor: 0, totalMinor: amountMinor, ...this.freeze(amountMinor, currency), ...(source.data.billId ? { appliedMinor, billFx: source.data.billFx } : {}), date: date(p.date ?? today()), status: "posted", reason };
    this.write("entry", `entry:${command.id}`, data, context, 0);
  }
  private cost(command: OpsCommand, context: Context, entryId = `entry:${command.id}`) {
    const p = command.payload; const subscriptionId = required(p.subscriptionId, "订阅 ID"); const subscription = this.get<SubscriptionData>(subscriptionId, "subscription").data;
    const currency = this.currency(p.currency ?? p.currencyCode, subscription.currency); const amountMinor = integer(p.amountMinor, "购买金额"); const feePercent = text(p.feePercent, subscription.feePercent); const fee = paymentFee(amountMinor, feePercent);
    let interval: { periodStart?: string; periodEnd?: string } = {};
    if (p.periodStart !== undefined || p.periodEnd !== undefined) { const checked = range(p.periodStart, p.periodEnd); interval = { periodStart: checked.startDate, periodEnd: checked.endDate }; }
    const frozen = this.freeze(fee.totalAmountMinor, currency);
    const costAllocation: NonNullable<EntryData["costAllocation"]> = { mode: subscription.allocation, slots: this.snapshotRaw().slots.filter(slot => slot.data.subscriptionId === subscriptionId && slot.data.status === "available").map(slot => ({ slotId: slot.id, weight: slot.data.weight, fixedCostMinor: slot.data.fixedCostMinor ?? 0 })) };
    if (costAllocation.mode === "fixed-amount") {
      let cumulative = 0; let usdBefore = 0; let cnyBefore = 0;
      costAllocation.fixedShares = costAllocation.slots.map(slot => {
        cumulative += interval.periodStart && interval.periodEnd ? periodValueForRange(slot.fixedCostMinor ?? 0, interval.periodStart, interval.periodEnd, subscription.period, subscription.cycleAnchorDay) : slot.fixedCostMinor ?? 0;
        const value = this.freeze(cumulative, subscription.currency);
        const share = { slotId: slot.slotId, usdMinor: value.usdMinor - usdBefore, cnyMinor: value.cnyMinor === null ? null : value.cnyMinor - cnyBefore };
        usdBefore = value.usdMinor; cnyBefore = value.cnyMinor ?? 0; return share;
      });
      if (usdBefore > frozen.usdMinor || frozen.cnyMinor !== null && cnyBefore > frozen.cnyMinor) invalid("固定分摊合计超过这笔实际购买成本，请先调整固定金额。");
    }
    const data: EntryData = { ...metadata({ ...p, channelId: p.channelId ?? subscription.channelId, channelName: p.channelName ?? subscription.channelName }), type: "cost", subscriptionId, amountMinor, currency, feePercent, feeAmountMinor: fee.feeAmountMinor, totalMinor: fee.totalAmountMinor, ...frozen, costAllocation, date: date(p.date ?? today()), ...interval, status: "posted" };
    this.write("entry", entryId, data, context, 0);
  }
  private dispatch(command: OpsCommand, context: Context) {
    const p = command.payload;
    switch (command.type) {
      case "customer.save": case "template.save": case "subscription.save": case "slot.save": this.save(command, context, command.type.split(".")[0] as "customer" | "template" | "subscription" | "slot"); break;
      case "customer.archive": case "customer.delete": {
        const record = this.get<CustomerData>(required(p.id, "客户 ID"), "customer"); this.expected(command, record);
        if (this.snapshotRaw().rentals.some(row => row.data.customerId === record.id && row.data.status === "active")) invalid("客户仍有有效租赁，请先退出。");
        this.write("customer", record.id, this.detach({ ...record.data, archived: true }, ["archived"]), context, record.revision); break;
      }
      case "rental.join": this.join(command, context); break;
      case "rental.renew": this.renewRental(command, context); break;
      case "rental.exit": this.exitRental(command, context); break;
      case "rental.switch": {
        const record = this.get<RentalData>(required(p.id, "租赁 ID"), "rental"); this.expected(command, record); if (record.data.status !== "active") invalid("已退出租赁不能换号。");
        const slot = this.get<SlotData>(required(p.toSlotId, "目标位置"), "slot"); const sub = this.get<SubscriptionData>(slot.data.subscriptionId, "subscription"); const switchDate = date(p.date ?? today()); const reason = required(p.reason, "换号原因");
        const physicalDate = record.data.history.filter(event => event.type !== "renew").at(-1)!.date;
        if (switchDate < physicalDate || switchDate >= record.data.endDate || slot.id === record.data.slotId) invalid("换号日期或目标位置无效。");
        if (slot.data.status === "disabled" || sub.data.status === "disabled" || this.occupied(slot.id, switchDate, record.data.endDate, record.id)) throw new OperationsError("conflict", "目标位置不可用。");
        const data: RentalData = { ...record.data, slotId: slot.id, subscriptionId: slot.data.subscriptionId, history: [...record.data.history, { type: "switch", date: switchDate, commandId: context.id, fromSlotId: record.data.slotId, toSlotId: slot.id, reason, periodVersion: record.data.periodVersion }] };
        this.write("rental", record.id, this.detach(data, ["slotId", "subscriptionId", "history"]), context, record.revision); break;
      }
      case "renewal.batch": {
        if (!Array.isArray(p.items) || !p.items.length || p.items.length > 1000) invalid("批量续期需要 1–1000 个租赁。");
        const ids = new Set<string>();
        for (const item of p.items as Record<string, unknown>[]) { const id = required(item.id, "租赁 ID"); if (ids.has(id)) invalid("同一批次不能重复续期一个租赁。"); ids.add(id); this.renewRental({ ...command, payload: { ...item, ...(p.period ? { period: p.period } : {}) } }, context); } break;
      }
      case "subscription.renew": {
        const record = this.get<SubscriptionData>(required(p.id, "订阅 ID"), "subscription"); this.expected(command, record); if (record.data.status !== "active") invalid("订阅已停用。");
        if (p.expectedEndDate !== undefined && p.expectedEndDate !== record.data.endDate) throw new OperationsError("conflict", "订阅期次已变化。");
        const term = period(p.period, record.data.period); const cycleAnchorDay = record.data.cycleAnchorDay ?? Number(record.data.startDate.slice(8, 10)); const startDate = record.data.endDate; const endDate = addPeriod(startDate, term, cycleAnchorDay);
        const next = this.detach({ ...record.data, startDate, endDate, cycleAnchorDay, period: term, amountMinor: p.amountMinor === undefined ? record.data.amountMinor : integer(p.amountMinor, "金额"), currency: this.currency(p.currency, record.data.currency), feePercent: text(p.feePercent, record.data.feePercent) }, ["startDate", "endDate", "cycleAnchorDay", "period", "amountMinor", "currency", "feePercent", "status"]);
        this.write("subscription", record.id, next, context, record.revision);
        this.cost({ ...command, payload: { ...p, subscriptionId: record.id, amountMinor: next.amountMinor, currency: next.currency, feePercent: next.feePercent, periodStart: startDate, periodEnd: endDate } }, context); break;
      }
      case "subscription.disable": case "slot.disable": {
        const kind = command.type.split(".")[0] as "slot" | "subscription"; const record = this.get<SlotData | SubscriptionData>(required(p.id, "记录 ID"), kind); this.expected(command, record); const reason = required(p.reason, "停用原因");
        const active = this.snapshotRaw().rentals.filter(row => row.data.status === "active" && (kind === "slot" ? row.data.slotId === record.id : row.data.subscriptionId === record.id));
        if (active.length) invalid("仍有有效租赁，请先退出，再停用并保留历史。");
        this.write(kind, record.id, this.detach({ ...record.data, status: "disabled", note: [record.data.note, reason].filter(Boolean).join("\n") }, ["status", "note"]), context, record.revision); break;
      }
      case "bill.issue": this.issueBill(p, context); break;
      case "bill.discount": {
        const record = this.get<BillData>(required(p.id, "账单 ID"), "bill"); this.expected(command, record); if (record.data.status !== "open") invalid("账单已作废。");
        const reason = required(p.reason, "优惠原因"); const discountMinor = integer(p.discountMinor ?? p.amountMinor, "优惠金额"); const total = p.total === true ? discountMinor : record.data.discountMinor + discountMinor;
        const paid = billBalance(this.snapshotRaw(), record.id).receivedMinor;
        if (total > record.data.amountMinor || record.data.amountMinor - total < paid) invalid("优惠后应收不能低于已收金额，请先退款。");
        const amount = record.data.amountMinor - total; const usdMinor = freezeUsdMinor(amount, record.data.fx.minorUnit, record.data.fx.rateToUsd); const cnyMinor = record.data.fx.cnyRateToUsd ? crossMinor(amount, record.data.fx.minorUnit, record.data.fx.rateToUsd, 2, record.data.fx.cnyRateToUsd) : record.data.fx.rateToCny ? freezeUsdMinor(amount, record.data.fx.minorUnit, record.data.fx.rateToCny) : null;
        this.write("bill", record.id, { ...record.data, discountMinor: total, usdMinor, cnyMinor, reason }, context, record.revision); break;
      }
      case "bill.void": case "entry.void": {
        const kind = command.type.split(".")[0] as "bill" | "entry"; const record = this.get<BillData | EntryData>(required(p.id, "记录 ID"), kind); this.expected(command, record); const reason = required(p.reason, "作废原因");
        if (kind === "bill" && billBalance(this.snapshotRaw(), record.id).receivedMinor > 0) invalid("账单已有收款，请先退款再作废。");
        if (kind === "entry" && this.snapshotRaw().entries.some(row => row.data.sourceEntryId === record.id && row.data.status === "posted")) invalid("收款已有退款记录，不能直接作废。");
        this.write(kind, record.id, this.detach({ ...record.data, status: "void", reason }, ["status", "reason"]), context, record.revision); break;
      }
      case "entry.receive": this.receive(command, context); break;
      case "entry.refund": this.refund(command, context); break;
      case "entry.cost": this.cost(command, context); break;
      case "status.batch": {
        const reason = required(p.reason, "批量状态变更原因");
        if (!Array.isArray(p.items) || !p.items.length || p.items.length > 1000) invalid("批量状态变更需要 1–1000 条记录。");
        const ids = new Set<string>();
        for (const item of p.items as Record<string, unknown>[]) {
          const id = required(item.id, "记录 ID"); if (ids.has(id)) invalid("批次含重复记录。"); ids.add(id);
          if (item.kind !== "slot" && item.kind !== "subscription") invalid("只支持位置和订阅状态批量变更。");
          if (item.status === "disabled") this.dispatch({ ...command, type: `${item.kind}.disable`, payload: { id, expectedRevision: item.expectedRevision, reason } }, context);
          else if (item.status === "available" && item.kind === "slot" || item.status === "active" && item.kind === "subscription") {
            const record = this.get<SlotData | SubscriptionData>(id, item.kind); this.expected({ ...command, payload: item }, record);
            this.write(item.kind, id, this.detach({ ...record.data, status: item.status } as OpsData, ["status"]), context, record.revision);
          } else invalid("批量状态值无效。");
        }
        break;
      }
      case "import.commit": this.importRows(command, context); break;
      default: invalid(`不支持的操作：${command.type}`);
    }
  }
  private importRows(command: OpsCommand, context: Context) {
    const rows = command.payload.rows;
    if (!Array.isArray(rows) || !rows.length || rows.length > 10000) invalid("导入需要 1–10000 行命令。");
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as { type?: string; payload?: Record<string, unknown> };
      if (!row || !["customer.save", "subscription.save", "slot.save", "rental.join", "bill.issue", "entry.receive", "entry.cost"].includes(row.type ?? "") || !row.payload) invalid(`导入第 ${i + 1} 行格式无效。`);
      const key = fingerprint(row); const id = `import:${key}`;
      if (this.sqlite.prepare("SELECT 1 FROM ops_command WHERE id=?").get(id)) continue;
      if (row.type === "customer.save" && this.snapshotRaw().customers.some(customer => customer.data.name === text(row.payload!.name) && customer.data.contact === text(row.payload!.contact) && customer.data.email === text(row.payload!.email))) continue;
      const nested: OpsCommand = { id, type: row.type!, payload: { ...row.payload, externalKey: text(row.payload.externalKey) || key } };
      assertOperationsAccess(context.actor, nested);
      this.dispatch(nested, { ...context, id });
      this.sqlite.prepare("INSERT INTO ops_command(id,hash,result,actor_id,created_at) VALUES(?,?,?,?,?)").run(id, fingerprint({ command: nested, actor: context.actor.id }), "[]", context.actor.id, new Date().toISOString());
    }
  }
  applyRecords(command: ReplicaCommand, actor: OpsActor = ADMIN) { return this.applyReplica(command, actor); }
  applyReplica(command: ReplicaCommand, actor: OpsActor = ADMIN): OpsResult {
    if (actor.role !== "admin") throw new OperationsError("forbidden", "同步记录导入仅管理员可用。");
    required(command.id, "同步命令 ID"); if (!Array.isArray(command.records) || command.records.length > 10000) invalid("同步记录数量无效。");
    return this.sqlite.transaction(() => {
      const hash = fingerprint(command); const existing = this.sqlite.prepare("SELECT hash,result FROM ops_command WHERE id=?").get(command.id) as { hash: string; result: string } | undefined;
      if (existing) { if (existing.hash !== hash) throw new OperationsError("idempotency", "同步命令 ID 已用于其他内容。"); return { ok: true as const, replayed: true, changedIds: JSON.parse(existing.result), snapshot: filterOperationsSnapshot(this.snapshotRaw(), actor) }; }
      const context: Context = { id: command.id, actor, type: "sync.apply", changed: new Set() };
      const ids = new Set<string>();
      for (const row of command.records) {
        required(row.id, "记录 ID"); if (ids.has(row.id)) invalid("同步批次含重复记录 ID。"); ids.add(row.id);
        if (!["customer", "template", "subscription", "slot", "rental", "bill", "entry"].includes(row.kind) || !row.data || typeof row.data !== "object") invalid("同步记录类型无效。");
        assertOperationsAccess(actor, { id: command.id, type: "sync.apply", payload: { data: row.data } });
        integer(row.expectedRevision, "预期版本"); if (row.sourceRevision !== undefined) integer(row.sourceRevision, "来源版本", 1);
        const prior = this.find(row.id);
        validateRecord(row.kind, row.data);
        if (prior && row.kind === "rental") {
          const before = decode(prior).data as RentalData; const after = row.data as RentalData;
          if (after.periodVersion < before.periodVersion || after.history.length < before.history.length || canonical(after.history.slice(0, before.history.length)) !== canonical(before.history)) throw new OperationsError("immutable", "不能删除或改写租赁历史。");
        }
        if (prior && (row.kind === "entry" || row.kind === "bill")) {
          const oldData = decode(prior).data as EntryData | BillData;
          const oldImmutable = { ...oldData } as Record<string, unknown>; const nextImmutable = { ...row.data } as Record<string, unknown>;
          const mutable = row.kind === "entry" ? ["status", "reason", "note", "tags", "group", "legacy"] : ["status", "reason", "note", "tags", "group", "discountMinor", "usdMinor", "cnyMinor", "legacy"];
          for (const key of mutable) { delete oldImmutable[key]; delete nextImmutable[key]; }
          if (canonical(oldImmutable) !== canonical(nextImmutable)) throw new OperationsError("immutable", "不能通过同步改写历史金额、汇率或账期。");
          if (oldData.status === "void" && (row.data as EntryData | BillData).status !== "void") throw new OperationsError("immutable", "不能复活已作废账务记录。");
          if ((row.data as EntryData | BillData).status === "void" && !text((row.data as EntryData | BillData).reason)) invalid("同步作废必须保留原因。");
          if (row.kind === "bill") { const bill = row.data as BillData; if (bill.discountMinor < (oldData as BillData).discountMinor || bill.discountMinor > bill.amountMinor || bill.usdMinor !== freezeUsdMinor(bill.amountMinor - bill.discountMinor, bill.fx.minorUnit, bill.fx.rateToUsd)) throw new OperationsError("immutable", "同步账单优惠与冻结金额不一致。"); }
        }
        this.write(row.kind, row.id, row.data, context, row.expectedRevision, row.sourceRevision);
        // Remote canonical records retain provenance but never inherit this
        // machine's authority to refresh similarly numbered V1 source rows.
        this.sqlite.prepare("DELETE FROM ops_legacy_owner WHERE record_id=?").run(row.id);
      }
      this.validateRelations();
      this.auditWrite(context, required(command.reason ?? "已授权设备同步", "同步原因"));
      this.sqlite.prepare("INSERT INTO ops_command(id,hash,result,actor_id,created_at) VALUES(?,?,?,?,?)").run(command.id, hash, JSON.stringify([...context.changed]), actor.id, new Date().toISOString());
      return { ok: true as const, replayed: false, changedIds: [...context.changed], snapshot: filterOperationsSnapshot(this.snapshotRaw(), actor) };
    }).immediate();
  }
  private validateRelations() {
    const snapshot = this.snapshotRaw();
    for (const row of this.all()) {
      validateRecord(row.kind, row.data);
      if ("currency" in row.data) {
        const currency = this.sqlite.prepare("SELECT minor_unit FROM currency WHERE code=?").get(row.data.currency) as { minor_unit: number } | undefined;
        if (!currency) invalid("记录币种未登记。");
        if ("fx" in row.data && row.data.fx.minorUnit !== currency.minor_unit) invalid("冻结币种精度与登记币种不一致。");
        if ("fx" in row.data && row.data.currency === "USD" && row.data.fx.rateToUsd !== "1") invalid("美元基准汇率必须为 1。");
      }
    }
    for (const row of snapshot.slots) { this.get(row.data.subscriptionId, "subscription"); integer(row.data.weight, "分摊权重", 1); }
    for (const row of snapshot.subscriptions) {
      if (row.data.allocation === "fixed-amount") {
        const total = snapshot.slots.filter(slot => slot.data.subscriptionId === row.id && slot.data.status === "available").reduce((sum, slot) => sum + (slot.data.fixedCostMinor ?? 0), 0);
        if (!Number.isSafeInteger(total) || total > paymentFee(row.data.amountMinor, row.data.feePercent).totalAmountMinor) invalid("各位置固定分摊合计不能超过订阅含手续费周期成本。");
      }
    }
    for (const row of snapshot.rentals) {
      const slot = this.get<SlotData>(row.data.slotId, "slot"); const sub = this.get<SubscriptionData>(row.data.subscriptionId, "subscription"); const customer = row.data.customerId ? this.get<CustomerData>(row.data.customerId, "customer") : undefined;
      if (slot.data.subscriptionId !== sub.id) invalid("租赁位置与订阅不一致。");
      if (row.data.status === "active" && (slot.data.status === "disabled" || sub.data.status === "disabled" || customer?.data.archived)) invalid("有效租赁的订阅、位置或客户已停用。");
      if (row.data.usage === "rented" && !row.data.customerId) invalid("出租租赁缺少客户。"); integer(row.data.periodVersion, "租期版本", 1);
      if (row.data.endDate < row.data.startDate) invalid("租期日期无效。");
      for (const interval of rentalIntervals(row.data)) if (this.occupied(interval.slotId, interval.startDate, interval.endDate, row.id)) throw new OperationsError("conflict", "租赁历史占位冲突。");
    }
    for (const row of snapshot.bills) {
      this.get(row.data.subscriptionId, "subscription"); if (row.data.customerId) this.get(row.data.customerId, "customer");
      if (row.data.rentalId) { const rental = this.get<RentalData>(row.data.rentalId, "rental"); if (row.data.customerId !== rental.data.customerId) invalid("账单客户与租赁客户不一致。"); }
      const balance = billBalance(snapshot, row.id); if (balance.receivedMinor < 0 || row.data.status === "void" && balance.receivedMinor !== 0 || row.data.status !== "void" && balance.receivedMinor > balance.amountMinor) invalid("账单收款或退款余额无效，已收款账单须先退款再作废。");
    }
    for (const row of snapshot.entries) {
      if (row.data.costAllocation?.mode === "fixed-amount") {
        const shares = row.data.costAllocation.fixedShares; if (!shares || new Set(shares.map(share => share.slotId)).size !== shares.length) invalid("固定金额分摊快照无效。");
        if (shares.reduce((sum, share) => sum + share.usdMinor, 0) > row.data.usdMinor || row.data.cnyMinor !== null && shares.reduce((sum, share) => sum + (share.cnyMinor ?? 0), 0) > row.data.cnyMinor) invalid("固定金额分摊超过费用总额。");
      }
      if (row.data.billId) {
        const bill = this.get<BillData>(row.data.billId, "bill"); if (row.data.customerId !== bill.data.customerId || row.data.subscriptionId !== bill.data.subscriptionId) invalid("收款归属与账单不一致。");
        if (row.data.type === "receipt" && !row.data.legacy) {
          if (!row.data.billFx || row.data.billFx.currency !== bill.data.currency) invalid("收款缺少账单币种汇率。");
          const applied = crossMinor(row.data.amountMinor, row.data.fx.minorUnit, row.data.fx.rateToUsd, row.data.billFx.minorUnit, row.data.billFx.rateToUsd);
          if (row.data.appliedMinor !== applied) invalid("收款账单抵扣金额不一致。");
        }
      }
      if (row.data.subscriptionId && !row.data.legacy) this.get(row.data.subscriptionId, "subscription");
      if (row.data.customerId) this.get(row.data.customerId, "customer");
      if (row.data.sourceEntryId) {
        const source = this.get<EntryData>(row.data.sourceEntryId, "entry");
        if (source.data.type !== "receipt" || row.data.type !== "refund" || source.data.currency !== row.data.currency || source.data.billId !== row.data.billId || source.data.customerId !== row.data.customerId || source.data.subscriptionId !== row.data.subscriptionId || source.data.rentalId !== row.data.rentalId) invalid("退款来源不一致。");
        if (row.data.status === "posted" && source.data.status !== "posted") invalid("有效退款的原收款不能已作废。");
        const refunds = snapshot.entries.filter(entry => entry.data.sourceEntryId === source.id && entry.data.status === "posted");
        const refunded = refunds.reduce((sum, entry) => sum + entry.data.amountMinor, 0);
        if (refunded > source.data.amountMinor) invalid("累计退款超过原收款。");
        if (source.data.billId) {
          const numerator = BigInt(source.data.appliedMinor ?? 0) * BigInt(row.data.amountMinor); const denominator = BigInt(source.data.amountMinor);
          const lower = Number(numerator / denominator); const upper = Number((numerator + denominator - BigInt(1)) / denominator);
          if ((row.data.appliedMinor ?? 0) < lower || (row.data.appliedMinor ?? 0) > upper) invalid("单笔退款账单抵扣不符合原收款比例。");
        }
        if (source.data.billId && refunds.reduce((sum, entry) => sum + (entry.data.appliedMinor ?? 0), 0) !== Number(BigInt(source.data.appliedMinor ?? 0) * BigInt(refunded) / BigInt(source.data.amountMinor))) invalid("退款账单抵扣金额不一致。");
      }
    }
  }
}
