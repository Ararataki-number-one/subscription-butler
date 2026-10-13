import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db-harness";
import { seedCurrencies } from "@/db/seed";
import { insertChannel } from "@/db/channels";
import { insertSpaceWithMother } from "@/db/spaces";
import { insertChildAccount } from "@/db/childAccounts";
import { motherAccount } from "@/db/schema";
import { OperationsStore } from "@/db/operations";
import type { CustomerData, LegacyLink, OperationsSnapshot, OpsKind, OpsRecord, RentalData, SlotData, SubscriptionData } from "../operations/types";
import { filterRenewalCalendarEntries, overdueRenewalEntries, renewalCalendarEntries, upcomingRenewalEntries } from "./renewal-calendar";

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
});
