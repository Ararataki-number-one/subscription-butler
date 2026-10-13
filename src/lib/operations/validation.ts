import { z } from "zod";
import { OperationsError } from "./errors";
import { freezeUsdMinor } from "@/lib/money";
import { paymentFee } from "@/lib/payment-fees";
import { crossMinor, date } from "./utils";
import type { BillData, EntryData, OpsData, OpsKind, RentalData } from "./types";

const minor = z.number().int().nonnegative().safe();
const text = z.string().max(10000);
const ref = text.min(1);
const day = z.string().refine(value => { try { date(value); return true; } catch { return false; } }, "无效日期");
const rate = z.string().regex(/^\d+(?:\.\d+)?$/).refine(value => Number(value) > 0 && Number.isFinite(Number(value)));
const period = z.object({ unit: z.enum(["day", "month", "quarter", "year"]), count: z.number().int().min(1).max(1200) }).strict();
const legacy = z.object({ sources: z.array(ref).max(1000), fingerprint: ref, managedFields: z.array(ref), detachedFields: z.array(ref).optional(), present: z.boolean(), conflict: text.optional() }).strict().optional();
const metadata = { tags: z.array(text).max(100), group: text, note: text, externalKey: text.optional(), legacy, channelId: z.union([z.number().int().positive(), ref]).optional(), channelName: text.optional() };
const fx = z.object({ rateToUsd: rate, rateToCny: rate.nullable(), cnyRateToUsd: rate.nullable().optional(), quoteDate: ref, fetchedAt: ref, source: ref, minorUnit: z.number().int().min(0).max(8) }).strict();
const schemas = {
  customer: z.object({ ...metadata, name: ref, contact: text, email: text, archived: z.boolean() }).strict(),
  template: z.object({ ...metadata, name: ref, service: ref, planName: text, capacity: z.number().int().min(1).max(1000), currency: ref, amountMinor: minor, feePercent: text, period, allocation: z.enum(["daily", "fixed", "fixed-amount"]) }).strict(),
  subscription: z.object({ ...metadata, name: ref, service: ref, planName: text, account: text, templateId: ref.optional(), countryCode: z.string().regex(/^[A-Z]{2}$/).optional(), openingDate: day.optional(), currency: ref, amountMinor: minor, feePercent: text, period, cycleAnchorDay: z.number().int().min(1).max(31).optional(), startDate: day, endDate: day, status: z.enum(["active", "disabled"]), allocation: z.enum(["daily", "fixed", "fixed-amount"]) }).strict(),
  slot: z.object({ ...metadata, subscriptionId: ref, label: ref, account: text, kind: z.enum(["mother", "child", "member", "generic"]), weight: z.number().int().positive().safe(), fixedCostMinor: minor.optional(), status: z.enum(["available", "disabled"]) }).strict(),
  rental: z.object({ ...metadata, subscriptionId: ref, slotId: ref, customerId: ref.optional(), usage: z.enum(["rented", "self"]), startDate: day, endDate: day, cycleAnchorDay: z.number().int().min(1).max(31).optional(), billing: z.object({ amountMinor: minor, currency: ref, period }).strict(), status: z.enum(["active", "ended"]), periodVersion: z.number().int().positive().safe(), history: z.array(z.object({ type: z.enum(["join", "renew", "exit", "switch"]), date: day, commandId: ref, fromSlotId: ref.optional(), toSlotId: ref.optional(), reason: text.optional(), periodVersion: z.number().int().positive().safe(), periodStart: day.optional(), periodEnd: day.optional() }).strict()).min(1).max(10000) }).strict(),
  bill: z.object({ ...metadata, subscriptionId: ref, rentalId: ref.optional(), customerId: ref.optional(), startDate: day, endDate: day, dueDate: day, amountMinor: minor, discountMinor: minor, currency: ref, usdMinor: minor, cnyMinor: minor.nullable(), fx, status: z.enum(["open", "void"]), reason: text.optional() }).strict(),
  entry: z.object({ ...metadata, type: z.enum(["receipt", "refund", "cost"]), subscriptionId: ref.optional(), rentalId: ref.optional(), customerId: ref.optional(), billId: ref.optional(), sourceEntryId: ref.optional(), amountMinor: minor, currency: ref, feePercent: text, feeAmountMinor: minor, totalMinor: minor, usdMinor: minor, cnyMinor: minor.nullable(), fx, billFx: z.object({ currency: ref, minorUnit: z.number().int().min(0).max(8), rateToUsd: rate }).strict().optional(), costAllocation: z.object({ mode: z.enum(["daily", "fixed", "fixed-amount"]), slots: z.array(z.object({ slotId: ref, weight: z.number().int().positive().safe(), fixedCostMinor: minor.optional() }).strict()).max(1000), fixedShares: z.array(z.object({ slotId: ref, usdMinor: minor, cnyMinor: minor.nullable() }).strict()).max(1000).optional() }).strict().optional(), date: day, periodStart: day.optional(), periodEnd: day.optional(), appliedMinor: minor.optional(), status: z.enum(["posted", "void"]), reason: text.optional() }).strict(),
};
export function validateRecord(kind: OpsKind, value: OpsData) {
  const parsed = schemas[kind].safeParse(value);
  if (!parsed.success) throw new OperationsError("validation", `记录 ${kind} 格式无效：${parsed.error.issues.slice(0, 3).map(issue => issue.path.join(".") + " " + issue.message).join("；")}`);
  const currency = "currency" in value ? value.currency : undefined;
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new OperationsError("validation", "币种格式无效。");
  if (kind === "subscription" || kind === "template") {
    const data = value as { amountMinor: number; feePercent: string; startDate?: string; endDate?: string };
    paymentFee(data.amountMinor, data.feePercent);
    if (data.startDate && data.endDate && data.endDate <= data.startDate) throw new OperationsError("validation", "订阅日期无效。");
  }
  if (kind === "rental") {
    const data = value as RentalData;
    if (data.endDate < data.startDate || data.status === "active" && data.endDate === data.startDate || data.usage === "self" && data.billing.amountMinor !== 0) throw new OperationsError("validation", "租期或自用金额无效。");
    const physical = data.history.filter(event => event.type !== "renew");
    for (let i = 1; i < physical.length; i++) if (physical[i].date < physical[i - 1].date) throw new OperationsError("validation", "实际加入、换号和退出日期必须按顺序保留。");
    for (const event of data.history) if (!!event.periodStart !== !!event.periodEnd || event.periodStart && event.periodEnd! <= event.periodStart) throw new OperationsError("validation", "续租历史账期无效。");
  }
  if (kind === "bill" || kind === "entry") {
    const data = value as BillData | EntryData;
    if (data.status === "void" && !data.reason) throw new OperationsError("validation", "账务作废必须有原因。");
    if (kind === "bill") {
      const bill = data as BillData;
      if (bill.endDate <= bill.startDate || bill.discountMinor > bill.amountMinor) throw new OperationsError("validation", "账期或折扣无效。");
    } else {
      const entry = data as EntryData;
      const fee = paymentFee(entry.amountMinor, entry.feePercent);
      if (entry.feeAmountMinor !== fee.feeAmountMinor || entry.totalMinor !== (entry.type === "cost" ? fee.totalAmountMinor : entry.amountMinor - fee.feeAmountMinor)) throw new OperationsError("validation", "手续费金额不一致。");
      if (!!entry.periodStart !== !!entry.periodEnd || entry.periodStart && entry.periodEnd! <= entry.periodStart) throw new OperationsError("validation", "成本服务期无效。");
      if (entry.type === "refund" && (!entry.sourceEntryId || !entry.reason)) throw new OperationsError("validation", "退款需要原收款和原因。");
    }
    {
      const amount = kind === "bill" ? (data as BillData).amountMinor - (data as BillData).discountMinor : (data as EntryData).totalMinor;
      if (data.usdMinor !== freezeUsdMinor(amount, data.fx.minorUnit, data.fx.rateToUsd)) throw new OperationsError("validation", "冻结美元金额与汇率不一致。");
      const cny = data.fx.cnyRateToUsd ? crossMinor(amount, data.fx.minorUnit, data.fx.rateToUsd, 2, data.fx.cnyRateToUsd) : data.fx.rateToCny ? freezeUsdMinor(amount, data.fx.minorUnit, data.fx.rateToCny) : null;
      if (data.cnyMinor !== cny) throw new OperationsError("validation", "冻结人民币金额与汇率不一致。");
    }
  }
}
