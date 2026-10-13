import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db-harness";
import { seedCurrencies } from "./seed";
import { upsertRates } from "./fxRates";
import { insertChannel } from "./channels";
import { insertSpaceWithMother } from "./spaces";
import { insertChildAccount } from "./childAccounts";
import { motherAccount, space } from "./schema";
import { OperationsError, OperationsStore } from "./operations";
import { allocateCostToRentals, calculatePricing } from "@/lib/operations/report";
import { shanghaiToday } from "@/lib/operations/utils";
import { previewCsv, writeCsv } from "@/lib/workspace/csv";
import type { OpsCommand } from "@/lib/operations/types";

describe("operational ledger acceptance", () => {
  let ctx: ReturnType<typeof createTestDb>; let store: OperationsStore; let counter: number;
  const run = (type: string, payload: Record<string, unknown>, id?: string) => store.execute({ id: id ?? `test-${++counter}`, type, payload });
  beforeEach(() => {
    ctx = createTestDb(); seedCurrencies(ctx.db); store = new OperationsStore(ctx.sqlite); counter = 0;
    upsertRates(ctx.db, [{ currencyCode: "USD", rateToUsd: "1", quoteDate: "2026-10-13", fetchedAt: "2026-10-13T00:00:00Z", source: "test" }, { currencyCode: "CNY", rateToUsd: "0.15", quoteDate: "2026-10-13", fetchedAt: "2026-10-13T00:00:00Z", source: "test" }]);
  });
  afterEach(() => { vi.useRealTimers(); ctx.sqlite.close(); });
  function setup(capacity = 2, allocation = "fixed") {
    run("customer.save", { name: "Customer", contact: "customer-contact" }, "customer-create");
    run("subscription.save", { name: "Service", service: "Any SaaS", currency: "CNY", amountMinor: 10000, period: { unit: "month", count: 1 }, startDate: "2026-01-01", capacity, allocation }, "subscription-create");
    const snapshot = store.snapshot();
    return { customer: snapshot.customers[0], subscription: snapshot.subscriptions[0], slots: snapshot.slots };
  }
  function rented() {
    const fixture = setup();
    run("rental.join", { slotId: fixture.slots[0].id, customerId: fixture.customer.id, usage: "rented", startDate: "2026-01-01", amountMinor: 8000, currency: "CNY", period: { unit: "month", count: 1 } }, "rental-create");
    return { ...fixture, rental: store.snapshot().rentals[0], bill: store.snapshot().bills[0] };
  }
  function legacy(planType: "team" | "pro20x" = "team") {
    const channelId = insertChannel(ctx.db, "Legacy card", { feePercent: "2.5" }).id;
    const sub = insertSpaceWithMother(ctx.db, { name: "Old", planType, country: "GB", paymentChannelId: channelId, currencyCode: "USD", amountMinor: 1000, amountUsd: 1000, periodUnit: "month", periodCount: 1, currentPeriodStartDate: "2026-01-01", openingDate: "2026-01-01", expiryDate: "2026-02-01" }, "owner@example.com");
    ctx.db.update(motherAccount).set({ usageStatus: "rented", contact: "Owner customer", joinedDate: "2026-01-01", nextPaymentDate: "2026-02-01", expectedAmountMinor: 8000, expectedCurrencyCode: "CNY" }).where(eq(motherAccount.spaceId, sub.id)).run();
    return { sub, channelId };
  }
  it("migrates stable old IDs, merges same-email child into mother and creates no guessed bills", () => {
    const { sub, channelId } = legacy();
    insertChildAccount(ctx.db, { spaceId: sub.id, email: "OWNER@example.com", usageStatus: "rented", contact: "Duplicate", joinedDate: "2026-01-01", monthlyAmountMinor: 8000, monthlyCurrencyCode: "CNY", monthlyRateUsed: "0.15", monthlyRateAsOf: "2026-01-01", monthlyRateSource: "test", monthlyAmountUsd: 1200, monthlyPaymentDay: 1, nextPaymentDate: "2026-02-01" });
    const first = store.snapshot(); const second = store.snapshot();
    expect(first.slots).toHaveLength(1); expect(first.rentals).toHaveLength(1); expect(first.customers).toHaveLength(1); expect(first.bills).toHaveLength(0);
    expect(first.subscriptions[0].id).toBe(`legacy:subscription:${sub.id}`);
    expect(first.subscriptions[0].data.channelId).toBe(channelId); expect(first.slots[0].data.legacy!.sources).toHaveLength(2);
    expect(second.changeSeq).toBe(first.changeSeq); expect(first.rentals[0].data.billing.amountMinor).toBe(8000);
  });
  it("Pro migration contains actual members only and no fake mother rental", () => {
    const { sub } = legacy("pro20x");
    expect(store.snapshot().slots).toHaveLength(0);
    insertChildAccount(ctx.db, { spaceId: sub.id, email: "member@example.com", usageStatus: "rented", contact: "Member", joinedDate: "2026-01-01", monthlyAmountMinor: 45000, monthlyCurrencyCode: "CNY", monthlyRateUsed: "0.15", monthlyRateAsOf: "2026-01-01", monthlyRateSource: "test", monthlyAmountUsd: 6750, monthlyPaymentDay: 1, nextPaymentDate: "2026-02-01" });
    const snapshot = store.snapshot(); expect(snapshot.slots).toHaveLength(1); expect(snapshot.slots[0].data.kind).toBe("member"); expect(snapshot.rentals).toHaveLength(1);
  });
  it("legacy refresh updates managed fields but preserves operations edits and closed histories", () => {
    const { sub } = legacy(); const first = store.snapshot().subscriptions[0];
    run("subscription.save", { id: first.id, expectedRevision: first.revision, name: "Edited in operations" });
    ctx.db.update(space).set({ name: "Edited old", amountMinor: 2500 }).where(eq(space.id, sub.id)).run();
    const after = store.snapshot().subscriptions[0]; expect(after.data.name).toBe("Edited in operations"); expect(after.data.amountMinor).toBe(2500); expect(after.data.legacy!.managedFields).not.toContain("name");
    const rental = store.snapshot().rentals[0]; run("rental.exit", { id: rental.id, expectedRevision: rental.revision, date: "2026-01-15", reason: "Stopped" });
    ctx.db.update(motherAccount).set({ nextPaymentDate: "2026-03-01" }).where(eq(motherAccount.spaceId, sub.id)).run();
    expect(store.snapshot().rentals[0].data.status).toBe("ended"); expect(store.snapshot().rentals[0].data.endDate).toBe("2026-01-15");
  });
  it("same command is idempotent and a different command cannot reuse stale renewal period", () => {
    const { rental } = rented();
    const command: OpsCommand = { id: "renew-once", type: "rental.renew", payload: { id: rental.id, expectedRevision: rental.revision, expectedPeriod: rental.data.periodVersion } };
    const one = store.execute(command); const two = store.execute(command); expect(two.replayed).toBe(true); expect(two.snapshot.bills).toHaveLength(2);
    expect(one.snapshot.rentals[0].data.endDate).toBe("2026-03-01");
    expect(() => store.execute({ ...command, id: "offline-duplicate" })).toThrow(OperationsError);
    expect(() => store.execute({ ...command, payload: { ...command.payload, amountMinor: 9999 } })).toThrow(/同一命令/);
    expect(store.snapshot().rentals[0].data.periodVersion).toBe(2);
  });
  it("complete rental lifecycle keeps join/renew/switch/exit history and frees inventory", () => {
    const fixture = rented();
    run("rental.renew", { id: fixture.rental.id, expectedRevision: fixture.rental.revision, expectedPeriod: 1 });
    let current = store.snapshot().rentals[0]; run("rental.switch", { id: current.id, expectedRevision: current.revision, toSlotId: fixture.slots[1].id, date: "2026-02-10", reason: "Account change" });
    current = store.snapshot().rentals[0]; run("rental.exit", { id: current.id, expectedRevision: current.revision, date: "2026-02-20", reason: "Customer leaves" });
    const final = store.snapshot().rentals[0]; expect(final.data.history.map(event => event.type)).toEqual(["join", "renew", "switch", "exit"]); expect(final.data.status).toBe("ended");
    run("slot.disable", { id: fixture.slots[1].id, expectedRevision: store.snapshot().slots.find(row => row.id === fixture.slots[1].id)!.revision, reason: "Retired" });
    expect(store.snapshot().bills).toHaveLength(2); expect(store.snapshot().slots.find(row => row.id === fixture.slots[1].id)!.data.status).toBe("disabled");
  });
  it("self-use occupies a real slot without customer income or fake receivable", () => {
    const fixture = setup(); run("rental.join", { slotId: fixture.slots[0].id, usage: "self", startDate: "2026-01-01", amountMinor: 99999 });
    expect(store.snapshot().bills).toHaveLength(0); expect(store.snapshot().rentals[0].data.billing.amountMinor).toBe(0);
    expect(() => run("rental.join", { slotId: fixture.slots[0].id, customerId: fixture.customer.id, startDate: "2026-01-10" })).toThrow(/占用/);
  });
  it("partial receipt, top-up and refund share a native-currency receivable balance", () => {
    const { bill } = rented();
    run("entry.receive", { billId: bill.id, amountMinor: 3000, currency: "CNY", date: "2026-01-02" }, "partial");
    run("entry.receive", { billId: bill.id, amountMinor: 5000, currency: "CNY", date: "2026-01-03" }, "topup");
    expect(store.report().receivables.bills[0].outstandingMinor).toBe(0);
    run("entry.refund", { sourceEntryId: "entry:partial", amountMinor: 1000, date: "2026-01-04", reason: "Returned part" });
    expect(store.report().receivables.bills[0].outstandingMinor).toBe(1000);
    expect(store.report().cash.incomeUsd).toBe(1050); expect(store.report().accrual.incomeUsd).toBe(1200);
    expect(() => run("entry.refund", { sourceEntryId: "entry:partial", amountMinor: 2500, reason: "Too much" })).toThrow(/累计退款/);
    expect(() => run("entry.receive", { billId: bill.id, amountMinor: 1001 })).toThrow(/超过/);
  });
  it("discount and void require reasons, retain audit and never erase money", () => {
    const { bill } = rented();
    expect(() => run("bill.discount", { id: bill.id, expectedRevision: bill.revision, discountMinor: 1000 })).toThrow(/原因/);
    run("bill.discount", { id: bill.id, expectedRevision: bill.revision, discountMinor: 1000, reason: "Loyalty" });
    const discounted = store.snapshot().bills[0]; expect(discounted.data.cnyMinor).toBe(7000); expect(discounted.data.usdMinor).toBe(1050);
    run("bill.void", { id: bill.id, expectedRevision: discounted.revision, reason: "Issued in error" });
    expect(store.snapshot().bills[0].data.amountMinor).toBe(8000); expect(store.report().accrual.incomeUsd).toBe(0);
    expect(store.audit().some(row => row.reason === "Issued in error")).toBe(true);
  });
  it("annual purchase including percent fees accrues by actual days and reconciles across months", () => {
    const fixture = setup();
    run("entry.cost", { subscriptionId: fixture.subscription.id, amountMinor: 36500, currency: "USD", feePercent: "10", date: "2026-01-01", periodStart: "2026-01-01", periodEnd: "2027-01-01" }, "annual-cost");
    const entry = store.snapshot().entries[0]; expect(entry.data.totalMinor).toBe(40150); expect(store.report({ from: "2026-01-01", to: "2026-02-01" }).accrual.costUsd).toBe(3410);
    let sum = 0; for (let month = 1; month <= 12; month++) { const from = `2026-${String(month).padStart(2, "0")}-01`; const to = month === 12 ? "2027-01-01" : `2026-${String(month + 1).padStart(2, "0")}-01`; sum += store.report({ from, to }).accrual.costUsd; }
    expect(sum).toBe(40150); expect(store.report({ from: "2026-02-01", to: "2026-03-01" }).cash.costUsd).toBe(0);
  });
  it("fixed slot weights retain vacant cost while daily usage allocates to actual participants", () => {
    const fixture = rented();
    run("entry.cost", { subscriptionId: fixture.subscription.id, amountMinor: 3100, currency: "USD", date: "2026-01-01", periodStart: "2026-01-01", periodEnd: "2026-02-01" }, "month-cost");
    const fixed = allocateCostToRentals(store.snapshot(), "entry:month-cost"); expect(fixed.rentals[0].usdMinor).toBe(1550); expect(fixed.unallocatedUsd).toBe(1550);
    const sub = store.snapshot().subscriptions[0]; run("subscription.save", { id: sub.id, expectedRevision: sub.revision, allocation: "daily" });
    expect(allocateCostToRentals(store.snapshot(), "entry:month-cost").unallocatedUsd).toBe(1550);
    run("entry.cost", { subscriptionId: fixture.subscription.id, amountMinor: 3100, currency: "USD", date: "2026-01-01", periodStart: "2026-01-01", periodEnd: "2026-02-01" }, "daily-cost");
    const daily = allocateCostToRentals(store.snapshot(), "entry:daily-cost"); expect(daily.rentals[0].usdMinor).toBe(3100); expect(daily.unallocatedUsd).toBe(0);
  });
  it("FX cache updates current estimates while bills, receipts and purchase entries remain frozen", () => {
    const fixture = rented(); run("entry.receive", { billId: fixture.bill.id, amountMinor: 1000, currency: "CNY" }, "frozen-receipt"); run("entry.cost", { subscriptionId: fixture.subscription.id, amountMinor: 1000, currency: "CNY" }, "frozen-cost");
    const before = store.snapshot(); const estimates = store.report().estimates;
    upsertRates(ctx.db, [{ currencyCode: "CNY", rateToUsd: "0.2", quoteDate: "2026-10-14", fetchedAt: "2026-10-14T00:00:00Z", source: "new-test" }]);
    const after = store.snapshot(); expect(after.entries).toEqual(before.entries); expect(after.bills).toEqual(before.bills); expect(store.report().estimates.incomeUsd).not.toBe(estimates.incomeUsd);
    expect(store.report().estimates.lines.find(line => line.type === "estimated-income")!.cnyMinor).toBe(8000);
  });
  it("batch renewal is transactional on stale items and returns no partial changes", () => {
    const fixture = rented(); const secondSlot = fixture.slots[1]; run("rental.join", { slotId: secondSlot.id, customerId: fixture.customer.id, startDate: "2026-01-01", amountMinor: 5000 }, "second-rental");
    const rentals = store.snapshot().rentals; const before = store.snapshot();
    expect(() => run("renewal.batch", { items: rentals.map((row, i) => ({ id: row.id, expectedRevision: row.revision, expectedPeriod: i === 1 ? 99 : row.data.periodVersion })) })).toThrow(/租期/);
    expect(store.snapshot()).toEqual(before);
  });
  it("CSV command imports commit atomically and deduplicate repeated data across batches", () => {
    const rows = [{ type: "customer.save", payload: { name: "Imported", contact: "Contact" } }];
    run("import.commit", { rows, sourceName: "customers.csv" }, "import-one"); run("import.commit", { rows, sourceName: "renamed.csv" }, "import-two"); expect(store.snapshot().customers).toHaveLength(1);
    const before = store.snapshot(); expect(() => run("import.commit", { rows: [{ type: "customer.save", payload: { name: "Will roll back" } }, { type: "customer.save", payload: { name: "" } }] })).toThrow(/客户名称/); expect(store.snapshot()).toEqual(before);
  });
  it("template capacity builds explicit inventory, pricing includes fees and requires occupied capacity", () => {
    run("template.save", { name: "Template", service: "Storage", capacity: 3, amountMinor: 10000, currency: "USD", feePercent: "2.5", period: { unit: "year", count: 1 } }, "template-create");
    run("subscription.save", { name: "Templated", templateId: "template:template-create", startDate: "2026-01-01" }); expect(store.snapshot().slots).toHaveLength(3); expect(store.snapshot().subscriptions[0].data.endDate).toBe("2027-01-01");
    const pricing = calculatePricing({ amountMinor: 10000, feePercent: "2.5", capacity: 3, occupied: 2, marginPercent: 20 }); expect(pricing.costMinor).toBe(10250); expect(pricing.breakEvenPerSlot).toBe(5125); expect(pricing.targetPerSlot).toBe(6407);
  });
  it("replica preserves authoritative revision and refuses historical money edits or invalid shapes", () => {
    const fixture = rented(); run("entry.receive", { billId: fixture.bill.id, amountMinor: 1000 }, "replica-receipt"); const entry = store.snapshot().entries[0];
    expect(() => store.applyReplica({ id: "mutate-history", records: [{ ...entry, data: { ...entry.data, amountMinor: 2000 }, expectedRevision: entry.revision, sourceRevision: 10 }] })).toThrow();
    const customer = store.snapshot().customers[0]; store.applyReplica({ id: "align-version", records: [{ ...customer, expectedRevision: customer.revision, sourceRevision: 20 }], reason: "Hub canonical revision" }); expect(store.snapshot().customers[0].revision).toBe(20);
    store.applyReplica({ id: "explicit-align-down", records: [{ ...customer, expectedRevision: 20, sourceRevision: 3 }], reason: "Explicit canonical source alignment" }); expect(store.snapshot().customers[0].revision).toBe(3);
    expect(() => store.applyReplica({ id: "invalid-customer", records: [{ ...customer, data: { ...customer.data, name: "" }, expectedRevision: 3, sourceRevision: 4 }] })).toThrow(/格式无效/);
  });
  it("customer read scope includes own cash/bills, removes private data and forbids writes", () => {
    const fixture = rented(); run("entry.receive", { billId: fixture.bill.id, amountMinor: 1000, note: "Private collection note" });
    const actor = { id: "customer-token", role: "customer" as const, customerId: fixture.customer.id }; const snapshot = store.snapshot(actor);
    expect(snapshot.subscriptions).toHaveLength(0); expect(snapshot.slots).toHaveLength(0); expect(snapshot.channels).toHaveLength(0); expect(snapshot.entries[0].data.note).toBe("");
    expect(store.changes(0, 500, actor).every(change => change.record.data.note === "")).toBe(true);
    expect(() => store.execute({ id: "customer-write", type: "customer.save", payload: { name: "Escalation" } }, actor)).toThrow();
  });
  it("business dates use Shanghai around the UTC date boundary", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-12T20:00:00Z")); expect(shanghaiToday()).toBe("2026-10-13");
  });
  it("native CNY cents never lose precision through intermediate USD rounding", () => {
    const fixture = rented(); run("entry.receive", { billId: fixture.bill.id, amountMinor: 1, currency: "CNY", date: "2026-01-02" });
    const entry = store.snapshot().entries[0]; expect(entry.data.cnyMinor).toBe(1); expect(entry.data.usdMinor).toBe(0); expect(store.report().receivables.bills[0].receivedMinor).toBe(1);
  });
  it("accrual keeps a native CNY cent even when its USD reference rounds to zero", () => {
    const fixture = setup(); run("bill.issue", { subscriptionId: fixture.subscription.id, customerId: fixture.customer.id, startDate: "2026-01-01", endDate: "2026-01-02", amountMinor: 1, currency: "CNY" });
    run("entry.cost", { subscriptionId: fixture.subscription.id, amountMinor: 1, currency: "CNY", date: "2026-01-01", periodStart: "2026-01-01", periodEnd: "2026-01-02" });
    const report = store.report({ from: "2026-01-01", to: "2026-01-02" }); expect(report.accrual.lines).toHaveLength(2); expect(report.accrual.lines.every(line => line.usdMinor === 0 && line.cnyMinor === 1)).toBe(true);
  });
  it("customer accrued and estimated costs use only their share and reconcile to subscription cost", () => {
    const fixture = rented(); run("entry.cost", { subscriptionId: fixture.subscription.id, amountMinor: 3100, currency: "USD", date: "2026-01-01", periodStart: "2026-01-01", periodEnd: "2026-02-01" });
    const customer = store.report({ customerId: fixture.customer.id, from: "2026-01-01", to: "2026-02-01" }); expect(customer.accrual.costUsd).toBe(1550); expect(customer.cash.costUsd).toBe(1550); expect(customer.estimates.costUsd).toBe(750);
    expect(customer.accrual.lines.find(line => line.type === "cost")!.sourceId).toMatch(/^entry:/);
  });
  it("receivables as of a period end exclude a later actual payment", () => {
    const fixture = rented(); run("entry.receive", { billId: fixture.bill.id, amountMinor: 8000, currency: "CNY", date: "2026-02-02" });
    expect(store.report({ from: "2026-01-01", to: "2026-02-01" }).receivables.bills[0].outstandingMinor).toBe(8000); expect(store.report().receivables.bills[0].outstandingMinor).toBe(0);
  });
  it("legacy receipts stay unallocated and remain an auditable frozen source after deletion", () => {
    const fixture = legacy();
    ctx.sqlite.prepare("INSERT INTO account_receipt(space_id,received_date,amount_minor,currency_code,rate_used,rate_as_of,rate_source,amount_usd,payer,note) VALUES(?,?,?,?,?,?,?,?,?,?)").run(fixture.sub.id, "2026-01-02", 1000, "USD", "1", "2026-01-02", "test", 1000, "Legacy payer", "Historic source");
    const entry = store.snapshot().entries[0]; expect(entry.data.billId).toBeUndefined(); expect(store.snapshot().bills).toHaveLength(0); expect(store.report().cash.incomeUsd).toBe(1000); expect(store.report().accrual.incomeUsd).toBe(0);
    ctx.sqlite.prepare("DELETE FROM account_receipt").run(); const retained = store.snapshot().entries[0]; expect(retained.id).toBe(entry.id); expect(retained.data.amountMinor).toBe(1000); expect(retained.data.status).toBe("posted"); expect(retained.data.legacy!.conflict).toMatch(/旧收款来源已删除/);
  });
  it("batch disable records atomic status changes and rejects any occupied item", () => {
    const fixture = rented(); const before = store.snapshot();
    expect(() => run("status.batch", { reason: "Retire inventory", items: fixture.slots.map(slot => ({ id: slot.id, kind: "slot", expectedRevision: slot.revision, status: "disabled" })) })).toThrow(/有效租赁/); expect(store.snapshot()).toEqual(before);
    run("rental.exit", { id: fixture.rental.id, expectedRevision: fixture.rental.revision, date: "2026-01-15", reason: "Finished" });
    run("status.batch", { reason: "Retire inventory", items: store.snapshot().slots.map(slot => ({ id: slot.id, kind: "slot", expectedRevision: slot.revision, status: "disabled" })) }); expect(store.snapshot().slots.every(slot => slot.data.status === "disabled")).toBe(true);
  });
  it("replicated V1 records remain active on a device with empty V1 tables", () => {
    legacy(); const source = store.snapshot(); const remoteContext = createTestDb(); seedCurrencies(remoteContext.db); const remote = new OperationsStore(remoteContext.sqlite);
    try {
      const records = [...source.customers, ...source.subscriptions, ...source.slots, ...source.rentals, ...source.bills, ...source.entries].map(record => ({ ...record, expectedRevision: 0, sourceRevision: record.revision }));
      remote.applyReplica({ id: "bootstrap-legacy", records, reason: "Authorised bootstrap to empty ledger" });
      const after = remote.snapshot(); expect(after.subscriptions[0].data.status).toBe("active"); expect(after.rentals[0].data.status).toBe("active"); expect(after.subscriptions[0].data.amountMinor).toBe(source.subscriptions[0].data.amountMinor); expect(after.rentals[0].data.legacy!.present).toBe(true); expect(remote.snapshot().changeSeq).toBe(after.changeSeq);
    } finally { remoteContext.sqlite.close(); }
  });
  it("local V1 IDs colliding with canonical replica are quarantined instead of merged", () => {
    legacy(); const source = store.snapshot();
    const canonical = source.subscriptions[0]; store.applyReplica({ id: "remote-canonical", records: [{ ...canonical, data: { ...canonical.data, name: "Canonical hub name", amountMinor: 5000 }, expectedRevision: canonical.revision, sourceRevision: canonical.revision + 1 }] });
    ctx.db.update(space).set({ name: "Conflicting local old source", amountMinor: 9000 }).run();
    const after = store.snapshot(); expect(after.subscriptions[0].data.name).toBe("Canonical hub name"); expect(after.subscriptions[0].data.amountMinor).toBe(5000); expect(store.audit().some(row => row.action === "legacy.conflict")).toBe(true);
    const count = store.audit().length; store.snapshot(); expect(store.audit()).toHaveLength(count);
  });
  it("31st month anchor recovers after February for rentals and subscriptions", () => {
    const fixture = setup(); const sub = fixture.subscription;
    run("subscription.save", { id: sub.id, expectedRevision: sub.revision, startDate: "2026-01-31", period: { unit: "month", count: 1 } });
    const currentSub = store.snapshot().subscriptions[0]; expect(currentSub.data.endDate).toBe("2026-02-28");
    run("subscription.renew", { id: currentSub.id, expectedRevision: currentSub.revision, date: "2026-02-28" }); expect(store.snapshot().subscriptions[0].data.endDate).toBe("2026-03-31");
    run("rental.join", { slotId: fixture.slots[0].id, customerId: fixture.customer.id, startDate: "2026-01-31", amountMinor: 1000, currency: "CNY" });
    const rental = store.snapshot().rentals[0]; expect(rental.data.endDate).toBe("2026-02-28");
    run("rental.renew", { id: rental.id, expectedRevision: rental.revision, expectedPeriod: 1 }); expect(store.snapshot().rentals[0].data.endDate).toBe("2026-03-31"); expect(store.snapshot().rentals[0].data.cycleAnchorDay).toBe(31);
  });
  it("29th annual anchor recovers at the next leap year and legacy payment day overrides joined day", () => {
    const fixture = setup(); run("rental.join", { slotId: fixture.slots[0].id, usage: "self", startDate: "2024-02-29", period: { unit: "year", count: 1 } });
    for (let renewal = 0; renewal < 3; renewal++) { const row = store.snapshot().rentals[0]; run("rental.renew", { id: row.id, expectedRevision: row.revision, expectedPeriod: row.data.periodVersion }); }
    expect(store.snapshot().rentals[0].data.endDate).toBe("2028-02-29");
    const old = legacy(); ctx.db.update(motherAccount).set({ joinedDate: "2026-01-25", monthlyPaymentDay: 12, nextPaymentDate: "2026-02-12" }).where(eq(motherAccount.spaceId, old.sub.id)).run();
    const row = store.snapshot().rentals.find(row => row.data.legacy)!; expect(row.data.cycleAnchorDay).toBe(12); run("rental.renew", { id: row.id, expectedRevision: row.revision, expectedPeriod: row.data.periodVersion }); expect(store.snapshot().rentals.find(record => record.id === row.id)!.data.endDate).toBe("2026-03-12");
  });
  it("fixed native amounts cap costs, preserve exact shares and keep later slot changes out of history", () => {
    const fixture = setup(2, "fixed-amount");
    run("slot.save", { id: fixture.slots[0].id, expectedRevision: fixture.slots[0].revision, fixedCostMinor: 2000 });
    run("slot.save", { id: fixture.slots[1].id, expectedRevision: fixture.slots[1].revision, fixedCostMinor: 3000 });
    run("rental.join", { slotId: fixture.slots[0].id, customerId: fixture.customer.id, startDate: "2026-01-01", amountMinor: 8000, currency: "CNY" });
    run("entry.cost", { subscriptionId: fixture.subscription.id, amountMinor: 10000, currency: "CNY", date: "2026-01-01", periodStart: "2026-01-01", periodEnd: "2026-02-01" }, "fixed-amount-cost");
    const cost = store.snapshot().entries[0]; const usd = allocateCostToRentals(store.snapshot(), cost.id); const cny = allocateCostToRentals(store.snapshot(), cost.id, undefined, undefined, cost.data.cnyMinor!, "CNY");
    expect(usd.rentals[0].usdMinor).toBe(300); expect(usd.unallocatedUsd).toBe(1200); expect(cny.rentals[0].usdMinor).toBe(2000); expect(cny.unallocatedUsd).toBe(8000);
    expect(store.report({ customerId: fixture.customer.id }).estimates.costUsd).toBe(300);
    const slot = store.snapshot().slots.find(row => row.id === fixture.slots[0].id)!; run("slot.save", { id: slot.id, expectedRevision: slot.revision, fixedCostMinor: 1000 });
    expect(allocateCostToRentals(store.snapshot(), cost.id).rentals[0].usdMinor).toBe(300); expect(store.report({ customerId: fixture.customer.id }).estimates.costUsd).toBe(150);
    const other = store.snapshot().slots.find(row => row.id === fixture.slots[1].id)!; expect(() => run("slot.save", { id: other.id, expectedRevision: other.revision, fixedCostMinor: 10000 })).toThrow(/固定分摊/);
  });
  it("fixed amount daily matrix reconciles every month and never creates negative remainder", () => {
    const fixture = setup(2, "fixed-amount");
    for (const slot of fixture.slots) run("slot.save", { id: slot.id, expectedRevision: slot.revision, fixedCostMinor: 1 });
    for (const slot of fixture.slots) run("rental.join", { slotId: slot.id, usage: "self", startDate: "2026-01-01", period: { unit: "year", count: 1 } });
    run("entry.cost", { subscriptionId: fixture.subscription.id, amountMinor: 24, currency: "CNY", date: "2026-01-01", periodStart: "2026-01-01", periodEnd: "2027-01-01" }, "small-fixed-year");
    const entry = store.snapshot().entries[0]; let sum = 0;
    for (let month = 1; month <= 12; month++) { const from = `2026-${String(month).padStart(2, "0")}-01`; const to = month === 12 ? "2027-01-01" : `2026-${String(month + 1).padStart(2, "0")}-01`; const result = allocateCostToRentals(store.snapshot(), entry.id, from, to, entry.data.cnyMinor!, "CNY"); expect(result.unallocatedUsd).toBeGreaterThanOrEqual(0); sum += result.unallocatedUsd + result.rentals.reduce((value, row) => value + row.usdMinor, 0); }
    expect(sum).toBe(24);
    const full = allocateCostToRentals(store.snapshot(), entry.id, undefined, undefined, entry.data.cnyMinor!, "CNY"); expect(full.rentals.map(row => row.usdMinor).sort()).toEqual([12, 12]); expect(full.unallocatedUsd).toBe(0);
  });
  it("deleting a legacy receipt source never voids the confirmed source of a posted refund", () => {
    const fixture = legacy(); ctx.sqlite.prepare("INSERT INTO account_receipt(space_id,received_date,amount_minor,currency_code,rate_used,rate_as_of,rate_source,amount_usd) VALUES(?,?,?,?,?,?,?,?)").run(fixture.sub.id, "2026-01-02", 1000, "USD", "1", "2026-01-02", "test", 1000);
    const source = store.snapshot().entries[0]; run("entry.refund", { sourceEntryId: source.id, amountMinor: 200, date: "2026-01-03", reason: "Explicit refund" }); const income = store.report().cash.incomeUsd;
    ctx.sqlite.prepare("DELETE FROM account_receipt").run(); const retained = store.snapshot().entries.find(row => row.id === source.id)!;
    expect(retained.data.status).toBe("posted"); expect(retained.data.legacy!.present).toBe(false); expect(retained.data.legacy!.sources).toContain("account_receipt:1"); expect(store.report().cash.incomeUsd).toBe(income); expect(store.report().cash.incomeUsd).toBe(800);
  });
  it("formal operations renewal takes custody of legacy rental identity and occupied status", () => {
    const fixture = legacy(); const rental = store.snapshot().rentals[0]; run("rental.renew", { id: rental.id, expectedRevision: rental.revision, expectedPeriod: rental.data.periodVersion });
    ctx.db.update(motherAccount).set({ usageStatus: "disabled", nextPaymentDate: "2026-04-01" }).where(eq(motherAccount.spaceId, fixture.sub.id)).run();
    const snapshot = store.snapshot(); expect(snapshot.rentals[0].data.usage).toBe("rented"); expect(snapshot.rentals[0].data.status).toBe("active"); expect(snapshot.rentals[0].data.customerId).toBe(rental.data.customerId); expect(snapshot.customers[0].data.archived).toBe(false); expect(snapshot.slots[0].data.status).toBe("available");
    run("entry.receive", { billId: snapshot.bills[0].id, amountMinor: 1000, currency: "CNY" }); expect(store.snapshot().entries).toHaveLength(1);
  });
  it("early renewal reserves a future bill without blocking current-period switching or exit", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-13T04:00:00Z"));
    const fixture = setup();
    run("slot.save", { id: fixture.slots[1].id, expectedRevision: fixture.slots[1].revision, weight: 3 });
    run("rental.join", { slotId: fixture.slots[0].id, customerId: fixture.customer.id, startDate: "2026-10-01", amountMinor: 8000, currency: "CNY" }, "early-join");
    run("entry.cost", { subscriptionId: fixture.subscription.id, amountMinor: 3100, currency: "USD", date: "2026-10-01", periodStart: "2026-10-01", periodEnd: "2026-11-01" }, "early-cost");
    let rental = store.snapshot().rentals[0]; run("rental.renew", { id: rental.id, expectedRevision: rental.revision, expectedPeriod: rental.data.periodVersion }, "early-renew");
    rental = store.snapshot().rentals[0]; expect(rental.data.history[1]).toMatchObject({ type: "renew", date: "2026-10-13", periodStart: "2026-11-01", periodEnd: "2026-12-01" });
    expect(store.snapshot().bills.find(bill => bill.data.startDate === "2026-11-01")!.data.endDate).toBe("2026-12-01");
    run("rental.switch", { id: rental.id, expectedRevision: rental.revision, toSlotId: fixture.slots[1].id, date: "2026-10-15", reason: "Current-period switch after early renewal" });
    rental = store.snapshot().rentals[0]; run("rental.exit", { id: rental.id, expectedRevision: rental.revision, date: "2026-10-20", reason: "Exit after early renewal" });
    const final = store.snapshot(); expect(final.rentals[0].data.history.map(event => event.type)).toEqual(["join", "renew", "switch", "exit"]); expect(final.rentals[0].data.endDate).toBe("2026-10-20");
    expect(allocateCostToRentals(final, "entry:early-cost", "2026-10-01", "2026-10-15").rentals[0].usdMinor).toBe(350);
    expect(allocateCostToRentals(final, "entry:early-cost", "2026-10-15", "2026-10-20").rentals[0].usdMinor).toBe(375);
    const costs = allocateCostToRentals(final, "entry:early-cost"); expect(costs.rentals[0].usdMinor).toBe(725); expect(costs.unallocatedUsd).toBe(2375);
  });
  it("legacy country and first activation remain distinct from the current paid period", () => {
    const fixture = legacy(); ctx.db.update(space).set({ openingDate: "2025-09-01" }).where(eq(space.id, fixture.sub.id)).run();
    let record = store.snapshot().subscriptions[0]; expect(record.data.countryCode).toBe("GB"); expect(record.data.openingDate).toBe("2025-09-01"); expect(record.data.startDate).toBe("2026-01-01");
    run("subscription.save", { id: record.id, expectedRevision: record.revision, startDate: "2026-02-01" });
    record = store.snapshot().subscriptions[0]; run("subscription.renew", { id: record.id, expectedRevision: record.revision, date: "2026-02-01" });
    expect(store.snapshot().subscriptions[0].data.openingDate).toBe("2025-09-01"); expect(store.snapshot().subscriptions[0].data.countryCode).toBe("GB");
  });
  it("owned older projections backfill new optional fields once even with an already matching source fingerprint", () => {
    legacy(); const projected = store.snapshot().subscriptions[0]; const older = structuredClone(projected.data);
    delete older.countryCode; delete older.openingDate; older.legacy!.managedFields = older.legacy!.managedFields.filter(key => key !== "countryCode" && key !== "openingDate");
    ctx.sqlite.prepare("UPDATE ops_record SET data=? WHERE id=?").run(JSON.stringify(older), projected.id);
    const backfilled = store.snapshot(); expect(backfilled.subscriptions[0].data.countryCode).toBe("GB"); expect(backfilled.subscriptions[0].data.openingDate).toBe("2026-01-01");
    expect(backfilled.subscriptions[0].data.legacy!.managedFields).toEqual(expect.arrayContaining(["countryCode", "openingDate"]));
    expect(store.snapshot().changeSeq).toBe(backfilled.changeSeq);
  });
  it("edited or explicitly cleared source fields never get restored by later legacy refresh", () => {
    const fixture = legacy(); let record = store.snapshot().subscriptions[0];
    run("subscription.save", { id: record.id, expectedRevision: record.revision, countryCode: "us", openingDate: "2025-02-01" });
    ctx.db.update(space).set({ country: "FR", openingDate: "2024-05-23" }).where(eq(space.id, fixture.sub.id)).run();
    record = store.snapshot().subscriptions[0]; expect(record.data.countryCode).toBe("US"); expect(record.data.openingDate).toBe("2025-02-01");
    run("subscription.save", { id: record.id, expectedRevision: record.revision, countryCode: "", openingDate: null });
    ctx.db.update(space).set({ country: "CA", openingDate: "2024-08-13" }).where(eq(space.id, fixture.sub.id)).run();
    record = store.snapshot().subscriptions[0]; expect(record.data.countryCode).toBeUndefined(); expect(record.data.openingDate).toBeUndefined(); expect(record.data.legacy!.detachedFields).toEqual(expect.arrayContaining(["countryCode", "openingDate"]));
    const seq = store.snapshot().changeSeq; expect(store.snapshot().changeSeq).toBe(seq);
  });
  it("old subscriptions without optional fields remain valid and invalid new values roll back", () => {
    const fixture = setup(); const before = store.snapshot(); expect(fixture.subscription.data.countryCode).toBeUndefined(); expect(fixture.subscription.data.openingDate).toBeUndefined();
    expect(() => run("subscription.save", { id: fixture.subscription.id, expectedRevision: fixture.subscription.revision, countryCode: "United Kingdom" })).toThrow(/国家代码/);
    expect(() => run("subscription.save", { id: fixture.subscription.id, expectedRevision: fixture.subscription.revision, openingDate: "2026-02-30" })).toThrow(/格式无效/);
    expect(store.snapshot()).toEqual(before);
  });
  it("subscription CSV optional fields survive parsing and commands while missing old columns stay compatible", () => {
    const csv = writeCsv([["name", "service", "currency", "amountMinor", "startDate", "countryCode", "openingDate"], ["Synthetic CSV", "Generic SaaS", "CNY", 1000, "2026-01-01", "GB", "2025-09-01"]]);
    const preview = previewCsv(csv, ["name", "service", "currency", "amountMinor", "startDate"]); expect(preview.errors).toHaveLength(0);
    run("import.commit", { rows: preview.rows.map(row => ({ type: "subscription.save", payload: { ...row, amountMinor: Number(row.amountMinor) } })) });
    const record = store.snapshot().subscriptions[0]; expect(record.data.countryCode).toBe("GB"); expect(record.data.openingDate).toBe("2025-09-01");
    const parsedExport = previewCsv(writeCsv([["countryCode", "openingDate"], [record.data.countryCode, record.data.openingDate]]), []); expect(parsedExport.rows[0]).toEqual({ countryCode: "GB", openingDate: "2025-09-01" });
    run("import.commit", { rows: [{ type: "subscription.save", payload: { name: "Older CSV", service: "Generic SaaS", currency: "CNY", amountMinor: 500, startDate: "2026-01-01" } }] });
    expect(store.snapshot().subscriptions).toHaveLength(2); expect(store.snapshot().subscriptions.find(row => row.data.name === "Older CSV")!.data.countryCode).toBeUndefined();
  });
});
