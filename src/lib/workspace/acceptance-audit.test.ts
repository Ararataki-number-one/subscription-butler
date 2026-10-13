import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@/test/db-harness";
import { seedCurrencies } from "@/db/seed";
import { upsertRates } from "@/db/fxRates";
import { OperationsStore } from "@/db/operations";
import { allocateCostToRentals } from "@/lib/operations/report";
import type { BillData, EntryData, OpsRecord } from "@/lib/operations/types";

describe("independent financial acceptance audit", () => {
  let context: ReturnType<typeof createTestDb>;
  let store: OperationsStore;
  let sequence = 0;
  const run = (type: string, payload: Record<string, unknown>) => store.execute({ id: `independent-${++sequence}`, type, payload });
  beforeEach(() => {
    context = createTestDb(); seedCurrencies(context.db); store = new OperationsStore(context.sqlite); sequence = 0;
    upsertRates(context.db, [
      { currencyCode: "USD", rateToUsd: "1", quoteDate: "2026-10-13", fetchedAt: "2026-10-13T00:00:00Z", source: "synthetic-audit" },
      { currencyCode: "CNY", rateToUsd: "0.2", quoteDate: "2026-10-13", fetchedAt: "2026-10-13T00:00:00Z", source: "synthetic-audit" },
    ]);
  });
  afterEach(() => context.sqlite.close());
  function rented(capacity = 1) {
    run("customer.save", { name: "Synthetic customer" });
    run("subscription.save", { name: "Synthetic subscription", service: "Fixture service", currency: "USD", amountMinor: 10000, period: { unit: "month", count: 1 }, startDate: "2026-01-01", capacity, allocation: "fixed" });
    const initial = store.snapshot();
    run("rental.join", { slotId: initial.slots[0].id, customerId: initial.customers[0].id, usage: "rented", startDate: "2026-01-01", amountMinor: 12000, currency: "USD", period: { unit: "month", count: 1 } });
    const snapshot = store.snapshot();
    return { customer: snapshot.customers[0], subscription: snapshot.subscriptions[0], slots: snapshot.slots, rental: snapshot.rentals[0], bill: snapshot.bills[0] };
  }
  function replica(record: OpsRecord<BillData> | OpsRecord<EntryData>, id: string, data: BillData | EntryData, expectedRevision = 0) {
    return store.applyReplica({ id: `audit-replica-${++sequence}`, reason: "synthetic acceptance audit", records: [{ id, kind: record.kind, data, expectedRevision }] });
  }
  it("rejects caller-supplied legacy metadata as a bypass for frozen monetary equality", () => {
    const { bill } = rented();
    const forged = { ...bill.data, usdMinor: bill.data.usdMinor + 100000,
      legacy: { sources: ["synthetic:source"], fingerprint: "synthetic", managedFields: [], present: true } };
    expect(() => replica(bill, "audit-new-forged-bill", forged)).toThrow();
  });
  it("cannot void a paid bill through replica while command-path void would require refund", () => {
    const { bill } = rented(); run("entry.receive", { billId: bill.id, amountMinor: bill.data.amountMinor, currency: "USD", date: "2026-01-02" });
    expect(() => replica(bill, bill.id, { ...bill.data, status: "void", reason: "synthetic void" }, bill.revision)).toThrow();
  });
  it("ties replicated refund bill application proportionally to the native refunded amount", () => {
    const { bill } = rented(); run("entry.receive", { billId: bill.id, amountMinor: bill.data.amountMinor, currency: "USD", date: "2026-01-02" });
    const source = store.snapshot().entries.find(row => row.data.type === "receipt")!;
    run("entry.refund", { sourceEntryId: source.id, amountMinor: 1, date: "2026-01-03", reason: "synthetic partial refund" });
    const refund = store.snapshot().entries.find(row => row.data.type === "refund")!;
    expect(() => replica(refund, "audit-inflated-applied-refund", { ...refund.data, appliedMinor: bill.data.amountMinor - 1 })).toThrow();
  });
  it("cannot attribute a replicated unallocated refund to a different subscription than its source", () => {
    const fixture = rented();
    run("subscription.save", { name: "Another synthetic subscription", service: "Fixture service", currency: "USD", amountMinor: 1000, period: { unit: "month", count: 1 }, startDate: "2026-01-01" });
    const other = store.snapshot().subscriptions.find(row => row.id !== fixture.subscription.id)!;
    run("entry.receive", { subscriptionId: fixture.subscription.id, amountMinor: 100, currency: "USD", date: "2026-01-02" });
    const source = store.snapshot().entries.find(row => !row.data.billId && row.data.type === "receipt")!;
    run("entry.refund", { sourceEntryId: source.id, amountMinor: 1, date: "2026-01-03", reason: "synthetic refund" });
    const refund = store.snapshot().entries.find(row => row.data.type === "refund")!;
    expect(() => replica(refund, "audit-wrong-subscription-refund", { ...refund.data, subscriptionId: other.id })).toThrow();
  });
  it("customer estimated net includes the customer's subscription cost share", () => {
    const fixture = rented(); const report = store.report({ customerId: fixture.customer.id });
    expect(report.estimates.incomeUsd).toBe(12000);
    expect(report.estimates.costUsd).toBe(10000);
    expect(report.estimates.netUsd).toBe(2000);
  });
  it("switching weighted positions preserves the pre-switch cost allocation interval", () => {
    const fixture = rented(2);
    run("slot.save", { id: fixture.slots[1].id, expectedRevision: fixture.slots[1].revision, weight: 3 });
    run("entry.cost", { subscriptionId: fixture.subscription.id, amountMinor: 3100, currency: "USD", date: "2026-01-01", periodStart: "2026-01-01", periodEnd: "2026-02-01" });
    const cost = store.snapshot().entries.find(row => row.data.type === "cost")!;
    run("rental.switch", { id: fixture.rental.id, expectedRevision: fixture.rental.revision, toSlotId: fixture.slots[1].id, date: "2026-01-16", reason: "synthetic weighted switch" });
    const allocation = allocateCostToRentals(store.snapshot(), cost.id);
    expect(allocation.rentals.find(row => row.rentalId === fixture.rental.id)?.usdMinor).toBe(1575);
    expect(allocation.unallocatedUsd).toBe(1525);
  });
  it("a switched rental still prevents another customer occupying its historical source slot interval", () => {
    const fixture = rented(2);
    run("rental.switch", { id: fixture.rental.id, expectedRevision: fixture.rental.revision, toSlotId: fixture.slots[1].id, date: "2026-01-16", reason: "synthetic switch" });
    expect(() => run("rental.join", { slotId: fixture.slots[0].id, customerId: fixture.customer.id, usage: "rented", startDate: "2026-01-10", amountMinor: 1000, currency: "USD", period: { unit: "day", count: 3 } })).toThrow();
  });
});
