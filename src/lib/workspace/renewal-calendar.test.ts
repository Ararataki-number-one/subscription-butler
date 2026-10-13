import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db-harness";
import { seedCurrencies } from "@/db/seed";
import { insertChannel } from "@/db/channels";
import { insertSpaceWithMother } from "@/db/spaces";
import { insertChildAccount } from "@/db/childAccounts";
import { motherAccount } from "@/db/schema";
import { OperationsStore } from "@/db/operations";
import type { CalendarRenewalEvent, CustomerData, LegacyLink, OperationsSnapshot, OpsKind, OpsRecord, RentalData, SlotData, SubscriptionData } from "../operations/types";
import { filterRenewalCalendarEntries, overdueRenewalEntries, renewalCalendarEntries, renewalCalendarOccurrenceKey, renewalCalendarStatus, upcomingRenewalEntries } from "./renewal-calendar";

const metadata = { tags: [], group: "", note: "" };
const period = { unit: "month", count: 1 } as const;
const record = <T>(id: string, kind: OpsKind, data: T): OpsRecord<T> => ({ id, kind, data, revision: 1, updatedAt: "2026-10-13T00:00:00Z" });
const legacy = (sources: string[], present = true): LegacyLink => ({ sources, present, fingerprint: "synthetic", managedFields: [] });
const subscription = (id: string, data: Partial<SubscriptionData> = {}) => record<SubscriptionData>(id, "subscription", {
  ...metadata, name: "Synthetic Business", service: "ChatGPT", planName: "Business", account: "synthetic-main", currency: "USD", amountMinor: 1000, feePercent: "0", period,
  startDate: "2026-10-01", endDate: "2026-10-25", status: "active", allocation: "fixed", ...data,
});
const slot = (id: string, subscriptionId: string, data: Partial<SlotData> = {}) => record<SlotData>(id, "slot", {
  ...metadata, subscriptionId, label: "子账号", account: "synthetic-child", kind: "child", weight: 1, status: "available", ...data,
});
const rental = (id: string, subscriptionId: string, slotId: string, data: Partial<RentalData> = {}) => record<RentalData>(id, "rental", {
  ...metadata, subscriptionId, slotId, customerId: "customer", usage: "rented", startDate: "2026-10-01", endDate: "2026-10-13", billing: { amountMinor: 1000, currency: "USD", period }, status: "active", periodVersion: 1,
  history: [{ type: "join", date: "2026-10-01", commandId: "synthetic", periodVersion: 1, toSlotId: slotId }], ...data,
});
const renewal = (kind: CalendarRenewalEvent["kind"], subscriptionId: string, data: Partial<CalendarRenewalEvent> = {}): CalendarRenewalEvent => ({
  kind, subscriptionId, dueDate: "2026-10-13", nextDueDate: "2026-11-13", completedAt: "2026-10-05T02:00:00Z", commandId: "synthetic-renewal",
  name: "Original service", service: "ChatGPT", planName: "Original plan", account: "original-account", customerName: kind === "rental" ? "Original customer" : "",
  role: kind === "subscription" ? "订阅续费" : "旧成员标签", amountMinor: 1800, currency: "USD", feePercent: kind === "subscription" ? "2.5" : "0", ...data,
});
function snapshot(): OperationsSnapshot {
  return { version: 1, changeSeq: 0, channels: [], customers: [record<CustomerData>("customer", "customer", { ...metadata, name: "Synthetic customer", contact: "", email: "", archived: false })],
    templates: [], plans: [], subscriptions: [], slots: [], rentals: [], bills: [], entries: [] };
}

