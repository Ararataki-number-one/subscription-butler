import { createHash } from "node:crypto";
import { OperationsError } from "./errors";
import type { Metadata, Period, RentalData } from "./types";

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
export function fingerprint(value: unknown) { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function invalid(message: string): never { throw new OperationsError("validation", message); }
export function text(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.length > 10000) invalid("文本格式无效或过长。");
  return value.trim();
}
export function required(value: unknown, label: string): string { const result = text(value); if (!result) invalid(`${label}不能为空。`); return result; }
export function integer(value: unknown, label: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) invalid(`${label}必须为不小于 ${min} 的安全整数。`);
  return value;
}
export function date(value: unknown, label = "日期"): string {
  const result = required(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) invalid(`${label}格式无效。`);
  return result;
}
export function period(value: unknown, fallback: Period = { unit: "month", count: 1 }): Period {
  if (value === undefined) return fallback;
  if (!value || typeof value !== "object") invalid("周期格式无效。");
  const object = value as Record<string, unknown>;
  const unit = object.unit;
  if (unit !== "day" && unit !== "month" && unit !== "quarter" && unit !== "year") invalid("周期单位无效。");
  const count = integer(object.count, "周期数量", 1);
  if (count > 1200) invalid("周期数量过大。");
  return { unit, count };
}
export function addPeriod(start: string, value: Period, anchorDay?: number): string {
  const result = new Date(`${date(start)}T00:00:00Z`);
  if (value.unit === "day") result.setUTCDate(result.getUTCDate() + value.count);
  else {
    const months = value.count * (value.unit === "year" ? 12 : value.unit === "quarter" ? 3 : 1);
    const day = anchorDay ?? result.getUTCDate();
    if (!Number.isInteger(day) || day < 1 || day > 31) invalid("周期锚点日期必须为 1–31。");
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + months);
    const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
    result.setUTCDate(Math.min(day, last));
  }
  return result.toISOString().slice(0, 10);
}
export function periodValueForRange(amount: number, start: string, end: string, value: Period, anchorDay?: number) {
  let cursor = start; let total = 0; let cycles = 0;
  while (cursor < end) {
    if (++cycles > 40000) invalid("分摊周期过长。");
    const next = addPeriod(cursor, value, anchorDay);
    total += allocateRange(amount, cursor, next, cursor, end < next ? end : next);
    if (!Number.isSafeInteger(total)) invalid("固定分摊总额过大。");
    cursor = next;
  }
  return total;
}
export function range(start: unknown, end: unknown): { startDate: string; endDate: string } {
  const startDate = date(start, "开始日"); const endDate = date(end, "结束日");
  if (endDate <= startDate) invalid("结束日必须晚于开始日。");
  return { startDate, endDate };
}
export function days(start: string, end: string) { return (Date.parse(end) - Date.parse(start)) / 86400000; }
export function allocateRange(amount: number, start: string, end: string, from: string, to: string): number {
  const total = days(start, end); if (total <= 0) invalid("分摊期必须为正数。");
  const a = Math.max(0, Math.min(total, days(start, from)));
  const b = Math.max(a, Math.min(total, days(start, to)));
  return Number(BigInt(amount) * BigInt(b) / BigInt(total) - BigInt(amount) * BigInt(a) / BigInt(total));
}
/** Convert directly between currencies without rounding an intermediate USD amount. */
export function crossMinor(amount: number, sourceUnit: number, sourceRate: string, targetUnit: number, targetRate: string): number {
  const parse = (value: string) => {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) invalid("汇率格式无效。");
    const fraction = match[2] ?? ""; const coefficient = BigInt(match[1] + fraction);
    if (!coefficient) invalid("汇率必须为正数。");
    return { coefficient, scale: BigInt(10) ** BigInt(fraction.length) };
  };
  const source = parse(sourceRate); const target = parse(targetRate);
  const numerator = BigInt(amount) * source.coefficient * target.scale * BigInt(10) ** BigInt(targetUnit);
  const denominator = source.scale * target.coefficient * BigInt(10) ** BigInt(sourceUnit);
  const result = Number((numerator + denominator / BigInt(2)) / denominator);
  if (!Number.isSafeInteger(result)) invalid("折算金额过大。");
  return result;
}
export function shanghaiToday() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
export function rentalIntervals(rental: RentalData) {
  let slotId = rental.history.find(event => event.type === "join")?.toSlotId ?? rental.history.find(event => event.type === "switch")?.fromSlotId ?? rental.slotId;
  let cursor = rental.startDate;
  const intervals: { slotId: string; startDate: string; endDate: string }[] = [];
  for (const event of rental.history.filter(event => event.type === "switch" && event.toSlotId)) {
    if (event.date > rental.endDate) break;
    if (event.date > cursor) intervals.push({ slotId, startDate: cursor, endDate: event.date });
    cursor = event.date; slotId = event.toSlotId!;
  }
  if (rental.endDate > cursor) intervals.push({ slotId, startDate: cursor, endDate: rental.endDate });
  return intervals;
}
export function metadata(value: Record<string, unknown>, previous?: Metadata): Metadata {
  const tags = value.tags === undefined ? previous?.tags ?? [] : value.tags;
  if (!Array.isArray(tags) || tags.some(tag => typeof tag !== "string") || tags.length > 100) invalid("标签格式无效。");
  return { tags: [...new Set((tags as string[]).map(tag => text(tag)).filter(Boolean))], group: text(value.group, previous?.group), note: text(value.note, previous?.note), ...(value.channelId !== undefined ? { channelId: value.channelId as number | string } : previous?.channelId !== undefined ? { channelId: previous.channelId } : {}), ...(value.channelName !== undefined ? { channelName: text(value.channelName) } : previous?.channelName ? { channelName: previous.channelName } : {}), ...(value.externalKey !== undefined ? { externalKey: text(value.externalKey) } : previous?.externalKey ? { externalKey: previous.externalKey } : {}), ...(previous?.legacy ? { legacy: previous.legacy } : {}) };
}
