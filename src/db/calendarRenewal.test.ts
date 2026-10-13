import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db-harness";
import { seedCurrencies } from "./seed";
import { insertChannel } from "./channels";
import { insertSpaceWithMother } from "./spaces";
import { insertChildAccount } from "./childAccounts";
import { childAccount, motherAccount, space } from "./schema";
import { OperationsStore } from "./operations";
import type { OpsRecord, RentalData, SubscriptionData } from "@/lib/operations/types";

describe("confirmed calendar renewals", () => {
  let context: ReturnType<typeof createTestDb>, store: OperationsStore, sequence: number;
  const run = (type: string, payload: Record<string, unknown>, id = `calendar-test-${++sequence}`) => store.execute({ id, type, payload });
  const confirm = (record: OpsRecord<SubscriptionData | RentalData>, id?: string) => run("calendar.renew", { kind: record.kind, id: record.id, dueDate: record.data.endDate, expectedRevision: record.revision }, id);
  beforeEach(() => {
    context = createTestDb(); seedCurrencies(context.db); store = new OperationsStore(context.sqlite); sequence = 0;
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-13T04:00:00Z"));
  });
  afterEach(() => { vi.useRealTimers(); context.sqlite.close(); });
  function native() {
    run("customer.save", { id: "customer", name: "Synthetic customer" });
    run("subscription.save", { id: "subscription", name: "Synthetic service", service: "Any SaaS", account: "synthetic-main", currency: "USD", amountMinor: 1000, feePercent: "2", startDate: "2026-01-31", period: { unit: "month", count: 1 }, capacity: 2 });
    return store.snapshot();
  }
  function legacy(planType: "team" | "pro20x" = "team", motherUsage: "rented" | null = "rented", motherDate: string | null = "2026-02-01") {
    const channelId = insertChannel(context.db, "Synthetic legacy card").id;
    const subscription = insertSpaceWithMother(context.db, { name: "Synthetic legacy service", planType, country: "US", paymentChannelId: channelId, currencyCode: "USD", amountMinor: 1000, amountUsd: 1000, feePercent: "2", periodUnit: "month", periodCount: 1, openingDate: "2026-01-01", currentPeriodStartDate: "2026-01-01", expiryDate: "2026-02-01" }, "synthetic-owner@example.invalid");
    context.db.update(motherAccount).set({ usageStatus: motherUsage, contact: "Synthetic mother", joinedDate: "2026-01-01", nextPaymentDate: motherDate, expectedAmountMinor: 2000, expectedCurrencyCode: "USD" }).where(eq(motherAccount.spaceId, subscription.id)).run();
    return subscription;
  }
  function child(spaceId: number, email = "synthetic-child@example.invalid", nextPaymentDate = "2026-02-01") {
    return insertChildAccount(context.db, { spaceId, email, usageStatus: "rented", contact: "Synthetic child", joinedDate: "2026-01-01", monthlyAmountMinor: 3000, monthlyCurrencyCode: "USD", monthlyRateUsed: "1", monthlyRateAsOf: "2026-01-01", monthlyRateSource: "synthetic", monthlyAmountUsd: 3000, monthlyPaymentDay: 1, nextPaymentDate });
  }
  const sourceDates = () => ({ spaces: context.sqlite.prepare("SELECT id,current_period_start_date,expiry_date FROM space ORDER BY id").all(), mothers: context.sqlite.prepare("SELECT id,next_payment_date FROM mother_account ORDER BY id").all(), children: context.sqlite.prepare("SELECT id,next_payment_date FROM child_account ORDER BY id").all() });

  it("keeps classic subscription price and period updates live while renewal snapshots remain immutable", () => {
    const source = legacy();
    const prior = store.snapshot().subscriptions[0];
    const renewed = confirm(prior).snapshot.subscriptions[0];
    const history = structuredClone(renewed.data.calendarHistory);
    const cost = structuredClone(store.snapshot().entries[0]);
    context.db.update(space).set({ amountMinor: 2000, feePercent: "3", periodCount: 2, expiryDate: "2026-04-01" }).where(eq(space.id, source.id)).run();
    const updated = store.snapshot().subscriptions[0];
    expect(updated.data).toMatchObject({ amountMinor: 2000, feePercent: "3", period: { unit: "month", count: 2 }, endDate: "2026-04-01" });
    expect(updated.data.calendarHistory).toEqual(history);
    expect(store.snapshot().entries[0]).toEqual(cost);
    run("subscription.save", { id: updated.id, expectedRevision: updated.revision, amountMinor: 9000 });
    context.db.update(space).set({ amountMinor: 3000 }).where(eq(space.id, source.id)).run();
    expect(store.snapshot().subscriptions[0].data.amountMinor).toBe(9000);
  });

  it("keeps classic rental pricing, identity and disable updates live without losing renewal history", () => {
    const source = legacy(), member = child(source.id);
    const prior = store.snapshot().rentals.find(row => row.data.slotId.endsWith(`child:${member.id}`))!;
    const renewed = confirm(prior).snapshot.rentals.find(row => row.id === prior.id)!;
    const history = structuredClone(renewed.data.calendarHistory);
    const bill = structuredClone(store.snapshot().bills.find(row => row.data.rentalId === renewed.id));
    context.db.update(childAccount).set({ monthlyAmountMinor: 5000, contact: "Changed classic contact" }).where(eq(childAccount.id, member.id)).run();
    const updated = store.snapshot(), rental = updated.rentals.find(row => row.id === renewed.id)!;
    expect(rental.data.billing.amountMinor).toBe(5000);
    expect(updated.customers.find(row => row.id === rental.data.customerId)?.data.name).toBe("Changed classic contact");
    expect(rental.data.periodVersion).toBe(2);
    expect(rental.data.history.filter(event => event.type === "renew")).toHaveLength(1);
    expect(rental.data.calendarHistory).toEqual(history);
    expect(updated.bills.find(row => row.data.rentalId === rental.id)).toEqual(bill);
    context.db.update(childAccount).set({ usageStatus: "disabled" }).where(eq(childAccount.id, member.id)).run();
    const disabled = store.snapshot();
    expect(disabled.slots.find(row => row.id === rental.data.slotId)?.data.status).toBe("disabled");
    expect(disabled.rentals.find(row => row.id === rental.id)?.data.status).toBe("ended");
    expect(disabled.rentals.find(row => row.id === rental.id)?.data.calendarHistory).toEqual(history);
  });

  it("advances one original anchored period, records the old date and cost, and rejects stale or repeated occurrences", () => {
    const record = native().subscriptions[0];
    const one = confirm(record, "confirmed-once"), two = confirm(record, "confirmed-once");
    expect(two.replayed).toBe(true);
    const renewed = one.snapshot.subscriptions[0];
    expect(renewed.data.endDate).toBe("2026-03-31");
    expect(renewed.data.calendarHistory).toEqual([expect.objectContaining({ kind: "subscription", subscriptionId: record.id, dueDate: "2026-02-28", nextDueDate: "2026-03-31", commandId: "confirmed-once", completedAt: "2026-10-13T04:00:00.000Z", account: "synthetic-main", name: "Synthetic service", amountMinor: 1000, currency: "USD", feePercent: "2" })]);
    expect(one.snapshot.entries).toHaveLength(1); expect(one.snapshot.entries[0].data.type).toBe("cost"); expect(one.snapshot.entries[0].data.totalMinor).toBe(1020);
    const before = store.snapshot();
    expect(() => confirm(record, "different-click")).toThrow(/版本/);
    expect(() => run("calendar.renew", { kind: "subscription", id: renewed.id, expectedRevision: renewed.revision, dueDate: record.data.endDate })).toThrow(/已.*续费|已变化/);
    expect(store.snapshot()).toEqual(before);
    run("subscription.save", { id: renewed.id, expectedRevision: renewed.revision, name: "Renamed after confirmation", account: "changed-login", amountMinor: 9000 });
    expect(store.snapshot().subscriptions[0].data.calendarHistory).toEqual(renewed.data.calendarHistory);
  });

  it("renews rental billing without a receipt and preserves the historical subscription after a switch", () => {
    const fixture = native(), slot = fixture.slots[0];
    run("slot.save", { id: slot.id, expectedRevision: slot.revision, kind: "mother", label: "母号", account: "synthetic-mother" });
    run("rental.join", { slotId: slot.id, customerId: "customer", startDate: "2026-01-01", currency: "USD", amountMinor: 2000 });
    const rental = store.snapshot().rentals[0], result = confirm(rental);
    expect(result.snapshot.entries).toEqual([]); expect(result.snapshot.bills).toHaveLength(2);
    const renewed = result.snapshot.rentals[0], history = renewed.data.calendarHistory![0];
    expect(history).toMatchObject({ kind: "rental", subscriptionId: "subscription", customerName: "Synthetic customer", account: "synthetic-mother", role: "母号", slotKind: "mother", amountMinor: 2000, currency: "USD", feePercent: "0" });
    run("subscription.save", { id: "other-subscription", name: "Synthetic new subscription", currency: "USD", startDate: "2026-01-01", capacity: 1 });
    const target = store.snapshot().slots.find(row => row.data.subscriptionId === "other-subscription")!;
    run("rental.switch", { id: renewed.id, expectedRevision: renewed.revision, toSlotId: target.id, date: "2026-01-15", reason: "Synthetic switch" });
    const switched = store.snapshot().rentals[0];
    expect(switched.data.subscriptionId).toBe("other-subscription"); expect(switched.data.calendarHistory![0]).toEqual(history);
  });

  it("projects only subscription dates and keeps later classic edits visible without rewriting confirmed history", () => {
    const source = legacy(), record = store.snapshot().subscriptions[0];
    const beforeSource = context.sqlite.prepare("SELECT * FROM space WHERE id=?").get(source.id) as Record<string, unknown>;
    const renewed = confirm(record).snapshot.subscriptions[0];
    const afterSource = context.sqlite.prepare("SELECT * FROM space WHERE id=?").get(source.id) as Record<string, unknown>;
    expect(afterSource).toEqual({ ...beforeSource, current_period_start_date: "2026-02-01", expiry_date: "2026-03-01" });
    expect(store.snapshot().subscriptions[0].revision).toBe(renewed.revision);
    context.db.update(space).set({ expiryDate: "2026-04-01" }).where(eq(space.id, source.id)).run();
    const refreshed = store.snapshot().subscriptions[0];
    expect(refreshed.data.endDate).toBe("2026-04-01"); expect(refreshed.data.calendarHistory).toEqual(renewed.data.calendarHistory);
    expect(refreshed.data.legacy!.managedFields).toEqual(expect.arrayContaining(["startDate", "endDate"]));
    expect(refreshed.data.legacy!.managedFields).not.toContain("calendarHistory");
  });

  it.each(["period", "anchor"] as const)("refuses a subscription with the same due date but a different %s", difference => {
    legacy(); const original = store.snapshot().subscriptions[0];
    run("subscription.save", { id: original.id, expectedRevision: original.revision, ...(difference === "period" ? { period: { unit: "day", count: 31 } } : { cycleAnchorDay: 2 }) });
    const changed = store.snapshot().subscriptions[0];
    expect(changed.data.endDate).toBe(original.data.endDate);
    const before = store.snapshot(), dates = sourceDates();
    expect(() => confirm(changed, "incompatible-subscription")).toThrow(/周期或锚点/);
    expect(sourceDates()).toEqual(dates); expect(store.snapshot()).toEqual(before);
    expect(context.sqlite.prepare("SELECT id FROM ops_command WHERE id='incompatible-subscription'").get()).toBeUndefined();
    expect(store.snapshot().entries).toEqual([]);
  });

  it.each(["period", "anchor"] as const)("refuses a changed rental %s even after the classic due date is aligned", difference => {
    const source = legacy(), original = store.snapshot().rentals[0];
    run("rental.renew", { id: original.id, expectedRevision: original.revision, expectedPeriod: original.data.periodVersion, ...(difference === "period" ? { period: { unit: "day", count: 28 } } : {}) });
    context.db.update(motherAccount).set({ nextPaymentDate: "2026-03-01", ...(difference === "anchor" ? { monthlyPaymentDay: 2 } : {}) }).where(eq(motherAccount.spaceId, source.id)).run();
    const changed = store.snapshot().rentals[0]; expect(changed.data.endDate).toBe("2026-03-01");
    const before = store.snapshot(), dates = sourceDates();
    expect(() => confirm(changed, "incompatible-rental")).toThrow(/周期或锚点/);
    expect(sourceDates()).toEqual(dates); expect(store.snapshot()).toEqual(before);
    expect(before.bills).toHaveLength(1); expect(before.rentals[0].data.calendarHistory).toHaveLength(1); expect(before.entries).toEqual([]);
  });

  it("keeps compatible monthly source anchors through February and consecutive confirmed periods", () => {
    const source = legacy();
    context.db.update(space).set({ openingDate: "2026-01-31", currentPeriodStartDate: "2026-01-31", expiryDate: "2026-02-28" }).where(eq(space.id, source.id)).run();
    let subscription = store.snapshot().subscriptions[0];
    subscription = confirm(subscription).snapshot.subscriptions[0]; expect(subscription.data.endDate).toBe("2026-03-31");
    subscription = confirm(subscription).snapshot.subscriptions[0]; expect(subscription.data.endDate).toBe("2026-04-30");
    expect(subscription.data.cycleAnchorDay).toBe(31);
    expect(context.sqlite.prepare("SELECT current_period_start_date,expiry_date,period_unit,period_count FROM space WHERE id=?").get(source.id)).toEqual({ current_period_start_date: "2026-03-31", expiry_date: "2026-04-30", period_unit: "month", period_count: 1 });
    expect(store.snapshot().subscriptions[0].revision).toBe(subscription.revision);
    expect(subscription.data.calendarHistory?.map(event => [event.dueDate, event.nextDueDate])).toEqual([["2026-02-28", "2026-03-31"], ["2026-03-31", "2026-04-30"]]);
  });

  it.each([
    { usage: "rented" as const, motherDate: "2026-02-01", aliasDate: "2026-04-01" },
    { usage: null, motherDate: null, aliasDate: "2026-02-01" },
  ])("renews a merged mother account once even when unused alias dates differ ($usage)", ({ usage, motherDate, aliasDate }) => {
    const source = legacy("team", usage, motherDate), duplicate = child(source.id, "SYNTHETIC-OWNER@example.invalid", aliasDate);
    const before = store.snapshot(); expect(before.rentals).toHaveLength(1); expect(before.slots).toHaveLength(1);
    const renewed = confirm(before.rentals[0]).snapshot;
    expect(renewed.rentals[0].data.endDate).toBe("2026-03-01"); expect(renewed.rentals[0].data.calendarHistory).toHaveLength(1);
    expect(renewed.bills).toHaveLength(1); expect(renewed.entries).toEqual([]);
    expect(context.sqlite.prepare("SELECT next_payment_date FROM mother_account WHERE space_id=?").get(source.id)).toEqual({ next_payment_date: "2026-03-01" });
    expect(context.sqlite.prepare("SELECT next_payment_date FROM child_account WHERE id=?").get(duplicate.id)).toEqual({ next_payment_date: "2026-03-01" });
    expect(store.snapshot().rentals[0].revision).toBe(renewed.rentals[0].revision);
    context.db.update(motherAccount).set({ nextPaymentDate: "2026-04-01" }).where(eq(motherAccount.spaceId, source.id)).run();
    if (usage === null) context.db.update(childAccount).set({ nextPaymentDate: "2026-04-01" }).where(eq(childAccount.id, duplicate.id)).run();
    expect(store.snapshot().rentals[0].data.endDate).toBe("2026-04-01");
    expect(store.snapshot().rentals[0].data.calendarHistory).toEqual(renewed.rentals[0].data.calendarHistory);
  });

  it("projects Business child and Pro member dates without manufacturing a Pro mother renewal or payment", () => {
    const business = legacy(), pro = legacy("pro20x"), businessChild = child(business.id), proChild = child(pro.id, "synthetic-pro-member@example.invalid");
    const initial = store.snapshot();
    for (const row of initial.rentals.filter(row => initial.slots.find(slot => slot.id === row.data.slotId)!.data.kind !== "mother")) confirm(row);
    const after = store.snapshot();
    expect(context.sqlite.prepare("SELECT next_payment_date FROM child_account WHERE id IN (?,?) ORDER BY id").all(businessChild.id, proChild.id)).toEqual([{ next_payment_date: "2026-03-01" }, { next_payment_date: "2026-03-01" }]);
    expect(after.rentals.filter(row => row.data.subscriptionId === `legacy:subscription:${pro.id}`)).toHaveLength(1);
    expect(after.rentals.find(row => row.data.subscriptionId === `legacy:subscription:${pro.id}`)!.data.calendarHistory![0].slotKind).toBe("member");
    expect(context.sqlite.prepare("SELECT next_payment_date FROM mother_account WHERE space_id=?").get(pro.id)).toEqual({ next_payment_date: "2026-02-01" });
    expect(after.bills).toHaveLength(2); expect(after.entries).toEqual([]);
  });

  it("ordinary renewal commands record snapshots while retaining their previous no-legacy-write behavior", () => {
    legacy(); const initial = store.snapshot(), dates = sourceDates();
    run("subscription.renew", { id: initial.subscriptions[0].id, expectedRevision: initial.subscriptions[0].revision });
    const rental = store.snapshot().rentals[0]; run("rental.renew", { id: rental.id, expectedRevision: rental.revision, expectedPeriod: rental.data.periodVersion });
    const after = store.snapshot(); expect(sourceDates()).toEqual(dates);
    expect(after.subscriptions[0].data.calendarHistory).toHaveLength(1); expect(after.rentals[0].data.calendarHistory).toHaveLength(1);
  });

  it("never projects unowned replicated sources or guesses a classic row from a stable record ID", () => {
    legacy(); const original = store.snapshot().subscriptions[0], dates = sourceDates();
    store.applyReplica({ id: "synthetic-remote", records: [{ ...original, expectedRevision: original.revision, sourceRevision: original.revision, data: { ...original.data, name: "Remote canonical service" } }] });
    const record = store.snapshot().subscriptions[0]; confirm(record);
    expect(sourceDates()).toEqual(dates); expect(store.snapshot().subscriptions[0].data.calendarHistory).toHaveLength(1);
  });

  it("refuses a forged owned source namespace and mismatched aliases without touching another account", () => {
    const source = legacy(), duplicate = child(source.id, "SYNTHETIC-OWNER@example.invalid");
    let rental = store.snapshot().rentals[0];
    const forged = { ...rental.data, legacy: { ...rental.data.legacy!, sources: ["mother_account:999999"] } };
    context.sqlite.prepare("UPDATE ops_record SET data=? WHERE id=?").run(JSON.stringify(forged), rental.id);
    const dates = sourceDates();
    expect(() => confirm({ ...rental, data: forged })).toThrow(/来源/); expect(sourceDates()).toEqual(dates);
    context.sqlite.prepare("UPDATE ops_record SET data=? WHERE id=?").run(JSON.stringify(rental.data), rental.id);
    context.db.update(childAccount).set({ email: "unrelated-account@example.invalid" }).where(eq(childAccount.id, duplicate.id)).run();
    rental = store.snapshot().rentals.find(row => row.id === rental.id)!;
    const unrelatedAlias = { ...rental.data, legacy: { ...rental.data.legacy!, sources: [rental.data.legacy!.sources[0], `child_account:${duplicate.id}`] } };
    context.sqlite.prepare("UPDATE ops_record SET data=? WHERE id=?").run(JSON.stringify(unrelatedAlias), rental.id);
    expect(() => confirm({ ...rental, data: unrelatedAlias })).toThrow(/来源/); expect(sourceDates()).toEqual(dates);
  });

  it.each(["different-space", "different-email"] as const)("rejects a %s merged source before changing any legacy date", mismatch => {
    const source = legacy();
    let member;
    if (mismatch === "different-space") member = child(legacy().id, "SYNTHETIC-OWNER@example.invalid");
    else {
      member = child(source.id, "unrelated-account@example.invalid");
      context.db.update(childAccount).set({ isMotherAccount: true }).where(eq(childAccount.id, member.id)).run();
    }
    let rental = store.snapshot().rentals.find(row => row.data.subscriptionId === `legacy:subscription:${source.id}`)!;
    if (mismatch === "different-space") {
      const data = { ...rental.data, legacy: { ...rental.data.legacy!, sources: [...rental.data.legacy!.sources, `child_account:${member.id}`] } };
      context.sqlite.prepare("UPDATE ops_record SET data=? WHERE id=?").run(JSON.stringify(data), rental.id); rental = { ...rental, data };
    }
    const dates = sourceDates();
    expect(() => confirm(rental)).toThrow(/来源/);
    expect(sourceDates()).toEqual(dates);
    expect(store.snapshot().bills).toEqual([]); expect(store.snapshot().entries).toEqual([]);
  });

  it.each(["cost", "merged-alias"] as const)("rolls source dates, history and ledger back together on a %s failure", failure => {
    const source = legacy(); if (failure === "merged-alias") child(source.id, "SYNTHETIC-OWNER@example.invalid");
    const before = store.snapshot(), dates = sourceDates();
    const record = failure === "cost" ? before.subscriptions[0] : before.rentals[0];
    if (failure === "cost") context.sqlite.exec("CREATE TRIGGER synthetic_calendar_failure BEFORE INSERT ON ops_record WHEN NEW.kind='entry' BEGIN SELECT RAISE(ABORT,'synthetic cost failure'); END");
    else context.sqlite.exec("CREATE TRIGGER synthetic_calendar_failure BEFORE UPDATE OF next_payment_date ON child_account BEGIN SELECT RAISE(ABORT,'synthetic alias failure'); END");
    expect(() => confirm(record, "must-rollback")).toThrow(/synthetic/);
    expect(sourceDates()).toEqual(dates); expect(store.snapshot()).toEqual(before);
    expect(context.sqlite.prepare("SELECT id FROM ops_command WHERE id='must-rollback'").get()).toBeUndefined();
  });

  it("rejects history tampering and invalid replicated history while allowing older records without the optional field", () => {
    const record = native().subscriptions[0]; expect(record.data.calendarHistory).toBeUndefined();
    const renewed = confirm(record).snapshot.subscriptions[0], event = renewed.data.calendarHistory![0];
    expect(() => run("subscription.save", { id: renewed.id, expectedRevision: renewed.revision, calendarHistory: [] })).toThrow(/历史/);
    const replica = (history: SubscriptionData["calendarHistory"]) => store.applyReplica({ id: `replica-test-${++sequence}`, records: [{ ...renewed, expectedRevision: renewed.revision, data: { ...renewed.data, calendarHistory: history } }] });
    expect(() => replica([])).toThrow(/历史/);
    expect(() => replica([{ ...event, account: "tampered-login" }])).toThrow(/历史/);
    expect(() => replica([{ ...event, nextDueDate: event.dueDate }])).toThrow(/历史/);
    expect(() => replica([{ ...event, completedAt: "not-a-time" }])).toThrow(/格式/);
    expect(store.snapshot().subscriptions[0]).toEqual(renewed);
  });

  it("keeps renewal snapshots out of customer snapshots and change logs and denies customer or read-only renewals", () => {
    const initial = native(), event = confirm(initial.subscriptions[0]).snapshot.subscriptions[0].data.calendarHistory![0];
    const subscription = store.snapshot().subscriptions[0];
    for (const role of ["customer", "read-only"] as const) expect(() => store.execute({ id: `forbidden-${role}`, type: "calendar.renew", payload: { kind: "subscription", id: subscription.id, dueDate: subscription.data.endDate, expectedRevision: subscription.revision } }, { id: "scoped", role, customerId: "customer" })).toThrow(/权限/);
    const raw = store.snapshot().customers[0], unsafe = { ...raw, data: { ...raw.data, calendarHistory: [event] } };
    context.sqlite.prepare("UPDATE ops_record SET data=? WHERE id=?").run(JSON.stringify(unsafe.data), raw.id);
    context.sqlite.prepare("UPDATE ops_change SET record_json=? WHERE record_id=?").run(JSON.stringify(unsafe), raw.id);
    const actor = { id: "scoped", role: "customer" as const, customerId: "customer" };
    const view = store.snapshot(actor); expect(view.subscriptions).toEqual([]); expect(view.rentals).toEqual([]);
    expect(view.customers[0].data).not.toHaveProperty("calendarHistory");
    expect(store.changes(0, 500, actor).every(change => !("calendarHistory" in change.record.data))).toBe(true);
  });
});