describe("classic renewal calendar", () => {
  it("lists purchases and mother, child and Pro member terms with their real account and customer", () => {
    const value = snapshot();
    value.subscriptions = [subscription("business", { legacy: legacy(["space:11"]) }), subscription("pro", { name: "Synthetic Pro", planName: "Pro 20x", endDate: "2026-10-20" })];
    value.slots = [slot("mother", "business", { label: "母号", kind: "mother", account: "synthetic-mother" }), slot("child", "business"), slot("member", "pro", { label: "拼车成员", kind: "member", account: "synthetic-member" })];
    value.rentals = [rental("mother-term", "business", "mother"), rental("child-term", "business", "child", { endDate: "2026-10-14" }), rental("member-term", "pro", "member", { endDate: "2026-10-15" })];
    const before = structuredClone(value), entries = renewalCalendarEntries(value);
    expect(entries.map(row => row.recordId)).toEqual(["mother-term", "child-term", "member-term", "pro", "business"]);
    expect(entries[0]).toMatchObject({ kind: "rental", recordId: "mother-term", subRecordId: "business", date: "2026-10-13", name: "Synthetic Business", account: "synthetic-mother", customerName: "Synthetic customer", slotLabel: "母号", slotKind: "mother", sourceLegacySpaceId: 11 });
    expect(entries[1]).toMatchObject({ slotKind: "child", slotLabel: "子账号", account: "synthetic-child" });
    expect(entries[2]).toMatchObject({ slotKind: "member", slotLabel: "拼车成员", planName: "Pro 20x", account: "synthetic-member" });
    expect(entries[4]).toMatchObject({ kind: "subscription", recordId: "business", account: "synthetic-main", customerName: "" });
    expect(value).toEqual(before);
  });

  it("omits ended rentals, disabled inventories and missing or mismatched relationships without inventing slots", () => {
    const value = snapshot();
    value.subscriptions = [subscription("active"), subscription("disabled", { status: "disabled" }), subscription("empty-pro", { planName: "Pro 5x" })];
    value.slots = [slot("available", "active"), slot("disabled-slot", "active", { status: "disabled" }), slot("inactive-sub-slot", "disabled"), slot("missing-sub-slot", "missing")];
    value.rentals = [rental("ended", "active", "available", { status: "ended" }), rental("inactive-slot", "active", "disabled-slot"), rental("inactive-sub", "disabled", "inactive-sub-slot"),
      rental("missing-slot", "active", "absent"), rental("missing-sub", "missing", "missing-sub-slot"), rental("wrong-sub", "empty-pro", "available")];
    expect(renewalCalendarEntries(value).map(row => row.recordId)).toEqual(["active", "empty-pro"]);
  });

  it("falls back to the subscription login for an empty slot and retains self-use without a customer", () => {
    const value = snapshot(); value.subscriptions = [subscription("subscription")];
    value.slots = [slot("slot", "subscription", { account: "  " })];
    value.rentals = [rental("self-term", "subscription", "slot", { customerId: undefined, usage: "self" })];
    expect(renewalCalendarEntries(value)[0]).toMatchObject({ account: "synthetic-main", customerName: "", usage: "self" });
  });

  it("uses the existing legacy bridge's merged mother slot once and never adds a Pro mother term", () => {
    const context = createTestDb();
    try {
      seedCurrencies(context.db);
      const channelId = insertChannel(context.db, "Synthetic card").id;
      const create = (name: string, planType: "team" | "pro20x", email: string) => insertSpaceWithMother(context.db, { name, planType, country: "US", paymentChannelId: channelId, currencyCode: "USD", amountMinor: 1000, amountUsd: 1000, currentPeriodStartDate: "2026-10-01", openingDate: "2026-10-01", expiryDate: "2026-11-01", periodUnit: "month", periodCount: 1 }, email);
      const business = create("Synthetic legacy Business", "team", "synthetic-owner@example.invalid"), pro = create("Synthetic legacy Pro", "pro20x", "synthetic-pro-owner@example.invalid");
      context.db.update(motherAccount).set({ usageStatus: "rented", contact: "Synthetic mother customer", joinedDate: "2026-10-01", nextPaymentDate: "2026-10-18", expectedAmountMinor: 2000, expectedCurrencyCode: "USD" }).where(eq(motherAccount.spaceId, business.id)).run();
      const child = (spaceId: number, email: string) => insertChildAccount(context.db, { spaceId, email, usageStatus: "rented", contact: "Synthetic member", joinedDate: "2026-10-01", monthlyAmountMinor: 2000, monthlyCurrencyCode: "USD", monthlyRateUsed: "1", monthlyRateAsOf: "2026-10-01", monthlyRateSource: "synthetic", monthlyAmountUsd: 2000, monthlyPaymentDay: 18, nextPaymentDate: "2026-10-18" });
      child(business.id, "SYNTHETIC-OWNER@example.invalid"); child(pro.id, "synthetic-member@example.invalid");
      const projected = new OperationsStore(context.sqlite).snapshot(), entries = renewalCalendarEntries(projected);
      expect(projected.slots).toHaveLength(2);
      expect(projected.slots.find(row => row.data.kind === "mother")?.data.legacy?.sources).toHaveLength(2);
      expect(entries.filter(row => row.kind === "subscription")).toHaveLength(2);
      expect(entries.filter(row => row.kind === "rental")).toHaveLength(2);
      expect(entries.filter(row => row.slotKind === "mother")).toHaveLength(1);
      expect(entries.filter(row => row.subRecordId === `legacy:subscription:${pro.id}` && row.kind === "rental").map(row => row.slotKind)).toEqual(["member"]);
    } finally { context.sqlite.close(); }
  });

  it("exposes only an unambiguous present source ID and never infers a classic route from a record ID", () => {
    const value = snapshot(); value.subscriptions = [
      subscription("unique", { legacy: legacy(["space:3", "space:3", "other:5"]) }), subscription("ambiguous", { legacy: legacy(["space:3", "space:4"]) }),
      subscription("unsafe", { legacy: legacy(["space:9007199254740992"]) }), subscription("malformed", { legacy: legacy(["space:3", "space:0"]) }),
      subscription("removed", { legacy: legacy(["space:3"], false) }), subscription("legacy:subscription:9"),
    ];
    const entries = renewalCalendarEntries(value);
    expect(entries.find(row => row.recordId === "unique")?.sourceLegacySpaceId).toBe(3);
    expect(entries.filter(row => row.recordId !== "unique").every(row => row.sourceLegacySpaceId === undefined)).toBe(true);
  });

  it("filters a month and visible identity fields without modifying the source entries", () => {
    const value = snapshot(); value.subscriptions = [subscription("business", { endDate: "2026-11-01" })];
    value.slots = [slot("slot", "business", { label: "母号", kind: "mother", account: "MemberLogin" })];
    value.rentals = [rental("term", "business", "slot")];
    const entries = renewalCalendarEntries(value), before = structuredClone(entries);
    expect(filterRenewalCalendarEntries(entries, { month: "2026-10", search: "  MEMBERLOGIN 母号 customer  " }).map(row => row.recordId)).toEqual(["term"]);
    expect(filterRenewalCalendarEntries(entries, { month: "2026-11", search: "Business 订阅续费" }).map(row => row.recordId)).toEqual(["business"]);
    expect(filterRenewalCalendarEntries(entries, { month: "2026-13" })).toEqual([]);
    expect(filterRenewalCalendarEntries(entries, { search: "unmatched" })).toEqual([]);
    expect(filterRenewalCalendarEntries(entries)).toEqual(entries);
    expect(entries).toEqual(before);
  });

  it("keeps overdue dates separate and includes today through the seventh day across months", () => {
    const value = snapshot(); value.subscriptions = [subscription("previous", { endDate: "2026-10-30" }), subscription("today", { endDate: "2026-10-31" }), subscription("last", { endDate: "2026-11-07" }), subscription("later", { endDate: "2026-11-08" })];
    const entries = renewalCalendarEntries(value), before = structuredClone(entries);
    expect(overdueRenewalEntries(entries, "2026-10-31").map(row => row.recordId)).toEqual(["previous"]);
    expect(upcomingRenewalEntries(entries, "2026-10-31").map(row => row.recordId)).toEqual(["today", "last"]);
    expect(upcomingRenewalEntries(entries, "2026-10-31", 0).map(row => row.recordId)).toEqual(["today"]);
    expect(entries).toEqual(before);
  });

  it("handles leap days and rejects invalid dates or non-integer day windows", () => {
    const value = snapshot(); value.subscriptions = [subscription("leap", { endDate: "2028-02-29" }), subscription("march", { endDate: "2028-03-01" }), subscription("invalid", { endDate: "2028-02-30" })];
    const entries = renewalCalendarEntries(value);
    expect(upcomingRenewalEntries(entries, "2028-02-27", 2).map(row => row.recordId)).toEqual(["leap"]);
    expect(filterRenewalCalendarEntries(entries, { month: "2028-02" }).map(row => row.recordId)).toEqual(["leap"]);
    expect(overdueRenewalEntries(entries, "2028-03-01").map(row => row.recordId)).toEqual(["leap"]);
    for (const days of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(upcomingRenewalEntries(entries, "2028-02-27", days)).toEqual([]);
    expect(upcomingRenewalEntries(entries, "2028-02-30")).toEqual([]);
    expect(overdueRenewalEntries(entries, "not-a-date")).toEqual([]);
  });

  it("keeps completed subscription snapshots beside the next pending term after current identity and price edits", () => {
    const value = snapshot();
    value.subscriptions = [subscription("subscription", { name: "Edited service", account: "edited-account", amountMinor: 9900, currency: "CNY", feePercent: "8", endDate: "2026-11-13", calendarHistory: [renewal("subscription", "subscription")] })];
    const before = structuredClone(value), entries = renewalCalendarEntries(value);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ date: "2026-10-13", completed: true, name: "Original service", planName: "Original plan", account: "original-account", amountMinor: 1800, currency: "USD", feePercent: "2.5", role: "订阅续费", completedAt: "2026-10-05T02:00:00Z", nextDueDate: "2026-11-13", historyCommandId: "synthetic-renewal" });
    expect(entries[1]).toMatchObject({ date: "2026-11-13", completed: false, name: "Edited service", account: "edited-account", amountMinor: 9900, currency: "CNY", feePercent: "8" });
    expect(filterRenewalCalendarEntries(entries, { month: "2026-10", search: "original-account Original" })).toEqual([entries[0]]);
    expect(entries.map(renewalCalendarOccurrenceKey)).toEqual(["subscription:subscription:2026-10-13", "subscription:subscription:2026-11-13"]);
    expect(value).toEqual(before);
    value.subscriptions[0].data.status = "disabled";
    expect(renewalCalendarEntries(value)).toEqual([entries[0]]);
  });

  it("retains an original rental snapshot after switching parents and losing its old inventory", () => {
    const value = snapshot();
    value.subscriptions = [subscription("current-parent")];
    value.slots = [slot("current-slot", "current-parent", { account: "edited-account", label: "新位置", kind: "child" })];
    value.customers[0].data.name = "Edited customer";
    value.rentals = [rental("term", "current-parent", "current-slot", { endDate: "2026-11-13", calendarHistory: [renewal("rental", "original-parent", { slotId: "removed-slot", slotLabel: "原母号", slotKind: "mother", role: "原母号标签", usage: "rented", amountMinor: 3600, currency: "CNY" })] })];
    const entries = renewalCalendarEntries(value), historical = entries.find(entry => entry.completed)!;
    expect(historical).toMatchObject({ kind: "rental", recordId: "term", subRecordId: "original-parent", name: "Original service", account: "original-account", customerName: "Original customer", role: "原母号标签", slotKind: "mother", slotId: "removed-slot", amountMinor: 3600, currency: "CNY", feePercent: "0" });
    expect(entries.find(entry => entry.kind === "rental" && !entry.completed)).toMatchObject({ subRecordId: "current-parent", account: "edited-account", customerName: "Edited customer" });
    value.rentals[0].data.status = "ended";
    value.subscriptions[0].data.status = "disabled";
    value.slots = [];
    expect(renewalCalendarEntries(value)).toEqual([historical]);
  });

  it("merges repeated occurrence dates with explicit completion first and invents no pending next date", () => {
    const value = snapshot(); value.subscriptions = [subscription("subscription")]; value.slots = [slot("slot", "subscription")];
    const frozen = renewal("rental", "subscription");
    value.rentals = [rental("term", "subscription", "slot", { history: [
      { type: "join", date: "2026-10-01", commandId: "join", periodVersion: 1, toSlotId: "slot" },
      { type: "renew", date: "2026-10-05", commandId: "old-renew", periodVersion: 2, periodStart: "2026-10-13", periodEnd: "2026-11-13" },
    ], calendarHistory: [frozen, { ...frozen, commandId: "duplicate-renew", account: "duplicate-account" }] })];
    const entries = renewalCalendarEntries(value), occurrences = entries.filter(entry => entry.recordId === "term");
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ completed: true, date: "2026-10-13", historyCommandId: "synthetic-renewal", account: "original-account", amountMinor: 1800 });
    expect(entries.some(entry => entry.date === "2026-11-13")).toBe(false);
    expect(new Set(entries.map(renewalCalendarOccurrenceKey)).size).toBe(entries.length);
  });

  it("derives only stored old month-end terms and keeps consecutive early renewals beside the current term", () => {
    const value = snapshot(); value.subscriptions = [subscription("subscription")]; value.slots = [slot("slot", "subscription")];
    value.rentals = [rental("term", "subscription", "slot", { endDate: "2027-03-31", periodVersion: 3, history: [
      { type: "join", date: "2027-01-01", commandId: "legacy-join", periodVersion: 1 },
      { type: "renew", date: "2027-01-15", commandId: "early-one", periodVersion: 2, periodStart: "2027-01-31", periodEnd: "2027-02-28" },
      { type: "renew", date: "2027-01-15", commandId: "early-two", periodVersion: 3, periodStart: "2027-02-28", periodEnd: "2027-03-31" },
    ] })];
    const entries = renewalCalendarEntries(value).filter(entry => entry.kind === "rental");
    expect(entries.map(entry => [entry.date, entry.completed])).toEqual([["2027-01-31", true], ["2027-02-28", true], ["2027-03-31", false]]);
    expect(entries.slice(0, 2).map(entry => entry.completedAt)).toEqual(["2027-01-15", "2027-01-15"]);
    expect(entries.slice(0, 2).every(entry => entry.amountMinor === undefined && entry.currency === undefined && entry.feePercent === undefined)).toBe(true);
    expect(entries[1].nextDueDate).toBe("2027-03-31");
    expect(filterRenewalCalendarEntries(entries, { month: "2027-02" })).toEqual([entries[1]]);
    expect(entries[2].amountMinor).toBe(1000);
  });

  it("replays the original inventory at each old renewal and preserves completed terms after exit and disable", () => {
    const value = snapshot();
    value.subscriptions = [subscription("old-parent", { status: "disabled" }), subscription("new-parent")];
    value.slots = [slot("old-slot", "old-parent", { status: "disabled", account: "original-mother", kind: "mother", label: "原母号" }), slot("new-slot", "new-parent", { account: "new-child" })];
    value.rentals = [rental("term", "new-parent", "new-slot", { endDate: "2027-04-30", periodVersion: 3, history: [
      { type: "join", date: "2027-01-01", commandId: "legacy-join", periodVersion: 1 },
      { type: "renew", date: "2027-01-10", commandId: "old-parent-renew", periodVersion: 2, periodStart: "2027-02-28", periodEnd: "2027-03-31" },
      { type: "switch", date: "2027-01-15", commandId: "switch-parent", periodVersion: 2, fromSlotId: "old-slot", toSlotId: "new-slot" },
      { type: "renew", date: "2027-01-16", commandId: "new-parent-renew", periodVersion: 3, periodStart: "2027-03-31", periodEnd: "2027-04-30" },
    ] })];
    const historical = renewalCalendarEntries(value).filter(entry => entry.kind === "rental" && entry.completed);
    expect(historical[0]).toMatchObject({ date: "2027-02-28", subRecordId: "old-parent", slotId: "old-slot", account: "original-mother", slotKind: "mother" });
    expect(historical[1]).toMatchObject({ date: "2027-03-31", subRecordId: "new-parent", slotId: "new-slot", account: "new-child" });
    value.rentals[0].data.status = "ended";
    value.subscriptions[1].data.status = "disabled";
    value.slots[1].data.status = "disabled";
    expect(renewalCalendarEntries(value)).toEqual(historical);
  });

  it("does not guess completed terms from manual date edits or incomplete old renewal records", () => {
    const value = snapshot(); value.subscriptions = [subscription("subscription", { endDate: "2026-12-25" })]; value.slots = [slot("slot", "subscription")];
    value.rentals = [rental("term", "subscription", "slot", { endDate: "2027-01-13", history: [
      { type: "join", date: "2026-10-01", commandId: "join", periodVersion: 1, toSlotId: "slot" },
      { type: "renew", date: "2026-10-05", commandId: "missing-range", periodVersion: 2 },
      { type: "renew", date: "2026-10-05", commandId: "invalid-date", periodVersion: 3, periodStart: "2026-02-30", periodEnd: "2026-03-31" },
      { type: "renew", date: "2026-10-05", commandId: "empty-range", periodVersion: 4, periodStart: "2026-10-13", periodEnd: "2026-10-13" },
    ] })];
    const entries = renewalCalendarEntries(value);
    expect(entries.map(entry => entry.date)).toEqual(["2026-12-25", "2027-01-13"]);
    expect(entries.every(entry => !entry.completed)).toBe(true);
  });

  it("does not attribute an old renewal to the current parent when its historical slot is missing", () => {
    const value = snapshot(); value.subscriptions = [subscription("current-parent")]; value.slots = [slot("current-slot", "current-parent")];
    value.rentals = [rental("term", "current-parent", "current-slot", { endDate: "2026-11-13", history: [
      { type: "join", date: "2026-10-01", commandId: "join", periodVersion: 1, toSlotId: "removed-slot" },
      { type: "renew", date: "2026-10-05", commandId: "old-renew", periodVersion: 2, periodStart: "2026-10-13", periodEnd: "2026-11-13" },
      { type: "switch", date: "2026-10-06", commandId: "switch", periodVersion: 2, fromSlotId: "removed-slot", toSlotId: "current-slot" },
    ] })];
    const entries = renewalCalendarEntries(value);
    expect(entries.filter(entry => entry.kind === "rental")).toMatchObject([{ completed: false, date: "2026-11-13", subRecordId: "current-parent" }]);
    expect(entries.some(entry => entry.completed)).toBe(false);
  });

  it.each([
    { date: "2026-10-30", completed: false, expected: "overdue" },
    { date: "2026-10-31", completed: false, expected: "due-today" },
    { date: "2026-11-07", completed: false, expected: "due-soon" },
    { date: "2026-11-08", completed: false, expected: "upcoming" },
    { date: "2026-10-01", completed: true, expected: "renewed" },
    { date: "2027-01-01", completed: true, expected: "renewed" },
  ])("classifies $date completed=$completed as $expected independently of past due dates", ({ date, completed, expected }) => {
    expect(renewalCalendarStatus({ date, completed }, "2026-10-31")).toBe(expected);
  });

  it("keeps unverified dates neutral and permits a today-only upcoming window", () => {
    expect(renewalCalendarStatus({ date: "2026-11-01", completed: false }, "2026-10-31", 0)).toBe("upcoming");
    expect(renewalCalendarStatus({ date: "2026-10-31", completed: false }, "2026-10-31", 0)).toBe("due-today");
    expect(renewalCalendarStatus({ date: "2026-02-30", completed: false }, "2026-10-31")).toBe("upcoming");
    expect(renewalCalendarStatus({ date: "2026-10-01", completed: false }, "invalid")).toBe("upcoming");
    expect(renewalCalendarStatus({ date: "2026-11-01", completed: false }, "2026-10-31", NaN)).toBe("upcoming");
    expect(renewalCalendarStatus({ date: "2026-10-01", completed: true }, "invalid")).toBe("renewed");
  });
});
