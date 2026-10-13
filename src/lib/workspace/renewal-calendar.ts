import type { OperationsSnapshot, RentalData, SlotData, SubscriptionData } from "../operations/types";
import { calendarDays } from "./view-model";

export type RenewalCalendarEntry = {
  kind: "subscription" | "rental";
  recordId: string;
  subRecordId: string;
  date: string;
  name: string;
  service: string;
  planName: string;
  account: string;
  customerName: string;
  slotId?: string;
  slotLabel?: string;
  slotKind?: SlotData["kind"];
  usage?: RentalData["usage"];
  sourceLegacySpaceId?: number;
};

/** A source reference is not proof that the classic row exists on this device. */
function legacySpaceId(subscription: SubscriptionData): number | undefined {
  if (!subscription.legacy?.present) return undefined;
  const ids = new Set<number>();
  for (const source of subscription.legacy.sources) {
    if (!source.startsWith("space:")) continue;
    const match = /^space:([1-9]\d*)$/.exec(source);
    if (!match) return undefined;
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id)) return undefined;
    ids.add(id);
  }
  return ids.size === 1 ? [...ids][0] : undefined;
}

/** Uses normalized records once; merged legacy source rows are never expanded. */
export function renewalCalendarEntries(snapshot: OperationsSnapshot): RenewalCalendarEntry[] {
  const subscriptions = new Map(snapshot.subscriptions.filter(row => row.data.status === "active").map(row => [row.id, row]));
  const slots = new Map(snapshot.slots.filter(row => row.data.status === "available").map(row => [row.id, row]));
  const customers = new Map(snapshot.customers.map(row => [row.id, row.data.name]));
  const common = (id: string, subscription: SubscriptionData) => {
    const sourceLegacySpaceId = legacySpaceId(subscription);
    return { subRecordId: id, name: subscription.name, service: subscription.service, planName: subscription.planName,
      ...(sourceLegacySpaceId === undefined ? {} : { sourceLegacySpaceId }) };
  };
  const entries: RenewalCalendarEntry[] = [...subscriptions.values()].map(row => ({
    ...common(row.id, row.data), kind: "subscription", recordId: row.id, date: row.data.endDate,
    account: row.data.account.trim(), customerName: "",
  }));
  for (const row of snapshot.rentals) {
    if (row.data.status !== "active") continue;
    const subscription = subscriptions.get(row.data.subscriptionId), slot = slots.get(row.data.slotId);
    if (!subscription || !slot || slot.data.subscriptionId !== subscription.id) continue;
    entries.push({
      ...common(subscription.id, subscription.data), kind: "rental", recordId: row.id, date: row.data.endDate,
      account: slot.data.account.trim() || subscription.data.account.trim(),
      customerName: row.data.customerId ? customers.get(row.data.customerId) ?? "" : "",
      slotId: slot.id, slotLabel: slot.data.label, slotKind: slot.data.kind, usage: row.data.usage,
    });
  }
  return entries.sort((a, b) => a.date.localeCompare(b.date) ||
    (a.kind === b.kind ? 0 : a.kind === "subscription" ? -1 : 1) || a.recordId.localeCompare(b.recordId));
}

export function filterRenewalCalendarEntries(entries: readonly RenewalCalendarEntry[], options: { month?: string; search?: string } = {}): RenewalCalendarEntry[] {
  const dates = options.month ? new Set(calendarDays(options.month)) : null;
  const terms = (options.search ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(entry => {
    if (dates && !dates.has(entry.date)) return false;
    const text = [entry.name, entry.service, entry.planName, entry.account, entry.customerName, entry.slotLabel,
      entry.slotKind, entry.recordId, entry.subRecordId, entry.kind === "subscription" ? "订阅续费" : "租期续租",
      entry.usage === "self" ? "自用" : entry.usage === "rented" ? "出租" : ""].join(" ").toLowerCase();
    return terms.every(term => text.includes(term));
  });
}

function dateNumber(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const milliseconds = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) return null;
  return milliseconds / 86400000;
}

export function overdueRenewalEntries(entries: readonly RenewalCalendarEntry[], today: string): RenewalCalendarEntry[] {
  const current = dateNumber(today);
  if (current === null) return [];
  return entries.filter(entry => { const date = dateNumber(entry.date); return date !== null && date < current; });
}

/** Inclusive business-date window; UTC integer days avoid clock/DST rounding. */
export function upcomingRenewalEntries(entries: readonly RenewalCalendarEntry[], today: string, days = 7): RenewalCalendarEntry[] {
  const current = dateNumber(today);
  if (current === null || !Number.isSafeInteger(days) || days < 0 || !Number.isSafeInteger(current + days)) return [];
  return entries.filter(entry => { const date = dateNumber(entry.date); return date !== null && date >= current && date <= current + days; });
}
