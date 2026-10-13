import type { CalendarRenewalEvent, OperationsSnapshot, RentalData, SlotData, SubscriptionData } from "../operations/types";
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
  completed: boolean;
  completedAt?: string;
  nextDueDate?: string;
  historyCommandId?: string;
  role?: string;
  amountMinor?: number;
  currency?: string;
  feePercent?: string;
  slotId?: string;
  slotLabel?: string;
  slotKind?: SlotData["kind"];
  usage?: RentalData["usage"];
  sourceLegacySpaceId?: number;
};

export type RenewalCalendarStatus = "renewed" | "overdue" | "due-today" | "due-soon" | "upcoming";

export function renewalCalendarOccurrenceKey(entry: Pick<RenewalCalendarEntry, "kind" | "recordId" | "date">): string {
  return `${entry.kind}:${entry.recordId}:${entry.date}`;
}

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
  const allSubscriptions = new Map(snapshot.subscriptions.map(row => [row.id, row]));
  const allSlots = new Map(snapshot.slots.map(row => [row.id, row]));
  const subscriptions = new Map(snapshot.subscriptions.filter(row => row.data.status === "active").map(row => [row.id, row]));
  const slots = new Map(snapshot.slots.filter(row => row.data.status === "available").map(row => [row.id, row]));
  const customers = new Map(snapshot.customers.map(row => [row.id, row.data.name]));
  const occurrences = new Map<string, { entry: RenewalCalendarEntry; priority: number }>();
  const add = (entry: RenewalCalendarEntry, priority = 0) => {
    const key = renewalCalendarOccurrenceKey(entry), prior = occurrences.get(key);
    if (!prior || entry.completed && !prior.entry.completed || entry.completed === prior.entry.completed && priority > prior.priority) {
      occurrences.set(key, { entry, priority });
    }
  };
  const common = (id: string, subscription: SubscriptionData) => {
    const sourceLegacySpaceId = legacySpaceId(subscription);
    return { subRecordId: id, name: subscription.name, service: subscription.service, planName: subscription.planName,
      ...(sourceLegacySpaceId === undefined ? {} : { sourceLegacySpaceId }) };
  };
  const historyEntry = (kind: RenewalCalendarEntry["kind"], recordId: string, history: CalendarRenewalEvent) => {
    if (history.kind !== kind || !knownRenewalRange(history.dueDate, history.nextDueDate)) return;
    const source = allSubscriptions.get(history.subscriptionId);
    const sourceLegacySpaceId = source ? legacySpaceId(source.data) : undefined;
    add({ kind, recordId, subRecordId: history.subscriptionId, date: history.dueDate,
      name: history.name, service: history.service, planName: history.planName, account: history.account, customerName: history.customerName,
      completed: true, completedAt: history.completedAt, nextDueDate: history.nextDueDate, historyCommandId: history.commandId,
      role: history.role, amountMinor: history.amountMinor, currency: history.currency, feePercent: history.feePercent,
      slotId: history.slotId, slotLabel: history.slotLabel, slotKind: history.slotKind, usage: history.usage,
      ...(sourceLegacySpaceId === undefined ? {} : { sourceLegacySpaceId }) }, 2);
  };
  for (const row of snapshot.subscriptions) {
    if (row.data.status === "active") add({
      ...common(row.id, row.data), kind: "subscription", recordId: row.id, date: row.data.endDate,
      account: row.data.account.trim(), customerName: "", completed: false, role: "订阅续费",
      amountMinor: row.data.amountMinor, currency: row.data.currency, feePercent: row.data.feePercent,
    });
    for (const history of row.data.calendarHistory ?? []) historyEntry("subscription", row.id, history);
  }
  for (const row of snapshot.rentals) {
    const subscription = subscriptions.get(row.data.subscriptionId), slot = slots.get(row.data.slotId);
    if (row.data.status === "active" && subscription && slot && slot.data.subscriptionId === subscription.id) add({
      ...common(subscription.id, subscription.data), kind: "rental", recordId: row.id, date: row.data.endDate,
      account: slot.data.account.trim() || subscription.data.account.trim(),
      customerName: row.data.customerId ? customers.get(row.data.customerId) ?? "" : "",
      slotId: slot.id, slotLabel: slot.data.label, slotKind: slot.data.kind, usage: row.data.usage,
      completed: false, role: slot.data.label, amountMinor: row.data.billing.amountMinor, currency: row.data.billing.currency, feePercent: "0",
    });
    // Old renew events prove the old/new due dates, but contain no historical prices or customer names.
    const firstSwitch = row.data.history.find(event => event.type === "switch");
    let oldSlotId = row.data.history.find(event => event.type === "join")?.toSlotId ?? firstSwitch?.fromSlotId ?? (!firstSwitch ? row.data.slotId : undefined);
    for (const event of row.data.history) {
      if (event.type === "join" && event.toSlotId) oldSlotId = event.toSlotId;
      if (event.type === "switch") oldSlotId = event.toSlotId;
      if (event.type !== "renew" || !event.periodStart || !event.periodEnd || !knownRenewalRange(event.periodStart, event.periodEnd) || dateNumber(event.date) === null) continue;
      const oldSlot = oldSlotId ? allSlots.get(oldSlotId) : undefined;
      const oldSubscription = oldSlot ? allSubscriptions.get(oldSlot.data.subscriptionId) : undefined;
      if (!oldSlot || !oldSubscription) continue;
      add({ ...common(oldSubscription.id, oldSubscription.data), kind: "rental", recordId: row.id, date: event.periodStart,
        account: oldSlot.data.account.trim() || oldSubscription.data.account.trim(), customerName: "",
        slotId: oldSlot.id, slotLabel: oldSlot.data.label, slotKind: oldSlot.data.kind,
        completed: true, completedAt: event.date, nextDueDate: event.periodEnd, historyCommandId: event.commandId, role: oldSlot.data.label }, 1);
    }
    for (const history of row.data.calendarHistory ?? []) historyEntry("rental", row.id, history);
  }
  const entries = [...occurrences.values()].map(row => row.entry);
  return entries.sort((a, b) => a.date.localeCompare(b.date) ||
    (a.kind === b.kind ? 0 : a.kind === "subscription" ? -1 : 1) || a.recordId.localeCompare(b.recordId));
}

export function filterRenewalCalendarEntries(entries: readonly RenewalCalendarEntry[], options: { month?: string; search?: string } = {}): RenewalCalendarEntry[] {
  const dates = options.month ? new Set(calendarDays(options.month)) : null;
  const terms = (options.search ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(entry => {
    if (dates && !dates.has(entry.date)) return false;
    const text = [entry.name, entry.service, entry.planName, entry.account, entry.customerName, entry.slotLabel, entry.role,
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

function knownRenewalRange(start: string, end: string): boolean {
  const from = dateNumber(start), to = dateNumber(end);
  return from !== null && to !== null && to > from;
}

/** Completion proves renewal, independently of the occurrence's date; it does not imply collection. */
export function renewalCalendarStatus(entry: Pick<RenewalCalendarEntry, "date" | "completed">, today: string, soonDays = 7): RenewalCalendarStatus {
  if (entry.completed) return "renewed";
  const due = dateNumber(entry.date), current = dateNumber(today);
  if (due === null || current === null) return "upcoming";
  if (due < current) return "overdue";
  if (due === current) return "due-today";
  if (Number.isSafeInteger(soonDays) && soonDays >= 0 && Number.isSafeInteger(current + soonDays) && due <= current + soonDays) return "due-soon";
  return "upcoming";
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
